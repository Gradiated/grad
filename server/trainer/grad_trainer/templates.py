"""Pinned chat template and loss-mask renderer matching server/api/src/planner.ts."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Literal, Sequence

TEMPLATE_REVISIONS: dict[str, str] = {
    "qwen/qwen3-0.6b": "qwen3@3",
    "qwen/qwen3-1.7b": "qwen3@3",
    "qwen/qwen3-4b": "qwen3@3",
    "qwen/qwen3-8b": "qwen3@3",
    "qwen/qwen3-14b": "qwen3@3",
    "qwen/qwen3-32b": "qwen3@3",
    "gradiated/linden-1": "systemone@1",
    "baai/bge-small-en-v1.5": "bge@1",
}

_THINK_RE = re.compile(r"<think>[\s\S]*?</think>")
_THINK_STRIP_RE = re.compile(r"<think>[\s\S]*?</think>\s*")


@dataclass(frozen=True)
class RenderedSpan:
    text: str
    trained: bool
    tokens: int


@dataclass(frozen=True)
class RenderedExample:
    record_id: str
    template_revision: str
    total_tokens: int
    trained_tokens: int
    trained_fraction: float
    spans: tuple[RenderedSpan, ...]

    @property
    def full_text(self) -> str:
        return "".join(span.text for span in self.spans)

    @property
    def trained_text(self) -> str:
        return "".join(span.text for span in self.spans if span.trained)


def estimate_text_tokens(text: str) -> int:
    trimmed = text.strip()
    if not trimmed:
        return 0
    return max(1, math.ceil(len(trimmed) / 4))


def template_revision_for_model(model: str) -> str:
    return TEMPLATE_REVISIONS.get(model.strip().lower(), "qwen3@3")


def render_messages(
    record_id: str,
    messages: Sequence[dict[str, Any]],
    *,
    model: str = "qwen/qwen3-8b",
    train_on: Literal["last", "all_assistant"] = "last",
    thinking: Literal["auto", "on", "off"] = "auto",
    preserve_thinking: bool = False,
) -> RenderedExample:
    """Render messages with pinned template rules and explicit loss masking."""
    revision = template_revision_for_model(model)

    last_assistant_idx = -1
    for idx in range(len(messages) - 1, -1, -1):
        if messages[idx].get("role") == "assistant":
            last_assistant_idx = idx
            break

    spans: list[RenderedSpan] = []
    total_tokens = 0
    trained_tokens = 0

    for idx, msg in enumerate(messages):
        role = str(msg.get("role", "user"))
        raw_content = str(msg.get("content") or "")
        is_assistant = role == "assistant"
        is_last_assistant = idx == last_assistant_idx

        explicit_train = msg.get("train")
        if explicit_train is not None:
            trained = bool(explicit_train)
        elif is_assistant:
            trained = train_on == "all_assistant" or is_last_assistant
        else:
            trained = False

        if trained and is_assistant:
            has_think = bool(_THINK_RE.search(raw_content))
            if thinking == "off" and has_think:
                raise ValueError(
                    f"Record '{record_id}' contains a <think> block but thinking='off'."
                )
            if thinking == "on" and not has_think:
                raise ValueError(
                    f"Record '{record_id}' has no <think> block but thinking='on'."
                )

        content = (
            _THINK_STRIP_RE.sub("", raw_content)
            if (is_assistant and not is_last_assistant and not preserve_thinking)
            else raw_content
        )

        header = f"<|im_start|>{role}\n"
        body = f"{content}<|im_end|>\n"
        header_tokens = estimate_text_tokens(header) + 2
        body_tokens = estimate_text_tokens(body) + 1

        spans.append(RenderedSpan(text=header, trained=False, tokens=header_tokens))
        spans.append(RenderedSpan(text=body, trained=trained, tokens=body_tokens))
        total_tokens += header_tokens + body_tokens
        if trained:
            trained_tokens += body_tokens

    fraction = trained_tokens / total_tokens if total_tokens > 0 else 0.0
    return RenderedExample(
        record_id=record_id,
        template_revision=revision,
        total_tokens=total_tokens,
        trained_tokens=trained_tokens,
        trained_fraction=round(fraction, 6),
        spans=tuple(spans),
    )
