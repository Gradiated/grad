"""Record-shape helpers shared by recipes (no torch)."""

from __future__ import annotations

import hashlib
import json
from typing import Any, Sequence

from ..errors import RecipeDataError

TRAJECTORY_SCHEMA = "grad.trajectory/1"

# (prompt, chosen, rejected, record or group id)
Pair = tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]], str]


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


def expected_turns(value: Any) -> list[dict[str, Any]]:
    """The assistant answer an ``expected_output`` stands for (a gold answer or a synced
    correction), or ``[]`` when it isn't one. A string, a number, a message, a list of messages
    or ``{"messages": [...]}`` map directly; a one-key object with a string value (LangSmith
    ``{"answer": ...}``, ``{"label": ...}``) is that string; any other object is its JSON, the
    way providers store a structured output."""
    if value is None or isinstance(value, bool):
        return []
    if isinstance(value, (int, float)):
        return [{"role": "assistant", "content": str(value)}]
    if isinstance(value, str):
        return [{"role": "assistant", "content": value}] if value.strip() else []
    if isinstance(value, dict):
        if "role" in value or isinstance(value.get("messages"), list) or isinstance(value.get("content"), str):
            turns = as_messages(value, "assistant")
        elif len(value) == 1 and isinstance(next(iter(value.values())), str):
            return expected_turns(next(iter(value.values())))
        elif not value:
            return []
        else:
            return [{"role": "assistant", "content": json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)}]
    elif isinstance(value, list):
        try:
            turns = as_messages(value, "assistant")
        except RecipeDataError:
            return []
    else:
        return []
    return turns if any(t.get("role") == "assistant" for t in turns) else []


def own_messages(rec: dict[str, Any]) -> list[dict[str, Any]]:
    """The conversation as logged, with the record's own answer: chat ``messages``,
    ``input.messages`` + ``output.turns``, or ``prompt`` + ``completion``."""
    if isinstance(rec.get("messages"), list) and rec["messages"]:
        return [dict(m) for m in rec["messages"]]
    inp = rec.get("input")
    if rec.get("schema") == TRAJECTORY_SCHEMA or (isinstance(inp, dict) and inp.get("messages")):
        prompt, turns = trajectory_messages(rec)
        return prompt + turns
    if rec.get("prompt") is not None:
        return as_messages(rec["prompt"], "user") + as_messages(rec.get("completion"), "assistant")
    return []


def split_answer(messages: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(prompt, answer): the answer is the run of assistant turns that ends the conversation."""
    cut = len(messages)
    while cut and messages[cut - 1].get("role") == "assistant":
        cut -= 1
    return messages[:cut], messages[cut:]


def record_messages(rec: dict[str, Any]) -> list[dict[str, Any]]:
    """The conversation a record trains on. ``expected_output`` (a gold answer or a synced
    correction) is the target: it replaces the record's own final answer, or answers a prompt
    that has none. Without a prompt, a record trains on nothing."""
    conversation = own_messages(rec)
    target = expected_turns(rec.get("expected_output"))
    prompt, _ = split_answer(conversation)
    if not target or not prompt:
        return conversation if prompt else []
    return prompt + target


def correction_pair(rec: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]] | None:
    """(prompt, chosen, rejected) for a record whose ``expected_output`` corrects its own answer:
    the correction is chosen and the logged answer rejected."""
    target = expected_turns(rec.get("expected_output"))
    prompt, answer = split_answer(own_messages(rec))
    if not target or not prompt or not answer or answer == target:
        return None
    return prompt, target, answer


def scored_messages(rec: dict[str, Any]) -> list[dict[str, Any]]:
    """The answer a record's ``scores`` grade: its own answer, else its ``expected_output``."""
    conversation = own_messages(rec)
    return conversation if split_answer(conversation)[1] else record_messages(rec)


def prompt_messages(rec: dict[str, Any]) -> list[dict[str, Any]]:
    """The conversation up to (not including) the trailing assistant turns."""
    return split_answer(own_messages(rec))[0]


def common_prefix(a: Sequence[dict[str, Any]], b: Sequence[dict[str, Any]]) -> int:
    n = 0
    while n < len(a) and n < len(b) and a[n] == b[n]:
        n += 1
    return n


def _completion(value: Any) -> list[dict[str, Any]]:
    turns = as_messages(value, "assistant")
    for turn in turns:
        if turn.get("role") != "assistant":
            raise RecipeDataError("DPO completions must be assistant turns.")
    return turns


def extract_pairs(records: list[dict[str, Any]]) -> tuple[list[Pair], int]:
    """Build (prompt, chosen, rejected, id) pairs. Returns pairs and the count of dropped rows."""
    pairs: list[Pair] = []
    dropped = 0
    groups: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for index, rec in enumerate(records):
        rid = record_id(rec, index)
        role, group = rec.get("role"), rec.get("group_id")
        if rec.get("schema") == TRAJECTORY_SCHEMA and role in ("chosen", "rejected") and group is not None:
            groups.setdefault(str(group), {"chosen": [], "rejected": []})[role].append(rec)
            continue
        if rec.get("chosen") is None or rec.get("rejected") is None:
            # A synced correction: the fix (expected_output) is chosen, the logged answer rejected.
            correction = correction_pair(rec)
            if correction is None:
                dropped += 1
            else:
                pairs.append((*correction, rid))
            continue
        chosen = as_messages(rec["chosen"], "assistant")
        rejected = as_messages(rec["rejected"], "assistant")
        if rec.get("prompt") is not None:
            prompt = as_messages(rec["prompt"], "user")
        elif rec.get("messages"):
            prompt = as_messages(rec["messages"], "user")
        else:
            shared = common_prefix(chosen, rejected)
            prompt, chosen, rejected = chosen[:shared], chosen[shared:], rejected[shared:]
        pairs.append((prompt, _completion(chosen), _completion(rejected), rid))

    for group_id, sides in sorted(groups.items()):
        if len(sides["chosen"]) != 1 or not sides["rejected"]:
            dropped += len(sides["chosen"]) + len(sides["rejected"])
            continue
        prompt, chosen = trajectory_messages(sides["chosen"][0])
        for rej in sides["rejected"]:
            rej_prompt, rejected = trajectory_messages(rej)
            if rej_prompt != prompt:
                raise RecipeDataError(f"Preference group '{group_id}' has different prompts on each side.")
            pairs.append((prompt, _completion(chosen), _completion(rejected), group_id))

    valid: list[Pair] = []
    for prompt, chosen, rejected, rid in pairs:
        if not prompt or not chosen or not rejected or chosen == rejected:
            dropped += 1
            continue
        valid.append((prompt, chosen, rejected, rid))
    return valid, dropped


def prompt_key(rec: dict[str, Any]) -> str:
    """A router record's prompt group: its ``group_id``, else a hash of its prompt messages.

    ``routerGroupKey`` in server/api/src/planner.ts computes the same key.
    """
    if rec.get("group_id") is not None:
        return str(rec["group_id"])
    canonical = json.dumps(prompt_messages(rec), sort_keys=True, ensure_ascii=False)
    return "prompt:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]


def with_prompt_groups(records: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """Give every record a ``group_id`` (its prompt key), so a split keeps prompt groups whole."""
    return [rec if rec.get("group_id") is not None else {**rec, "group_id": prompt_key(rec)} for rec in records]
