"""Tier-1 trace parsers with format auto-detection.

Supported formats:

- ``grad_trajectories``: native grad records (chat ``messages``, preference pairs, embedding
  triplets, decision ``state``/``questions``, ``grad.trajectory/1``) and OpenAI chat JSONL
- ``gradiated``: Gradiated proxy trace export (``request``/``response``)
- ``otel``: OpenTelemetry GenAI spans (``gen_ai.prompt.N.*`` and ``gen_ai.input.messages``) and
  OpenInference spans (``llm.input_messages.N.message.*``); attributes may be a dict or an
  OTLP JSON list of ``{key, value: {stringValue|intValue|...}}``
- ``langfuse``, ``posthog`` (``$ai_generation``), ``braintrust``, ``langsmith``
"""

from __future__ import annotations

import json
from collections import Counter
from typing import Any, Callable, Iterable

SUPPORTED_CONNECTORS = (
    "grad_trajectories",
    "gradiated",
    "otel",
    "langfuse",
    "posthog",
    "braintrust",
    "langsmith",
)
MAX_DEPTH = 8

# DatasetRecord fields kept verbatim from native rows (server/api/src/contracts.ts).
NATIVE_FIELDS = (
    "id", "session_id", "group_id", "messages", "tools", "prompt", "chosen", "rejected", "query",
    "positive", "negatives", "state", "questions", "expected_output", "scores", "metrics",
    "metadata", "schema", "role", "input", "output",
)  # fmt: skip
_NON_CHAT_FIELDS = ("prompt", "chosen", "rejected", "query", "positive", "state", "questions", "expected_output", "input")


def _flatten_content(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                if isinstance(block.get("text"), str):
                    parts.append(block["text"])
                elif block.get("type") == "tool_result":
                    parts.append(_flatten_content(block.get("content")))
        return "\n".join(parts)
    return str(content)


def _anthropic_tool_calls(content: Any) -> list[dict[str, Any]]:
    if not isinstance(content, list):
        return []
    return [
        {
            "id": str(b.get("id", "")),
            "type": "function",
            "function": {"name": str(b.get("name", "")), "arguments": b.get("input", {})},
        }
        for b in content
        if isinstance(b, dict) and b.get("type") == "tool_use"
    ]


def _message(item: dict[str, Any], default_role: str) -> dict[str, Any]:
    content = item.get("content")
    role = str(item.get("role", default_role))
    msg: dict[str, Any] = {"role": role, "content": _flatten_content(content)}
    calls = item.get("tool_calls") or _anthropic_tool_calls(content)
    if calls:
        msg["tool_calls"] = calls
    if item.get("tool_call_id") is not None:
        msg["tool_call_id"] = str(item["tool_call_id"])
    if isinstance(content, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
        msg["role"] = "tool"
    if isinstance(item.get("reasoning_content"), str):
        msg["reasoning_content"] = item["reasoning_content"]
    return msg


def _coerce_messages(value: Any, default_role: str = "user", depth: int = 0) -> list[dict[str, Any]]:
    if value is None or value == {} or depth > MAX_DEPTH:
        return []
    if isinstance(value, str):
        return [{"role": default_role, "content": value}]
    if isinstance(value, dict):
        if "role" in value:
            return [_message(value, default_role)]
        if isinstance(value.get("messages"), list):
            return _coerce_messages(value["messages"], default_role, depth + 1)
        if "message" in value:
            return _coerce_messages(value["message"], default_role, depth + 1)
        if isinstance(value.get("content"), (str, list)):
            return [_message({"role": default_role, **value}, default_role)]
        return [{"role": default_role, "content": json.dumps(value, sort_keys=True)}]
    if isinstance(value, list):
        out: list[dict[str, Any]] = []
        for item in value:
            if isinstance(item, dict) and "role" in item:
                out.append(_message(item, default_role))
            elif isinstance(item, dict) and "message" in item:
                out.extend(_coerce_messages(item["message"], default_role, depth + 1))
            elif isinstance(item, str):
                out.append({"role": default_role, "content": item})
        return out
    return [{"role": default_role, "content": str(value)}]


def _coerce_scores(raw: Any) -> dict[str, float]:
    out: dict[str, float] = {}
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict) and item.get("name"):
                val = item.get("value")
                if isinstance(val, (int, float)) and not isinstance(val, bool):
                    out[str(item["name"])] = float(val)
        return out
    if not isinstance(raw, dict):
        return out
    for k, v in raw.items():
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            out[str(k)] = float(v)
        elif isinstance(v, dict) and isinstance(v.get("avg"), (int, float)):
            out[str(k)] = float(v["avg"])
    return out


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


def otel_attributes(row: dict[str, Any]) -> dict[str, Any]:
    attrs = row.get("attributes")
    if isinstance(attrs, dict):
        return attrs
    if isinstance(attrs, list):
        return {
            str(a["key"]): _otlp_value(a.get("value"))
            for a in attrs
            if isinstance(a, dict) and "key" in a
        }
    return {}


def detect_source(row: dict[str, Any]) -> str:
    """Auto-detect the trace connector format of a single row."""
    if "$ai_input" in row or row.get("event") == "$ai_generation":
        return "posthog"
    props = row.get("properties")
    if isinstance(props, dict) and "$ai_input" in props:
        return "posthog"
    if any(str(k).startswith(("gen_ai.", "llm.")) for k in otel_attributes(row)):
        return "otel"
    if isinstance(row.get("request"), dict) and isinstance(row.get("response"), dict):
        return "gradiated"
    if "inputs" in row and "outputs" in row:
        return "langsmith"
    if "span_attributes" in row or "root_span_id" in row or ("input" in row and "expected" in row):
        return "braintrust"
    if "sessionId" in row or "traceId" in row or ("input" in row and "output" in row and row.get("schema") is None):
        return "langfuse"
    return "grad_trajectories"


def _parse_grad_trajectories(row: dict[str, Any]) -> dict[str, Any]:
    record = {k: row[k] for k in NATIVE_FIELDS if row.get(k) is not None}
    if "messages" in record:
        record["messages"] = _coerce_messages(row["messages"])
    for key in ("id", "session_id", "group_id"):
        if key in record:
            record[key] = str(record[key])
    if "scores" in record:
        record["scores"] = _coerce_scores(row["scores"])
        if not record["scores"]:
            del record["scores"]
    return record


def _parse_gradiated(row: dict[str, Any]) -> dict[str, Any]:
    req = row.get("request") or {}
    resp = row.get("response") or {}
    messages = _coerce_messages(req.get("messages"))
    choices = resp.get("choices") or []
    if choices and isinstance(choices[0], dict):
        messages.extend(_coerce_messages(choices[0].get("message"), default_role="assistant"))
    record: dict[str, Any] = {"messages": messages}
    if isinstance(req.get("tools"), list):
        record["tools"] = req["tools"]
    if row.get("trace_id") or row.get("session_id"):
        record["session_id"] = str(row.get("session_id") or row.get("trace_id"))
    if row.get("id"):
        record["id"] = str(row["id"])
    scores = _coerce_scores(row.get("scores"))
    if scores:
        record["scores"] = scores
    model = row.get("model") or req.get("model")
    record["metadata"] = {"source": "gradiated", **({"model": model} if model else {})}
    return record


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
                out.append(_message(msg, default_role))
        return out
    return _coerce_messages(value, default_role)


def _parse_otel(row: dict[str, Any]) -> dict[str, Any]:
    attrs = otel_attributes(row)
    messages = _indexed_messages(attrs, "gen_ai.prompt", "role", "content", "user")
    messages += _indexed_messages(attrs, "gen_ai.completion", "role", "content", "assistant")
    if not messages:  # OpenInference
        messages = _indexed_messages(attrs, "llm.input_messages", "message.role", "message.content", "user")
        messages += _indexed_messages(attrs, "llm.output_messages", "message.role", "message.content", "assistant")
    if not messages and "gen_ai.input.messages" in attrs:  # current GenAI semantic conventions
        messages = _json_messages(attrs["gen_ai.input.messages"], "user")
        messages += _json_messages(attrs.get("gen_ai.output.messages"), "assistant")

    record: dict[str, Any] = {"messages": messages}
    session = attrs.get("session.id") or attrs.get("gen_ai.conversation.id") or row.get("trace_id") or row.get("traceId")
    if session:
        record["session_id"] = str(session)
    span = row.get("span_id") or row.get("spanId")
    if span:
        record["id"] = str(span)
    model = attrs.get("gen_ai.request.model") or attrs.get("gen_ai.response.model") or attrs.get("llm.model_name")
    record["metadata"] = {"source": "otel", **({"model": str(model)} if model else {})}
    return record


def _parse_langfuse(row: dict[str, Any]) -> dict[str, Any]:
    messages = _coerce_messages(row.get("input"), default_role="user")
    messages.extend(_coerce_messages(row.get("output"), default_role="assistant"))
    record: dict[str, Any] = {"messages": messages}
    if row.get("id"):
        record["id"] = str(row["id"])
    if row.get("sessionId") or row.get("traceId"):
        record["session_id"] = str(row.get("sessionId") or row.get("traceId"))
    scores = _coerce_scores(row.get("scores"))
    if scores:
        record["scores"] = scores
    record["metadata"] = {"source": "langfuse", **({"model": str(row["model"])} if row.get("model") else {})}
    return record


def _parse_posthog(row: dict[str, Any]) -> dict[str, Any]:
    props = row.get("properties") if isinstance(row.get("properties"), dict) else row
    messages = _coerce_messages(props.get("$ai_input"), default_role="user")
    messages.extend(_coerce_messages(props.get("$ai_output_choices"), default_role="assistant"))
    record: dict[str, Any] = {"messages": messages}
    session = props.get("$ai_session_id") or props.get("$ai_trace_id")
    if session:
        record["session_id"] = str(session)
    if row.get("uuid") or row.get("id"):
        record["id"] = str(row.get("uuid") or row.get("id"))
    record["metadata"] = {"source": "posthog", **({"model": str(props["$ai_model"])} if props.get("$ai_model") else {})}
    return record


def _parse_braintrust(row: dict[str, Any]) -> dict[str, Any]:
    messages = _coerce_messages(row.get("input"), default_role="user")
    messages.extend(_coerce_messages(row.get("output"), default_role="assistant"))
    record: dict[str, Any] = {"messages": messages}
    if row.get("id"):
        record["id"] = str(row["id"])
    if row.get("root_span_id"):
        record["session_id"] = str(row["root_span_id"])
    if row.get("expected") is not None:
        record["expected_output"] = row["expected"]
    scores = _coerce_scores(row.get("scores"))
    if scores:
        record["scores"] = scores
    meta = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
    record["metadata"] = {"source": "braintrust", **({"model": str(meta["model"])} if meta.get("model") else {})}
    return record


def _parse_langsmith(row: dict[str, Any]) -> dict[str, Any]:
    inputs = row.get("inputs") or {}
    outputs = row.get("outputs") or {}
    messages = _coerce_messages(inputs.get("messages", inputs), default_role="user")
    gens = outputs.get("generations")
    if isinstance(gens, list) and gens:
        first = gens[0]
        if isinstance(first, list) and first:
            first = first[0]
        if isinstance(first, dict):
            messages.extend(_coerce_messages(first.get("message") or first.get("text"), default_role="assistant"))
    else:
        messages.extend(_coerce_messages(outputs, default_role="assistant"))
    record: dict[str, Any] = {"messages": messages}
    if row.get("id"):
        record["id"] = str(row["id"])
    if row.get("session_id") or row.get("trace_id"):
        record["session_id"] = str(row.get("session_id") or row.get("trace_id"))
    scores = _coerce_scores(row.get("feedback_stats"))
    if scores:
        record["scores"] = scores
    record["metadata"] = {"source": "langsmith"}
    return record


_PARSERS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "grad_trajectories": _parse_grad_trajectories,
    "gradiated": _parse_gradiated,
    "otel": _parse_otel,
    "langfuse": _parse_langfuse,
    "posthog": _parse_posthog,
    "braintrust": _parse_braintrust,
    "langsmith": _parse_langsmith,
}


def is_usable(record: dict[str, Any]) -> bool:
    return bool(record.get("messages")) or any(record.get(f) is not None for f in _NON_CHAT_FIELDS)


def parse_row(row: Any, source: str = "auto") -> tuple[dict[str, Any] | None, str | None]:
    """Parse one row. Returns (record, None) or (None, skip reason)."""
    if source != "auto" and source not in _PARSERS:
        raise ValueError(f"Unknown trace connector '{source}'. Supported: {', '.join(SUPPORTED_CONNECTORS)}.")
    if not isinstance(row, dict):
        return None, "not_an_object"
    detected = detect_source(row) if source == "auto" else source
    record = _PARSERS[detected](row)
    if not is_usable(record):
        return None, f"{detected}:no_messages"
    return record, None


def normalize_traces_with_stats(
    rows: Iterable[Any], *, source: str = "auto"
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    records: list[dict[str, Any]] = []
    skipped: Counter[str] = Counter()
    for row in rows:
        record, reason = parse_row(row, source)
        if record is None:
            skipped[str(reason)] += 1
        else:
            records.append(record)
    return records, dict(skipped)


def normalize_traces(rows: Iterable[Any], *, source: str = "auto") -> list[dict[str, Any]]:
    """Normalize trace rows from any Tier-1 source into grad DatasetRecord dicts."""
    return normalize_traces_with_stats(rows, source=source)[0]
