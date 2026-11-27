"""Recipe loggers: W&B and MLflow over HTTP against fake trackers, and failures that never fail a run."""

from __future__ import annotations

import base64
import gzip
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "fixtures"))

from fake_protocol_server import FakeProtocolServer  # noqa: E402
from stub_runners import StubImporter, StubRunner  # noqa: E402

from grad_trainer import loggers  # noqa: E402
from grad_trainer.worker import ProtocolClient, TrainerWorker  # noqa: E402


class FakeTracker:
    """Records every request; ``replies`` maps a path prefix to (status, body)."""

    def __init__(self, replies: dict[str, tuple[int, Any]]) -> None:
        self.replies = replies
        self.requests: list[tuple[str, str, dict[str, str], Any]] = []
        tracker = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:
                return

            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length)) if length else None
                tracker.requests.append((self.command, self.path, dict(self.headers), body))
                status, payload = next(
                    (v for k, v in tracker.replies.items() if self.path.startswith(k)), (200, {})
                )
                raw = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            do_GET = _handle
            do_POST = _handle

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def bodies(self, prefix: str) -> list[Any]:
        return [b for _m, p, _h, b in self.requests if p.startswith(prefix)]


MLFLOW_REPLIES = {
    "/api/2.0/mlflow/experiments/get-by-name": (404, {"error_code": "RESOURCE_DOES_NOT_EXIST"}),
    "/api/2.0/mlflow/experiments/create": (200, {"experiment_id": "7"}),
    "/api/2.0/mlflow/runs/create": (200, {"run": {"info": {"run_id": "mlr1"}}}),
}
WANDB_REPLIES = {
    "/graphql": (200, {"data": {"viewer": {"entity": "team"}, "upsertBucket": {"bucket": {"id": "b", "name": "n"}}}}),
}
RUN = {"id": "run_1", "name": "sft-x", "config": {"lr": 0.0002, "adapter": {"rank": 16}, "tags": ["a"]}}


# The fake trackers listen on loopback, which the egress guard allows only when listed.
LOOPBACK_ALLOWED = {"GRAD_SOURCES_EGRESS_ALLOW": "127.0.0.1/32"}


class LoggerTests(unittest.TestCase):
    def setUp(self) -> None:
        patcher = mock.patch.dict(os.environ, LOOPBACK_ALLOWED)
        patcher.start()
        self.addCleanup(patcher.stop)

    def tracker(self, replies: dict[str, tuple[int, Any]]) -> FakeTracker:
        fake = FakeTracker(replies)
        self.addCleanup(fake.close)
        return fake

    def test_mlflow_creates_the_experiment_and_logs_steps(self) -> None:
        fake = self.tracker(MLFLOW_REPLIES)
        warnings: list[str] = []
        group = loggers.Loggers([{"kind": "mlflow", "tracking_uri": fake.url + "/", "api_key": "tok", "experiment": "exp"}], RUN, warnings.append)
        group.log({"step": 3, "loss": 0.5, "eval_metrics": {"accuracy": 0.9}, "phase": "train", "best": True})
        group.log({"loss": 0.1})  # no step: ignored
        group.finish("completed")
        self.assertEqual(warnings, [])
        self.assertEqual(fake.bodies("/api/2.0/mlflow/experiments/create"), [{"name": "exp"}])
        params, metrics = fake.bodies("/api/2.0/mlflow/runs/log-batch")
        self.assertIn({"key": "adapter.rank", "value": "16"}, params["params"])
        self.assertEqual({m["key"]: (m["value"], m["step"]) for m in metrics["metrics"]}, {"loss": (0.5, 3), "eval_metrics/accuracy": (0.9, 3)})
        self.assertEqual(fake.bodies("/api/2.0/mlflow/runs/update")[0]["status"], "FINISHED")
        self.assertTrue(all(h.get("Authorization") == "Bearer tok" for _m, _p, h, _b in fake.requests))

    def test_mlflow_reuses_an_existing_experiment(self) -> None:
        fake = self.tracker({**MLFLOW_REPLIES, "/api/2.0/mlflow/experiments/get-by-name": (200, {"experiment": {"experiment_id": "3"}})})
        group = loggers.Loggers([{"kind": "mlflow", "tracking_uri": fake.url}], {"id": "r"}, lambda _m: None)
        group.finish("failed")
        self.assertEqual(fake.bodies("/api/2.0/mlflow/runs/create")[0]["experiment_id"], "3")
        self.assertEqual(fake.bodies("/api/2.0/mlflow/runs/update")[0]["status"], "FAILED")
        self.assertNotIn("Authorization", fake.requests[0][2])

    def test_wandb_upserts_the_run_and_streams_history(self) -> None:
        fake = self.tracker(WANDB_REPLIES)
        group = loggers.Loggers([{"kind": "wandb", "host": fake.url, "project": "proj", "api_key": "k"}], RUN, lambda _m: None)
        group.log({"step": 1, "loss": 2.0})
        group.log({"step": 2, "loss": 1.0})
        group.finish("cancelled")
        upsert = fake.bodies("/graphql")[1]["variables"]
        self.assertEqual((upsert["project"], upsert["entity"], upsert["displayName"]), ("proj", "team", "sft-x"))
        self.assertEqual(json.loads(upsert["config"])["lr"], {"value": 0.0002})
        streams = fake.bodies("/files/team/proj/")
        rows = [s["files"]["wandb-history.jsonl"] for s in streams[:2]]
        self.assertEqual([(r["offset"], json.loads(r["content"][0])["_step"]) for r in rows], [(0, 1), (1, 2)])
        self.assertEqual(streams[2], {"complete": True, "exitcode": 1})
        auth = fake.requests[0][2]["Authorization"]
        self.assertEqual(base64.b64decode(auth.split()[1]).decode(), "api:k")

    def test_failures_disable_one_tracker_and_never_raise(self) -> None:
        fake = self.tracker({**WANDB_REPLIES, "/files/": (500, {})})
        bad_key = self.tracker({"/graphql": (200, {"errors": [{"message": "invalid api key"}]})})
        warnings: list[str] = []
        group = loggers.Loggers(
            [
                {"kind": "wandb", "host": fake.url, "project": "p", "entity": "e", "api_key": "k"},
                {"kind": "wandb", "host": bad_key.url, "project": "p", "api_key": "secret-value"},
                {"kind": "mlflow", "tracking_uri": "http://127.0.0.1:9"},
                {"kind": "neptune"},
            ],
            RUN,
            warnings.append,
        )
        self.assertEqual(len(group.active), 1)
        group.log({"step": 1, "loss": 1.0})
        group.log({"step": 2, "loss": 1.0})
        group.finish("completed")
        self.assertEqual(len(fake.bodies("/files/")), 1)
        self.assertIn("logger 'wandb' disabled: could not start (W&B rejected the request: invalid api key)", warnings)
        self.assertTrue(any(w.startswith("logger 'mlflow' disabled: could not start") for w in warnings))
        self.assertIn("logger 'neptune' is not supported (wandb, mlflow); skipped", warnings)
        self.assertIn("logger 'wandb' disabled: log failed (HTTP 500)", warnings)
        self.assertFalse(any("secret-value" in w for w in warnings))


class LoggerEgressTests(unittest.TestCase):
    """r8 P1-7: tracker hosts go through the source egress guard."""

    def setUp(self) -> None:
        patcher = mock.patch.dict(os.environ, {"GRAD_SOURCES_EGRESS_ALLOW": ""})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_private_hosts_other_schemes_and_cross_origin_redirects_are_refused(self) -> None:
        internal = FakeTracker(MLFLOW_REPLIES)
        self.addCleanup(internal.close)
        # Loopback is not allowed by default: the tracker never sees the key.
        warnings: list[str] = []
        loggers.Loggers([{"kind": "mlflow", "tracking_uri": internal.url, "api_key": "TENANT-TOKEN"}], RUN, warnings.append)
        self.assertEqual(internal.requests, [])
        self.assertTrue(any("blocked address" in w for w in warnings), warnings)
        for uri in ("file:///etc/hostname#", "gopher://x.example", "http://169.254.169.254"):
            warnings = []
            loggers.Loggers([{"kind": "mlflow", "tracking_uri": uri}], RUN, warnings.append)
            self.assertTrue(warnings and "disabled: could not start" in warnings[0], (uri, warnings))

        # An allowed front host that redirects elsewhere: the key is not forwarded.
        with mock.patch.dict(os.environ, {"GRAD_SOURCES_EGRESS_ALLOW": "127.0.0.0/8"}):
            redirect = _Redirector(internal.url)
            self.addCleanup(redirect.close)
            loggers.Loggers(
                [{"kind": "mlflow", "tracking_uri": redirect.url, "api_key": "TENANT-TOKEN"}], RUN, lambda _m: None
            )
        self.assertTrue(internal.requests)
        self.assertFalse(any(h.get("Authorization") for _m, _p, h, _b in internal.requests))


class _Redirector:
    """Redirects every request to ``target`` (another origin)."""

    def __init__(self, target: str) -> None:
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:
                return

            def _go(self) -> None:
                self.send_response(307)
                self.send_header("Location", target + self.path)
                self.send_header("Content-Length", "0")
                self.end_headers()

            do_GET = _go
            do_POST = _go

        self.httpd = ThreadingHTTPServer(("127.0.0.2", 0), Handler)
        self.url = f"http://127.0.0.2:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


class WorkerLoggerTests(unittest.TestCase):
    def setUp(self) -> None:
        patcher = mock.patch.dict(os.environ, LOOPBACK_ALLOWED)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_worker_streams_metrics_and_finishes_with_the_run_status(self) -> None:
        fake = FakeTracker(MLFLOW_REPLIES)
        self.addCleanup(fake.close)
        tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.addCleanup(tmp.cleanup)
        job = {
            "id": "run_1",
            "kind": "train",
            "attempt": 1,
            "run": {"id": "run_1", "name": "sft-x", "recipe_kind": "sft", "resolved_config": {"lr": 1}},
            "price_per_million_tokens": 0.4,
            "max_cost_usd": None,
            "dataset": {"version": 1, "download_url": "/v1/trainer-jobs/run_1/dataset"},
            "resume": None,
            "loggers": [{"kind": "mlflow", "tracking_uri": fake.url}],
        }
        srv = FakeProtocolServer(api_key="k", jobs=[job])
        srv.blobs["/v1/trainer-jobs/run_1/dataset"] = gzip.compress(b'{"messages":[{"role":"user","content":"hi"}]}\n')
        srv.__enter__()
        self.addCleanup(srv.__exit__)
        worker = TrainerWorker(
            server_url=srv.base_url,
            worker_id="w",
            workdir=tmp.name,
            recipe_runner_factory=lambda _kind: StubRunner(),
            import_runner=StubImporter(),
            recipes=["sft"],
            heartbeat_interval_s=0.05,
            client=ProtocolClient(srv.base_url, "k", retry_base_s=0.01, retry_cap_s=0.02),
        )
        self.assertEqual(worker.run_once()["status"], "completed")
        steps = [b["metrics"][0]["step"] for b in fake.bodies("/api/2.0/mlflow/runs/log-batch") if "metrics" in b]
        self.assertEqual(steps, [1, 2, 3])
        self.assertEqual(fake.bodies("/api/2.0/mlflow/runs/update")[0]["status"], "FINISHED")


if __name__ == "__main__":
    unittest.main()
