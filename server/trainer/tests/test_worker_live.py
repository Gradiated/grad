"""Live protocol test: TrainerWorker against a real server/api process."""

from __future__ import annotations

import hashlib
import json
import unittest
import urllib.request
from pathlib import Path

from fixtures.live_server import LiveServer, http as _http
from fixtures.stub_runners import StubRunner

from grad_trainer.worker import TrainerWorker

TINY_MODELS = [
    {
        "id": "test/tiny-qwen3",
        "hf_repo": None,
        "family": "llm",
        "adapters": ["lora"],
        "default_for": [],
        "price_per_million_tokens_usd": 1,
        "max_context_tokens": 2048,
        "template_revision": "qwen3@3",
        "calibrated_lrs": {"sft": 1e-3},
    }
]


class LiveWorkerTest(unittest.TestCase):
    def test_worker_trains_and_publishes_artifact_against_live_server(self) -> None:
        server = LiveServer(self, TINY_MODELS)
        base = server.base
        tmp_dir = server.dir
        try:
            records = [
                {
                    "session_id": f"s{i}",
                    "messages": [
                        {"role": "user", "content": f"q{i}"},
                        {"role": "assistant", "content": f"a{i}"},
                    ],
                }
                for i in range(8)
            ]
            _http(f"{base}/v1/datasets/live/records", "POST", {"records": records})
            status, body, _ = _http(
                f"{base}/v1/runs",
                "POST",
                {
                    "dataset": "live",
                    "name": "live-sft",
                    "recipe": {
                        "kind": "sft",
                        "model": "test/tiny-qwen3",
                        "batch_size": 1,
                    },
                },
            )
            self.assertEqual(status, 202)
            run_id = json.loads(body)["id"]

            runner = StubRunner(steps=3, checkpoint_at=2)
            worker = TrainerWorker(
                server_url=base,
                worker_id="live-worker",
                workdir=tmp_dir / "work",
                recipe_runner_factory=lambda _kind: runner,
                recipes=["sft"],
            )
            result = worker.run_once()
            self.assertIsNotNone(result)
            self.assertEqual(len(runner.calls[0]["records"]), 8)

            _, body, _ = _http(f"{base}/v1/runs/{run_id}")
            run = json.loads(body)
            self.assertEqual(run["status"], "completed")
            self.assertGreater(run["cost_usd"], 0)
            artifact_id = run["artifact_id"]

            _, body, _ = _http(
                f"{base}/v1/artifacts/{urllib.request.quote(artifact_id)}"
            )
            artifact = json.loads(body)
            _, blob, headers = _http(
                f"{base}/v1/artifacts/{urllib.request.quote(artifact_id)}/download"
            )
            self.assertEqual(hashlib.sha256(blob).hexdigest(), artifact["sha256"])
            self.assertEqual(headers.get("X-Artifact-Sha256"), artifact["sha256"])

            _, body, _ = _http(f"{base}/v1/runs/{run_id}/checkpoints")
            self.assertEqual([c["step"] for c in json.loads(body)["data"]], [2])
        except Exception:
            print(server.log_tail())
            raise


if __name__ == "__main__":
    unittest.main()
