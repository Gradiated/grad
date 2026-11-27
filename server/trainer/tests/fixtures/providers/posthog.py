"""PostHog: POST /api/projects/{id}/query/ with a HogQLQuery (``results`` rows + ``columns``),
paged by ``timestamp`` keyset. Generations are ``$ai_generation`` events; feedback is
``survey sent`` with ``$ai_trace_id`` and ``$survey_response_<question>`` (1 = up, 2 = down)."""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Any

from .base import Condition, ProviderFixture, Req, iso, parse

COLUMNS = ["uuid", "event", "timestamp", "created_at", "distinct_id", "properties"]


class PostHogFixture(ProviderFixture):
    name = "posthog"
    secret = "phx_0123456789"
    project = "12345"
    metadata_keys = ("model", "version", "user_id", "tags", "environment", "name")

    def add_trace(self, i: int, at: datetime) -> None:
        user, assistant = self.messages(i)
        p = self.remember(i, at)
        props = {
            "$ai_trace_id": self.trace_id(i),
            "$ai_session_id": p["session_id"],
            "$ai_span_name": p["name"],
            "$ai_model": p["model"],
            "$ai_provider": "gradiated",
            "$ai_input": [user],
            "$ai_output_choices": [assistant],
            "model_version": p["version"],
            "environment": p["environment"],
            "tags": p["tags"],
            "tier": p["tier"],
        }
        self.traces.append({"uuid": f"evt-{i}", "event": "$ai_generation", "timestamp": iso(at), "created_at": iso(at), "distinct_id": p["user_id"], "properties": props})

    def synced_score(self, name: str) -> str:
        return "thumbs"  # the LLM feedback survey's first question, whatever its id

    def add_score(self, trace_id: str, name: str, value: float, at: datetime) -> None:
        # The thumbs question (a UUID id, listed first in $survey_questions) and a text follow-up.
        thumbs, why = f"0193-{name}", f"0194-{name}"
        props = {
            "$survey_id": "srv-1",
            "$survey_questions": [{"id": thumbs, "question": "Was this helpful?"}, {"id": why, "question": "What went wrong?"}],
            f"$survey_response_{thumbs}": 1 if value >= 1 else 2,
            f"$survey_response_{why}": "" if value >= 1 else "it made things up",
            "$ai_trace_id": trace_id,
        }
        self.scores.append({"uuid": f"evt-s{len(self.scores)}", "event": "survey sent", "timestamp": iso(at), "created_at": iso(at), "distinct_id": "user-7", "properties": props})

    def respond(self, req: Req) -> tuple[int, Any, dict[str, str]]:
        if req.path != f"/api/projects/{self.project}/query/":
            return 404, {"detail": "not found"}, {}
        query = req.body["query"]
        assert query["kind"] == "HogQLQuery"
        sql = query["query"]
        events = self.traces if "event = '$ai_generation'" in sql else self.scores
        after = parse(re.search(r"timestamp >= '([^']+)'", sql).group(1))  # type: ignore[union-attr]
        limit = int(re.search(r"LIMIT (\d+)", sql).group(1))  # type: ignore[union-attr]
        rows = sorted((e for e in events if self.stuck or parse(e["timestamp"]) >= after), key=lambda e: e["timestamp"])
        if events is self.traces:
            rows = self.serve(self.admit(rows, lambda e: e["properties"]["$ai_trace_id"], self.conditions(sql))[:limit], lambda e: e["properties"]["$ai_trace_id"])
        rows = rows[:limit]
        # properties come back as a JSON string column
        results = [[e[c] if c != "properties" else json.dumps(e[c]) for c in COLUMNS] for e in rows]
        return 200, {"results": results, "columns": COLUMNS, "types": [], "hogql": sql}, {}

    FIELDS = {"properties.$ai_model": "model", "properties.$ai_span_name": "name", "properties.$ai_session_id": "session_id", "distinct_id": "user_id"}

    def conditions(self, sql: str) -> list[Condition]:
        found: list[Condition] = []
        for column, items in re.findall(r"([\w.$]+) IN \(([^)]*)\)", sql):
            found.append((self.FIELDS.get(column, column.removeprefix("properties.")), "in", re.findall(r"'([^']*)'", items)))
        found += [(key, "=", value) for key, value in re.findall(r"properties\.(\w+) = '([^']*)'", sql)]
        found += [("start", "<", parse(when)) for when in re.findall(r"timestamp < '([^']+)'", sql)]
        return found
