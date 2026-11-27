"""Chaos test: SIGTERM a real worker mid-run (its GPU is being reclaimed).

The worker saves a checkpoint of the step it is on, hands the attempt back
(`abandoned`, `compute_reclaimed`) and exits; a fresh worker resumes from that
exact step. Invariants: the right attempt events, no lost or repeated steps,
and the run is billed for exactly the tokens an uninterrupted run uses.

Only the worker processes this test started are signalled.
"""

from __future__ import annotations

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
TERMINAL = {"completed", "failed", "cancelled", "stopped_budget", "stopped_balance"}
GPU = {"name": "NVIDIA H100 80GB HBM3", "memory_gb": 79.6}


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


class ReclaimLiveTest(unittest.TestCase):
    def setUp(self) -> None:
        self.server = LiveServer(self)
        self.api = self.server.base
        self.workers: list[subprocess.Popen[bytes]] = []
        self.addCleanup(self._stop_workers)

    def _stop_workers(self) -> None:
        for proc in self.workers:
            if proc.poll() is None:
                proc.kill()
                proc.wait(10)

    def start_worker(self, tag: str) -> subprocess.Popen[bytes]:
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
                "GRAD_WORKER_ID": f"reclaim-{tag}",
                "GRAD_WORKER_GPU": json.dumps(GPU),
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

    def events(self, run_id: str) -> list[dict[str, Any]]:
        out, cursor = [], None
        for _ in range(100):
            page = self.get(f"/v1/runs/{run_id}/events?limit=1000" + (f"&cursor={cursor}" if cursor else ""))
            out += page["data"]
            cursor = page["next_cursor"]
            if not cursor:
                return out
        self.fail("events pagination did not end")

    def new_run(self, name: str) -> str:
        body = {"dataset": "reclaim", "name": name, "recipe": {"kind": "sft", "model": "test/tiny-qwen3", "batch_size": 1, "epochs": 4}}
        status, raw, _ = http(f"{self.api}/v1/runs", "POST", body)
        self.assertEqual(status, 202)
        return str(json.loads(raw)["id"])

    def test_sigterm_saves_the_current_step_and_a_new_worker_resumes_from_it(self) -> None:
        http(f"{self.api}/v1/datasets/reclaim/records", "POST", {"records": records(60)})
        first = self.start_worker("a")
        control = self.wait_run(self.new_run("control"))
        self.assertEqual(control["status"], "completed")

        run_id = self.new_run("reclaimed")
        deadline = time.time() + 60
        while len(self.get(f"/v1/runs/{run_id}/checkpoints")["data"]) < 2 and time.time() < deadline:
            time.sleep(0.05)
        first.send_signal(signal.SIGTERM)
        self.assertEqual(first.wait(30), 0, "the worker exits cleanly after handing the run back")

        handed_back = self.get(f"/v1/runs/{run_id}")
        self.assertEqual((handed_back["status"], handed_back["attempt"]), ("queued", 1))
        last_step = max(e["step"] for e in self.events(run_id) if e["type"] == "metric")
        checkpoints = self.get(f"/v1/runs/{run_id}/checkpoints?limit=100")["data"]
        self.assertEqual(max(c["step"] for c in checkpoints), last_step, "emergency checkpoint at the current step")
        interruption = handed_back["last_interruption"]
        self.assertEqual(
            (interruption["attempt"], interruption["reason"], interruption["step"], interruption["resume_step"]),
            (1, "compute_reclaimed", last_step, last_step),
        )
        self.assertEqual(handed_back["phase"], "queued")

        self.start_worker("b")
        final = self.wait_run(run_id)
        self.assertEqual((final["status"], final["attempt"]), ("completed", 2), final)

        events = self.events(run_id)
        attempts = [(e["event"], e["attempt"], e["reason"], e["resume_step"]) for e in events if e["type"] == "attempt"]
        self.assertEqual(
            attempts,
            [
                ("started", 1, None, None),
                ("interrupted", 1, "compute_reclaimed", last_step),
                ("started", 2, None, last_step),
            ],
        )
        starting = [e for e in events if e["type"] == "phase" and e["phase"] == "starting"]
        self.assertEqual([e["gpu"] for e in starting], [GPU, GPU])
        logs = [e["message"] for e in events if e["type"] in ("log", "warning")]
        self.assertTrue(any(f"step {last_step}" in m for m in logs), [(e["type"], e.get("phase") or e.get("event"), e.get("step"), e["attempt"]) for e in events if e["type"] != "metric"])
        self.assertEqual(events[-1]["type"], "completed")
        text = json.dumps(events).lower()
        self.assertNotIn("spot", text)
        self.assertNotIn("preempt", text)

        # No step lost or repeated, and billed exactly like the uninterrupted run.
        steps = [e["step"] for e in events if e["type"] == "metric"]
        self.assertEqual(steps, list(range(1, len(steps) + 1)))
        self.assertEqual(final["tokens_processed"], control["tokens_processed"])
        self.assertAlmostEqual(final["cost_usd"], control["cost_usd"], places=9)
        usage = [u for u in self.get("/v1/usage?limit=200")["data"] if u["ref_id"] == run_id]
        self.assertEqual(sum(u["tokens_through"] - u["tokens_from"] for u in usage), control["tokens_processed"])
        self.assertEqual({u["attempt"] for u in usage}, {1, 2})


if __name__ == "__main__":
    unittest.main()
