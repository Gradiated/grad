"""Dataset records: trajectories, chat records, preference pairs, triplets, tasks, contexts.

Every helper here serialises to the ``DatasetRecord`` wire shape (``to_dict()``), and
plain dicts are accepted everywhere a record is. :class:`Trajectory` is also what local
Python scorers receive: ``traj.text`` is the final assistant answer, ``traj.input.messages``
the prompt turns, ``traj.metadata`` / ``traj.scores`` / ``traj.expected_output`` the
record's own fields.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence

__all__ = [
    "Context",
    "PreferencePair",
    "Record",
    "Task",
    "Trajectory",
    "TrajectoryInput",
    "TrajectoryOutput",
    "Triplet",
    "coerce_record",
]

MAX_CONTEXT_CHARS = 4_000_000
"""Longest ``Context.from_text``/``from_file`` document the server accepts (``context_text``)."""


def _content_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, Mapping) and isinstance(part.get("text"), str):
                parts.append(part["text"])
            elif isinstance(part, str):
                parts.append(part)
        return "".join(parts)
    return str(content)


@dataclass(frozen=True)
class TrajectoryInput:
    """The prompt side of a trajectory: every turn before the final assistant answer."""

    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]] | None = None


@dataclass(frozen=True)
class TrajectoryOutput:
    """The model's answer: the trailing assistant turns and their concatenated ``text``."""

    turns: list[dict[str, Any]]

    @property
    def text(self) -> str:
        """Text of the final assistant turn (``""`` when there is none)."""
        return _content_text(self.turns[-1].get("content")) if self.turns else ""


@dataclass
class Trajectory:
    """A logged multi-turn interaction, the unit of training data and of scoring.

    ``messages`` use the OpenAI chat format; set ``"train": False`` on a message to
    exclude it from the loss. ``scores``, ``metrics`` and ``metadata`` travel with the
    record and are what filters, routers and scorers read.
    """

    messages: list[dict[str, Any]] = field(default_factory=list)
    session_id: str | None = None
    group_id: str | None = None
    tools: list[dict[str, Any]] | None = None
    scores: dict[str, float] = field(default_factory=dict)
    metrics: dict[str, float] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    expected_output: Any = None
    role: str | None = None
    id: str | None = None
    source: str | None = None
    timestamp: str | None = None

    @classmethod
    def from_messages(
        cls,
        messages: Sequence[Mapping[str, Any]],
        *,
        session_id: str | None = None,
        group_id: str | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        scores: Mapping[str, float] | None = None,
        metrics: Mapping[str, float] | None = None,
        metadata: Mapping[str, Any] | None = None,
        expected_output: Any = None,
    ) -> Trajectory:
        """Build a trajectory from chat messages (the OpenAI fine-tuning format)."""
        return cls(
            messages=[dict(m) for m in messages],
            session_id=session_id,
            group_id=group_id,
            tools=[dict(t) for t in tools] if tools is not None else None,
            scores={str(k): float(v) for k, v in (scores or {}).items()},
            metrics={str(k): float(v) for k, v in (metrics or {}).items()},
            metadata=dict(metadata or {}),
            expected_output=expected_output,
        )

    @classmethod
    def from_record(cls, record: Mapping[str, Any]) -> Trajectory:
        """Build a trajectory view of a ``DatasetRecord`` dict (as returned by the API)."""
        messages = record.get("messages")
        if not isinstance(messages, list):
            messages = []
            inp = record.get("input")
            if isinstance(inp, Mapping) and isinstance(inp.get("messages"), list):
                messages.extend(inp["messages"])
            prompt = record.get("prompt")
            if isinstance(prompt, str):
                messages.append({"role": "user", "content": prompt})
            elif isinstance(prompt, list):
                messages.extend(prompt)
            out = record.get("output")
            if isinstance(out, Mapping) and isinstance(out.get("turns"), list):
                messages.extend(out["turns"])
            completion = record.get("completion")
            if isinstance(completion, str):
                messages.append({"role": "assistant", "content": completion})
            elif isinstance(completion, list):
                messages.extend(completion)
        return cls(
            messages=[dict(m) for m in messages if isinstance(m, Mapping)],
            session_id=record.get("session_id"),
            group_id=record.get("group_id"),
            tools=record.get("tools"),
            scores=dict(record.get("scores") or {}),
            metrics=dict(record.get("metrics") or {}),
            metadata=dict(record.get("metadata") or {}),
            expected_output=record.get("expected_output"),
            role=record.get("role"),
            id=record.get("id"),
            source=record.get("source"),
            timestamp=record.get("timestamp"),
        )

    def _split(self) -> int:
        idx = len(self.messages)
        while idx > 0 and self.messages[idx - 1].get("role") == "assistant":
            idx -= 1
        return idx

    @property
    def input(self) -> TrajectoryInput:
        """Prompt turns (everything before the trailing assistant turns)."""
        return TrajectoryInput(self.messages[: self._split()], self.tools)

    @property
    def output(self) -> TrajectoryOutput:
        """Trailing assistant turns (the answer being trained or scored)."""
        return TrajectoryOutput(self.messages[self._split() :])

    @property
    def text(self) -> str:
        """Text of the final assistant turn; ``""`` if the trajectory has no answer yet."""
        return self.output.text

    def append_env_tokens(self, content: str, *, role: str = "tool") -> Trajectory:
        """Append an environment/tool observation that is never trained on."""
        self.messages.append({"role": role, "content": content, "train": False})
        return self

    def with_targets(self, *, scores: Mapping[str, float] | None = None, expected_output: Any = None) -> Trajectory:
        """Attach outcome scores and/or a gold ``expected_output``; returns ``self``."""
        if scores:
            self.scores.update({str(k): float(v) for k, v in scores.items()})
        if expected_output is not None:
            self.expected_output = expected_output
        return self

    def to_dict(self) -> dict[str, Any]:
        """The ``DatasetRecord`` wire form."""
        out: dict[str, Any] = {"messages": [dict(m) for m in self.messages]}
        for key in ("session_id", "group_id", "role", "id", "source", "timestamp"):
            value = getattr(self, key)
            if value is not None:
                out[key] = value
        if self.tools is not None:
            out["tools"] = [dict(t) for t in self.tools]
        if self.scores:
            out["scores"] = dict(self.scores)
        if self.metrics:
            out["metrics"] = dict(self.metrics)
        if self.metadata:
            out["metadata"] = dict(self.metadata)
        if self.expected_output is not None:
            out["expected_output"] = self.expected_output
        return out


_RECORD_FIELDS = (
    "messages",
    "prompt",
    "completion",
    "chosen",
    "rejected",
    "query",
    "positive",
    "negatives",
    "state",
    "questions",
    "expected_output",
    "tools",
    "session_id",
    "group_id",
    "role",
    "id",
    "scores",
    "metrics",
    "metadata",
)


@dataclass
class Record:
    """An explicit dataset record for structured recipes (decision models, cartridges, ...).

    Only the fields you set are sent. Decision-model records use ``state``,
    ``questions`` and ``expected_output``; cartridge datasets use ``prompt`` or
    ``messages`` without an answer.
    """

    messages: list[dict[str, Any]] | None = None
    prompt: str | list[dict[str, Any]] | None = None
    completion: str | list[dict[str, Any]] | None = None
    chosen: str | list[dict[str, Any]] | None = None
    rejected: str | list[dict[str, Any]] | None = None
    query: str | None = None
    positive: str | None = None
    negatives: list[str] | None = None
    state: Any = None
    questions: dict[str, Any] | None = None
    expected_output: Any = None
    tools: list[dict[str, Any]] | None = None
    session_id: str | None = None
    group_id: str | None = None
    role: str | None = None
    id: str | None = None
    scores: dict[str, float] | None = None
    metrics: dict[str, float] | None = None
    metadata: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        """The ``DatasetRecord`` wire form (unset fields omitted)."""
        return {name: getattr(self, name) for name in _RECORD_FIELDS if getattr(self, name) is not None}


@dataclass
class PreferencePair:
    """A DPO preference pair: one prompt, a preferred and a rejected answer.

    ``group_id`` keeps a pair on one side of the train/eval split.
    """

    prompt: str | list[dict[str, Any]]
    chosen: str | list[dict[str, Any]]
    rejected: str | list[dict[str, Any]]
    session_id: str | None = None
    group_id: str | None = None
    metadata: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        """The ``DatasetRecord`` wire form."""
        out: dict[str, Any] = {"prompt": self.prompt, "chosen": self.chosen, "rejected": self.rejected}
        for key in ("session_id", "group_id", "metadata"):
            value = getattr(self, key)
            if value is not None:
                out[key] = value
        return out


@dataclass
class Triplet:
    """An embedding training example: a query, a relevant passage and optional hard negatives."""

    query: str
    positive: str
    negatives: list[str] = field(default_factory=list)
    session_id: str | None = None
    metadata: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        """The ``DatasetRecord`` wire form."""
        out: dict[str, Any] = {"query": self.query, "positive": self.positive}
        if self.negatives:
            out["negatives"] = list(self.negatives)
        if self.session_id is not None:
            out["session_id"] = self.session_id
        if self.metadata is not None:
            out["metadata"] = self.metadata
        return out


@dataclass
class Task:
    """A prompt to attempt, for evaluations and environment rollouts.

    Environments receive one as ``setup(task, rollout_id)``; ``seed`` carries per-task
    fixtures and ``messages`` the full prompt when it is a conversation.
    """

    prompt: str | None = None
    messages: list[dict[str, Any]] | None = None
    expected_output: Any = None
    seed: dict[str, Any] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)
    max_turns: int | None = None
    id: str | None = None

    @classmethod
    def from_dict(cls, data: Mapping[str, Any], *, id: str | None = None) -> Task:
        """Build a task from a dispatched task payload or a dataset record."""
        prompt = data.get("prompt")
        messages = data.get("messages")
        max_turns = data.get("max_turns")
        return cls(
            prompt=prompt if isinstance(prompt, str) else None,
            messages=[dict(m) for m in messages] if isinstance(messages, list) else (prompt if isinstance(prompt, list) else None),
            expected_output=data.get("expected_output", data.get("answer")),
            seed=dict(data.get("seed") or {}),
            metadata=dict(data.get("metadata") or {}),
            max_turns=int(max_turns) if isinstance(max_turns, (int, float)) and not isinstance(max_turns, bool) else None,
            id=id or (str(data["id"]) if data.get("id") is not None else None),
        )

    @property
    def expected(self) -> Any:
        """Alias of ``expected_output``."""
        return self.expected_output

    def prompt_messages(self) -> list[dict[str, Any]]:
        """The task as chat messages (``prompt`` becomes one user turn)."""
        if self.messages:
            return [dict(m) for m in self.messages]
        return [{"role": "user", "content": self.prompt or ""}]

    def to_dict(self) -> dict[str, Any]:
        """The wire form (also a valid ``DatasetRecord`` when only prompt fields are set)."""
        out: dict[str, Any] = {}
        if self.prompt is not None:
            out["prompt"] = self.prompt
        if self.messages is not None:
            out["messages"] = self.messages
        if self.expected_output is not None:
            out["expected_output"] = self.expected_output
        if self.metadata or self.seed:
            out["metadata"] = {**self.metadata, **({"seed": self.seed} if self.seed else {})}
        return out


@dataclass(frozen=True)
class Context:
    """The long document a :class:`grad.recipes.CartridgeRecipe` compresses into a prefix.

    It is sent inline as ``context_text``; build one with :meth:`from_text` or :meth:`from_file`.
    """

    text: str

    def __post_init__(self) -> None:
        if not isinstance(self.text, str):
            raise TypeError(f"Context text must be a str, got {type(self.text).__name__}.")
        if not self.text.strip():
            raise ValueError("Context text is empty.")
        if len(self.text) > MAX_CONTEXT_CHARS:
            raise ValueError(f"Context is {len(self.text):,} characters; the limit is {MAX_CONTEXT_CHARS:,}. Split the document or shorten it.")

    @classmethod
    def from_text(cls, text: str) -> Context:
        """Use ``text`` as the context."""
        return cls(text=text)

    @classmethod
    def from_file(cls, path: str | os.PathLike[str], *, encoding: str = "utf-8") -> Context:
        """Read a local text file (Markdown, plain text, ...) as the context; it is sent inline."""
        return cls(text=Path(path).read_text(encoding=encoding))

    def to_recipe_fields(self) -> dict[str, str]:
        """The recipe wire field (``context_text``)."""
        return {"context_text": self.text}


def coerce_record(item: Any) -> dict[str, Any]:
    """Accept a plain dict or any object with ``to_dict()`` and return the wire dict."""
    if isinstance(item, Mapping):
        return dict(item)
    to_dict = getattr(item, "to_dict", None)
    if callable(to_dict):
        out = to_dict()
        if isinstance(out, Mapping):
            return dict(out)
    raise TypeError(
        f"Expected a record dict or a Trajectory/Record/PreferencePair/Triplet, got {type(item).__name__}. "
        "To push a file, pass its path: client.datasets.push(name, './train.jsonl')."
    )
