"""File formats that don't belong to an observability provider.

- ``grad_trajectories``: native grad records (chat ``messages``, prompt/completion, preference
  pairs, embedding triplets, decision ``state``/``questions``, ``grad.trajectory/1``)
- ``openai_chat``: OpenAI chat fine-tuning JSONL (``messages`` + ``tools``)
- ``otel``: OpenTelemetry GenAI spans (``gen_ai.prompt.N.*`` and ``gen_ai.input.messages``) and
  OpenInference spans (``llm.input_messages.N.message.*``); attributes may be a dict or an
  OTLP JSON list of ``{key, value: {stringValue|intValue|...}}``

Provider formats (Langfuse, LangSmith, ...) live in ``grad_trainer.providers``, one class each.
"""

from __future__ import annotations

import json
from typing import Any, Callable

from .records import NATIVE_FIELDS, coerce_messages, coerce_scores, message, record_metadata


def parse_grad_trajectories(row: dict[str, Any]) -> dict[str, Any]:
    record = {k: row[k] for k in NATIVE_FIELDS if row.get(k) is not None}
    if "messages" in record:
        record["messages"] = coerce_messages(row["messages"])
    for key in ("id", "session_id", "group_id"):
        if key in record:
            record[key] = str(record[key])
    if "scores" in record:
        record["scores"] = coerce_scores(row["scores"])
        if not record["scores"]:
            del record["scores"]
    return record


def _otlp_value(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    for key in ("stringValue", "boolValue", "doubleValue"):
        if key in value:
            return value[key]
    if "intValue" in value:
        return int(value["intValue"])
    if "arrayValue" in value:
        return [_otlp_value(v) for v in value["arrayValue"].get("values", [])]
    return value


def _flatten(value: dict[str, Any], prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, val in value.items():
        name = f"{prefix}{key}"
        if isinstance(val, dict):
            out.update(_flatten(val, f"{name}."))
        elif isinstance(val, list) and val and all(isinstance(v, dict) for v in val) and key.endswith(("input_messages", "output_messages")):
            for i, item in enumerate(val):
                out.update(_flatten(item, f"{name}.{i}."))
        else:
            out[name] = val
    return out


def otel_attributes(row: dict[str, Any]) -> dict[str, Any]:
    """Span attributes as one flat dict with dotted keys (dict, nested dict or OTLP list)."""
    attrs = row.get("attributes")
    if isinstance(attrs, dict):
        return _flatten(attrs)
    if isinstance(attrs, list):
        return {str(a["key"]): _otlp_value(a.get("value")) for a in attrs if isinstance(a, dict) and "key" in a}
    return {}


def _indexed_messages(attrs: dict[str, Any], prefix: str, role_key: str, content_key: str, default_role: str) -> list[dict[str, Any]]:
    messages = []
    idx = 0
    while f"{prefix}.{idx}.{content_key}" in attrs or f"{prefix}.{idx}.{role_key}" in attrs:
        messages.append(
            {
                "role": str(attrs.get(f"{prefix}.{idx}.{role_key}", default_role)),
                "content": str(attrs.get(f"{prefix}.{idx}.{content_key}", "")),
            }
        )
        idx += 1
    return messages


def _json_messages(value: Any, default_role: str) -> list[dict[str, Any]]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return [{"role": default_role, "content": value}]
    if isinstance(value, list):
        out = []
        for msg in value:
            if isinstance(msg, dict) and isinstance(msg.get("parts"), list):
                text = "".join(str(p.get("content", "")) for p in msg["parts"] if isinstance(p, dict) and p.get("type") == "text")
                out.append({"role": str(msg.get("role", default_role)), "content": text})
            elif isinstance(msg, dict):
                out.append(message(msg, default_role))
        return out
    return coerce_messages(value, default_role)


def otel_messages(attrs: dict[str, Any]) -> list[dict[str, Any]]:
    messages = _indexed_messages(attrs, "gen_ai.prompt", "role", "content", "user")
    messages += _indexed_messages(attrs, "gen_ai.completion", "role", "content", "assistant")
    if not messages:  # OpenInference
        messages = _indexed_messages(attrs, "llm.input_messages", "message.role", "message.content", "user")
        messages += _indexed_messages(attrs, "llm.output_messages", "message.role", "message.content", "assistant")
    if not messages and "gen_ai.input.messages" in attrs:  # current GenAI semantic conventions
        messages = _json_messages(attrs["gen_ai.input.messages"], "user")
        messages += _json_messages(attrs.get("gen_ai.output.messages"), "assistant")
    return messages


def parse_otel(row: dict[str, Any]) -> dict[str, Any]:
    attrs = otel_attributes(row)
    record: dict[str, Any] = {"messages": otel_messages(attrs)}
    session = attrs.get("session.id") or attrs.get("gen_ai.conversation.id") or row.get("trace_id") or row.get("traceId")
    if session:
        record["session_id"] = str(session)
    span = row.get("span_id") or row.get("spanId")
    if span:
        record["id"] = str(span)
    model = attrs.get("gen_ai.request.model") or attrs.get("gen_ai.response.model") or attrs.get("llm.model_name")
    record["metadata"] = record_metadata("otel", model=str(model) if model else None)
    return record


def is_otel(row: dict[str, Any]) -> bool:
    return any(str(k).startswith(("gen_ai.", "llm.")) for k in otel_attributes(row))


FORMATS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "grad_trajectories": parse_grad_trajectories,
    "openai_chat": parse_grad_trajectories,  # same fields: messages (+ tools)
    "otel": parse_otel,
}
