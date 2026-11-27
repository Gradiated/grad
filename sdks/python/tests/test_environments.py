"""serve_environment: protocol, policies, concurrency, retries, graceful drain, and never fabricating results."""

from __future__ import annotations

import json
import os
import signal
import threading
import time
import unittest
from typing import Any, Literal

from _fakes import FakeSender, json_reply, make_client, problem

import grad
from grad import Action, ChatCompletionsPolicy, Environment, Observation, Rubric, Scorer, StatefulScorer, Task, Trajectory, environments, serve_environment, validators
from grad.environments import StepOutcome, ToolCall, tool_schema


class Hub:
    """A scripted env-worker hub: queued tasks, recorded completions."""

    def __init__(self, tasks: list[dict[str, Any]], *, claim_errors: list[Any] | None = None, complete_errors: list[Any] | None = None) -> None:
        self.tasks = list(tasks)
        self.claim_errors = list(claim_errors or [])
        self.complete_errors = list(complete_errors or [])
        self.completed: dict[str, dict[str, Any]] = {}
        self.registers = 0
        self.claims = 0
        self.lock = threading.Lock()

    def __call__(self, request: Any) -> Any:
        path = request.url.split("?")[0].split("api.test")[1]
        body = json.loads(request.body) if isinstance(request.body, (bytes, bytearray)) else None
        with self.lock:
            if path == "/v1/env-workers/register":
                self.registers += 1
                return json_reply({"name": body["name"], "worker_id": body["worker_id"], "concurrency": body["concurrency"], "last_heartbeat_at": "now"})
            if path.endswith("/claim"):
                self.claims += 1
                if self.claim_errors:
                    return self.claim_errors.pop(0)
                if self.tasks:
                    return json_reply({"task": self.tasks.pop(0)})
                return json_reply({"task": None})
            if path.endswith("/complete"):
                if self.complete_errors:
                    return self.complete_errors.pop(0)
                self.completed[path.split("/")[-2]] = body
                return json_reply({"ok": True})
        raise AssertionError(path)


def envelope(task_id: str, task: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {"id": task_id, "env_name": "support-app", "task": task, "model_id": "qwen/qwen3-8b", "system_prompt": None, "timeout_s": 120, **extra}


def echo_policy(messages: list[dict[str, Any]], *, tools: Any = None, model: str | None = None, task: Task | None = None) -> str:
    return f"{model}: {messages[-1]['content']}"


def serve(hub: Hub, env: Any, *, policy: Any = echo_policy, **kwargs: Any) -> int:
    client, _, _ = make_client(handler=hub, max_retries=0)
    kwargs.setdefault("max_tasks", len(hub.tasks))
    kwargs.setdefault("handle_signals", False)
    kwargs.setdefault("wait_ms", 10)
    return serve_environment(env, name="support-app", policy=policy, client=client, **kwargs)


class Counter(Environment[dict]):
    max_turns = 5

    def setup(self, task: Task, rollout_id: str) -> dict:
        return {"id": rollout_id, "turns": 0}

    def step(self, handle: dict, action: Action) -> Observation:
        handle["turns"] += 1
        return Observation(text=f"turn {handle['turns']}", done=handle["turns"] >= 2)

    def evaluate(self, handle: dict, trajectory: Trajectory) -> dict[str, float]:
        return {"turns": handle["turns"] / 2, "answered": 1.0 if trajectory.text else 0.0}


class WorkerTests(unittest.TestCase):
    def test_requires_a_policy_and_never_fabricates(self) -> None:
        client, sender, _ = make_client({})
        with self.assertRaises(ValueError) as ctx:
            serve_environment(Counter(), name="support-app", policy=None, client=client)
        self.assertIn("never fabricates", str(ctx.exception))
        self.assertEqual(sender.sent, [], "nothing is registered without a policy")
        with self.assertRaises(TypeError):
            serve_environment(Counter(), name="support-app", policy="gpt", client=client)  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            serve_environment(Counter(), name=" ", policy=echo_policy, client=client)
        with self.assertRaises(ValueError):
            serve_environment(Counter(), name="x", policy=echo_policy, client=client, concurrency=0)
        with self.assertRaises(TypeError):
            serve_environment(42, name="x", policy=echo_policy, client=client)
        with self.assertRaises(TypeError):
            serve_environment(lambda: 42, name="x", policy=echo_policy, client=client)

    def test_multi_turn_rollout_with_named_scores(self) -> None:
        hub = Hub([envelope("t1", {"prompt": "hi", "metadata": {"k": 1}}, system_prompt="Be brief.")])
        self.assertEqual(serve(hub, Counter), 1)  # a subclass is instantiated
        result = hub.completed["t1"]
        self.assertEqual(result["scores"], {"turns": 1.0, "answered": 1.0})
        self.assertEqual(result["score"], 1.0)
        roles = [m["role"] for m in result["trajectory"]["messages"]]
        self.assertEqual(roles, ["system", "user", "assistant", "user", "assistant"])
        msgs = result["trajectory"]["messages"]
        self.assertEqual(msgs[2]["content"], "qwen/qwen3-8b: hi")
        self.assertFalse(msgs[3]["train"])
        self.assertTrue(result["worker_id"].startswith("env-"))
        self.assertGreaterEqual(hub.registers, 1)

    def test_single_turn_rubric_environment(self) -> None:
        env = Environment(rubric=Rubric([Scorer("short", fn=lambda t: 1.0 if len(t.text) < 100 else 0.0, weight=3.0), validators.NonEmpty()]), system_prompt="sys")
        hub = Hub([envelope("t1", {"messages": [{"role": "user", "content": "q"}], "max_turns": 5})])
        serve(hub, lambda: env)
        result = hub.completed["t1"]
        self.assertEqual(result["scores"], {"short": 1.0, "non_empty": 1.0})
        self.assertEqual(result["score"], 1.0)
        self.assertEqual(result["trajectory"]["messages"][0], {"role": "system", "content": "sys"})

    def test_environment_without_rubric_or_evaluate_reports_an_error(self) -> None:
        hub = Hub([envelope("t1", {"prompt": "q"})])
        serve(hub, Environment())
        result = hub.completed["t1"]
        self.assertIsNone(result["score"])
        self.assertEqual(result["scores"], {})
        self.assertIn("NotImplementedError", result["error"])
        self.assertEqual(len(result["trajectory"]["messages"]), 2)

    def test_errors_in_policy_step_setup_and_evaluate_become_task_errors(self) -> None:
        class BadStep(Environment[None]):
            def step(self, handle: None, action: Action) -> Observation:
                return "nope"  # type: ignore[return-value]

            def teardown(self, handle: None) -> None:
                raise RuntimeError("teardown boom")

        class BadSetup(Environment[None]):
            def setup(self, task: Task, rollout_id: str) -> None:
                raise RuntimeError("no docker")

        class BadScore(Environment[None]):
            def evaluate(self, handle: None, trajectory: Trajectory) -> float:
                return float("nan")

        def bad_policy(messages: Any, **kw: Any) -> Any:
            return {"role": "user", "content": "x"}

        cases = [(BadStep(), echo_policy, "must return an Observation"), (BadSetup(), echo_policy, "no docker"), (BadScore(), echo_policy, "non-finite"), (Counter(), bad_policy, "assistant message"), (Counter(), lambda m, **k: 5, "string or an assistant")]
        for env, policy, needle in cases:
            with self.subTest(env=type(env).__name__, needle=needle):
                hub = Hub([envelope("t1", {"prompt": "q"})])
                serve(hub, env, policy=policy)
                self.assertIn(needle, hub.completed["t1"]["error"])
                self.assertIsNone(hub.completed["t1"]["score"])

    def test_tools_environment(self) -> None:
        def calculator(expression: str) -> str:
            """Evaluate an arithmetic expression.

            More details."""
            return str(eval(expression))  # noqa: S307 - test fixture

        def lookup(order_id: str, verbose: bool = False) -> dict[str, Any]:
            """Find an order."""
            raise KeyError(order_id)

        env = environments.Tools([calculator, lookup], rubric=Rubric([Scorer("correct", fn=lambda t: 1.0 if "84" in t.text else 0.0)]), max_turns=4, requirements=[])
        self.assertEqual(env.tools()[0]["function"]["description"], "Evaluate an arithmetic expression.")  # type: ignore[index]
        calls = iter(
            [
                {"role": "assistant", "content": None, "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "calculator", "arguments": '{"expression": "12 * 7"}'}}]},
                {"role": "assistant", "content": "", "tool_calls": [{"id": "c2", "function": {"name": "lookup", "arguments": {"order_id": "9"}}}, {"id": "c3", "function": {"name": "nope", "arguments": "{bad"}}]},
                {"role": "assistant", "content": "The answer is 84."},
            ]
        )
        seen_tools: list[Any] = []

        def policy(messages: Any, *, tools: Any = None, **kw: Any) -> Any:
            seen_tools.append(tools)
            return next(calls)

        hub = Hub([envelope("t1", {"prompt": "What is 12*7?"})])
        serve(hub, env, policy=policy)
        result = hub.completed["t1"]
        self.assertEqual(result["scores"], {"correct": 1.0})
        msgs = result["trajectory"]["messages"]
        tool_msgs = [m for m in msgs if m["role"] == "tool"]
        self.assertEqual(tool_msgs[0], {"role": "tool", "content": "84", "train": False, "tool_call_id": "c1"})
        self.assertIn("KeyError", tool_msgs[1]["content"])
        self.assertIn("unknown tool", tool_msgs[2]["content"])
        self.assertEqual(len(seen_tools[0]), 2)
        self.assertEqual(environments.Tools([]).max_turns, 1)
        with self.assertRaises(ValueError):
            environments.Tools([calculator, calculator])
        with self.assertRaises(grad.ScorerError):
            serve(Hub([]), environments.Tools([calculator], requirements=["definitely-not-installed-pkg"]))

    def test_tool_schema(self) -> None:
        def f(a: int, b: float, c: bool, d: list[str], e: dict[str, int], g: Literal["x", "y"], h: str | None = None, *args: Any, i: Any = 1, **kw: Any) -> None:
            """Doc."""

        params = tool_schema(f)["function"]["parameters"]
        self.assertEqual(params["required"], ["a", "b", "c", "d", "e", "g"])
        self.assertEqual(params["properties"]["d"], {"type": "array", "items": {"type": "string"}})
        self.assertEqual(params["properties"]["e"], {"type": "object"})
        self.assertEqual(params["properties"]["g"], {"enum": ["x", "y"]})
        self.assertEqual(params["properties"]["h"], {"type": "string"})
        self.assertEqual(params["properties"]["i"], {})
        self.assertNotIn("args", params["properties"])

    def test_concurrency_uses_separate_handles(self) -> None:
        barrier = threading.Barrier(4, timeout=5)
        handles: list[int] = []

        class Parallel(Environment[dict]):
            def setup(self, task: Task, rollout_id: str) -> dict:
                barrier.wait()  # only passes if 4 rollouts run at once
                handle = {"rid": rollout_id}
                handles.append(id(handle))
                return handle

            def evaluate(self, handle: dict, trajectory: Trajectory) -> float:
                return 1.0

        hub = Hub([envelope(f"t{i}", {"prompt": str(i)}) for i in range(4)])
        self.assertEqual(serve(hub, Parallel(), concurrency=4), 4)
        self.assertEqual(len(set(handles)), 4)
        self.assertEqual(sorted(hub.completed), ["t0", "t1", "t2", "t3"])

    def test_transient_claim_and_complete_errors_are_retried(self) -> None:
        hub = Hub(
            [envelope("t1", {"prompt": "q"})],
            claim_errors=[problem(502, "bad_gateway"), problem(404, "env_not_registered")],
            complete_errors=[problem(500, "boom")],
        )
        self.assertEqual(serve(hub, Counter(), max_tasks=1), 1)
        self.assertIn("t1", hub.completed)
        self.assertGreaterEqual(hub.registers, 2, "a 404 on claim re-registers")

    def test_rejected_completion_is_dropped(self) -> None:
        hub = Hub([envelope("t1", {"prompt": "q"})], complete_errors=[problem(409, "task_not_claimed")])
        self.assertEqual(serve(hub, Counter()), 0)

    def test_auth_errors_stop_the_worker(self) -> None:
        hub = Hub([], claim_errors=[problem(401, "unauthorized")])
        with self.assertRaises(grad.AuthenticationError):
            serve(hub, Counter(), max_tasks=None)
        client, _, _ = make_client({"POST /v1/env-workers/register": problem(403, "forbidden")})
        with self.assertRaises(grad.PermissionDeniedError):
            serve_environment(Counter(), name="x", policy=echo_policy, client=client, handle_signals=False)
        hub = Hub([envelope("t1", {"prompt": "q"})], complete_errors=[problem(401, "unauthorized")])
        with self.assertRaises(grad.AuthenticationError):
            serve(hub, Counter())

    def test_registration_retries_until_the_server_is_up(self) -> None:
        attempts = {"n": 0}
        hub = Hub([envelope("t1", {"prompt": "q"})])

        def handler(request: Any) -> Any:
            if request.url.endswith("/register") and attempts["n"] < 1:
                attempts["n"] += 1
                return problem(503, "starting")
            return hub(request)

        client, _, _ = make_client(handler=handler, max_retries=0)
        self.assertEqual(serve_environment(Counter(), name="support-app", policy=echo_policy, client=client, max_tasks=1, handle_signals=False, wait_ms=10), 1)
        client, _, _ = make_client({"POST /v1/env-workers/register": problem(422, "validation_error")})
        with self.assertRaises(grad.ValidationError):
            serve_environment(Counter(), name="x", policy=echo_policy, client=client, handle_signals=False)
        stop = threading.Event()
        stop.set()
        client, _, _ = make_client({"POST /v1/env-workers/register": problem(503, "starting")}, max_retries=0)
        self.assertEqual(serve_environment(Counter(), name="x", policy=echo_policy, client=client, handle_signals=False, stop_event=stop), 0)

    def test_empty_claims_do_not_busy_loop_and_stop_event_is_honoured(self) -> None:
        hub = Hub([])
        stop = threading.Event()
        threading.Timer(1.0, stop.set).start()
        started = time.monotonic()
        self.assertEqual(serve(hub, Counter(), max_tasks=None, stop_event=stop, heartbeat_s=0.2), 0)
        self.assertLess(time.monotonic() - started, 3)
        self.assertLessEqual(hub.claims, 8)
        self.assertGreaterEqual(hub.registers, 2, "heartbeats re-register")

    def test_drain_reports_unfinished_rollouts(self) -> None:
        release = threading.Event()

        class Slow(Environment[None]):
            def setup(self, task: Task, rollout_id: str) -> None:
                release.wait(5)

            def evaluate(self, handle: None, trajectory: Trajectory) -> float:
                return 1.0

        hub = Hub([envelope("slow", {"prompt": "q"})])
        stop = threading.Event()
        threading.Timer(0.3, stop.set).start()
        try:
            serve(hub, Slow(), max_tasks=None, stop_event=stop, drain_timeout_s=0.2)
        finally:
            release.set()
        self.assertEqual(hub.completed["slow"]["error"], "worker shut down before the rollout finished")
        self.assertIsNone(hub.completed["slow"]["score"])
        time.sleep(0.2)
        self.assertEqual(len(hub.completed), 1, "the late rollout does not post a second result")

    def test_sigterm_drains_gracefully(self) -> None:
        hub = Hub([])
        previous = signal.getsignal(signal.SIGTERM)
        threading.Timer(0.5, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
        processed = serve(hub, Counter(), max_tasks=None, handle_signals=True)
        self.assertEqual(processed, 0)
        self.assertIs(signal.getsignal(signal.SIGTERM), previous)

    def test_rollout_timeout(self) -> None:
        hub = Hub([envelope("t1", {"prompt": "q"}, timeout_s=1)])
        client, _, clock = make_client(handler=hub, max_retries=0)

        def slow_policy(messages: Any, **kw: Any) -> str:
            clock.now += 5
            return "late"

        serve_environment(Counter(), name="support-app", policy=slow_policy, client=client, max_tasks=1, handle_signals=False, wait_ms=10)
        self.assertIn("timeout", hub.completed["t1"]["error"])

    def test_stateful_scorer_in_environment_rubric(self) -> None:
        class Store(Environment[dict]):
            def setup(self, task: Task, rollout_id: str) -> dict:
                return {"refunds": []}

            def step(self, handle: dict, action: Action) -> Observation:
                handle["refunds"].append(action.text)
                return StepOutcome("refunded", done=True)

        env = Store(rubric=Rubric([StatefulScorer("refund_state", weight=0.7, fn=lambda t, h: 1.0 if h["refunds"] else 0.0), Scorer("polite", weight=0.3, fn=lambda t: 0.0)]))
        hub = Hub([envelope("t1", {"prompt": "refund"})])
        serve(hub, env)
        self.assertAlmostEqual(hub.completed["t1"]["score"], 0.7)
        self.assertEqual(StepOutcome("o").observation, "o")

    def test_chat_completions_policy(self) -> None:
        policy = ChatCompletionsPolicy("http://localhost:8000/v1", api_key="sk", temperature=0.2, max_tokens=64)
        sender = FakeSender(
            {
                "POST /v1/chat/completions": [
                    json_reply({"choices": [{"message": {"role": "assistant", "content": "hello", "tool_calls": [{"id": "c", "function": {"name": "f", "arguments": "{}"}}]}}]}),
                    json_reply({"choices": []}),
                    problem(503, "down"),
                ]
            }
        )
        policy._transport.sender = sender
        msg = policy([{"role": "user", "content": "hi", "train": False}], tools=[{"type": "function"}], model="qwen/qwen3-8b")
        self.assertEqual(msg["content"], "hello")
        self.assertEqual(msg["tool_calls"][0]["id"], "c")
        body = sender.sent[0].json
        self.assertEqual(body["model"], "qwen/qwen3-8b")
        self.assertEqual(body["messages"], [{"role": "user", "content": "hi"}])
        self.assertEqual((body["temperature"], body["max_tokens"]), (0.2, 64))
        self.assertEqual(sender.sent[0].header("Authorization"), "Bearer sk")
        with self.assertRaises(ValueError):
            policy([{"role": "user", "content": "hi"}], model="m")
        with self.assertRaises(grad.ServerError):
            policy([{"role": "user", "content": "hi"}], model="m")
        with self.assertRaises(ValueError):
            ChatCompletionsPolicy("http://localhost:1")([{"role": "user", "content": "x"}])
        policy.close()

    def test_action_parsing_and_namespace(self) -> None:
        action = Action.from_message({"role": "assistant", "content": "x", "tool_calls": [{"function": {"name": "a", "arguments": "[1]"}}, {"function": {"name": "b", "arguments": ""}}]})
        self.assertEqual(action.tool_calls, [ToolCall("a", {"_raw": [1]}), ToolCall("b", {})])
        self.assertEqual(Action.from_message({"content": ["parts"]}).text, "")
        for factory in (environments.Harbor, environments.MCP, environments.DockerCompose, environments.from_gym, environments.from_verifiers):
            with self.assertRaises(grad.NotAvailableInV0Error):
                factory("x")
        self.assertEqual(environments.Remote("support-app").timeout_s, 120)
        self.assertIsNone(Environment().tools())
        with self.assertRaises(ValueError):
            Environment(max_turns=0)
        self.assertEqual(Environment().step(None, action), Observation(done=True))

    def test_client_environments_serve_and_default_client(self) -> None:
        hub = Hub([envelope("t1", {"prompt": "q"})])
        client, _, _ = make_client(handler=hub, max_retries=0)
        self.assertEqual(client.environments.serve(Counter(), name="support-app", policy=echo_policy, max_tasks=1, handle_signals=False, wait_ms=10), 1)
        import tempfile
        from unittest import mock

        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": tmp}, clear=False):
            os.environ.pop("GRADIATED_API_KEY", None)
            os.environ.pop("GRADIATED_BASE_URL", None)
            with self.assertRaises(grad.GradConfigError):
                serve_environment(Counter(), name="x", policy=echo_policy, base_url="https://grad.example")


if __name__ == "__main__":
    unittest.main()
