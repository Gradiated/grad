"""Chaos test: real workers and two API replicas on one Postgres, through a fault proxy.

The proxy (tests/harness/fault-proxy.ts) cuts every few worker POST responses
after the server committed them (the lost ack), and fails over from a dead
replica. Mid-run, the worker and one API replica are killed with SIGKILL; a
fresh worker finishes the run. Invariants: the run completes on exactly one
more attempt, it is billed for the tokens it really processed (no checkpoint
prefix billed twice), one metric per (attempt, step), and an import through
the same proxy stores each record once.

Only processes this test started are killed (the worker it spawns, and the
replica PID its own stack reports).
"""

from __future__ import annotations

import hashlib
import json
import os
import signal
import subprocess
import sys
import time
import unittest
from pathlib import Path
from typing import Any

from fixtures.live_server import LiveServer, http, http_json

TRAINER_DIR = Path(__file__).resolve().parents[1]
TERMINAL = {"completed", "failed", "cancelled", "stopped_budget"}


def records(n: int) -> list[dict[str, Any]]:
    return [
        {
            "messages": [
                {"role": "user", "content": f"question {i} about topic {i % 7} alpha beta"},
                {"role": "assistant", "content": f"answer {i} delta {i % 5}"},
            ]
        }
        for i in range(n)
    ]


class ChaosLiveTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = LiveServer(self, "--replicas", "2", "--drop-worker-ack-every", "4")
        self.api = self.server.info["replicas"][1]["url"]  # the replica that survives
        self.workers: list[subprocess.Popen[bytes]] = []
        self.addCleanup(self._stop_workers)

    def _stop_workers(self) -> None:
        for proc in self.workers:
            if proc.poll() is None:
                proc.kill()
                proc.wait(10)

    def start_worker(self, tag: str, worker_id: str | None = None) -> subprocess.Popen[bytes]:
        log = (self.server.dir / f"worker-{tag}.log").open("wb")
        self.addCleanup(log.close)
        proc = subprocess.Popen(
            [sys.executable, "-m", "grad_trainer.worker"],
            cwd=TRAINER_DIR,
            env={
                **os.environ,
                "PYTHONPATH": ".",
                "GRAD_SERVER_URL": self.server.info["worker_url"],
                "GRAD_TRAINER_BACKEND": "reference",
                "GRAD_LEASE_SECONDS": "30",
                "GRAD_POLL_INTERVAL_S": "0.2",
                "GRAD_WORKER_ID": worker_id or f"chaos-{tag}",
                "GRAD_WORKDIR": str(self.server.dir / f"work-{tag}"),
                "HF_HUB_OFFLINE": "1",
            },
            stdout=log,
            stderr=log,
        )
        self.workers.append(proc)
        return proc

    def get(self, path: str) -> Any:
        return http_json(f"{self.api}{path}")

    def wait_run(self, run_id: str, timeout: float = 180) -> dict[str, Any]:
        deadline = time.time() + timeout
        while time.time() < deadline:
            run = self.get(f"/v1/runs/{run_id}")
            if run["status"] in TERMINAL:
                return run
            time.sleep(0.3)
        self.fail(f"run {run_id} did not finish: {run}\n{self.server.log_tail()}")

    def all_metrics(self, run_id: str) -> list[dict[str, Any]]:
        points, cursor = [], None
        for _ in range(100):
            page = self.get(f"/v1/runs/{run_id}/metrics?limit=500" + (f"&cursor={cursor}" if cursor else ""))
            points += page["data"]
            cursor = page["next_cursor"]
            if not cursor:
                return points
        self.fail("metrics pagination did not end")

    def new_run(self, name: str) -> str:
        body = {"dataset": "chaos", "name": name, "recipe": {"kind": "sft", "model": "test/tiny-qwen3", "batch_size": 1, "epochs": 4}}
        status, raw, _ = http(f"{self.api}/v1/runs", "POST", body)
        self.assertEqual(status, 202)
        return str(json.loads(raw)["id"])

    def test_kill9_worker_and_replica_mid_run_with_lost_acks(self) -> None:
        http(f"{self.api}/v1/datasets/chaos/records", "POST", {"records": records(60)})
        worker = self.start_worker("a")

        # An import through the lossy proxy stores every record exactly once.
        blob = "".join(json.dumps(r) + "\n" for r in records(25)).encode()
        upload = http_json(
            f"{self.api}/v1/uploads",
            "POST",
            {"purpose": "dataset_import", "filename": "x.jsonl", "size_bytes": len(blob), "sha256": hashlib.sha256(blob).hexdigest()},
        )
        http(self.api + upload["url"] if upload["url"].startswith("/") else upload["url"], "PUT", data=blob, headers=upload["headers"])
        imp = http_json(f"{self.api}/v1/datasets/imported/imports", "POST", {"source": {"kind": "upload", "upload_id": upload["upload_id"], "format": "jsonl"}})

        control = self.wait_run(self.new_run("control"))
        self.assertEqual(control["status"], "completed")
        deadline = time.time() + 60
        while self.get(f"/v1/imports/{imp['id']}")["status"] not in ("completed", "failed") and time.time() < deadline:
            time.sleep(0.3)
        self.assertEqual(self.get(f"/v1/imports/{imp['id']}")["status"], "completed")
        self.assertEqual(self.get("/v1/datasets/imported")["record_count"], 25)

        # The chaos run: kill -9 the worker after two checkpoints, then a replica.
        run_id = self.new_run("chaos")
        deadline = time.time() + 60
        while len(self.get(f"/v1/runs/{run_id}/checkpoints")["data"]) < 2 and time.time() < deadline:
            time.sleep(0.05)
        worker.send_signal(signal.SIGKILL)
        worker.wait(10)
        os.kill(int(self.server.info["replicas"][0]["pid"]), signal.SIGKILL)
        time.sleep(1)

        at_kill = self.get(f"/v1/runs/{run_id}")
        self.assertEqual((at_kill["status"], at_kill["attempt"]), ("running", 1))
        resume_step = max(c["step"] for c in self.get(f"/v1/runs/{run_id}/checkpoints?limit=100")["data"])
        tokens_at_resume = next(m["tokens"] for m in self.all_metrics(run_id) if m["step"] == resume_step)

        self.start_worker("b")
        final = self.wait_run(run_id)
        self.assertEqual(final["status"], "completed", final)
        # (On a failure, last_interruption and the stack log say why another attempt started.)
        self.assertEqual(final["attempt"], 2, f"{final.get('last_interruption')}\n{self.server.log_tail()}")
        # Billed: attempt 1 as reported up to the kill, plus attempt 2 from the
        # checkpoint on. The checkpoint prefix is never billed twice.
        expected = at_kill["tokens_processed"] + control["tokens_processed"] - tokens_at_resume
        self.assertEqual(final["tokens_processed"], expected)
        self.assertLess(final["tokens_processed"] - control["tokens_processed"], control["tokens_processed"] * 0.2)
        self.assertAlmostEqual(final["cost_usd"], final["tokens_processed"] * final["price_per_million_tokens"] / 1e6, places=6)

        points = self.all_metrics(run_id)
        keys = [(m["attempt"], m["step"]) for m in points]
        self.assertEqual(len(keys), len(set(keys)), "a metric was stored twice")
        self.assertEqual(len(self.get("/v1/artifacts?name=chaos")["data"]), 1)
        stats = http_json(f"{self.server.info['worker_url']}/__fault/stats")
        self.assertGreater(stats["droppedWorkerAcks"], 0)
        self.assertGreater(stats["failovers"], 0)

    def test_restart_with_the_same_worker_id_takes_a_new_billed_attempt(self) -> None:
        # r8 B6: Helm names a worker after its pod and compose hard-codes one, so a
        # restarted process keeps GRAD_WORKER_ID. It must not re-enter its old
        # attempt (that dropped the checkpoint prefix from the bill, -17.5%).
        http(f"{self.api}/v1/datasets/chaos/records", "POST", {"records": records(60)})
        worker = self.start_worker("a", worker_id="chaos-fixed")
        control = self.wait_run(self.new_run("control"))
        run_id = self.new_run("restart")
        deadline = time.time() + 60
        while len(self.get(f"/v1/runs/{run_id}/checkpoints")["data"]) < 2 and time.time() < deadline:
            time.sleep(0.05)
        worker.send_signal(signal.SIGKILL)
        worker.wait(10)
        time.sleep(1)
        at_kill = self.get(f"/v1/runs/{run_id}")
        resume_step = max(c["step"] for c in self.get(f"/v1/runs/{run_id}/checkpoints?limit=100")["data"])
        tokens_at_resume = next(m["tokens"] for m in self.all_metrics(run_id) if m["step"] == resume_step)

        self.start_worker("b", worker_id="chaos-fixed")
        final = self.wait_run(run_id)
        self.assertEqual((final["status"], final["attempt"]), ("completed", 2), final)
        self.assertEqual(final["tokens_processed"], at_kill["tokens_processed"] + control["tokens_processed"] - tokens_at_resume)


if __name__ == "__main__":
    unittest.main()
