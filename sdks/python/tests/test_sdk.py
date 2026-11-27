"""Unit and local HTTP integration tests for grad-sdk (Python)."""

from __future__ import annotations

import asyncio
import hashlib
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

from grad import (
    AsyncGrad,
    CartridgeRecipe,
    Context,
    DPORecipe,
    DecisionModelRecipe,
    EmbeddingRecipe,
    Environment,
    Grad,
    GradApiError,
    Judge,
    PreferencePair,
    RouterRecipe,
    Rubric,
    SFTRecipe,
    StepOutcome,
    Trajectory,
    Triplet,
    adapters,
    serve_environment,
    splits,
    validators,
)


class _StubServer:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, Any]] = []
        self.env_tasks: list[dict[str, Any]] = [
            {
                "id": "envtask_1",
                "env_name": "repo-ci",
                "task": {"prompt": "fix test", "expected_output": "patched"},
                "model_id": "qwen/qwen3-8b",
            }
        ]
        self.artifact_bytes = b"mock-artifact-archive"
        self.artifact_sha = hashlib.sha256(self.artifact_bytes).hexdigest()

        parent = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, _fmt: str, *_args: Any) -> None:
                return

            def _read_json(self) -> Any:
                length = int(self.headers.get("Content-Length", "0"))
                if length == 0:
                    return None
                return json.loads(self.rfile.read(length).decode("utf-8"))

            def _send_json(self, status: int, body: Any) -> None:
                raw = json.dumps(body).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self) -> None:
                parent.calls.append(("GET", self.path, None))
                if self.path == "/v1/models":
                    self._send_json(200, {"data": [{"id": "qwen/qwen3-8b"}]})
                elif self.path.startswith("/v1/datasets/support/records"):
                    self._send_json(
                        200,
                        {
                            "dataset": "support",
                            "total": 1,
                            "data": [
                                {
                                    "id": "r1",
                                    "messages": [
                                        {"role": "user", "content": "hi"},
                                        {"role": "assistant", "content": '{"ok": true}'},
                                    ],
                                }
                            ],
                        },
                    )
                elif self.path.startswith("/v1/artifacts/") and self.path.endswith("/download"):
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("X-Artifact-Sha256", parent.artifact_sha)
                    self.send_header("Content-Length", str(len(parent.artifact_bytes)))
                    self.end_headers()
                    self.wfile.write(parent.artifact_bytes)
                elif self.path.startswith("/v1/evals/eval_1/failures"):
                    self._send_json(
                        200,
                        {
                            "eval_id": "eval_1",
                            "data": [
                                {
                                    "task_id": "t2",
                                    "model": "qwen/qwen3-8b",
                                    "score": 0.2,
                                    "record": {
                                        "messages": [
                                            {"role": "user", "content": "hard"},
                                            {"role": "assistant", "content": "wrong"},
                                        ]
                                    },
                                }
                            ],
                        },
                    )
                else:
                    self._send_json(
                        404,
                        {
                            "status": 404,
                            "code": "not_found",
                            "title": "Not Found",
                            "detail": self.path,
                            "request_id": "req_stub",
                        },
                    )

            def do_POST(self) -> None:
                body = self._read_json()
                parent.calls.append(("POST", self.path, body))
                if self.path.startswith("/v1/datasets/"):
                    self._send_json(
                        200,
                        {
                            "id": "ds_1",
                            "name": self.path.split("/")[3],
                            "record_count": len(body["records"]),
                        },
                    )
                elif self.path == "/v1/runs/plan":
                    self._send_json(
                        200, {"estimated_cost_usd": 0.12, "estimated_steps": 10}
                    )
                elif self.path == "/v1/runs":
                    self._send_json(202, {"id": "run_1", "status": "queued"})
                elif self.path == "/v1/env-workers/register":
                    self._send_json(200, {"name": body["name"], "worker_id": body["worker_id"]})
                elif self.path.endswith("/claim"):
                    task = parent.env_tasks.pop(0) if parent.env_tasks else None
                    self._send_json(200, {"task": task})
                elif self.path.endswith("/complete"):
                    self._send_json(200, {"status": "completed", "result": body})
                else:
                    self._send_json(200, {"ok": True})

        self._server = HTTPServer(("127.0.0.1", 0), Handler)
        self.base_url = f"http://127.0.0.1:{self._server.server_port}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def __enter__(self) -> "_StubServer":
        self._thread.start()
        return self

    def __exit__(self, *_args: Any) -> None:
        self._server.shutdown()
        self._server.server_close()


class _DemoEnv(Environment):
    def __init__(self) -> None:
        self.torn_down = False

    def setup(self, task: dict[str, Any]) -> str:
        return str(task["prompt"])

    def step(self, action: str) -> StepOutcome:
        return StepOutcome(observation=f"ran:{action}", done=True)

    def evaluate(self) -> tuple[float, dict[str, float]]:
        return 1.0, {"pytest": 1.0}

    def teardown(self) -> None:
        self.torn_down = True


class PythonSdkTests(unittest.TestCase):
    def test_types_recipes_and_no_full_adapter(self) -> None:
        self.assertFalse(hasattr(adapters, "Full"))
        traj = (
            Trajectory.from_messages([{"role": "user", "content": "hi"}], session_id="s1")
            .append_env_tokens("tool output")
            .with_targets(scores={"pass": 1.0})
        )
        self.assertEqual(traj.to_dict()["messages"][-1]["train"], False)

        self.assertEqual(SFTRecipe(model="qwen/qwen3-8b").to_spec()["kind"], "sft")
        self.assertEqual(DPORecipe(beta=0.2).to_spec()["beta"], 0.2)
        self.assertEqual(RouterRecipe().to_spec()["kind"], "router")
        self.assertEqual(DecisionModelRecipe().to_spec()["kind"], "decision")
        self.assertEqual(
            CartridgeRecipe(context=Context(text="doc"), num_tokens=128).to_spec()["num_tokens"],
            128,
        )
        self.assertEqual(EmbeddingRecipe(temp=0.07).to_spec()["temp"], 0.07)

        self.assertEqual(PreferencePair("p", "c", "r").to_dict()["chosen"], "c")
        self.assertEqual(Triplet("q", "pos", ["neg"]).to_dict()["negatives"], ["neg"])

    def test_rubric_and_explicit_judge_model(self) -> None:
        with self.assertRaises(ValueError):
            Judge(model="", prompt="grade")

        rubric = Rubric([lambda out, _exp: 1.0 if out else 0.0, validators.json_valid(), Judge(model="qwen/qwen3-32b", prompt="good?")])
        wire = rubric.to_wire_items()
        self.assertEqual(len(wire), 3)
        self.assertEqual(wire[2]["model"], "qwen/qwen3-32b")

    def test_client_flow_scorer_dry_run_failures_mining_and_async(self) -> None:
        with _StubServer() as srv:
            client = Grad(base_url=srv.base_url, api_key="grad_local")
            models = client.models.list()
            self.assertEqual(models[0]["id"], "qwen/qwen3-8b")

            # Push plain dicts directly
            ds = client.datasets.push(
                "support",
                [{"messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": '{"ok": true}'}]}],
            )
            self.assertEqual(ds["record_count"], 1)

            # Dry-run scorer validates locally on sample record before hitting /v1/runs/plan
            def bad_scorer(_out: Any, _exp: Any) -> float:
                raise RuntimeError("boom in user scorer")

            with self.assertRaisesRegex(RuntimeError, "boom in user scorer"):
                client.runs.plan(
                    "support",
                    name="support-sft",
                    recipe=SFTRecipe(),
                    rubric=bad_scorer,
                )

            plan = client.runs.plan(
                "support",
                name="support-sft",
                recipe=SFTRecipe(),
                split=splits.BySession(0.1),
                rubric=validators.json_valid(),
            )
            self.assertEqual(plan["estimated_steps"], 10)

            # Download artifact with SHA-256 verification
            raw = client.artifacts.download("support-sft@latest")
            self.assertEqual(raw, srv.artifact_bytes)

            # Mine eval failures into a new dataset
            mined = client.evals.failures("eval_1", model="qwen/qwen3-8b").to_dataset("hard-cases")
            self.assertEqual(mined["name"], "hard-cases")

            # RFC 7807 error decoding
            with self.assertRaises(GradApiError) as ctx:
                client.datasets.get("missing")
            self.assertEqual(ctx.exception.status, 404)
            self.assertEqual(ctx.exception.code, "not_found")

            # AsyncGrad
            async_client = AsyncGrad(base_url=srv.base_url, api_key="grad_local")
            async_models = asyncio.run(async_client.wire.list_models())
            self.assertEqual(async_models["data"][0]["id"], "qwen/qwen3-8b")

            # Outbound serve_environment loop
            env = _DemoEnv()
            count = serve_environment(
                env,
                name="repo-ci",
                base_url=srv.base_url,
                api_key="grad_local",
                max_tasks=1,
                wait_ms=10,
            )
            self.assertEqual(count, 1)
            self.assertTrue(env.torn_down)


if __name__ == "__main__":
    unittest.main()
