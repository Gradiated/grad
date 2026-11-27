"""Chaos test for the eval worker (``grad-server worker --kinds eval``).

Two API replicas on one Postgres, behind the fault proxy that cuts every few
worker POST responses after the server committed them. Mid-eval, one API
replica is killed with SIGKILL: the eval finishes on its first attempt. Then
the eval worker itself is killed with SIGKILL mid-eval; a fresh eval worker
resumes it on the next attempt. Invariants: every (model, task, sample) output
is stored once, and the usage ledger bills exactly the tokens of the stored
outputs, per attempt.

Only processes this test's own stack reports (or it spawns) are killed.
"""

from __future__ import annotations

import os
import signal
import subprocess
import time
import unittest
from typing import Any

from fixtures.live_server import API_DIR, LiveServer, http_json

TERMINAL = {"completed", "failed", "cancelled"}


class EvalChaosLiveTest(unittest.TestCase):
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

    def start_eval_worker(self, tag: str) -> subprocess.Popen[bytes]:
        log = (self.server.dir / f"eval-worker-{tag}.log").open("wb")
        self.addCleanup(log.close)
        proc = subprocess.Popen(
            [os.environ.get("NODE", "node"), "--import", "tsx", "src/main.ts", "worker", "--kinds", "eval"],
            cwd=API_DIR,
            env={
                **os.environ,
                "GRAD_SERVER_URL": self.server.info["worker_url"],
                "GRAD_WORKER_ID": f"chaos-eval-{tag}",
                "GRAD_LEASE_SECONDS": "30",
                "GRAD_POLL_INTERVAL_S": "0.2",
                "GRAD_INFERENCE_BASE_URL": self.server.info["inference_url"],
            },
            stdout=log,
            stderr=log,
        )
        self.workers.append(proc)
        return proc

    def get(self, path: str) -> Any:
        return http_json(f"{self.api}{path}")

    def paged(self, path: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        cursor = None
        for _ in range(100):
            sep = "&" if "?" in path else "?"
            page = self.get(f"{path}{sep}limit=200" + (f"&cursor={cursor}" if cursor else ""))
            rows += page["data"]
            cursor = page["next_cursor"]
            if not cursor:
                return rows
        self.fail(f"{path}: pagination did not end")

    def new_eval(self, name: str) -> dict[str, Any]:
        return http_json(
            f"{self.api}/v1/evals",
            "POST",
            {"name": name, "models": ["qwen/qwen3-8b", "qwen/qwen3-1.7b"], "dataset": "chaos-evals", "samples": 2},
        )

    def wait_generated(self, eval_id: str, at_least: int) -> None:
        deadline = time.time() + 60
        while time.time() < deadline:
            ev = self.get(f"/v1/evals/{eval_id}")
            if ev["progress"]["generated"] >= at_least or ev["status"] in TERMINAL:
                return
            time.sleep(0.05)
        self.fail(f"eval {eval_id} made no progress:\n{self.server.log_tail()}")

    def wait_eval(self, eval_id: str, timeout: float = 150) -> dict[str, Any]:
        deadline = time.time() + timeout
        while time.time() < deadline:
            ev = self.get(f"/v1/evals/{eval_id}")
            if ev["status"] in TERMINAL:
                return ev
            time.sleep(0.3)
        self.fail(f"eval {eval_id} did not finish: {ev}\n{self.server.log_tail()}")

    def assert_exact(self, ev: dict[str, Any], attempts: set[int]) -> None:
        total = ev["progress"]["total_outputs"]
        outputs = self.paged(f"/v1/evals/{ev['id']}/outputs")
        keys = {(o["model"], o["task_id"], o["sample_index"]) for o in outputs}
        self.assertEqual(len(outputs), total, "one output per (model, task, sample)")
        self.assertEqual(len(keys), total, "no duplicate outputs")
        stored = sum(o["usage"]["prompt_tokens"] + o["usage"]["completion_tokens"] for o in outputs)
        usage = self.paged(f"/v1/usage?eval_id={ev['id']}")
        self.assertEqual({u["attempt"] for u in usage}, attempts)
        self.assertEqual(sum(u["tokens"] for u in usage), stored, "billed exactly the stored outputs' tokens")
        self.assertAlmostEqual(sum(u["cost_usd"] for u in usage), ev["total_cost_usd"], places=6)

    def test_kill9_api_replica_then_the_eval_worker_mid_eval(self) -> None:
        records = [
            {
                "messages": [
                    {"role": "user", "content": f"question {i} [delay 60ms]"},
                    {"role": "assistant", "content": f"answer {i}"},
                ]
            }
            for i in range(24)
        ]
        http_json(f"{self.api}/v1/datasets/chaos-evals/records", "POST", {"records": records})

        # An API replica dies mid-eval: the worker's requests fail over and the
        # eval finishes on its first attempt.
        first = self.new_eval("replica-killed")
        self.wait_generated(first["id"], 10)
        os.kill(self.server.info["replicas"][0]["pid"], signal.SIGKILL)
        done = self.wait_eval(first["id"])
        self.assertEqual(done["status"], "completed", done.get("error"))
        self.assert_exact(done, {1})

        # The eval worker dies (SIGKILL) mid-eval: its lease expires and a fresh
        # worker resumes after the outputs already stored.
        second = self.new_eval("worker-killed")
        self.wait_generated(second["id"], 10)
        os.kill(self.server.info["eval_worker_pid"], signal.SIGKILL)
        stalled = self.get(f"/v1/evals/{second['id']}")
        self.assertEqual(stalled["status"], "running")
        self.assertLess(stalled["progress"]["generated"], stalled["progress"]["total_outputs"])
        self.start_eval_worker("b")
        resumed = self.wait_eval(second["id"])
        self.assertEqual(resumed["status"], "completed", resumed.get("error"))
        self.assertIsNone(resumed["error"])
        self.assert_exact(resumed, {1, 2})


if __name__ == "__main__":
    unittest.main()
