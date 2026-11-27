"""Tier-1 trace parsers with format auto-detection.

Supported formats:
- grad_trajectories / OpenAI Chat JSONL
- gradiated (Gradiated proxy trace export)
- otel (OpenTelemetry GenAI / OpenInference spans)
- langfuse (Langfuse generation exports)
- posthog (PostHog $ai_generation events)
- braintrust (Braintrust log rows)
- langsmith (LangSmith run exports)
"""

from __future__ import annotations

import json
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
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "\n".join(parts)
    return str(content)


def _coerce_messages(value: Any, default_role: str = "user") -> list[dict[str, Any]]:
    if value is None:
        return []
    if isinstance(value, str):
        return [{"role": default_role, "content": value}]
    if isinstance(value, dict):
        if "role" in value:
            return [
                {
                    "role": str(value.get("role", default_role)),
                    "content": _flatten_content(value.get("content")),
                }
            ]
        if "messages" in value and isinstance(value["messages"], list):
            return _coerce_messages(value["messages"], default_role=default_role)
        return [{"role": default_role, "content": json.dumps(value, sort_keys=True)}]
    if isinstance(value, list):
        out: list[dict[str, Any]] = []
        for item in value:
            if isinstance(item, dict) and "role" in item:
                msg: dict[str, Any] = {
                    "role": str(item["role"]),
                    "content": _flatten_content(item.get("content")),
                }
                if "tool_calls" in item:
                    msg["tool_calls"] = item["tool_calls"]
                if "tool_call_id" in item:
                    msg["tool_call_id"] = str(item["tool_call_id"])
                out.append(msg)
            elif isinstance(item, dict) and "message" in item:
                out.extend(_coerce_messages(item["message"], default_role=default_role))
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


def detect_source(row: dict[str, Any]) -> str:
    """Auto-detect trace connector format from a single row."""
    if "$ai_input" in row or row.get("event") == "$ai_generation":
        return "posthog"
    props = row.get("properties")
    if isinstance(props, dict) and "$ai_input" in props:
        return "posthog"
    attrs = row.get("attributes")
    if isinstance(attrs, dict) and any(
        str(k).startswith(("gen_ai.", "llm.")) for k in attrs
    ):
        return "otel"
    if isinstance(row.get("request"), dict) and isinstance(row.get("response"), dict):
        return "gradiated"
    if "inputs" in row and "outputs" in row:
        return "langsmith"
    if "span_attributes" in row or ("input" in row and "expected" in row):
        return "braintrust"
    if "sessionId" in row or ("input" in row and "output" in row):
        return "langfuse"
    return "grad_trajectories"


def _parse_grad_trajectories(row: dict[str, Any]) -> dict[str, Any]:
    record: dict[str, Any] = {
        "messages": _coerce_messages(row.get("messages")),
    }
    if row.get("id"):
        record["id"] = str(row["id"])
    if row.get("session_id"):
        record["session_id"] = str(row["session_id"])
    scores = _coerce_scores(row.get("scores"))
    if scores:
        record["scores"] = scores
    if isinstance(row.get("metadata"), dict):
        record["metadata"] = dict(row["metadata"])
    return record


def _parse_gradiated(row: dict[str, Any]) -> dict[str, Any]:
    req = row.get("request") or {}
    resp = row.get("response") or {}
    messages = _coerce_messages(req.get("messages"))
    choices = resp.get("choices") or []
    if choices and isinstance(choices[0], dict):
        messages.extend(
            _coerce_messages(choices[0].get("message"), default_role="assistant")
        )
    record: dict[str, Any] = {"messages": messages}
    if row.get("trace_id") or row.get("session_id"):
        record["session_id"] = str(row.get("session_id") or row.get("trace_id"))
    if row.get("id"):
        record["id"] = str(row["id"])
    scores = _coerce_scores(row.get("scores"))
    if scores:
        record["scores"] = scores
    record["metadata"] = {
        "source": "gradiated",
        **({"model": row["model"]} if row.get("model") else {}),
    }
    return record


def _parse_otel(row: dict[str, Any]) -> dict[str, Any]:
    attrs = row.get("attributes") or {}
    messages: list[dict[str, Any]] = []
    idx = 0
    while f"gen_ai.prompt.{idx}.content" in attrs:
        role = str(attrs.get(f"gen_ai.prompt.{idx}.role", "user"))
        messages.append(
            {"role": role, "content": str(attrs[f"gen_ai.prompt.{idx}.content"])}
        )
        idx += 1
    c_idx = 0
    while f"gen_ai.completion.{c_idx}.content" in attrs:
        role = str(attrs.get(f"gen_ai.completion.{c_idx}.role", "assistant"))
        messages.append(
            {
                "role": role,
                "content": str(attrs[f"gen_ai.completion.{c_idx}.content"]),
            }
        )
        c_idx += 1

    record: dict[str, Any] = {"messages": messages}
    session = attrs.get("session.id") or row.get("trace_id")
    if session:
        record["session_id"] = str(session)
    if row.get("span_id"):
        record["id"] = str(row["span_id"])
    record["metadata"] = {
        "source": "otel",
        **(
            {"model": str(attrs["gen_ai.request.model"])}
            if "gen_ai.request.model" in attrs
            else {}
        ),
    }
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
    record["metadata"] = {"source": "langfuse"}
    return record


def _parse_posthog(row: dict[str, Any]) -> dict[str, Any]:
    props = row.get("properties") if isinstance(row.get("properties"), dict) else row
    messages = _coerce_messages(props.get("$ai_input"), default_role="user")
    messages.extend(
        _coerce_messages(props.get("$ai_output_choices"), default_role="assistant")
    )
    record: dict[str, Any] = {"messages": messages}
    session = props.get("$ai_session_id") or props.get("$ai_trace_id")
    if session:
        record["session_id"] = str(session)
    if row.get("uuid") or row.get("id"):
        record["id"] = str(row.get("uuid") or row.get("id"))
    record["metadata"] = {
        "source": "posthog",
        **(
            {"model": str(props["$ai_model"])}
            if props.get("$ai_model")
            else {}
        ),
    }
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
    record["metadata"] = {"source": "braintrust"}
    return record


def _parse_langsmith(row: dict[str, Any]) -> dict[str, Any]:
    inputs = row.get("inputs") or {}
    outputs = row.get("outputs") or {}
    messages = _coerce_messages(
        inputs.get("messages", inputs), default_role="user"
    )
    gens = outputs.get("generations")
    if isinstance(gens, list) and gens:
        first = gens[0]
        if isinstance(first, list) and first:
            first = first[0]
        if isinstance(first, dict):
            messages.extend(
                _coerce_messages(
                    first.get("message") or first.get("text"),
                    default_role="assistant",
                )
            )
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


def normalize_traces(
    rows: Iterable[dict[str, Any]],
    *,
    source: str = "auto",
) -> list[dict[str, Any]]:
    """Normalize trace rows from any Tier-1 source into grad DatasetRecord dicts."""
    if source != "auto" and source not in _PARSERS:
        raise ValueError(
            f"Unknown trace connector '{source}'. Supported: {', '.join(SUPPORTED_CONNECTORS)}."
        )

    normalized: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        detected = detect_source(row) if source == "auto" else source
        record = _PARSERS[detected](row)
        if record.get("messages"):
            normalized.append(record)
    return normalized
