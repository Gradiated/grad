"""Deterministic train/eval split, identical to ``splitRecords`` in server/api/src/planner.ts."""

from __future__ import annotations

import hashlib
from typing import Any, Sequence


def hash_fraction(key: str, seed: int) -> float:
    digest = hashlib.sha256(f"{seed}:{key}".encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") / 0x1_0000_0000


def _first_present(rec: dict[str, Any], *fields: str) -> Any:
    # Mirrors planner.ts splitKey: missing, null and empty-string ids all fall through.
    for name in fields:
        value = rec.get(name)
        if value is not None and value != "":
            return value
    return None


def split_key(rec: dict[str, Any], index: int, strategy: str) -> str:
    if strategy == "by_session":
        value = _first_present(rec, "session_id", "id")
    elif strategy == "by_group":
        value = _first_present(rec, "group_id", "session_id", "id")
    else:
        value = _first_present(rec, "id")
    return f"row:{index}" if value is None else str(value)


def split_records(
    records: Sequence[dict[str, Any]],
    *,
    strategy: str = "by_session",
    eval_fraction: float = 0.1,
    seed: int = 42,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    train: list[dict[str, Any]] = []
    eval_set: list[dict[str, Any]] = []
    for index, rec in enumerate(records):
        if hash_fraction(split_key(rec, index, strategy), seed) < eval_fraction:
            eval_set.append(rec)
        else:
            train.append(rec)
    if not train and eval_set:
        train.append(eval_set.pop(0))
    return train, eval_set


def two_folds(items: Sequence[Any], keys: Sequence[str], seed: int) -> tuple[list[Any], list[Any]]:
    """Split held-out items into a selection/calibration fold and a report fold.

    Items sharing a key land in the same fold. When only one fold would be non-empty, the
    selection fold gets everything and the report fold is empty (metrics are then null).
    """
    select: list[Any] = []
    report: list[Any] = []
    for item, key in zip(items, keys):
        (select if hash_fraction(key, seed + 1) < 0.5 else report).append(item)
    if not select:
        select, report = report, []
    return select, report
