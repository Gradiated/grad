"""Typed environment definitions for Wave 2 RL (``GRPORecipe(env=...)``).

An :class:`Environment` hands out one *handle* per rollout, so parallel attempts never
share mutable state::

    class TicketEnv(Environment[Store]):
        def setup(self, task: Task, rollout_id: str) -> Store: ...
        def step(self, handle: Store, action: Action) -> Observation: ...
        def evaluate(self, handle: Store, trajectory: Trajectory) -> float | dict[str, float]: ...
        def teardown(self, handle: Store) -> None: ...

v0 servers do not run environments; the classes are typed so code written against them
keeps importing when Wave 2 lands.
"""

from __future__ import annotations

import inspect
import json
import typing
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Generic, TypeVar

from .records import Task, Trajectory
from .rubrics import Rubric, Scorer, coerce_rubric

__all__ = [
    "Action",
    "Environment",
    "Observation",
    "StepOutcome",
    "ToolCall",
    "ToolsEnvironment",
    "environments",
]

H = TypeVar("H")


@dataclass(frozen=True)
class ToolCall:
    """One tool call the model made (``arguments`` already JSON-decoded)."""

    name: str
    arguments: dict[str, Any] = field(default_factory=dict)
    id: str | None = None


@dataclass(frozen=True)
class Action:
    """The model's turn: its text and any tool calls."""

    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    message: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_message(cls, message: Mapping[str, Any]) -> Action:
        """Parse an OpenAI-format assistant message."""
        calls = []
        for raw in message.get("tool_calls") or []:
            fn = raw.get("function") or {}
            args = fn.get("arguments", {})
            if isinstance(args, str):
                try:
                    args = json.loads(args) if args.strip() else {}
                except ValueError:
                    args = {"_raw": args}
            calls.append(ToolCall(name=str(fn.get("name", "")), arguments=dict(args) if isinstance(args, Mapping) else {"_raw": args}, id=raw.get("id")))
        content = message.get("content")
        return cls(text=content if isinstance(content, str) else "", tool_calls=calls, message=dict(message))


@dataclass
class Observation:
    """What the environment returns after a step.

    ``text`` is shown to the model as the next (untrained) turn; set ``messages`` to
    control the exact turns (e.g. ``tool`` results with ``tool_call_id``). ``done`` ends
    the rollout.
    """

    text: str = ""
    done: bool = False
    reward: float | None = None
    info: dict[str, Any] = field(default_factory=dict)
    messages: list[dict[str, Any]] | None = None


class StepOutcome(Observation):
    """Alias of :class:`Observation` (0.1 SDK name; ``observation`` is ``text``)."""

    def __init__(self, observation: str = "", done: bool = False, reward: float | None = None, info: dict[str, Any] | None = None) -> None:
        super().__init__(text=observation, done=done, reward=reward, info=dict(info or {}))

    @property
    def observation(self) -> str:
        """The observation text."""
        return self.text


class Environment(Generic[H]):
    """Base class for environments. Override ``setup``/``step``/``evaluate``/``teardown``.

    The default is a single-turn environment: the model answers once and the answer is
    scored by ``rubric`` (``Scorer``/``StatefulScorer``/validators, run in this process).
    One instance serves many rollouts concurrently, so keep per-rollout state in the
    handle ``setup`` returns.
    """

    max_turns: int = 1
    system_prompt: str | None = None

    def __init__(self, rubric: Any = None, *, max_turns: int | None = None, system_prompt: str | None = None) -> None:
        self.rubric: Rubric | None = None if rubric is None else coerce_rubric(rubric)
        if max_turns is not None:
            if max_turns < 1:
                raise ValueError("max_turns must be at least 1.")
            self.max_turns = max_turns
        if system_prompt is not None:
            self.system_prompt = system_prompt

    def tools(self) -> list[dict[str, Any]] | None:
        """OpenAI tool definitions offered to the model (``None`` for none)."""
        return None

    def setup(self, task: Task, rollout_id: str) -> H:
        """Prepare one rollout and return its handle (default: no state)."""
        return None  # type: ignore[return-value]

    def step(self, handle: H, action: Action) -> Observation:
        """React to the model's turn. Default: the first answer ends the rollout."""
        return Observation(done=True)

    def evaluate(self, handle: H, trajectory: Trajectory) -> float | Mapping[str, float]:
        """Score the finished rollout: a float, or named scores combined by the rubric weights."""
        if self.rubric is None:
            raise NotImplementedError(
                f"{type(self).__name__} has no rubric and does not override evaluate(); "
                "pass rubric=Rubric([...]) or implement evaluate(handle, trajectory)."
            )
        return self.rubric.score_local(trajectory, handle)

    def teardown(self, handle: H) -> None:
        """Release the rollout's resources (always called, even after errors)."""
        return None


def _json_type(annotation: Any) -> dict[str, Any]:
    origin = typing.get_origin(annotation)
    if annotation in (inspect.Parameter.empty, Any):
        return {}
    if annotation is str:
        return {"type": "string"}
    if annotation is bool:
        return {"type": "boolean"}
    if annotation is int:
        return {"type": "integer"}
    if annotation is float:
        return {"type": "number"}
    if origin in (list, Sequence) or annotation is list:
        args = typing.get_args(annotation)
        return {"type": "array", "items": _json_type(args[0]) if args else {}}
    if origin in (dict, Mapping) or annotation is dict:
        return {"type": "object"}
    if origin is typing.Literal:
        return {"enum": list(typing.get_args(annotation))}
    members = [a for a in typing.get_args(annotation) if a is not type(None)]
    if len(members) == 1:
        return _json_type(members[0])
    return {}


def tool_schema(fn: Callable[..., Any]) -> dict[str, Any]:
    """An OpenAI ``function`` tool definition from a typed Python function and its docstring."""
    sig = inspect.signature(fn)
    hints = typing.get_type_hints(fn)
    props: dict[str, Any] = {}
    required = []
    for name, param in sig.parameters.items():
        if param.kind in (param.VAR_POSITIONAL, param.VAR_KEYWORD):
            continue
        props[name] = _json_type(hints.get(name, param.annotation))
        if param.default is inspect.Parameter.empty:
            required.append(name)
    doc = inspect.getdoc(fn) or ""
    return {
        "type": "function",
        "function": {
            "name": fn.__name__,
            "description": doc.split("\n\n")[0],
            "parameters": {"type": "object", "properties": props, "required": required},
        },
    }


class ToolsEnvironment(Environment[None]):
    """Multi-turn tool use: the model calls your Python functions until it answers in text.

    Each function's signature and docstring become its JSON schema. Tool exceptions are
    returned to the model as an error result. ``requirements`` are checked against the
    locally installed packages when the worker starts.
    """

    def __init__(
        self,
        tools: Sequence[Callable[..., Any]],
        *,
        tasks: Any = None,
        rubric: Any = None,
        max_turns: int | None = None,
        system_prompt: str | None = None,
        requirements: Sequence[str] | None = None,
    ) -> None:
        super().__init__(rubric, max_turns=max_turns if max_turns is not None else (10 if tools else 1), system_prompt=system_prompt)
        self.functions = {fn.__name__: fn for fn in tools}
        if len(self.functions) != len(tools):
            raise ValueError("Tool function names must be unique.")
        self.tasks = tasks
        self.requirements = [str(r) for r in (requirements or [])]
        self._schemas = [tool_schema(fn) for fn in tools]

    def check_requirements(self) -> None:
        """Raise when a declared requirement is not installed."""
        Scorer("tools", fn=lambda _t: 0.0, requirements=self.requirements).check_requirements()

    def tools(self) -> list[dict[str, Any]] | None:
        """The tool definitions."""
        return list(self._schemas) or None

    def step(self, handle: None, action: Action) -> Observation:
        """Run each requested tool; the rollout ends on a turn without tool calls."""
        if not action.tool_calls:
            return Observation(done=True)
        messages = []
        for call in action.tool_calls:
            fn = self.functions.get(call.name)
            if fn is None:
                content = json.dumps({"error": f"unknown tool {call.name!r}; available: {sorted(self.functions)}"})
            else:
                try:
                    result = fn(**call.arguments)
                    content = result if isinstance(result, str) else json.dumps(result, default=str)
                except Exception as exc:  # the model sees the failure and can retry
                    content = json.dumps({"error": f"{type(exc).__name__}: {exc}"})
            msg: dict[str, Any] = {"role": "tool", "content": content, "train": False}
            if call.id:
                msg["tool_call_id"] = call.id
            messages.append(msg)
        return Observation(text="\n".join(m["content"] for m in messages), done=False, messages=messages)


class environments:
    """Environment constructors (``environments.Tools``)."""

    Tools = ToolsEnvironment
