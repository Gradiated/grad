"""Deterministic train/eval split, identical to ``splitRecords`` in server/api/src/planner.ts."""

from __future__ import annotations

import hashlib
from typing import Any, Mapping, Sequence


def hash_fraction(key: str, seed: int) -> float:
    digest = hashlib.sha256(f"{seed}:{key}".encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") / 0x1_0000_0000


def _first_present(rec: Mapping[str, Any], *fields: str) -> Any:
    # Mirrors planner.ts splitKey: missing, null and empty-string ids all fall through.
    for name in fields:
        value = rec.get(name)
        if value is not None and value != "":
            return value
    return None


def split_key(rec: Mapping[str, Any], index: int, strategy: str) -> str:
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
    train, held_out = split_indices(records, strategy=strategy, eval_fraction=eval_fraction, seed=seed)
    return [records[i] for i in train], [records[i] for i in held_out]


def split_indices(
    records: Sequence[Mapping[str, Any]],
    *,
    strategy: str = "by_session",
    eval_fraction: float = 0.1,
    seed: int = 42,
) -> tuple[list[int], list[int]]:
    """``split_records`` as positions: it reads only each record's id, session_id and group_id."""
    keys = [split_key(rec, index, strategy) for index, rec in enumerate(records)]
    fractions = [hash_fraction(key, seed) for key in keys]
    in_eval = [f < eval_fraction for f in fractions]
    if in_eval and all(in_eval):
        # Everything hashed into eval: the first record's whole group trains, so no
        # session or group straddles the two sides.
        in_eval = [key != keys[0] for key in keys]
    elif eval_fraction > 0 and not any(in_eval):
        # With two or more groups the eval side is never empty: the group that hashes
        # lowest is held out (tiny datasets otherwise trained unevaluated).
        held = keys[min(range(len(keys)), key=fractions.__getitem__)] if keys else None
        if any(key != held for key in keys):
            in_eval = [key == held for key in keys]
    return [i for i, e in enumerate(in_eval) if not e], [i for i, e in enumerate(in_eval) if e]


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
