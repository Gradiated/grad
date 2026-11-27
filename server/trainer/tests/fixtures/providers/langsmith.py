"""LangSmith: POST /api/v2/runs/query (``items`` + ``next_cursor``, newest first),
GET /api/v1/feedback (bare list, offset paging, newest first), GET /api/v1/sessions?name=."""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

from .base import Condition, ProviderFixture, Req, iso, parse

PROJECT_ID = "6f1c1a52-3f0e-4a4e-9b55-3d1d7c4e2a10"


class LangSmithFixture(ProviderFixture):
    name = "langsmith"
    secret = "lsv2_pt_0123456789"
    project = "support-bot"
    metadata_keys = ("model", "version", "tags", "user_id", "environment", "name")

    def authorized(self, req: Req) -> bool:
        return req.headers.get("x-api-key") == self.secret

    def add_trace(self, i: int, at: datetime) -> None:
        user, assistant = self.messages(i)
        p = self.remember(i, at)
        self.traces.append(
            {
                "id": self.trace_id(i),
                "trace_id": self.trace_id(i),
                "project_id": PROJECT_ID,
                "thread_id": p["session_id"],
                "name": p["name"],
                "run_type": "chain",
                "start_time": iso(at),
                "is_root": True,
                "inputs": {"messages": [user]},
                "outputs": {"messages": [assistant]},
                "metadata": {"model": p["model"], "version": p["version"], "environment": p["environment"], "user_id": p["user_id"], "tier": p["tier"]},
                "tags": p["tags"],
                "feedback_stats": {},
            }
        )

    def add_score(self, trace_id: str, name: str, value: float, at: datetime) -> None:
        self.scores.append(
            {
                "id": f"fb-{len(self.scores)}",
                "run_id": trace_id,
                "session_id": PROJECT_ID,
                "key": name,
                "score": value,
                "value": None,
                "comment": None,
                "correction": None,
                "created_at": iso(at),
                "modified_at": iso(at),
                "feedback_source": {"type": "api"},
            }
        )

    def add_correction(self, trace_id: str, answer: str, at: datetime) -> None:
        # create_feedback(run_id, key="correction", correction={"outputs": {...}}): no score.
        self.add_score(trace_id, "correction", 0.0, at)
        self.scores[-1].update(score=None, correction={"outputs": {"answer": answer}})

    def respond(self, req: Req) -> tuple[int, Any, dict[str, str]]:
        if req.path == "/api/v1/sessions":
            return 200, [{"id": PROJECT_ID, "name": self.project}] if req.arg("name") == self.project else [], {}
        if req.path == "/api/v2/runs/query":
            body = req.body
            assert body["project_ids"] == [PROJECT_ID] and body["is_root"] is True and "INPUTS" in body["selects"]
            since = parse(body["min_start_time"])
            rows = sorted((r for r in self.traces if parse(r["start_time"]) >= since), key=lambda r: r["start_time"], reverse=True)
            rows = self.admit(rows, lambda r: r["id"], self.conditions(body))
            chunk, cursor = self.page(rows, body.get("cursor"), int(body["page_size"]))
            self.serve(chunk, lambda r: r["id"])
            return 200, {"items": chunk, "next_cursor": cursor}, {}
        if req.path == "/api/v1/feedback":
            assert req.arg("session") == PROJECT_ID
            since = parse(req.arg("min_created_at"))
            rows = sorted((f for f in self.scores if since is None or parse(f["created_at"]) >= since), key=lambda f: f["created_at"], reverse=True)
            offset, limit = int(req.arg("offset", "0") or 0), int(req.arg("limit", "100") or 100)
            return 200, rows[offset : offset + limit], {}
        return 404, {"detail": "not found"}, {}

    def conditions(self, body: dict[str, Any]) -> list[Condition]:
        """``max_start_time`` and the filter expression's ``has(tags, ..)`` / ``in(name, [..])``."""
        found: list[Condition] = []
        if body.get("max_start_time"):
            found.append(("start", "<", parse(body["max_start_time"])))
        expr = body.get("filter") or ""
        found += [("tags", "all", [json.loads(tag)]) for tag in re.findall(r'has\(tags, ("[^"]*")\)', expr)]
        found += [("name", "in", json.loads(names)) for names in re.findall(r"in\(name, (\[[^\]]*\])\)", expr)]
        return found
