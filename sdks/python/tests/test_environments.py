"""The typed Wave 2 environment definitions (v0 servers do not run them)."""

from __future__ import annotations

import unittest
from typing import Any, Literal

import _fakes  # noqa: F401  (puts the SDK on sys.path)

import grad
from grad import Action, Environment, Observation, Rubric, Scorer, StatefulScorer, Task, Trajectory, environments
from grad.environments import StepOutcome, ToolCall, tool_schema


class EnvironmentTests(unittest.TestCase):
    def test_tools_environment_runs_tools_and_reports_failures(self) -> None:
        def calculator(expression: str) -> str:
            """Evaluate an arithmetic expression.

            More details."""
            return str(eval(expression))  # noqa: S307 - test fixture

        def lookup(order_id: str, verbose: bool = False) -> dict[str, Any]:
            """Find an order."""
            raise KeyError(order_id)

        env = environments.Tools([calculator, lookup], max_turns=4, requirements=[])
        self.assertEqual(env.tools()[0]["function"]["description"], "Evaluate an arithmetic expression.")  # type: ignore[index]
        action = Action.from_message(
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "calculator", "arguments": '{"expression": "12 * 7"}'}},
                    {"id": "c2", "function": {"name": "lookup", "arguments": {"order_id": "9"}}},
                    {"id": "c3", "function": {"name": "nope", "arguments": "{bad"}},
                ],
            }
        )
        obs = env.step(None, action)
        self.assertFalse(obs.done)
        self.assertEqual(obs.messages[0], {"role": "tool", "content": "84", "train": False, "tool_call_id": "c1"})
        self.assertIn("KeyError", obs.messages[1]["content"])
        self.assertIn("unknown tool", obs.messages[2]["content"])
        self.assertTrue(env.step(None, Action.from_message({"content": "The answer is 84."})).done)
        self.assertEqual(environments.Tools([]).max_turns, 1)
        with self.assertRaises(ValueError):
            environments.Tools([calculator, calculator])
        with self.assertRaises(grad.ScorerError):
            environments.Tools([calculator], requirements=["definitely-not-installed-pkg"]).check_requirements()

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

    def test_base_environment_defaults_and_rubric_scoring(self) -> None:
        action = Action.from_message({"role": "assistant", "content": "x", "tool_calls": [{"function": {"name": "a", "arguments": "[1]"}}, {"function": {"name": "b", "arguments": ""}}]})
        self.assertEqual(action.tool_calls, [ToolCall("a", {"_raw": [1]}), ToolCall("b", {})])
        self.assertEqual(Action.from_message({"content": ["parts"]}).text, "")
        env: Environment[Any] = Environment()
        self.assertIsNone(env.tools())
        self.assertIsNone(env.setup(Task.from_dict({"prompt": "q"}), "r1"))
        self.assertEqual(env.step(None, action), Observation(done=True))
        self.assertIsNone(env.teardown(None))
        with self.assertRaises(ValueError):
            Environment(max_turns=0)
        with self.assertRaises(NotImplementedError):
            env.evaluate(None, Trajectory(messages=[]))
        scored: Environment[Any] = Environment(
            Rubric([Scorer("says_hi", fn=lambda t: "hi" in t.text), StatefulScorer("handle", fn=lambda t, h: h == "state")]),
            max_turns=2,
            system_prompt="Be brief.",
        )
        traj = Trajectory(messages=[{"role": "user", "content": "q"}, {"role": "assistant", "content": "hi"}])
        self.assertEqual(scored.evaluate("state", traj), {"says_hi": 1.0, "handle": 1.0})
        self.assertEqual((scored.max_turns, scored.system_prompt), (2, "Be brief."))
        self.assertEqual(StepOutcome("o", done=True, reward=1.0).observation, "o")


if __name__ == "__main__":
    unittest.main()
