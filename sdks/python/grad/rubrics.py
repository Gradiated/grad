"""Unified Rubric, Judge (explicit model required), Scorer, and validator helpers."""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Any, Callable, Sequence


@dataclass(frozen=True)
class Judge:
    """LLM-as-judge scorer. Requires an explicit model (never silently defaults)."""

    model: str
    prompt: str
    name: str = "judge"
    weight: float = 1.0

    def __post_init__(self) -> None:
        if not self.model or not self.model.strip():
            raise ValueError("Judge requires an explicit non-empty 'model'.")
        if not self.prompt or not self.prompt.strip():
            raise ValueError("Judge requires a non-empty 'prompt'.")

    def to_wire_item(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "kind": "judge",
            "model": self.model,
            "prompt": self.prompt,
            "weight": self.weight,
        }


@dataclass(frozen=True)
class Scorer:
    """Optional named wrapper around a Python scorer function or built-in validator."""

    fn: Callable[[Any, Any], float | bool] | None = None
    name: str = "scorer"
    weight: float = 1.0
    validator: str | None = None
    pattern: str | None = None

    def score(self, output: Any, expected: Any = None) -> float:
        if self.fn is not None:
            res = self.fn(output, expected)
            if isinstance(res, bool):
                raise ValueError(
                    f"Scorer '{self.name}' returned bool {res!r}; return a float in [0.0, 1.0]."
                )
            if not isinstance(res, (int, float)) or not math.isfinite(float(res)):
                raise ValueError(
                    f"Scorer '{self.name}' returned non-finite/non-numeric value {res!r}."
                )
            return float(res)
        text = output if isinstance(output, str) else json.dumps(output)
        if self.pattern is not None:
            return 1.0 if re.search(self.pattern, text) else 0.0
        if self.validator == "json":
            try:
                json.loads(text)
                return 1.0
            except Exception:
                return 0.0
        if self.validator == "exact_match":
            return 1.0 if text.strip() == str(expected or "").strip() else 0.0
        return 1.0 if text.strip() else 0.0

    def to_wire_item(self) -> dict[str, Any]:
        if self.pattern is not None:
            return {
                "name": self.name,
                "kind": "regex",
                "pattern": self.pattern,
                "weight": self.weight,
            }
        if self.validator is not None:
            return {
                "name": self.name,
                "kind": "validator",
                "validator": self.validator,
                "weight": self.weight,
            }
        return {"name": self.name, "kind": "code", "weight": self.weight}


class validators:
    """Built-in deterministic validators usable directly in a Rubric."""

    @staticmethod
    def json_valid(name: str = "valid_json", weight: float = 1.0) -> Scorer:
        return Scorer(name=name, validator="json", weight=weight)

    @staticmethod
    def non_empty(name: str = "non_empty", weight: float = 1.0) -> Scorer:
        return Scorer(name=name, validator="non_empty", weight=weight)

    @staticmethod
    def exact_match(name: str = "exact_match", weight: float = 1.0) -> Scorer:
        return Scorer(name=name, validator="exact_match", weight=weight)

    @staticmethod
    def regex(pattern: str, *, name: str = "regex", weight: float = 1.0) -> Scorer:
        return Scorer(name=name, pattern=pattern, weight=weight)


class Rubric:
    """Weighted combination of plain callables, Scorers, or Judges."""

    def __init__(
        self,
        items: Sequence[Judge | Scorer | Callable[[Any, Any], float | bool] | tuple[Any, float]],
    ) -> None:
        if not items:
            raise ValueError("Rubric requires at least one scorer or judge.")
        self.entries: list[Judge | Scorer] = []
        for idx, item in enumerate(items):
            if isinstance(item, tuple) and len(item) == 2:
                raw_item, weight = item
                if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not math.isfinite(float(weight)) or float(weight) <= 0.0:
                    raise ValueError(f"Rubric weight must be a finite positive number, got {weight!r}.")
                self.entries.append(_coerce_entry(raw_item, idx, weight=float(weight)))
            else:
                self.entries.append(_coerce_entry(item, idx))

    def to_wire_items(self) -> list[dict[str, Any]]:
        return [entry.to_wire_item() for entry in self.entries]

    def dry_run(self, sample_record: dict[str, Any]) -> dict[str, float]:
        """Run all local Python scorers once on a sample record so bugs fail at plan time."""
        output = _sample_output(sample_record)
        expected = sample_record.get("expected_output")
        scores: dict[str, float] = {}
        for entry in self.entries:
            if isinstance(entry, Scorer):
                val = entry.score(output, expected)
                if not (0.0 <= val <= 1.0):
                    raise ValueError(
                        f"Scorer '{entry.name}' returned {val}, expected score in [0.0, 1.0]."
                    )
                scores[entry.name] = val
        return scores


def _sample_output(record: dict[str, Any]) -> Any:
    msgs = record.get("messages")
    if isinstance(msgs, list):
        for msg in reversed(msgs):
            if isinstance(msg, dict) and msg.get("role") == "assistant":
                return msg.get("content", "")
    return record.get("expected_output", "sample output")


def _coerce_entry(item: Any, idx: int, *, weight: float | None = None) -> Judge | Scorer:
    if isinstance(item, Judge):
        if weight is not None:
            return Judge(
                model=item.model, prompt=item.prompt, name=item.name, weight=weight
            )
        return item
    if isinstance(item, Scorer):
        if weight is not None:
            return Scorer(
                fn=item.fn,
                name=item.name,
                weight=weight,
                validator=item.validator,
                pattern=item.pattern,
            )
        return item
    if callable(item):
        fn_name = getattr(item, "__name__", f"scorer_{idx}")
        return Scorer(fn=item, name=fn_name, weight=weight if weight is not None else 1.0)
    raise TypeError(
        f"Rubric item must be a callable, Scorer, or Judge; got {type(item).__name__}."
    )


def coerce_rubric(rubric: Any) -> Rubric:
    """Accept a plain callable, Judge, Scorer, list, or Rubric."""
    if isinstance(rubric, Rubric):
        return rubric
    if isinstance(rubric, (list, tuple)):
        return Rubric(rubric)
    return Rubric([rubric])
