"""Live protocol test: TrainerWorker against a real server/api process."""

from __future__ import annotations

import hashlib
import json
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from fixtures.live_server import LiveServer, http as _http
from fixtures.stub_runners import StubRunner

from grad_trainer.worker import FileToken, TrainerWorker, WorkerAuthError


class LiveWorkerTest(unittest.TestCase):
    def test_worker_trains_and_publishes_artifact_against_live_server(self) -> None:
        server = LiveServer(self)
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


class LiveLeaseTokenTest(unittest.TestCase):
    """GRAD_WORKER_AUTH=lease end to end: the orchestrator mints a token on the internal
    port, a worker trains with it from GRAD_WORKER_TOKEN_FILE, revoking it locks the worker out."""

    def test_mint_train_revoke(self) -> None:
        server = LiveServer(self, "--auth", "api_key")
        base, internal = server.base, server.info["internal_url"]
        admin = {"Authorization": f"Bearer {server.info['api_key']}"}
        orchestrator = {"Authorization": f"Bearer {server.info['orchestrator_key']}"}
        try:
            expires = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
            status, body, headers = _http(
                f"{internal}/internal/v1/worker-tokens",
                "POST",
                {"host_id": "live-host", "lease_id": "lease-live", "kinds": ["train"], "gpu_memory_gb": 80, "expires_at": expires},
                headers=orchestrator,
            )
            self.assertEqual(status, 201)
            self.assertEqual({k.lower(): v for k, v in headers.items()}.get("cache-control"), "no-store")
            token_file = server.dir / "worker-token"
            token_file.write_text(json.loads(body)["token"] + "\n")

            # The public port has no internal routes, whatever the key.
            with self.assertRaises(urllib.error.HTTPError) as public:
                _http(f"{base}/internal/v1/worker-tokens", "POST", {}, headers=orchestrator)
            self.assertEqual(public.exception.code, 404)

            records = [
                {"messages": [{"role": "user", "content": f"q{i}"}, {"role": "assistant", "content": f"a{i}"}]}
                for i in range(4)
            ]
            _http(f"{base}/v1/datasets/lease/records", "POST", {"records": records}, headers=admin)
            _, body, _ = _http(
                f"{base}/v1/runs",
                "POST",
                {"dataset": "lease", "name": "lease-sft", "recipe": {"kind": "sft", "model": "test/tiny-qwen3", "batch_size": 1}},
                headers=admin,
            )
            run_id = json.loads(body)["id"]

            worker = TrainerWorker(
                server_url=base,
                api_key=FileToken(token_file),
                worker_id="live-host",
                workdir=server.dir / "work",
                recipe_runner_factory=lambda _kind: StubRunner(steps=2, checkpoint_at=None),
                recipes=["sft"],
                kinds=["train"],
                gpu=None,
            )
            self.assertIsNotNone(worker.run_once())
            _, body, _ = _http(f"{base}/v1/runs/{run_id}", headers=admin)
            self.assertEqual(json.loads(body)["status"], "completed")

            _, body, _ = _http(f"{internal}/internal/v1/worker-tokens/lease-live", "DELETE", headers=orchestrator)
            self.assertEqual(json.loads(body), {"lease_id": "lease-live", "revoked": 1})
            with self.assertRaises(WorkerAuthError) as rejected:
                worker.claim()
            self.assertEqual(rejected.exception.status, 401)
        except Exception:
            print(server.log_tail())
            raise


if __name__ == "__main__":
    unittest.main()
