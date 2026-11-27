"""Pinned chat templates and loss masks.

``qwen3@3`` reproduces the Hugging Face Qwen3 ``chat_template`` text exactly (the test suite
checks it against ``tokenizer.apply_chat_template`` with the upstream template), and splits
the text into segments marked trained / not trained:

- Only assistant turns can be trained. ``train_on="last"`` trains the final assistant turn,
  ``"all_assistant"`` every assistant turn; ``"train": true|false`` on a message overrides it.
  ``"train": true`` on a user, system or tool message is an error.
- A trained span starts after ``<|im_start|>assistant\\n`` and ends with ``<|im_end|>``.
- Thinking: the final assistant turn is rendered with a ``<think>`` block. When the target has
  reasoning, the block is trained. When it has none (``thinking="auto"`` or ``"off"``), the
  empty ``<think>\\n\\n</think>\\n\\n`` is rendered but masked: it is what Qwen3's generation
  prompt contains with thinking off, so the model learns to answer directly.
- Earlier assistant turns lose their reasoning, as upstream, unless ``preserve_thinking``.

Tokenization runs once over the whole rendered string (with offsets), so token boundaries are
exactly those of the full prompt; a token is trained when it starts inside a trained segment.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Sequence

from .errors import RecipeConfigError, RecipeDataError

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
# systemone@1 (linden-1) uses ChatML framing identical to qwen3@3 for the prompts it reads.
CHATML_REVISIONS = ("qwen3@3", "systemone@1")
THINKING_MODES = ("auto", "on", "off")


@dataclass(frozen=True)
class Segment:
    text: str
    trained: bool


@dataclass(frozen=True)
class RenderedChat:
    segments: tuple[Segment, ...]
    template_revision: str

    @property
    def text(self) -> str:
        return "".join(s.text for s in self.segments)

    @property
    def trained_text(self) -> str:
        return "".join(s.text for s in self.segments if s.trained)


@dataclass(frozen=True)
class TokenizedExample:
    input_ids: tuple[int, ...]
    trained: tuple[bool, ...]
    truncated: bool

    @property
    def num_trained(self) -> int:
        return sum(self.trained)


def template_revision_for_model(model: str) -> str:
    return TEMPLATE_REVISIONS.get(model.strip().lower(), "qwen3@3")


def message_text(content: Any) -> str:
    """OpenAI-style content: a string, or a list of parts with ``text``."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part if isinstance(part, str) else str(part.get("text", ""))
            for part in content
            if isinstance(part, (str, dict))
        )
    return str(content)


def _tojson(value: Any) -> str:
    # transformers' chat-template `tojson` filter: json.dumps(ensure_ascii=False).
    return json.dumps(value, ensure_ascii=False)


def _split_reasoning(msg: dict[str, Any]) -> tuple[str, str]:
    content = message_text(msg.get("content"))
    reasoning = msg.get("reasoning_content")
    if isinstance(reasoning, str):
        return reasoning, content
    if "</think>" in content:
        reasoning = content.split("</think>")[0].rstrip("\n").split("<think>")[-1].lstrip("\n")
        content = content.split("</think>")[-1].lstrip("\n")
        return reasoning, content
    return "", content


def _tool_calls_text(tool_calls: Any, content: str) -> str:
    out: list[str] = []
    for i, call in enumerate(tool_calls or []):
        if not isinstance(call, dict):
            raise RecipeDataError(f"tool_calls entries must be objects, got {call!r}.")
        if (i == 0 and content) or i > 0:
            out.append("\n")
        fn = call.get("function") or call
        args = fn.get("arguments", {})
        out.append('<tool_call>\n{"name": "')
        out.append(str(fn.get("name", "")))
        out.append('", "arguments": ')
        out.append(args if isinstance(args, str) else _tojson(args))
        out.append("}\n</tool_call>")
    return "".join(out)


def _last_query_index(messages: Sequence[dict[str, Any]]) -> int:
    for index in range(len(messages) - 1, -1, -1):
        msg = messages[index]
        content = msg.get("content")
        if (
            msg.get("role") == "user"
            and isinstance(content, str)
            and not (content.startswith("<tool_response>") and content.endswith("</tool_response>"))
        ):
            return index
    return len(messages) - 1


def render_chat(
    messages: Sequence[dict[str, Any]],
    *,
    record_id: str = "record",
    tools: Sequence[dict[str, Any]] | None = None,
    train_on: str = "last",
    thinking: str = "auto",
    preserve_thinking: bool = False,
    add_generation_prompt: bool = False,
    enable_thinking: bool = True,
    template_revision: str = "qwen3@3",
) -> RenderedChat:
    if template_revision not in CHATML_REVISIONS:
        raise RecipeConfigError(f"Template '{template_revision}' has no chat renderer.")
    if thinking not in THINKING_MODES:
        raise RecipeConfigError(
            f"thinking='{thinking}' is not supported by {template_revision}; use one of {list(THINKING_MODES)}."
        )
    if not messages:
        raise RecipeDataError(f"Record '{record_id}' has no messages.")
    for msg in messages:
        if not isinstance(msg, dict) or msg.get("role") not in ("system", "user", "assistant", "tool"):
            raise RecipeDataError(f"Record '{record_id}' has a message with an invalid role: {msg!r}.")

    segs: list[Segment] = []

    def emit(text: str, trained: bool = False) -> None:
        if text:
            segs.append(Segment(text, trained))

    first_is_system = messages[0].get("role") == "system"
    if tools:
        emit("<|im_start|>system\n")
        if first_is_system:
            emit(message_text(messages[0].get("content")) + "\n\n")
        emit(
            "# Tools\n\nYou may call one or more functions to assist with the user query.\n\n"
            "You are provided with function signatures within <tools></tools> XML tags:\n<tools>"
        )
        for tool in tools:
            emit("\n" + _tojson(tool))
        emit(
            "\n</tools>\n\nFor each function call, return a json object with function name and "
            "arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n"
            '{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call><|im_end|>\n'
        )
    elif first_is_system:
        emit("<|im_start|>system\n" + message_text(messages[0].get("content")) + "<|im_end|>\n")

    last_query = _last_query_index(messages)
    last_assistant = max(
        (i for i, m in enumerate(messages) if m.get("role") == "assistant"), default=-1
    )
    n = len(messages)
    for index, msg in enumerate(messages):
        role = msg["role"]
        explicit = msg.get("train")
        if explicit is not None and role != "assistant" and bool(explicit):
            raise RecipeDataError(
                f"Record '{record_id}': only assistant turns can be trained (message {index} is '{role}')."
            )
        if role == "user" or (role == "system" and index != 0):
            emit(f"<|im_start|>{role}\n{message_text(msg.get('content'))}<|im_end|>\n")
        elif role == "tool":
            if index == 0 or messages[index - 1].get("role") != "tool":
                emit("<|im_start|>user")
            emit("\n<tool_response>\n" + message_text(msg.get("content")) + "\n</tool_response>")
            if index == n - 1 or messages[index + 1].get("role") != "tool":
                emit("<|im_end|>\n")
        elif role == "assistant":
            trained = (
                bool(explicit)
                if explicit is not None
                else (train_on == "all_assistant" or index == last_assistant)
            )
            reasoning, content = _split_reasoning(msg)
            has_reasoning = bool(reasoning.strip("\n").strip())
            if trained and thinking == "off" and has_reasoning:
                raise RecipeDataError(
                    f"Record '{record_id}' message {index} contains reasoning but thinking='off'."
                )
            if trained and thinking == "on" and not has_reasoning:
                raise RecipeDataError(
                    f"Record '{record_id}' message {index} has no <think> reasoning but thinking='on'."
                )
            emit("<|im_start|>assistant\n")
            show_think = index > last_query and (index == n - 1 or bool(reasoning))
            if preserve_thinking and has_reasoning:
                show_think = True
            if show_think:
                think = "<think>\n" + reasoning.strip("\n") + "\n</think>\n\n"
                emit(think, trained and has_reasoning)
                body = content.lstrip("\n")
            else:
                body = content
            emit(body + _tool_calls_text(msg.get("tool_calls"), content) + "<|im_end|>", trained)
            emit("\n")

    if add_generation_prompt:
        emit("<|im_start|>assistant\n")
        if not enable_thinking:
            emit("<think>\n\n</think>\n\n")

    return RenderedChat(segments=tuple(segs), template_revision=template_revision)


def tokenize_rendered(
    rendered: RenderedChat,
    tokenizer: Any,
    *,
    max_len: int | None = None,
) -> TokenizedExample:
    """Tokenize the full rendered text once and map trained segments onto tokens."""
    text = rendered.text
    enc = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True)
    ids: list[int] = list(enc["input_ids"])
    offsets: list[tuple[int, int]] = [tuple(o) for o in enc["offset_mapping"]]

    spans: list[tuple[int, int]] = []
    pos = 0
    for seg in rendered.segments:
        if seg.trained:
            spans.append((pos, pos + len(seg.text)))
        pos += len(seg.text)

    trained: list[bool] = []
    span_idx = 0
    for start, _end in offsets:
        while span_idx < len(spans) and spans[span_idx][1] <= start:
            span_idx += 1
        trained.append(span_idx < len(spans) and spans[span_idx][0] <= start < spans[span_idx][1])

    truncated = max_len is not None and len(ids) > max_len
    if truncated:
        ids, trained = ids[:max_len], trained[:max_len]
    return TokenizedExample(input_ids=tuple(ids), trained=tuple(trained), truncated=truncated)
