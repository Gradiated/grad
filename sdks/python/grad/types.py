"""Core data types, adapters, splits, losses, and optimizer specs for grad-sdk."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Mapping, Sequence


@dataclass
class Trajectory:
    """Logged multi-turn interaction with explicit per-turn training mask support."""

    messages: list[dict[str, Any]] = field(default_factory=list)
    session_id: str | None = None
    group_id: str | None = None
    tools: list[dict[str, Any]] | None = None
    scores: dict[str, float] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_messages(
        cls,
        messages: Sequence[Mapping[str, Any]],
        *,
        session_id: str | None = None,
        group_id: str | None = None,
        tools: Sequence[Mapping[str, Any]] | None = None,
        scores: Mapping[str, float] | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> "Trajectory":
        return cls(
            messages=[dict(m) for m in messages],
            session_id=session_id,
            group_id=group_id,
            tools=[dict(t) for t in tools] if tools is not None else None,
            scores={str(k): float(v) for k, v in (scores or {}).items()},
            metadata=dict(metadata or {}),
        )

    def append_env_tokens(self, content: str, *, role: str = "tool") -> "Trajectory":
        """Append non-trained environment/tool observation tokens."""
        self.messages.append({"role": role, "content": content, "train": False})
        return self

    def with_targets(
        self,
        *,
        scores: Mapping[str, float] | None = None,
        expected_output: Any = None,
    ) -> "Trajectory":
        if scores:
            self.scores.update({str(k): float(v) for k, v in scores.items()})
        if expected_output is not None:
            self.metadata["expected_output"] = expected_output
        return self

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"messages": list(self.messages)}
        if self.session_id:
            out["session_id"] = self.session_id
        if self.group_id:
            out["group_id"] = self.group_id
        if self.tools is not None:
            out["tools"] = self.tools
        if self.scores:
            out["scores"] = dict(self.scores)
        if self.metadata:
            out["metadata"] = dict(self.metadata)
        return out


@dataclass
class Record:
    """Explicit training record for custom loops or structured datasets."""

    messages: list[dict[str, Any]] | None = None
    prompt: str | list[dict[str, Any]] | None = None
    expected_output: Any = None
    state: Any = None
    questions: dict[str, Any] | None = None
    session_id: str | None = None
    group_id: str | None = None
    scores: dict[str, float] | None = None
    metadata: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for attr in (
            "messages",
            "prompt",
            "expected_output",
            "state",
            "questions",
            "session_id",
            "group_id",
            "scores",
            "metadata",
        ):
            val = getattr(self, attr)
            if val is not None:
                out[attr] = val
        return out


@dataclass
class PreferencePair:
    prompt: str | list[dict[str, Any]]
    chosen: str | list[dict[str, Any]]
    rejected: str | list[dict[str, Any]]
    session_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "prompt": self.prompt,
            "chosen": self.chosen,
            "rejected": self.rejected,
        }
        if self.session_id:
            out["session_id"] = self.session_id
        return out


@dataclass
class Triplet:
    query: str
    positive: str
    negatives: list[str] = field(default_factory=list)
    session_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"query": self.query, "positive": self.positive}
        if self.negatives:
            out["negatives"] = list(self.negatives)
        if self.session_id:
            out["session_id"] = self.session_id
        return out


@dataclass
class Task:
    prompt: str
    expected_output: Any = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"prompt": self.prompt}
        if self.expected_output is not None:
            out["expected_output"] = self.expected_output
        if self.metadata:
            out["metadata"] = dict(self.metadata)
        return out


@dataclass
class Context:
    """Long-context document source for CartridgeRecipe."""

    text: str | None = None
    uri: str | None = None


def coerce_record(item: Any) -> dict[str, Any]:
    """Accept plain dicts or typed Record/Trajectory/PreferencePair/Triplet/Task objects."""
    if isinstance(item, dict):
        return dict(item)
    if hasattr(item, "to_dict") and callable(item.to_dict):
        return item.to_dict()
    raise TypeError(
        f"Expected dict or record object with .to_dict(), got {type(item).__name__}."
    )


class adapters:
    """Supported parameter-efficient adapter configurations (no Full FT for LLMs)."""

    @staticmethod
    def LoRA(
        *, rank: int = 32, alpha: int = 32, merge_on_export: bool = False
    ) -> dict[str, Any]:
        return {
            "kind": "lora",
            "rank": rank,
            "alpha": alpha,
            "merge_on_export": merge_on_export,
        }

    @staticmethod
    def PrefixKV(*, num_tokens: int = 256) -> dict[str, Any]:
        return {"kind": "prefix_kv", "num_tokens": num_tokens}

    @staticmethod
    def FrozenHead() -> dict[str, Any]:
        return {"kind": "frozen_head"}


class splits:
    """Dataset split specifications preventing train/eval leakage."""

    @staticmethod
    def BySession(eval_fraction: float | None = None, *, seed: int = 42) -> dict[str, Any]:
        out: dict[str, Any] = {"strategy": "by_session", "seed": seed}
        if eval_fraction is not None:
            out["eval_fraction"] = eval_fraction
        return out

    @staticmethod
    def ByGroup(eval_fraction: float | None = None, *, seed: int = 42) -> dict[str, Any]:
        out: dict[str, Any] = {"strategy": "by_group", "seed": seed}
        if eval_fraction is not None:
            out["eval_fraction"] = eval_fraction
        return out

    @staticmethod
    def Random(eval_fraction: float | None = None, *, seed: int = 42) -> dict[str, Any]:
        out: dict[str, Any] = {"strategy": "random", "seed": seed}
        if eval_fraction is not None:
            out["eval_fraction"] = eval_fraction
        return out


class losses:
    """Loss configuration helpers."""

    @staticmethod
    def CrossEntropy(
        reduction: Literal["per_example", "per_token"] = "per_example",
    ) -> dict[str, Any]:
        return {"kind": "cross_entropy", "reduction": reduction}

    @staticmethod
    def DPO(beta: float = 0.1) -> dict[str, Any]:
        return {"kind": "dpo", "beta": beta}

    @staticmethod
    def InfoNCE(temp: float = 0.05) -> dict[str, Any]:
        return {"kind": "infonce", "temp": temp}

    @staticmethod
    def TopKKLDistill(top_k: int = 32) -> dict[str, Any]:
        return {"kind": "top_k_kl_distill", "top_k": top_k}


class optim:
    """Optimizer presets."""

    @staticmethod
    def AdamW(
        lr: float | Literal["auto"] = "auto",
        *,
        weight_decay: float = 0.01,
        grad_clip: float = 1.0,
    ) -> dict[str, Any]:
        return {
            "kind": "adamw",
            "lr": lr,
            "weight_decay": weight_decay,
            "grad_clip": grad_clip,
        }
