"""Base of the per-provider fixtures the contract suite runs against.

A fixture holds traces and scores in the provider's documented response shapes and answers
the provider's export endpoints from them (filters, ordering and cursors included), so the
same contract tests exercise every provider through its real request/response format.
Trace ``i`` has the attributes of ``profile(i)`` (model ``m-i``, version ``v-i``, tags, name,
environment, user, session and a ``tier`` metadata key), each in the provider's native place;
``expected_metadata(i)`` says which ones a record maps. A fixture answers the filters its
provider pushes down (``Provider.pushdown_filters``) the way the real API does: it turns the
request into ``(field, op, value)`` conditions and ``admit`` applies them, recording the trace
ids it served in ``served``.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, ClassVar, Iterable

from fixtures.provider_server import Req

NOW = datetime(2026, 11, 27, 12, 0, tzinfo=timezone.utc)


def iso(at: datetime) -> str:
    return at.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def parse(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value.replace("Z", "+00:00").replace(" ", "T", 1)).replace(tzinfo=timezone.utc) if value else None


def profile(i: int) -> dict[str, Any]:
    """The attributes of trace ``i`` that the filter contract cases select on."""
    return {
        "model": f"m-{i}",
        "version": f"v-{i}",
        "tags": ["prod", "beta"] if i % 2 else ["prod"],
        "name": "triage" if i == 2 else "answer",
        "environment": "staging" if i == 4 else "production",
        "user_id": "user-0" if i == 0 else "user-7",
        "session_id": f"sess-{i}",
        "tier": "gold" if i in (1, 3) else "free",
    }


Condition = tuple[str, str, Any]  # (profile field or "start", "all" | "in" | "=" | ">=" | "<", value)


class ProviderFixture:
    name: ClassVar[str]
    secret: ClassVar[str] = "sk-test-0123456789"
    project: ClassVar[str | None] = None
    http: ClassVar[bool] = True
    metadata_keys: ClassVar[tuple[str, ...]] = ("model", "version", "tags")

    def __init__(self) -> None:
        self.traces: list[dict[str, Any]] = []
        self.scores: list[dict[str, Any]] = []
        self.stuck = False  # ignore cursors and serve the first trace page forever
        self.attrs: dict[str, dict[str, Any]] = {}  # trace id -> profile + "start"
        self.served: set[str] = set()  # trace ids the trace endpoint returned

    def remember(self, i: int, at: datetime) -> dict[str, Any]:
        attrs = {**profile(i), "start": at}
        self.attrs[self.trace_id(i)] = attrs
        return attrs

    def admit(self, rows: Iterable[dict[str, Any]], trace_id: Any, conditions: list[Condition]) -> list[dict[str, Any]]:
        """``rows`` whose trace passes every pushed-down condition; records them as served."""
        kept = []
        for row in rows:
            attrs = self.attrs.get(str(trace_id(row)), {})
            if all(_holds(attrs.get(field), op, value) for field, op, value in conditions):
                kept.append(row)
        return kept

    def serve(self, rows: list[dict[str, Any]], trace_id: Any) -> list[dict[str, Any]]:
        self.served.update(str(trace_id(r)) for r in rows)
        return rows

    def trace_id(self, i: int) -> str:
        return f"tr-{i}"

    def expected_metadata(self, i: int) -> dict[str, Any]:
        values = profile(i)
        return {k: values[k] for k in self.metadata_keys}

    def add_trace(self, i: int, at: datetime) -> None:
        raise NotImplementedError

    def add_score(self, trace_id: str, name: str, value: float, at: datetime) -> None:
        raise NotImplementedError

    def synced_score(self, name: str) -> str:
        """The score name a score added with ``add_score(name=...)`` syncs as."""
        return name

    def add_correction(self, trace_id: str, answer: str, at: datetime) -> None:
        """A fixed answer for a trace, the way the provider's feedback API records it."""
        raise NotImplementedError(f"{self.name} has no corrections")

    def respond(self, req: Req) -> tuple[int, Any, dict[str, str]]:
        raise NotImplementedError

    def authorized(self, req: Req) -> bool:
        return req.headers.get("authorization") == f"Bearer {self.secret}"

    def page(self, items: list[Any], cursor: str | None, limit: int) -> tuple[list[Any], str | None]:
        """Offset paging with an opaque-looking cursor (``off:N``)."""
        if self.stuck:
            return items[:limit], "stuck"
        offset = int(cursor.removeprefix("off:")) if cursor else 0
        chunk = items[offset : offset + limit]
        return chunk, f"off:{offset + limit}" if offset + limit < len(items) else None

    @staticmethod
    def messages(i: int) -> list[dict[str, str]]:
        return [{"role": "user", "content": f"question {i}"}, {"role": "assistant", "content": f"answer {i}"}]


def _holds(actual: Any, op: str, value: Any) -> bool:
    if op == "all":
        return set(value) <= set(actual or [])
    if op == "in":
        return actual is not None and str(actual) in {str(v) for v in value}
    if op == "=":
        return actual is not None and str(actual) == str(value)
    if op == ">=":
        return actual is not None and actual >= value
    if op == "<":
        return actual is not None and actual < value
    raise AssertionError(f"unknown op {op}")
