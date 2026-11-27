"""The grad dataset record: its fields, value coercion shared by every parser, and the merge
that applies score updates.

Records are immutable dataset parts. A source sync appends trace records and *score-update*
records (``metadata.score_update = true``: an ``id``, ``scores`` and/or ``expected_output``,
no content). ``merge_records`` folds a dataset's parts, in order, into one record per id:
later content replaces earlier content, later scores win per name, and an update for a trace
that never arrives is dropped. The worker applies it before a recipe sees the records.

A source with score filters (``has_feedback``, ``min_score``) can't judge a trace when it syncs
it, because feedback arrives later. It writes the rule on the record (``metadata.score_filter``)
and the merge keeps the record only once its merged scores pass (``passes_score_filter``).
"""

from __future__ import annotations

import json
from typing import Any, Iterable

MAX_DEPTH = 8
SCORE_UPDATE = "score_update"
DATASET_RESET = "dataset_reset"
SCORE_FILTER = "score_filter"
# A full source sync starts with this record: everything before it is dropped on read.
RESET_RECORD: dict[str, Any] = {"id": "grad:reset", "metadata": {DATASET_RESET: True}}

# DatasetRecord fields kept verbatim from native rows (server/api/src/contracts/datasets.ts).
NATIVE_FIELDS = (
    "id", "session_id", "group_id", "messages", "tools", "prompt", "completion", "chosen",
    "rejected", "query", "positive", "negatives", "state", "questions", "expected_output",
    "scores", "metrics", "metadata", "schema", "role", "input", "output", "source", "timestamp",
)  # fmt: skip
CONTENT_FIELDS = (
    "messages", "prompt", "completion", "chosen", "rejected", "query", "positive", "state",
    "questions", "expected_output", "input",
)  # fmt: skip


def is_usable(record: dict[str, Any]) -> bool:
    return bool(record.get("messages")) or any(
        record.get(f) is not None for f in CONTENT_FIELDS if f != "messages"
    )


def is_score_update(record: dict[str, Any]) -> bool:
    meta = record.get("metadata")
    return isinstance(meta, dict) and meta.get(SCORE_UPDATE) is True


def maybe_json(value: Any) -> Any:
    """Providers often send JSON as a string (Langfuse io, OTel attributes); decode it if so."""
    if isinstance(value, str) and value[:1] in ("{", "["):
        try:
            return json.loads(value)
        except ValueError:
            return value
    return value


def drop_none(**fields: Any) -> dict[str, Any]:
    return {k: v for k, v in fields.items() if v is not None and v != [] and v != {}}


def record_metadata(source: str, extra: Any = None, **fields: Any) -> dict[str, Any]:
    """``metadata`` of a provider record: the provider's own metadata, then the mapped fields
    (model, version, release, tags, user_id, ...) where they are set."""
    meta = dict(extra) if isinstance(extra, dict) else {}
    meta.update(drop_none(**fields))
    meta["source"] = source
    return meta


def score_value(value: Any) -> float | None:
    """A numeric score: numbers and booleans (true = 1.0); anything else is not a score."""
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    return None


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


def message(item: dict[str, Any], default_role: str) -> dict[str, Any]:
    content = item.get("content")
    msg: dict[str, Any] = {"role": str(item.get("role", default_role)), "content": _flatten_content(content)}
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


def coerce_messages(value: Any, default_role: str = "user", depth: int = 0) -> list[dict[str, Any]]:
    """Chat messages from the many shapes providers use: a string, a message, a list of
    messages, ``{"messages": [...]}``, ``{"message": ...}`` or ``{"content": ...}``."""
    if value is None or value == {} or depth > MAX_DEPTH:
        return []
    if isinstance(value, str):
        return [{"role": default_role, "content": value}]
    if isinstance(value, dict):
        if "role" in value:
            return [message(value, default_role)]
        if isinstance(value.get("messages"), list):
            return coerce_messages(value["messages"], default_role, depth + 1)
        if "message" in value:
            return coerce_messages(value["message"], default_role, depth + 1)
        if isinstance(value.get("content"), (str, list)):
            return [message({"role": default_role, **value}, default_role)]
        return [{"role": default_role, "content": json.dumps(value, sort_keys=True)}]
    if isinstance(value, list):
        out: list[dict[str, Any]] = []
        for item in value:
            if isinstance(item, dict) and "role" in item:
                out.append(message(item, default_role))
            elif isinstance(item, dict) and "message" in item:
                out.extend(coerce_messages(item["message"], default_role, depth + 1))
            elif isinstance(item, str):
                out.append({"role": default_role, "content": item})
        return out
    return [{"role": default_role, "content": str(value)}]


def coerce_scores(raw: Any) -> dict[str, float]:
    """``{name: number}``, ``[{name, value}]`` or aggregated ``{name: {avg}}`` → ``{name: float}``."""
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


def _apply(target: dict[str, Any], patch: dict[str, Any]) -> None:
    if patch.get("scores"):
        target["scores"] = {**(target.get("scores") or {}), **patch["scores"]}
    if patch.get("expected_output") is not None:
        target["expected_output"] = patch["expected_output"]


def is_reset(record: dict[str, Any]) -> bool:
    meta = record.get("metadata")
    return isinstance(meta, dict) and meta.get(DATASET_RESET) is True


def merge_records(records: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fold dataset parts (in order) into one record per ``id``; see the module docstring.
    Records without an id pass through unchanged; a reset marker (a full source sync) drops
    everything before it."""
    out: list[dict[str, Any]] = []
    by_id: dict[str, dict[str, Any]] = {}
    position: dict[str, int] = {}
    pending: dict[str, dict[str, Any]] = {}  # updates that arrived before their trace
    for rec in records:
        if is_reset(rec):
            out, by_id, position, pending = [], {}, {}, {}
            continue
        rid = rec.get("id")
        if not isinstance(rid, str) or not rid:
            out.append(rec)
            continue
        if is_score_update(rec):
            if rid in by_id:
                _apply(by_id[rid], rec)
            else:
                _apply(pending.setdefault(rid, {}), rec)
            continue
        new = dict(rec)
        if rid in by_id:
            old = by_id[rid]
            new["scores"] = {**(old.get("scores") or {}), **(rec.get("scores") or {})}
            if not new["scores"]:
                del new["scores"]
            if new.get("expected_output") is None and old.get("expected_output") is not None:
                new["expected_output"] = old["expected_output"]
            out[position[rid]] = new  # keep first-seen order
        else:
            position[rid] = len(out)
            out.append(new)
        by_id[rid] = new
        if rid in pending:
            _apply(new, pending.pop(rid))
    return [_admitted(r) for r in out if passes_score_filter(r)]


def passes_score_filter(record: dict[str, Any]) -> bool:
    """A merged record's ``metadata.score_filter``: ``has_feedback`` (a score or a correction),
    ``min_score`` as a number (at least one score, every score at least it) or as
    ``{name: number}`` (each named score present and at least it). No rule passes."""
    meta = record.get("metadata")
    rule = meta.get(SCORE_FILTER) if isinstance(meta, dict) else None
    if not isinstance(rule, dict):
        return True
    scores = {k: v for k, v in (record.get("scores") or {}).items() if isinstance(v, (int, float))}
    if rule.get("has_feedback") is True and not scores and record.get("expected_output") is None:
        return False
    minimum = rule.get("min_score")
    if isinstance(minimum, (int, float)) and not isinstance(minimum, bool):
        return bool(scores) and all(v >= minimum for v in scores.values())
    if isinstance(minimum, dict):
        return all(name in scores and scores[name] >= floor for name, floor in minimum.items())
    return True


def _admitted(record: dict[str, Any]) -> dict[str, Any]:
    meta = record.get("metadata")
    if not isinstance(meta, dict) or SCORE_FILTER not in meta:
        return record
    return {**record, "metadata": {k: v for k, v in meta.items() if k != SCORE_FILTER}}
