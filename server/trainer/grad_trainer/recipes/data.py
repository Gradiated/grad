"""Record-shape helpers shared by recipes (no torch)."""

from __future__ import annotations

from typing import Any, Sequence

from ..errors import RecipeDataError

TRAJECTORY_SCHEMA = "grad.trajectory/1"


def record_id(rec: dict[str, Any], index: int) -> str:
    value = rec.get("id")
    return str(value) if value is not None else f"row:{index}"


def as_messages(value: Any, default_role: str) -> list[dict[str, Any]]:
    if value is None:
        return []
    if isinstance(value, str):
        return [{"role": default_role, "content": value}]
    if isinstance(value, dict):
        if "role" in value:
            return [dict(value)]
        if isinstance(value.get("content"), str):
            return [{"role": default_role, "content": value["content"]}]
        if isinstance(value.get("messages"), list):
            return as_messages(value["messages"], default_role)
        raise RecipeDataError(f"Can't read messages from {sorted(value)}.")
    if isinstance(value, list):
        out: list[dict[str, Any]] = []
        for item in value:
            out.extend(as_messages(item, default_role))
        return out
    raise RecipeDataError(f"Can't read messages from a {type(value).__name__}.")


def trajectory_messages(rec: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(prompt messages, output turns) of a ``grad.trajectory/1`` record."""
    inp = rec.get("input") or {}
    out = rec.get("output") or {}
    prompt = as_messages(inp.get("messages") if isinstance(inp, dict) else inp, "user")
    turns = as_messages(out.get("turns", out.get("messages")) if isinstance(out, dict) else out, "assistant")
    return prompt, turns


def record_messages(rec: dict[str, Any]) -> list[dict[str, Any]]:
    """Full conversation of a record: chat ``messages``, a trajectory, or prompt + expected_output."""
    if isinstance(rec.get("messages"), list) and rec["messages"]:
        return [dict(m) for m in rec["messages"]]
    if rec.get("schema") == TRAJECTORY_SCHEMA:
        prompt, turns = trajectory_messages(rec)
        return prompt + turns
    prompt = as_messages(rec.get("prompt"), "user")
    expected = rec["completion"] if rec.get("completion") is not None else rec.get("expected_output")
    if isinstance(expected, dict) and "content" in expected:
        expected = expected["content"]
    answer = as_messages(expected, "assistant") if isinstance(expected, (str, list, dict)) else []
    return prompt + answer


def prompt_messages(rec: dict[str, Any]) -> list[dict[str, Any]]:
    """The conversation up to (not including) the trailing assistant turns."""
    if rec.get("schema") == TRAJECTORY_SCHEMA:
        return trajectory_messages(rec)[0]
    if rec.get("prompt") is not None and not rec.get("messages"):
        return as_messages(rec.get("prompt"), "user")
    msgs = record_messages(rec)
    while msgs and msgs[-1].get("role") == "assistant":
        msgs.pop()
    return msgs


def common_prefix(a: Sequence[dict[str, Any]], b: Sequence[dict[str, Any]]) -> int:
    n = 0
    while n < len(a) and n < len(b) and a[n] == b[n]:
        n += 1
    return n
