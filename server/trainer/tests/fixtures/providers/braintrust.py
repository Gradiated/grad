"""Braintrust: POST /btql with SQL over project_logs(...) (``data`` rows, cursor in the
``x-bt-cursor`` header, ``OFFSET '<cursor>'`` for the next page) and GET /v1/project.
logFeedback merges scores into the span row and bumps its ``_xact_id``."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from .base import ProviderFixture, Req, iso

PROJECT_ID = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d"
XACT_BASE = 1000192656880881099


class BraintrustFixture(ProviderFixture):
    name = "braintrust"
    project = "support-bot"
    metadata_keys = ("model", "version", "tags", "user_id")

    def __init__(self) -> None:
        super().__init__()
        self.xact = 0

    def _next_xact(self) -> str:
        self.xact += 1
        return str(XACT_BASE + self.xact)

    def add_trace(self, i: int, at: datetime) -> None:
        user, assistant = self.messages(i)
        span = self.trace_id(i)
        self.traces.append(
            {
                "id": span,
                "span_id": span,
                "root_span_id": span,
                "span_parents": None,
                "is_root": True,
                "_xact_id": self._next_xact(),
                "created": iso(at),
                "org_id": "org",
                "project_id": PROJECT_ID,
                "log_id": "g",
                "input": [user],
                "output": assistant["content"],
                "expected": None,
                "scores": None,
                "metadata": {"model": f"m-{i}", "version": f"v-{i}", "user_id": "user-7"},
                "tags": ["prod"],
            }
        )

    def add_score(self, trace_id: str, name: str, value: float, at: datetime) -> None:
        row = next(r for r in self.traces if r["id"] == trace_id)
        row["scores"] = {**(row["scores"] or {}), name: value}
        row["_xact_id"] = self._next_xact()

    def add_correction(self, trace_id: str, answer: str, at: datetime) -> None:
        # logFeedback({id, expected}) replaces the span's expected and bumps _xact_id.
        row = next(r for r in self.traces if r["id"] == trace_id)
        row["expected"] = answer
        row["_xact_id"] = self._next_xact()

    def respond(self, req: Req) -> tuple[int, Any, dict[str, str]]:
        if req.path == "/v1/project":
            found = [{"id": PROJECT_ID, "name": self.project, "org_id": "org"}] if req.arg("project_name") == self.project else []
            return 200, {"objects": found}, {}
        if req.path != "/btql":
            return 404, {"error": "not found"}, {}
        sql = req.body["query"]
        assert req.body.get("fmt") == "json" and f"project_logs('{PROJECT_ID}'" in sql and "WHERE is_root" in sql
        since = re.search(r"_xact_id > '(\d+)'", sql)
        limit = int(re.search(r"LIMIT (\d+)", sql).group(1))  # type: ignore[union-attr]
        offset = re.search(r"OFFSET '([^']*)'", sql)
        rows = sorted((r for r in self.traces if not since or int(r["_xact_id"]) > int(since.group(1))), key=lambda r: int(r["_xact_id"]))
        chunk, cursor = self.page(rows, offset.group(1) if offset else None, limit)
        return 200, {"data": chunk, "schema": {}}, {"x-bt-cursor": cursor} if cursor else {}
