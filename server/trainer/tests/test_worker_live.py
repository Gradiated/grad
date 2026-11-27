"""Live HTTP E2E test: TrainerWorker running against a real server/api process."""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

from grad_trainer.bundles import read_artifact_bundle
from grad_trainer.worker import TrainerWorker


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _http_json(
    url: str, method: str = "GET", payload: dict | None = None
) -> tuple[int, dict]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if data is not None else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


class LiveWorkerE2ETest(unittest.TestCase):
    def test_worker_claims_trains_and_publishes_artifact_against_live_server(
        self,
    ) -> None:
        repo_root = Path(__file__).resolve().parents[3]
        api_dir = repo_root / "server" / "api"
        tsx_bin = api_dir / "node_modules" / ".bin" / "tsx"
        if not tsx_bin.exists():
            self.skipTest("server/api node_modules not installed")

        port = _free_port()
        storage_dir = tempfile.mkdtemp(prefix="grad-trainer-e2e-")
        env = {
            **os.environ,
            "PORT": str(port),
            "HOST": "127.0.0.1",
            "AUTH_MODE": "none",
            "DEPLOY_MODE": "local",
            "STORAGE_DIR": storage_dir,
        }
        proc = subprocess.Popen(
            [str(tsx_bin), "src/main.ts"],
            cwd=str(api_dir),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        base_url = f"http://127.0.0.1:{port}"
        try:
            deadline = time.time() + 15.0
            while time.time() < deadline:
                try:
                    status, _ = _http_json(f"{base_url}/health/ready")
                    if status == 200:
                        break
                except Exception:
                    time.sleep(0.15)
            else:
                raise RuntimeError("grad-server did not become ready in time")

            # Push dataset
            records = [
                {
                    "session_id": f"s_{i}",
                    "messages": [
                        {"role": "user", "content": f"Question {i}"},
                        {"role": "assistant", "content": f"Answer {i}"},
                    ],
                }
                for i in range(6)
            ]
            status, ds = _http_json(
                f"{base_url}/v1/datasets/live-sft/records",
                method="POST",
                payload={"records": records},
            )
            self.assertEqual(status, 200)
            self.assertEqual(ds["record_count"], 6)

            # Enqueue SFT run
            status, run = _http_json(
                f"{base_url}/v1/runs",
                method="POST",
                payload={
                    "dataset": "live-sft",
                    "name": "live-sft-model",
                    "recipe": {"kind": "sft", "batch_size": 2, "epochs": 1},
                },
            )
            self.assertEqual(status, 202)
            run_id = run["id"]

            # Execute single worker cycle
            worker = TrainerWorker(server_url=base_url, worker_id="test-worker-1")
            completed = worker.run_once()
            self.assertIsNotNone(completed)
            assert completed is not None
            self.assertEqual(completed["run"]["status"], "completed")
            artifact_id = completed["artifact"]["id"]

            # Verify run status and download artifact bundle
            _, fetched_run = _http_json(f"{base_url}/v1/runs/{run_id}")
            self.assertEqual(fetched_run["status"], "completed")
            self.assertEqual(fetched_run["artifact_id"], artifact_id)

            with urllib.request.urlopen(
                f"{base_url}/v1/artifacts/{artifact_id}/download", timeout=10
            ) as dl:
                bundle_bytes = dl.read()
            manifest, files = read_artifact_bundle(bundle_bytes)
            self.assertEqual(manifest["recipe"], "sft")
            self.assertIn("adapter_model.safetensors", files)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
            if proc.stdout:
                proc.stdout.close()
            if proc.stderr:
                proc.stderr.close()
            shutil.rmtree(storage_dir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
