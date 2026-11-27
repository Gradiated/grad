"""Worker protocol v1 tests against an in-process fake grad-server."""

from __future__ import annotations

import contextlib
from datetime import timedelta
import gzip
import io
import json
import os
import signal
import tempfile
import threading
import unittest
from unittest import mock
from pathlib import Path
from typing import Any

from fixtures.fake_protocol_server import FakeProtocolServer
from fixtures.stub_runners import StubImporter, StubRunner

from grad_trainer import worker as worker_module
from grad_trainer.bundles import bundle_directory, extract_bundle
from grad_trainer.worker import (
    ProtocolClient,
    ServerError,
    TrainerWorker,
    WorkerAuthError,
    worker_from_env,
)

KEY = "grad_worker_key"


def train_job(
    job_id: str = "run_1",
    *,
    attempt: int = 1,
    dataset_url: str = "/v1/trainer-jobs/run_1/dataset",
    resume: dict | None = None,
    base: dict | None = None,
) -> dict[str, Any]:
    return {
        "id": job_id,
        "kind": "train",
        "attempt": attempt,
        "lease_seconds": 60,
        "lease_expires_at": "2026-11-27T12:01:00Z",
        "run": {
            "id": job_id,
            "workspace_id": "ws",
            "name": "demo",
            "recipe_kind": "sft",
            "resolved_config": {"recipe_kind": "sft", "lr": 0.001},
            "total_steps": 3,
        },
        "import": None,
        "price_per_million_tokens": 0.4,
        "max_cost_usd": 2.5,
        "dataset": {"version": 1, "record_count": 2, "download_url": dataset_url},
        "resume": resume,
        "base": base,
    }


def import_job(source: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": "imp_1",
        "kind": "import",
        "attempt": 1,
        "lease_seconds": 60,
        "lease_expires_at": "2026-11-27T12:01:00Z",
        "run": None,
        "import": {
            "id": "imp_1",
            "workspace_id": "ws",
            "dataset": "d",
            "source": source,
            "connector": "auto",
        },
        "price_per_million_tokens": None,
        "max_cost_usd": None,
        "dataset": None,
        "resume": None,
    }


# The job dataset download is gzip-compressed JSONL.
DATASET = gzip.compress(b'{"messages":[{"role":"user","content":"hi"}]}\n{"messages":[{"role":"user","content":"yo"}]}\n')


class WorkerProtocolTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(self.tmp.cleanup)

    def server(self, **kwargs: Any) -> FakeProtocolServer:
        srv = FakeProtocolServer(api_key=KEY, **kwargs)
        srv.blobs.setdefault("/v1/trainer-jobs/run_1/dataset", DATASET)
        srv.__enter__()
        self.addCleanup(srv.__exit__)
        return srv

    def worker(
        self,
        srv: FakeProtocolServer,
        runner: Any = None,
        importer: Any = None,
        **kwargs: Any,
    ) -> TrainerWorker:
        client = ProtocolClient(srv.base_url, KEY, retry_base_s=0.01, retry_cap_s=0.02)
        return TrainerWorker(
            server_url=srv.base_url,
            worker_id="w-test",
            workdir=self.tmp.name,
            recipe_runner_factory=lambda _kind: runner or StubRunner(),
            import_runner=importer or StubImporter(),
            recipes=["sft"],
            heartbeat_interval_s=kwargs.pop("heartbeat_interval_s", 0.05),
            client=client,
            **kwargs,
        )

    def test_happy_path_train(self) -> None:
        srv = self.server(jobs=[train_job()])
        runner = StubRunner()
        with contextlib.redirect_stderr(io.StringIO()) as err:
            result = self.worker(srv, runner).run_once()
        self.assertEqual(result["status"], "completed")
        self.assertIn("claimed train job run_1 attempt 1", err.getvalue())

        claim = srv.bodies("claim")[0]
        self.assertRegex(claim.pop("worker_id"), r"^w-test-[0-9a-f]{6}$")
        self.assertEqual(
            claim,
            {
                "lease_seconds": 180,
                "kinds": ["train", "import"],
                "recipes": ["sft"],
            },
        )
        call = runner.calls[0]
        self.assertEqual(len(call["records"]), 2)
        self.assertEqual(call["budget"].max_cost_usd, 2.5)
        self.assertEqual(call["budget"].price_per_million_tokens, 0.4)
        self.assertIsNone(call["resume"])

        progress = srv.bodies("progress")
        self.assertEqual([p["metric"]["step"] for p in progress], [1, 2, 3])
        self.assertTrue(
            all(p["attempt"] == 1 and "timestamp" in p["metric"] for p in progress)
        )

        uploads = srv.bodies("uploads")
        self.assertEqual([u["kind"] for u in uploads], ["checkpoint", "artifact"])
        puts = [r for r in srv.requests if r.method == "PUT"]
        self.assertEqual(puts[0].headers["x-amz-checksum-sha256"], "abc")
        for u, put in zip(uploads, puts):
            self.assertEqual(len(put.body), u["size_bytes"])

        ckpt = srv.bodies("checkpoints")[0]
        self.assertEqual(
            (ckpt["step"], ckpt["upload_id"], ckpt["format"]), (2, "upl_1", "peft_lora")
        )

        complete = srv.bodies("complete")[0]
        self.assertEqual(complete["status"], "completed")
        self.assertEqual(complete["upload_id"], "upl_2")
        self.assertEqual(complete["format"], "peft_lora")
        self.assertEqual(
            complete["tokens_processed"], 300
        )  # max(reported 150, metered 300)
        self.assertEqual(complete["eval_report"]["eval_loss"], 0.1)

        bundle = Path(self.tmp.name) / "artifact.tgz"
        bundle.write_bytes(srv.uploads["upl_2"])
        manifest = extract_bundle(bundle, Path(self.tmp.name) / "x")
        self.assertEqual(manifest["format"], "peft_lora")
        self.assertIn("adapter_model.safetensors", manifest["files"])
        self.assertIn("eval_report_sha256", manifest)
        self.assertEqual((manifest["kind"], manifest["format_version"]), ("final", 1))
        # The server gets the bundle's own manifest, file map included.
        self.assertEqual(complete["manifest"], manifest)

    def test_bundle_that_breaks_its_format_spec_fails_the_job(self) -> None:
        srv = self.server(jobs=[train_job()])
        self.worker(srv, StubRunner(checkpoint_at=None, manifest={"kind": "final"})).run_once()
        complete = srv.bodies("complete")[0]
        self.assertEqual(complete["status"], "failed")
        self.assertIn("manifest.json does not match manifest.schema.json", complete["error"])
        self.assertEqual(srv.bodies("uploads"), [])

    def test_resume_downloads_and_extracts_checkpoint(self) -> None:
        src = Path(self.tmp.name) / "ckpt"
        src.mkdir()
        (src / "optimizer.pt").write_bytes(b"opt")
        archive = Path(self.tmp.name) / "ckpt.tgz"
        bundle_directory(src, archive, manifest={"kind": "checkpoint"}, validate=False)
        srv = self.server(
            jobs=[
                train_job(
                    attempt=2,
                    resume={
                        "checkpoint_id": "ckpt_9",
                        "step": 10,
                        "download_url": "/blobs/objects?key=ck",
                    },
                )
            ]
        )
        srv.blobs["/blobs/objects"] = archive.read_bytes()
        runner = StubRunner(checkpoint_at=None)
        self.worker(srv, runner).run_once()
        call = runner.calls[0]
        self.assertEqual(call["resume"].step, 10)
        self.assertEqual(call["resume_files"], ["manifest.json", "optimizer.pt"])
        self.assertEqual(srv.bodies("progress")[0]["metric"]["step"], 11)
        self.assertEqual(srv.bodies("complete")[0]["attempt"], 2)

    def test_continued_training_loads_the_verified_starting_artifact(self) -> None:
        src = Path(self.tmp.name) / "sft-artifact"
        src.mkdir()
        (src / "adapter_config.json").write_text("{}")
        archive = Path(self.tmp.name) / "sft.tgz"
        info = bundle_directory(src, archive, manifest={"format": "peft_lora"}, validate=False)
        base = {"artifact_id": "sft@2026-11-27-1", "sha256": info.sha256, "download_url": "/blobs/base"}
        srv = self.server(jobs=[train_job(base=base), train_job("run_2", base={**base, "sha256": "0" * 64})])
        srv.blobs["/blobs/base"] = archive.read_bytes()
        runner = StubRunner(checkpoint_at=None)
        self.worker(srv, runner).run_once()
        call = runner.calls[0]
        self.assertEqual(call["base"].artifact_id, "sft@2026-11-27-1")
        self.assertEqual(call["base_files"], ["adapter_config.json", "manifest.json"])

        # A tampered download fails the job before any training.
        self.worker(srv, runner).run_once()
        self.assertEqual(len(runner.calls), 1)
        failed = srv.bodies("complete")[-1]
        self.assertEqual(failed["status"], "failed")
        self.assertIn("sha256", failed["error"])

    def test_cancel_from_progress_completes_cancelled_without_upload(self) -> None:
        srv = self.server(
            jobs=[train_job()],
            progress_reply=lambda n: {
                "should_stop": n >= 2,
                "stop_reason": "cancelled",
                "status": "cancelled",
            },
        )
        self.worker(srv, StubRunner(checkpoint_at=None)).run_once()
        complete = srv.bodies("complete")[0]
        self.assertEqual(complete["status"], "cancelled")
        self.assertNotIn("upload_id", complete)
        self.assertEqual(complete["tokens_processed"], 200)
        self.assertEqual(srv.bodies("uploads"), [])

    def test_budget_stop_maps_to_stopped_budget_and_uploads(self) -> None:
        for reason in ("budget", "insufficient_balance"):
            with self.subTest(reason):
                srv = self.server(
                    jobs=[train_job()],
                    progress_reply=lambda n, r=reason: {"should_stop": n >= 0, "stop_reason": r},
                )
                self.worker(srv, StubRunner(checkpoint_at=None)).run_once()
                complete = srv.bodies("complete")[0]
                self.assertEqual(complete["status"], "stopped_budget")
                # The server tells a cap stop from a balance stop by the reason we send.
                self.assertEqual(complete["stop_reason"], reason)
                self.assertIn("upload_id", complete)

    def test_heartbeat_should_stop_cancels(self) -> None:
        srv = self.server(
            jobs=[train_job()],
            heartbeat_reply=lambda n: (
                200,
                {
                    "status": "cancelled",
                    "should_stop": True,
                    "stop_reason": "cancelled",
                    "lease_expires_at": "x",
                },
            ),
        )
        self.worker(
            srv, StubRunner(steps=200, checkpoint_at=None, step_sleep=0.02)
        ).run_once()
        self.assertEqual(srv.bodies("complete")[0]["status"], "cancelled")
        self.assertLess(len(srv.bodies("progress")), 200)

    def test_lease_lost_on_heartbeat_never_completes(self) -> None:
        srv = self.server(jobs=[train_job()], heartbeat_reply=lambda n: (409, {}))
        result = self.worker(
            srv, StubRunner(steps=200, checkpoint_at=None, step_sleep=0.02)
        ).run_once()
        self.assertEqual(result, {"job_id": "run_1", "status": "lease_lost"})
        self.assertEqual(srv.bodies("complete"), [])

    def _run_until_progress(self, worker: TrainerWorker, srv: FakeProtocolServer, n: int) -> tuple[threading.Thread, dict]:
        out: dict = {}
        thread = threading.Thread(target=lambda: out.setdefault("result", worker.run_once()))
        thread.start()
        for _ in range(500):
            if len(srv.bodies("progress")) >= n:
                break
            threading.Event().wait(0.01)
        return thread, out

    def test_reclaimed_compute_saves_the_current_step_and_hands_the_run_back(self) -> None:
        srv = self.server(jobs=[train_job()])
        worker = self.worker(srv, StubRunner(steps=200, checkpoint_at=None, step_sleep=0.03))
        with contextlib.redirect_stderr(io.StringIO()):
            thread, out = self._run_until_progress(worker, srv, 3)
            worker.request_shutdown()
            worker.request_shutdown()  # a second notice changes nothing
            thread.join(10)
        progress = [b["metric"]["step"] for b in srv.bodies("progress")]
        checkpoint = srv.bodies("checkpoints")
        self.assertEqual([c["step"] for c in checkpoint], [progress[-1]])
        self.assertEqual(progress[-1], progress[0] + len(progress) - 1)
        complete = srv.bodies("complete")[0]
        self.assertEqual((complete["status"], complete["reason"]), ("abandoned", "compute_reclaimed"))
        self.assertEqual(complete["tokens_processed"], 100 * len(progress))
        self.assertEqual(out["result"]["status"], "abandoned")
        events = srv.bodies("events")
        phases = [e["phase"] for e in events if e["type"] == "phase"]
        self.assertEqual(phases, ["loading_model", "training", "checkpointing"])
        log = [e for e in events if e["type"] == "log"][0]
        self.assertIn(f"saving a checkpoint at step {progress[-1]}", log["message"])
        self.assertNotIn("spot", json.dumps(events).lower())
        self.assertNotIn("preempt", json.dumps(events).lower())

    def test_reclaimed_compute_without_time_to_save_hands_back_at_once(self) -> None:
        srv = self.server(jobs=[train_job()])
        worker = self.worker(
            srv, StubRunner(steps=50, checkpoint_at=None, step_sleep=0.4), reclaim_grace_s=0.1
        )
        with contextlib.redirect_stderr(io.StringIO()):
            thread, out = self._run_until_progress(worker, srv, 2)
            worker.request_shutdown()
            for _ in range(100):  # handed back before the running step ends
                if srv.bodies("complete"):
                    break
                threading.Event().wait(0.01)
            self.assertEqual(len(srv.bodies("progress")), 2)
            thread.join(10)
        self.assertEqual(srv.bodies("checkpoints"), [])
        complete = srv.bodies("complete")
        self.assertEqual(len(complete), 1)
        self.assertEqual((complete[0]["status"], complete[0]["reason"]), ("abandoned", "compute_reclaimed"))
        self.assertEqual(complete[0]["tokens_processed"], 200)
        self.assertEqual(out["result"]["status"], "handed_back")

    def test_reclaim_before_training_hands_back_and_crash_reports_worker_error(self) -> None:
        srv = self.server(jobs=[train_job()])
        worker = self.worker(srv)
        worker._current = state = worker_module._JobState(job_id="run_1", attempt=1)
        state.phase = "loading_model"
        worker.request_shutdown()
        for _ in range(200):
            if srv.bodies("complete"):
                break
            threading.Event().wait(0.01)
        self.assertEqual(srv.bodies("complete")[0]["reason"], "compute_reclaimed")
        self.assertEqual(worker_module._interruption(ValueError("x")), "worker_error")
        uploading = worker_module._JobState(job_id="run_2", attempt=1)
        uploading.phase = "uploading"
        worker._current = uploading
        worker.request_shutdown()
        self.assertFalse(uploading.handed_back)
        self.assertIsNotNone(uploading.reclaim_deadline)

    def test_aws_termination_notice_is_treated_like_sigterm_with_its_grace(self) -> None:
        srv = self.server(jobs=[])
        worker = self.worker(srv, termination_notice="aws")
        with mock.patch.object(worker, "request_shutdown") as shutdown:
            notices = iter([None, 90.0])
            worker._watch_aws_notice(poll_s=0.001, notice=lambda: next(notices))
        shutdown.assert_called_once_with(grace_s=85.0)
        with self.assertRaises(ValueError):
            self.worker(srv, termination_notice="gcp")

        class Resp(io.BytesIO):
            def __enter__(self):  # type: ignore[no-untyped-def]
                return self

            def __exit__(self, *_a):  # type: ignore[no-untyped-def]
                return None

        class Opener:
            def __init__(self, bodies: list[Any]) -> None:
                self.bodies = bodies

            def open(self, req, timeout):  # type: ignore[no-untyped-def]
                body = self.bodies.pop(0)
                if isinstance(body, Exception):
                    raise body
                return Resp(body)

        soon = (worker_module.datetime.now(worker_module.timezone.utc) + timedelta(seconds=120)).isoformat()
        cases = [
            ([b"tok", json.dumps({"action": "terminate", "time": soon}).encode()], 115.0),
            ([b"tok", OSError("404")], None),
            ([b"tok", b'{"action": "stop"}'], 0.0),
        ]
        for bodies, expected in cases:
            with mock.patch.object(worker_module.urllib.request, "build_opener", return_value=Opener(bodies)):
                got = worker_module.aws_termination_notice()
            if expected is None:
                self.assertIsNone(got)
            else:
                self.assertGreaterEqual(got, expected)

    def test_gpu_detection_and_env(self) -> None:
        ok = mock.Mock(return_value=mock.Mock(stdout="NVIDIA H100 80GB HBM3, 81559\n"))
        self.assertEqual(worker_module.detect_gpu(ok), {"name": "NVIDIA H100 80GB HBM3", "memory_gb": 79.6})
        self.assertIsNone(worker_module.detect_gpu(mock.Mock(side_effect=OSError("no nvidia-smi"))))
        self.assertIsNone(worker_module._gpu_from_env("none"))
        self.assertTrue(worker_module._gpu_from_env(None))
        self.assertEqual(worker_module._gpu_from_env('{"name": "L4", "memory_gb": 22.5}'), {"name": "L4", "memory_gb": 22.5})
        with self.assertRaises(ValueError):
            worker_module._gpu_from_env('{"name": "L4"}')
        srv = self.server(jobs=[train_job()])
        self.worker(srv, gpu={"name": "L4", "memory_gb": 22.5}).run_once()
        self.assertEqual(srv.bodies("claim")[0]["gpu"], {"name": "L4", "memory_gb": 22.5})

    def test_cuda_oom_hands_the_attempt_back_for_a_retry(self) -> None:
        srv = self.server(jobs=[train_job()])
        self.worker(srv, StubRunner(raise_at=3, checkpoint_at=None)).run_once()
        complete = srv.bodies("complete")[0]
        self.assertEqual(complete["status"], "abandoned")
        self.assertEqual(complete["reason"], "oom")
        self.assertEqual(complete["tokens_processed"], 200)
        warning = [e for e in srv.bodies("events") if e["type"] == "warning"]
        self.assertIn("ran out of memory", warning[0]["message"])

    def test_out_of_memory_retries_once_with_half_the_micro_batch(self) -> None:
        srv = self.server(jobs=[train_job()])
        runner = StubRunner(oom_runs=1, checkpoint_at=None)
        with contextlib.redirect_stderr(io.StringIO()) as err:
            result = self.worker(srv, runner).run_once()
        self.assertEqual(result["status"], "completed")
        self.assertEqual([c["config"].get("micro_batch_tokens") for c in runner.calls], [None, 8192])
        self.assertIn("Traceback", err.getvalue())  # the OOM is logged with its traceback
        self.assertIn("retrying job run_1 once with micro_batch_tokens=8192", err.getvalue())

    def test_out_of_memory_twice_fails_naming_model_and_gpu(self) -> None:
        srv = self.server(jobs=[train_job()])
        runner = StubRunner(oom_runs=2, checkpoint_at=None)
        with contextlib.redirect_stderr(io.StringIO()):
            self.worker(srv, runner).run_once()
        self.assertEqual(len(runner.calls), 2)
        error = srv.bodies("complete")[0]["error"]
        self.assertEqual(srv.bodies("complete")[0]["status"], "failed")
        for text in ("qwen/qwen3-8b", "micro_batch_tokens=8192", "FakeGPU (80.0 GiB)", "already retried", "min_gpu_memory_gb"):
            self.assertIn(text, error)

    def test_gpu_memory_is_released_after_every_job(self) -> None:
        srv = self.server(jobs=[train_job()])
        with mock.patch("grad_trainer.worker.release_gpu_memory") as release:
            self.worker(srv, StubRunner(checkpoint_at=None)).run_once()
        release.assert_called_once_with()

    def test_unknown_recipe_completes_failed(self) -> None:
        srv = self.server(jobs=[train_job()])
        worker = self.worker(srv)

        def factory(kind: str) -> Any:
            raise ValueError(f"Unsupported recipe kind '{kind}'")

        worker.recipe_runner_factory = factory
        worker.run_once()
        self.assertIn("Unsupported recipe kind", srv.bodies("complete")[0]["error"])

    def test_checkpoint_conflict_is_ignored(self) -> None:
        srv = self.server(jobs=[train_job()], checkpoint_status=409)
        result = self.worker(srv).run_once()
        self.assertEqual(result["status"], "completed")

    def test_transient_errors_are_retried(self) -> None:
        srv = self.server(
            jobs=[train_job()], fail_next={"claim": [503], "complete": [503, 502]}
        )
        result = self.worker(srv, StubRunner(checkpoint_at=None)).run_once()
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(srv.calls("complete")), 3)

    def test_complete_outlasts_a_server_outage_and_keeps_the_bundle(self) -> None:
        # More consecutive failures than one retry round (complete_attempts=2).
        srv = self.server(jobs=[train_job()], fail_next={"complete": [503] * 5})
        worker = self.worker(srv, StubRunner(checkpoint_at=None), complete_attempts=2)
        result = worker.run_once()
        self.assertEqual(result["status"], "completed")
        self.assertEqual(len(srv.calls("complete")), 6)
        self.assertEqual(len(set(b["upload_id"] for b in srv.bodies("complete"))), 1)

    def test_complete_stops_retrying_when_the_lease_is_lost(self) -> None:
        srv = self.server(jobs=[train_job()], fail_next={"complete": [503, 409]})
        result = self.worker(srv, StubRunner(checkpoint_at=None), complete_attempts=1).run_once()
        self.assertEqual(result["status"], "lease_lost")

    def test_unexpected_error_abandons_instead_of_dropping_the_job(self) -> None:
        # The artifact upload ticket keeps failing: the job is handed back.
        srv = self.server(jobs=[train_job()], fail_next={"uploads": [400]})
        result = self.worker(srv, StubRunner(checkpoint_at=None)).run_once()
        complete = srv.bodies("complete")[-1]
        self.assertEqual(complete["status"], "abandoned")
        self.assertEqual(complete["tokens_processed"], 300)  # the attempt is still billed
        self.assertEqual(result["status"], "abandoned")

    def test_heartbeat_retries_fast_after_a_failure(self) -> None:
        srv = self.server(jobs=[train_job()], fail_next={"heartbeat": [503]})
        worker = self.worker(
            srv, StubRunner(steps=150, checkpoint_at=None, step_sleep=0.01), heartbeat_interval_s=0.2
        )
        with mock.patch("grad_trainer.worker.random.uniform", return_value=0.05):
            worker.run_once()
        self.assertGreaterEqual(len(srv.calls("heartbeat")), 3)

    def test_sigterm_abandons_running_job(self) -> None:
        srv = self.server(jobs=[train_job()])
        worker = self.worker(
            srv,
            StubRunner(steps=500, checkpoint_at=None, step_sleep=0.01),
            poll_interval_s=0.01,
        )
        previous = signal.getsignal(signal.SIGTERM), signal.getsignal(signal.SIGINT)
        self.addCleanup(signal.signal, signal.SIGTERM, previous[0])
        self.addCleanup(signal.signal, signal.SIGINT, previous[1])
        timer = threading.Timer(0.3, os.kill, (os.getpid(), signal.SIGTERM))
        timer.start()
        self.assertEqual(worker.serve_forever(), 0)
        timer.cancel()
        complete = srv.bodies("complete")[0]
        self.assertEqual(complete["status"], "abandoned")
        self.assertEqual(len(srv.calls("claim")), 1)

    def test_auth_failure_exits_with_clear_message(self) -> None:
        srv = self.server()
        srv.api_key = "other-key"
        worker = self.worker(srv)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            code = worker.serve_forever()
        self.assertEqual(code, 2)
        self.assertIn("rejected the worker key (HTTP 401", stderr.getvalue())
        self.assertIn("TRAINER_API_KEY", stderr.getvalue())
        with self.assertRaises(WorkerAuthError):
            worker.claim()

    def test_unreachable_server_is_reported(self) -> None:
        worker = TrainerWorker(
            server_url="http://127.0.0.1:9",
            client=ProtocolClient(
                "http://127.0.0.1:9", KEY, retry_base_s=0.001, retry_cap_s=0.001
            ),
            recipes=["sft"],
            poll_interval_s=0.01,
        )
        stderr = io.StringIO()
        threading.Timer(0.2, worker.request_shutdown).start()
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(worker.serve_forever(), 0)
        self.assertIn(
            "grad-server unreachable at http://127.0.0.1:9", stderr.getvalue()
        )

    def test_redirects_are_refused(self) -> None:
        other = self.server()
        srv = self.server(redirect_claim_to=f"{other.base_url}/v1/trainer-jobs/claim")
        with self.assertRaises(ServerError) as ctx:
            self.worker(srv).claim()
        self.assertEqual(ctx.exception.code, "redirect")
        self.assertEqual(other.requests, [])

    def test_foreign_origin_urls_get_no_authorization(self) -> None:
        storage = self.server()
        storage.blobs["/data.jsonl"] = DATASET
        srv = self.server(
            jobs=[train_job(dataset_url=f"{storage.base_url}/data.jsonl")],
            upload_origin=storage.base_url,
        )
        result = self.worker(srv, StubRunner(checkpoint_at=None)).run_once()
        self.assertEqual(result["status"], "completed")
        foreign = [r for r in storage.requests if r.method in ("GET", "PUT")]
        self.assertEqual({r.method for r in foreign}, {"GET", "PUT"})
        self.assertTrue(all("authorization" not in r.headers for r in foreign))
        self.assertTrue(
            all(r.headers.get("authorization") == f"Bearer {KEY}" for r in srv.requests)
        )

    def test_storage_errors_never_quote_presigned_credentials(self) -> None:
        # r8 P2-20: a failed presigned download posted its full URL and the S3 error XML.
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        class Storage(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:
                return

            def do_GET(self) -> None:
                body = b"<Error><AWSAccessKeyId>AKIAEXAMPLE</AWSAccessKeyId></Error>"
                self.send_response(403)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Storage)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        url = f"http://127.0.0.1:{httpd.server_address[1]}/bucket/blob?X-Amz-Credential=ASIA1&X-Amz-Security-Token=TOKEN1&X-Amz-Signature=SIG1"
        client = ProtocolClient("http://grad-api.invalid:8787", KEY)
        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(ServerError) as ctx:
            client.download(url, Path(tmp) / "x", attempts=1)
        message = str(ctx.exception)
        self.assertIn("HTTP 403", message)
        self.assertIn("/bucket/blob", message)
        for leaked in ("ASIA1", "TOKEN1", "SIG1", "X-Amz", "AKIAEXAMPLE", "<Error>"):
            self.assertNotIn(leaked, message)
        with tempfile.TemporaryDirectory() as tmp, self.assertRaises(Exception) as ctx:
            client.download("http://127.0.0.1:9/x?X-Amz-Signature=SIG2", Path(tmp) / "x", attempts=1)
        self.assertNotIn("SIG2", str(ctx.exception))

    def test_import_upload_job_posts_batches_and_summary(self) -> None:
        srv = self.server(
            jobs=[
                import_job(
                    {
                        "kind": "upload",
                        "upload_id": "upl_x",
                        "format": "jsonl",
                        "download_url": "/blobs/objects?key=raw",
                    }
                )
            ]
        )
        srv.blobs["/blobs/objects"] = b'{"a": 1}\n'
        # The first batch's response is lost after the server stored it: the
        # worker re-posts the same batch (same seq), which the server dedupes.
        srv.fail_next["records"] = [0]
        importer = StubImporter(batches=2, batch_size=3)
        result = self.worker(srv, importer=importer).run_once()
        self.assertEqual(result["status"], "completed")
        self.assertEqual(importer.sources[0]["kind"], "file")
        self.assertEqual(importer.sources[0]["format"], "jsonl")
        self.assertEqual(importer.sources[0]["content"], b'{"a": 1}\n')
        self.assertIsNone(importer.sources[0]["connector"])
        self.assertEqual([len(b["records"]) for b in srv.bodies("records")], [3, 3, 3])
        self.assertEqual([b["seq"] for b in srv.bodies("records")], [0, 0, 1])
        complete = srv.bodies("complete")[0]
        self.assertEqual(
            complete["import_summary"],
            {
                "dropped_count": 1,
                "drop_reasons": ["line 4: invalid JSON (Expecting value)"],
            },
        )

    def test_import_hf_source_passes_through_and_chunks(self) -> None:
        hf = {
            "kind": "hf",
            "repo": "openai/gsm8k",
            "split": "train",
            "config": "main",
            "columns": {"prompt": "question"},
            "limit": 5,
        }
        srv = self.server(jobs=[import_job(hf)])
        importer = StubImporter(batches=1, batch_size=10_001)
        self.worker(srv, importer=importer).run_once()
        self.assertEqual(importer.sources[0]["repo"], "openai/gsm8k")
        self.assertEqual(
            [len(b["records"]) for b in srv.bodies("records")], [10_000, 1]
        )
        self.assertEqual([b["seq"] for b in srv.bodies("records")], [0, 1])

    def test_gradiated_source_sync_pages_through_the_server_and_reports_the_watermark(self) -> None:
        from grad_trainer import import_runner

        trace = {"type": "trace", "trace_id": "t1", "messages": [{"role": "user", "content": "q"}], "metadata": {"model": "m"}}
        score = {"type": "score", "trace_id": "t1", "name": "thumbs", "value": 1, "updated_at": "2026-11-27T10:00:00Z"}
        srv = self.server(jobs=[import_job({"kind": "provider", "provider": "gradiated", "watermark": {"traces": "c0", "scores": "c0"}})])
        page = {"records": [trace, score], "cursor": "c1", "has_more": False}
        srv.source_pages = [page, page]  # one pass for traces, one for scores
        result = self.worker(srv, importer=import_runner).run_once()
        self.assertEqual(result["status"], "completed")
        self.assertEqual([b["cursor"] for b in srv.bodies("source-page")], ["c0", "c0"])
        self.assertTrue(all(b["attempt"] == 1 and b["worker_id"].startswith("w-test-") for b in srv.bodies("source-page")))
        records = [r for b in srv.bodies("records") for r in b["records"]]
        self.assertEqual([r["id"] for r in records], ["t1", "t1"])
        self.assertEqual(srv.bodies("complete")[0]["import_summary"]["watermark"], {"traces": "c1", "scores": "c1"})

    def test_failed_sync_never_echoes_the_secret(self) -> None:
        class Leaky:
            def run(self, source, connector, *, emit_batch, workdir, source_page=None):  # type: ignore[no-untyped-def]
                raise RuntimeError(f"auth failed for {source['secret']} (public {source['secret'].split(':')[0]})")

        srv = self.server(jobs=[import_job({"kind": "provider", "provider": "langfuse", "secret": "pk-lf-abcd:sk-lf-wxyz"})])
        result = self.worker(srv, importer=Leaky()).run_once()
        self.assertEqual(result["status"], "failed")
        error = srv.bodies("complete")[0]["error"]
        self.assertNotIn("sk-lf-wxyz", error)
        self.assertNotIn("pk-lf-abcd", error)
        self.assertIn("auth failed for ***", error)

    def test_training_merges_score_updates_into_their_records(self) -> None:
        storage_lines = [
            {"id": "t1", "messages": [{"role": "user", "content": "q"}], "scores": {"thumbs": 0.0}},
            {"id": "t1", "scores": {"thumbs": 1.0}, "metadata": {"score_update": True}},
        ]
        srv = self.server(jobs=[train_job(dataset_url="/blobs/data")])
        # One gzip member per stored part, back to back, as grad-server streams them.
        srv.blobs["/blobs/data"] = b"".join(gzip.compress(f"{json.dumps(r)}\n".encode()) for r in storage_lines)
        runner = StubRunner(checkpoint_at=None)
        self.worker(srv, runner).run_once()
        self.assertEqual(runner.calls[0]["records"], [{"id": "t1", "messages": [{"role": "user", "content": "q"}], "scores": {"thumbs": 1.0}}])

    def test_an_uncompressed_dataset_download_fails_setup(self) -> None:
        srv = self.server(jobs=[train_job(dataset_url="/blobs/data")])
        srv.blobs["/blobs/data"] = b'{"messages":[{"role":"user","content":"hi"}]}\n'
        runner = StubRunner(checkpoint_at=None)
        result = self.worker(srv, runner).run_once()
        self.assertEqual(result["status"], "failed")
        self.assertIn("setup failed", srv.bodies("complete")[0]["error"])
        self.assertEqual(runner.calls, [])

    def test_kinds_from_the_environment(self) -> None:
        srv = self.server()
        worker = worker_from_env(
            {"GRAD_SERVER_URL": srv.base_url, "TRAINER_API_KEY": KEY, "GRAD_WORKER_KINDS": " import, "}
        )
        self.assertEqual(worker.kinds, ["import"])
        self.assertIsNone(worker.claim())
        self.assertEqual(json.loads(srv.calls("claim")[0].body)["kinds"], ["import"])
        self.assertEqual(worker_from_env({"GRAD_SERVER_URL": srv.base_url}).kinds, ["train", "import"])
        with self.assertRaisesRegex(ValueError, "subset of train, import"):
            worker_from_env({"GRAD_WORKER_KINDS": "train,eval"})

    def test_two_processes_with_one_configured_id_hold_distinct_leases(self) -> None:
        # r8 B7: twins (or a restart) sharing GRAD_WORKER_ID must not share a lease.
        a = worker_from_env({"GRAD_SERVER_URL": "http://x", "GRAD_WORKER_ID": "pod-0"})
        b = worker_from_env({"GRAD_SERVER_URL": "http://x", "GRAD_WORKER_ID": "pod-0"})
        self.assertNotEqual(a.worker_id, b.worker_id)
        self.assertTrue(a.worker_id.startswith("pod-0-") and b.worker_id.startswith("pod-0-"))
        self.assertLessEqual(len(worker_from_env({"GRAD_SERVER_URL": "http://x", "GRAD_WORKER_ID": "p" * 160}).worker_id), 160)

    def test_idle_claim_returns_none(self) -> None:
        srv = self.server()
        self.assertIsNone(self.worker(srv).run_once())
        self.assertRegex(json.loads(srv.calls("claim")[0].body)["worker_id"], r"^w-test-[0-9a-f]{6}$")


if __name__ == "__main__":
    unittest.main()
