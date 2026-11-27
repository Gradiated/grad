"""Source filters, sampling and the score-filter rule.

Every provider accepts the same documented keys (``COMMON_FILTERS``); a few take extra ones
(``Provider.filter_keys``). Values are a string or a list of strings, any of which matches,
unless noted:

- ``tags`` (list): the trace carries every tag
- ``environment``, ``model``, ``version``, ``release``, ``name`` (trace name or route),
  ``user_id``, ``session_id``
- ``metadata``: ``{key: value}``; each key equals its value (compared as text)
- ``from`` / ``to``: ISO 8601; the trace started in ``[from, to)``
- ``has_feedback`` (bool) and ``min_score`` (a number: every score at least it; or
  ``{name: number}``): score filters, judged on the merged record (``records.SCORE_FILTER``)

A provider sends the keys in its ``pushdown_filters`` to its API, so it fetches less; the engine
then applies every common key again to the mapped record (``Filters.matches``), once, so a
provider API that ignores or loosens a parameter can't widen the sync. Score filters can't be
judged when a trace syncs, because feedback arrives later: the record carries the rule and the
dataset merge keeps it once its scores pass. grad-server validates the keys and values when a
source is created or updated (422 ``source_filter_unsupported``); this module trusts them.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Mapping


LIST_KEYS = ("environment", "model", "version", "release", "name", "user_id")
SCORE_KEYS = ("has_feedback", "min_score")
COMMON_FILTERS = frozenset({"tags", *LIST_KEYS, "session_id", "metadata", "from", "to", *SCORE_KEYS})


def parse_time(value: Any) -> datetime | None:
    from .base import parse_time as parse  # base imports this module

    return parse(value)


def values(value: Any) -> tuple[str, ...]:
    """A filter value as a tuple of strings: ``"a"`` and ``["a"]`` both give ``("a",)``."""
    if value is None:
        return ()
    items = value if isinstance(value, (list, tuple)) else [value]
    return tuple(text(v) for v in items)


def text(value: Any) -> str:
    """How filters compare values: booleans as ``true``/``false``, everything else as ``str``."""
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


@dataclass(frozen=True)
class Filters:
    raw: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "raw", dict(self.raw or {}))

    def get(self, key: str) -> tuple[str, ...]:
        return values(self.raw.get(key))

    def one(self, key: str) -> str | None:
        """The key's value when it names exactly one, for APIs that take a single value."""
        found = self.get(key)
        return found[0] if len(found) == 1 else None

    @property
    def metadata(self) -> dict[str, str]:
        meta = self.raw.get("metadata")
        return {str(k): text(v) for k, v in meta.items()} if isinstance(meta, dict) else {}

    @property
    def start(self) -> datetime | None:
        return parse_time(self.raw.get("from"))

    @property
    def end(self) -> datetime | None:
        return parse_time(self.raw.get("to"))

    def score_rule(self) -> dict[str, Any] | None:
        rule = {k: self.raw[k] for k in SCORE_KEYS if self.raw.get(k) not in (None, False)}
        return rule or None

    def matches(self, record: Mapping[str, Any]) -> bool:
        """Whether a mapped trace record passes every common, non-score filter."""
        meta = record.get("metadata") if isinstance(record.get("metadata"), dict) else {}
        tags = set(values(meta.get("tags")))
        if not set(self.get("tags")) <= tags:
            return False
        for key in LIST_KEYS:
            wanted = self.get(key)
            if wanted and (meta.get(key) is None or text(meta.get(key)) not in wanted):
                return False
        sessions = self.get("session_id")
        if sessions and text(record.get("session_id")) not in sessions:
            return False
        for key, value in self.metadata.items():
            if key not in meta or text(meta[key]) != value:
                return False
        if self.start or self.end:
            at = parse_time(record.get("timestamp"))
            if at is None or (self.start and at < self.start) or (self.end and at >= self.end):
                return False
        return True


def sampled(trace_id: str, rate: float) -> bool:
    """Deterministic per trace id: the same traces are kept on every sync and re-sync."""
    if rate >= 1:
        return True
    if rate <= 0:
        return False
    digest = hashlib.blake2b(trace_id.encode(), digest_size=8).digest()
    return int.from_bytes(digest, "big") < rate * 2**64
