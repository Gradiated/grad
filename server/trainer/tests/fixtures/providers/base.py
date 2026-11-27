"""Base of the per-provider fixtures the contract suite runs against.

A fixture holds traces and scores in the provider's documented response shapes and answers
the provider's export endpoints from them (filters, ordering and cursors included), so the
same contract tests exercise every provider through its real request/response format.
Trace ``i`` is tagged model ``m-i``, version ``v-i`` and tag ``prod`` wherever the provider
supports those fields; ``expected_metadata(i)`` says which ones it maps.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, ClassVar

from fixtures.provider_server import Req

NOW = datetime(2026, 11, 27, 12, 0, tzinfo=timezone.utc)


def iso(at: datetime) -> str:
    return at.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def parse(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value.replace("Z", "+00:00").replace(" ", "T", 1)).replace(tzinfo=timezone.utc) if value else None


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

    def trace_id(self, i: int) -> str:
        return f"tr-{i}"

    def expected_metadata(self, i: int) -> dict[str, Any]:
        values = {"model": f"m-{i}", "version": f"v-{i}", "tags": ["prod"], "user_id": "user-7"}
        return {k: values[k] for k in self.metadata_keys}

    def add_trace(self, i: int, at: datetime) -> None:
        raise NotImplementedError

    def add_score(self, trace_id: str, name: str, value: float, at: datetime) -> None:
        raise NotImplementedError

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
