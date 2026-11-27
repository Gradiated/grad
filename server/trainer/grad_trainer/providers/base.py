"""The provider base class. A provider implements only what is specific to it:

- ``to_record(raw)``: one provider row (an API result or a line of an export file) → a grad
  record, or ``None`` to skip it
- ``auth_headers(secret)``
- ``fetch_traces(since, cursor)``: one page of traces from the provider's export API
- ``fetch_scores(since, cursor)`` + ``to_score_update(raw)``: feedback, scores and corrections,
  including late ones on old traces (optional: skip both when trace rows carry their scores)
- ``detect(row)``: optional, recognises the provider's export rows for file auto-detection
- class attributes: ``name``, ``default_host``, ``page_size``, ``requests_per_minute``,
  ``filter_keys`` / ``pushdown_filters`` (see ``filters.py``) and, rarely, ``rescan_window`` /
  ``cursor_watermark``

Everything shared (HTTP, retries, pagination guards, watermark, batching, dedupe, merging)
lives in ``http.HttpClient`` and ``sync.SyncEngine``.
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from functools import cached_property
from typing import Any, Callable, ClassVar

from ..errors import SourceAPIChangedError, SourceUnavailableError
from ..records import SCORE_UPDATE
from .filters import COMMON_FILTERS, Filters
from .http import HttpClient

Raw = dict[str, Any]
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


@dataclass(frozen=True)
class Page:
    items: list[Raw]
    cursor: str | None = None  # the next page of this fetch; None on the last page
    resume: str | None = None  # cursor_watermark providers only: where the next sync starts


@dataclass(frozen=True)
class ScoreUpdate:
    """Scores and/or a correction for one trace, merged into its record by id."""

    trace_id: str
    scores: dict[str, float] = field(default_factory=dict)
    expected_output: Any = None
    updated_at: str | None = None  # ISO 8601; None when the provider has no update time

    def merge(self, newer: "ScoreUpdate") -> "ScoreUpdate":
        if (parse_time(newer.updated_at) or EPOCH) < (parse_time(self.updated_at) or EPOCH):
            return newer.merge(self)
        return ScoreUpdate(
            self.trace_id,
            {**self.scores, **newer.scores},
            newer.expected_output if newer.expected_output is not None else self.expected_output,
            newer.updated_at or self.updated_at,
        )

    def to_record(self, source: str) -> Raw:
        record: Raw = {"id": self.trace_id, "source": source, "metadata": {SCORE_UPDATE: True}}
        if self.scores:
            record["scores"] = dict(self.scores)
        if self.expected_output is not None:
            record["expected_output"] = self.expected_output
        if self.updated_at:
            record["timestamp"] = self.updated_at
        return record


@dataclass(frozen=True)
class SourceSpec:
    """A configured source. ``pull`` is the job-scoped page function the worker hands to
    providers that read through grad-server (``gradiated``)."""

    host: str | None = None
    secret: str = field(default="", repr=False)
    project: str | None = None
    filters: dict[str, Any] = field(default_factory=dict)
    pull: Callable[[str | None], dict[str, Any]] | None = field(default=None, repr=False)


EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def parse_time(value: Any) -> datetime | None:
    """ISO 8601 (``Z``, offsets, or naive = UTC) or epoch seconds/milliseconds → aware datetime."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return datetime.fromtimestamp(value / 1000 if value > 1e11 else value, timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00").replace(" ", "T", 1))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def iso_or_none(value: Any) -> str | None:
    parsed = parse_time(value)
    return iso(parsed) if parsed else None


class Provider(ABC):
    name: ClassVar[str]
    default_host: ClassVar[str | None] = None
    page_size: ClassVar[int] = 100
    requests_per_minute: ClassVar[float | None] = None
    # Scores are re-fetched from max(watermark, now - rescan_window), so edits that keep their
    # creation time still land. None: the provider's own cursor already covers late scores.
    rescan_window: ClassVar[timedelta | None] = timedelta(days=7)
    # True: the provider returns Page.resume (an opaque cursor) and the engine stores that as
    # the watermark instead of a timestamp.
    cursor_watermark: ClassVar[bool] = False
    # The filter keys this provider accepts (grad-server returns 422 for any other), and the
    # ones it sends to the provider's API. The engine applies every common key after fetching.
    filter_keys: ClassVar[frozenset[str]] = COMMON_FILTERS
    pushdown_filters: ClassVar[frozenset[str]] = frozenset()

    def __init__(self, spec: SourceSpec | None = None, **http_options: Any) -> None:
        self.spec = spec or SourceSpec()
        self._http_options = http_options

    # -- mapping (file imports and live sync) ----------------------------------------

    @abstractmethod
    def to_record(self, raw: Raw) -> Raw | None: ...

    def to_score_update(self, raw: Raw) -> ScoreUpdate | None:
        return None

    @classmethod
    def detect(cls, row: Raw) -> bool:
        return False

    # -- live sync ----------------------------------------------------------------------

    @abstractmethod
    def auth_headers(self, secret: str) -> dict[str, str]: ...

    @abstractmethod
    def fetch_traces(self, since: str | None, cursor: str | None) -> Page: ...

    def fetch_scores(self, since: str | None, cursor: str | None) -> Page:
        return Page([])

    # -- helpers ------------------------------------------------------------------------

    @cached_property
    def filters(self) -> Filters:
        return Filters(self.spec.filters)

    def window_start(self, since: str | None) -> str | None:
        """Where a time-ordered trace fetch starts: ``since``, raised to the ``from`` filter."""
        start, at = self.filters.start, parse_time(since)
        return iso(start) if start and (at is None or at < start) else since

    def window_end(self) -> str | None:
        """The ``to`` filter (exclusive), for the provider's upper time bound."""
        end = self.filters.end
        return iso(end) if end else None

    @cached_property
    def http(self) -> HttpClient:
        host = self.spec.host or self.default_host
        if not host:
            raise SourceUnavailableError(f"The {self.name} source needs a host.")
        secret = self.spec.secret
        return HttpClient(
            host,
            headers=self.auth_headers(secret),
            secrets=(secret, *secret.split(":")),
            requests_per_minute=self.requests_per_minute,
            **self._http_options,
        )

    def set_deadline(self, deadline: float) -> None:
        """No request starts or continues after ``deadline`` (``time.monotonic()``): a sync's cap."""
        self._http_options["deadline"] = deadline
        if "http" in self.__dict__:
            self.http.deadline = deadline

    def require_project(self) -> str:
        if not self.spec.project:
            raise SourceUnavailableError(f"The {self.name} source needs a project.")
        return self.spec.project

    def items(self, body: Any, *keys: str) -> list[Raw]:
        """``body[keys...]`` as a list of objects, or a typed error naming what was missing."""
        value = body
        for key in keys:
            value = value.get(key) if isinstance(value, dict) else None
        if not isinstance(value, list):
            raise SourceAPIChangedError(f"{self.name} response has no '{'.'.join(keys) or 'list'}' list")
        return [v for v in value if isinstance(v, dict)]
