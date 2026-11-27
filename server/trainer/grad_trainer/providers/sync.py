"""SyncEngine: runs one incremental (or full) sync of a provider and emits record batches.

Watermark (opaque to grad-server, stored when the sync job completes): ``{"traces": T, "scores":
S}``. For most providers both are ISO timestamps: traces are fetched from T, and scores from
``min(S, now - provider.rescan_window)`` so late edits still land. Only rows up to ``now -
SETTLE`` are taken (providers expose writes with a delay); the rest are picked up next time, so
a re-sync of the same window emits nothing new. ``cursor_watermark`` providers keep their own
opaque cursor instead. ``full=True`` ignores the watermark, re-reads everything and first emits
the reset marker, so the new dataset version holds only what this sync read.

Records are deduped by provider trace id within a sync (an identical re-read is dropped, a
changed one is re-emitted and wins when the parts are merged). Score updates for the same trace
are merged before they are emitted, latest ``updated_at`` winning.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Iterator

from ..errors import PaginationLoopError
from ..records import RESET_RECORD
from .base import Page, Provider, ScoreUpdate, iso, parse_time

# Langfuse documents ~10 min before reads see new data. GRAD_SOURCES_SETTLE_SECONDS overrides
# it (the live tests' fake providers are consistent at once).
SETTLE = timedelta(seconds=float(os.environ.get("GRAD_SOURCES_SETTLE_SECONDS") or 600))
DEFAULT_BATCH_SIZE = 500
MAX_PAGES = 100_000
MAX_EMPTY_PAGES = 20  # some APIs (Langfuse) may return empty pages that still carry a cursor
MAX_ERRORS = 100


@dataclass
class SyncResult:
    records: int = 0
    skipped: int = 0
    errors: list[str] = field(default_factory=list)
    watermark: dict[str, str | None] = field(default_factory=dict)


def pages(fetch: Callable[[str | None, str | None], Page], since: str | None, *, max_pages: int = MAX_PAGES) -> Iterator[Page]:
    """Follow ``cursor`` to the end. A repeated cursor, too many pages or too many empty pages
    raise ``PaginationLoopError`` instead of looping forever."""
    cursor: str | None = None
    seen: set[str] = set()
    empty = 0
    for _ in range(max_pages):
        page = fetch(since, cursor)
        yield page
        if not page.cursor:
            return
        if page.cursor in seen:
            raise PaginationLoopError(f"provider returned cursor {page.cursor[:40]!r} twice")
        empty = 0 if page.items else empty + 1
        if empty >= MAX_EMPTY_PAGES:
            raise PaginationLoopError(f"provider returned {empty} empty pages in a row")
        seen.add(page.cursor)
        cursor = page.cursor
    raise PaginationLoopError(f"provider returned more than {max_pages} pages")


def _digest(record: dict[str, Any]) -> bytes:
    return hashlib.blake2b(json.dumps(record, sort_keys=True, default=str).encode(), digest_size=12).digest()


class SyncEngine:
    def __init__(
        self,
        provider: Provider,
        *,
        emit_batch: Callable[[list[dict[str, Any]]], None],
        batch_size: int = DEFAULT_BATCH_SIZE,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        max_pages: int = MAX_PAGES,
    ) -> None:
        self.provider = provider
        self.emit_batch = emit_batch
        self.batch_size = max(1, batch_size)
        self.now = now
        self.max_pages = max_pages

    def run(self, watermark: dict[str, Any] | None = None, *, full: bool = False) -> SyncResult:
        p = self.provider
        wm = {} if full or not isinstance(watermark, dict) else watermark
        now = self.now()
        self._until = now - SETTLE
        self._result = SyncResult()
        self._seen: dict[str, bytes] = {}
        self._traces: dict[str, dict[str, Any]] = {}
        self._scores: dict[str, ScoreUpdate] = {}
        if full:
            # A rebuild: readers drop every part before this marker (records.merge_records).
            self.emit_batch([dict(RESET_RECORD)])

        traces_since = wm.get("traces")
        scores_since = wm.get("scores")
        if not p.cursor_watermark and p.rescan_window and parse_time(scores_since):
            scores_since = iso(min(parse_time(scores_since), now - p.rescan_window))  # type: ignore[type-var]

        trace_resume = self._drain(p.fetch_traces, traces_since, lambda raw: self._take_trace(raw, traces_since))
        score_resume = self._drain(p.fetch_scores, scores_since, lambda raw: self._take_score(raw, wm.get("scores")))
        self._flush()
        if p.cursor_watermark:
            self._result.watermark = {"traces": trace_resume or traces_since, "scores": score_resume or wm.get("scores")}
        else:
            self._result.watermark = {"traces": iso(self._until), "scores": iso(self._until)}
        return self._result

    # -- streams ------------------------------------------------------------------------

    def _drain(self, fetch: Callable[[str | None, str | None], Page], since: str | None, take: Callable[[dict[str, Any]], None]) -> str | None:
        resume = None
        for page in pages(fetch, since, max_pages=self.max_pages):
            for raw in page.items:
                try:
                    take(raw)
                except Exception as exc:  # one malformed row must not stop the sync
                    self._skip(f"{type(exc).__name__}: {exc}")
            resume = page.resume or resume
        return resume

    def _in_window(self, when: str | None, lower: str | None) -> bool:
        """Time-watermarked streams take rows in (lower, now - SETTLE]; rows without a time always."""
        if self.provider.cursor_watermark:
            return True
        at = parse_time(when)
        if at is None:
            return True
        low = parse_time(lower)
        return (low is None or at > low) and at <= self._until

    def _take_trace(self, raw: dict[str, Any], since: str | None) -> None:
        record = self.provider.to_record(raw)
        if record is None or not record.get("id"):
            self._skip("no trace id or no messages")
            return
        if not self._in_window(record.get("timestamp"), since):
            return
        rid = str(record["id"])
        digest = _digest(record)
        if self._seen.get(rid) == digest:
            return
        self._seen[rid] = digest
        self._traces.pop(rid, None)
        self._traces[rid] = record
        self._maybe_flush()

    def _take_score(self, raw: dict[str, Any], since: str | None) -> None:
        update = self.provider.to_score_update(raw)
        if update is None or not (update.scores or update.expected_output is not None):
            return
        if not self._in_window(update.updated_at, since):
            return
        old = self._scores.get(update.trace_id)
        self._scores[update.trace_id] = old.merge(update) if old else update
        self._maybe_flush()

    # -- batching -----------------------------------------------------------------------

    def _maybe_flush(self) -> None:
        if len(self._traces) + len(self._scores) >= self.batch_size:
            self._flush()

    def _flush(self) -> None:
        batch = list(self._traces.values())
        for update in self._scores.values():
            record = update.to_record(self.provider.name)
            key = f"score:{update.trace_id}"
            digest = _digest(record)
            if self._seen.get(key) != digest:
                self._seen[key] = digest
                batch.append(record)
        self._traces, self._scores = {}, {}
        if batch:
            self.emit_batch(batch)
            self._result.records += len(batch)

    def _skip(self, message: str) -> None:
        self._result.skipped += 1
        if len(self._result.errors) < MAX_ERRORS:
            self._result.errors.append(f"{self.provider.name}: {message}")
