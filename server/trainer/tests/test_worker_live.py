"""Live protocol test: TrainerWorker against a real server/api process."""

from __future__ import annotations

import hashlib
import json
import os
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

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


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _http(
    url: str, method: str = "GET", payload: dict | None = None
) -> tuple[int, bytes, dict]:
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.status, resp.read(), dict(resp.headers)


class LiveWorkerTest(unittest.TestCase):
    def test_worker_trains_and_publishes_artifact_against_live_server(self) -> None:
        api_dir = Path(__file__).resolve().parents[2] / "api"
        tsx_bin = api_dir / "node_modules" / ".bin" / "tsx"
        if not tsx_bin.exists():
            self.skipTest("server/api node_modules not installed")

        tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(tmp.cleanup)
        log_path = Path(tmp.name) / "server.log"
        port = _free_port()
        env = {
            **os.environ,
            "PORT": str(port),
            "HOST": "127.0.0.1",
            "AUTH_MODE": "none",
            "DEPLOY_MODE": "disabled",
            "STORAGE_DIR": str(Path(tmp.name) / "storage"),
            "GRAD_EXTRA_MODELS_JSON": json.dumps(TINY_MODELS),
            "EVAL_EXECUTOR": "false",
        }
        with log_path.open("wb") as log:
            proc = subprocess.Popen(
                [str(tsx_bin), "src/main.ts"],
                cwd=str(api_dir),
                env=env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        self.addCleanup(proc.wait, 10)
        self.addCleanup(proc.terminate)
        base = f"http://127.0.0.1:{port}"
        try:
            self._wait_ready(base, proc)
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
                workdir=Path(tmp.name) / "work",
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
            print(log_path.read_text(errors="replace")[-4000:])
            raise

    def _wait_ready(self, base: str, proc: subprocess.Popen) -> None:
        deadline = time.time() + 30
        while time.time() < deadline:
            if proc.poll() is not None:
                raise RuntimeError("grad-server exited during startup")
            try:
                if _http(f"{base}/health/ready")[0] == 200:
                    return
            except Exception:
                time.sleep(0.2)
        raise RuntimeError("grad-server did not become ready")


if __name__ == "__main__":
    unittest.main()
