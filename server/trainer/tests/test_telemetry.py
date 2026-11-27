"""Worker telemetry: heartbeat stats, the optional /metrics endpoint, and the
traceparent a claim hands the worker."""

from __future__ import annotations

import os
import tempfile
import unittest
import urllib.request
from typing import Any
from unittest import mock

from fixtures.fake_protocol_server import FakeProtocolServer
from fixtures.stub_runners import StubRunner
from test_worker_protocol import DATASET, KEY, train_job

from grad_trainer import telemetry as telemetry_mod
from grad_trainer.telemetry import WorkerTelemetry, gpu_stats
from grad_trainer.worker import ProtocolClient, TrainerWorker, worker_from_env

TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"


class FakeClock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


class WorkerTelemetryTests(unittest.TestCase):
    def test_tokens_per_second_and_heartbeat_stats(self) -> None:
        clock = FakeClock()
        gpus = [
            {"utilization": 0.5, "memory_used_bytes": 1e9},
            {"utilization": 1.0, "memory_used_bytes": 3e9},
        ]
        t = WorkerTelemetry(clock=clock, gpus=lambda: gpus)
        self.assertEqual(t.heartbeat_stats()["phase"], "idle")
        t.set_phase("starting")
        t.observe_step(1000)
        clock.t += 2
        t.observe_step(5000)
        self.assertEqual(
            t.heartbeat_stats(),
            {
                "phase": "training",
                "tokens_per_second": 2000.0,
                "gpu_memory_used_bytes": 4e9,
                "gpu_utilization": 0.75,
            },
        )
        t.set_phase("bogus")
        self.assertEqual(t.phase, "idle")
        self.assertEqual(t.tokens_per_second, 0.0)

    def test_unknown_gpu_utilisation_is_left_out(self) -> None:
        t = WorkerTelemetry(gpus=lambda: [{"utilization": -1.0, "memory_used_bytes": 5.0}])
        stats = t.heartbeat_stats()
        self.assertEqual(stats["gpu_memory_used_bytes"], 5.0)
        self.assertNotIn("gpu_utilization", stats)
        self.assertNotIn("gpu_memory_used_bytes", WorkerTelemetry(gpus=lambda: []).heartbeat_stats())

    def test_gpu_stats_without_a_gpu_is_empty(self) -> None:
        with mock.patch.object(telemetry_mod, "_NVML", [None]):
            self.assertEqual(gpu_stats(), [])

    def test_gpu_stats_reads_nvml(self) -> None:
        nvml = mock.Mock()
        nvml.nvmlDeviceGetCount.return_value = 1
        nvml.nvmlDeviceGetUtilizationRates.return_value = mock.Mock(gpu=40)
        nvml.nvmlDeviceGetMemoryInfo.return_value = mock.Mock(used=123)
        with mock.patch.object(telemetry_mod, "_NVML", [nvml]):
            self.assertEqual(gpu_stats(), [{"utilization": 0.4, "memory_used_bytes": 123.0}])

    def test_metrics_endpoint(self) -> None:
        t = WorkerTelemetry(gpus=lambda: [{"utilization": 0.25, "memory_used_bytes": 7.0}])
        server = t.serve(0, "127.0.0.1")
        self.addCleanup(t.close)
        t.set_phase("starting")
        t.observe_step(10)
        t.observe_step(20)
        t.observe_checkpoint(3.0)
        t.observe_checkpoint(None, reason="emergency", ok=False)
        t.observe_upload("checkpoint", 2048, 1.5)
        t.observe_job("train", "completed")
        port = server.server_port
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/metrics", timeout=5) as resp:
            text = resp.read().decode()
        for line in (
            'grad_trainer_phase{phase="training"} 1.0',
            'grad_trainer_phase{phase="idle"} 0.0',
            "grad_trainer_steps_total 2.0",
            "grad_trainer_step_duration_seconds_count 1.0",
            "grad_trainer_checkpoint_duration_seconds_sum 3.0",
            'grad_trainer_checkpoints_total{reason="periodic",result="ok"} 1.0',
            'grad_trainer_checkpoints_total{reason="emergency",result="failed"} 1.0',
            'grad_trainer_upload_bytes_total{kind="checkpoint"} 2048.0',
            'grad_trainer_upload_duration_seconds_count{kind="checkpoint"} 1.0',
            'grad_trainer_jobs_total{kind="train",status="completed"} 1.0',
            'grad_trainer_gpu_utilization_ratio{gpu="0"} 0.25',
            'grad_trainer_gpu_memory_used_bytes{gpu="0"} 7.0',
            "grad_trainer_tokens_per_second",
            "process_cpu_seconds_total",
        ):
            self.assertIn(line, text)


class WorkerIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.tmp.cleanup)

    def server(self, **kwargs: Any) -> FakeProtocolServer:
        srv = FakeProtocolServer(api_key=KEY, **kwargs)
        srv.blobs.setdefault("/v1/trainer-jobs/run_1/dataset", DATASET)
        srv.__enter__()
        self.addCleanup(srv.__exit__)
        return srv

    def test_heartbeats_carry_stats_and_requests_carry_the_traceparent(self) -> None:
        srv = self.server(jobs=[{**train_job(), "traceparent": TRACEPARENT}])
        telemetry = WorkerTelemetry(gpus=lambda: [])
        worker = TrainerWorker(
            server_url=srv.base_url,
            worker_id="w-test",
            workdir=self.tmp.name,
            recipe_runner_factory=lambda _kind: StubRunner(steps=6, step_sleep=0.03),
            recipes=["sft"],
            heartbeat_interval_s=0.02,
            client=ProtocolClient(srv.base_url, KEY, retry_base_s=0.01, retry_cap_s=0.02),
            telemetry=telemetry,
        )
        result = worker.run_once()
        self.assertEqual(result["status"], "completed")

        beats = srv.bodies("heartbeat")
        self.assertTrue(beats)
        self.assertTrue(all("stats" in b and "phase" in b["stats"] for b in beats))
        self.assertIn("training", {b["stats"]["phase"] for b in beats})

        job_calls = [r for r in srv.requests if "/trainer-jobs/run_1/" in r.path]
        self.assertTrue(job_calls)
        self.assertTrue(all(r.headers.get("traceparent") == TRACEPARENT for r in job_calls))
        claim = srv.calls("claim")[0]
        self.assertNotIn("traceparent", claim.headers)

        ckpt = srv.bodies("checkpoints")[0]
        self.assertIsInstance(ckpt["metadata"]["upload_seconds"], float)
        self.assertEqual(telemetry.phase, "idle")
        self.assertIsNone(worker.client.traceparent)

    def test_metrics_port_from_the_environment(self) -> None:
        srv = self.server()
        worker = worker_from_env(
            {
                "GRAD_SERVER_URL": srv.base_url,
                "GRAD_WORKER_METRICS_PORT": "0",
                "GRAD_WORKER_METRICS_HOST": "127.0.0.1",
            }
        )
        self.addCleanup(worker.telemetry.close)
        port = worker.telemetry.server.server_port
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/metrics", timeout=5) as resp:
            self.assertIn('grad_trainer_phase{phase="idle"} 1.0', resp.read().decode())
        self.assertIsNone(worker_from_env({"GRAD_SERVER_URL": srv.base_url}).telemetry.server)


if __name__ == "__main__":
    unittest.main()
