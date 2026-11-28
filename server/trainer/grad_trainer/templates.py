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
A tokenized example is two numpy arrays (int32 ids, bool mask): 5 bytes a token, where tuples
of Python ints took about 48 (a 1M-example SFT dataset is held in memory for the whole run).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Sequence

import numpy as np

from .errors import RecipeConfigError, RecipeDataError

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
    input_ids: np.ndarray  # int32 [T]
    trained: np.ndarray  # bool [T]
    truncated: bool

    @property
    def num_trained(self) -> int:
        return int(np.count_nonzero(self.trained))


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
    return tokenize_rendered_batch([rendered], tokenizer, max_len=max_len)[0]


def tokenize_rendered_batch(
    rendered: Sequence[RenderedChat],
    tokenizer: Any,
    *,
    max_len: int | None = None,
) -> list[TokenizedExample]:
    """``tokenize_rendered`` for many chats in one tokenizer call (the Rust tokenizer encodes a
    batch on every core; one text at a time it uses one)."""
    if not rendered:
        return []
    enc = tokenizer([r.text for r in rendered], add_special_tokens=False, return_offsets_mapping=True)
    return [
        _tokenized(chat, ids, offsets, max_len)
        for chat, ids, offsets in zip(rendered, enc["input_ids"], enc["offset_mapping"])
    ]


def _tokenized(rendered: RenderedChat, token_ids: Sequence[int], offsets: Sequence[Any], max_len: int | None) -> TokenizedExample:
    ids = np.asarray(token_ids, dtype=np.int32)
    starts = np.fromiter((o[0] for o in offsets), dtype=np.int64, count=len(ids))

    span_starts: list[int] = []
    span_ends: list[int] = []
    pos = 0
    for seg in rendered.segments:
        if seg.trained:
            span_starts.append(pos)
            span_ends.append(pos + len(seg.text))
        pos += len(seg.text)

    # Segments are disjoint and in order: a token is trained when the last span starting at or
    # before it has not ended yet.
    trained = np.zeros(len(ids), dtype=bool)
    if span_starts:
        last = np.searchsorted(np.asarray(span_starts), starts, side="right") - 1
        trained = (last >= 0) & (starts < np.asarray(span_ends)[np.maximum(last, 0)])

    truncated = max_len is not None and len(ids) > max_len
    if truncated:
        ids, trained = ids[:max_len].copy(), trained[:max_len].copy()
    return TokenizedExample(input_ids=ids, trained=trained, truncated=truncated)
