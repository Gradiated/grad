"""Gradiated Cloud traces:pull (r7-cloud-integration.md §4.1), reached through the worker's
job-scoped source-page call: ``{"records": [trace | score], "cursor", "has_more"}``.
No HTTP here: the fixture is the ``pull`` function the worker would pass."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from .base import ProviderFixture, iso

PAGE = 2


class GradiatedFixture(ProviderFixture):
    name = "gradiated"
    secret = ""
    http = False
    metadata_keys = ("model", "version")

    def __init__(self) -> None:
        super().__init__()
        self.stream: list[dict[str, Any]] = []  # one append-only stream, as the Cloud API reads it

    def add_trace(self, i: int, at: datetime) -> None:
        self.stream.append(
            {
                "type": "trace",
                "trace_id": self.trace_id(i),
                "session_id": f"sess-{i}",
                "generation_id": f"gen-{i}",
                "messages": self.messages(i),
                "tools": [],
                "output": {},
                "metadata": {"model": f"m-{i}", "task": "support", "version": f"v-{i}", "grad_artifact_id": None, "source": "hosted", "started_at": iso(at)},
            }
        )

    def add_score(self, trace_id: str, name: str, value: float, at: datetime) -> None:
        self.stream.append(
            {"type": "score", "trace_id": trace_id, "name": name, "value": value, "expected_output": None, "comment": None, "updated_at": iso(at), "score_id": f"s{len(self.stream)}"}
        )

    def pull(self, cursor: str | None) -> dict[str, Any]:
        offset = 0 if self.stuck or not cursor else int(cursor)
        chunk = self.stream[offset : offset + PAGE]
        end = offset + len(chunk)
        return {"records": chunk, "cursor": str(end), "has_more": self.stuck or end < len(self.stream)}
