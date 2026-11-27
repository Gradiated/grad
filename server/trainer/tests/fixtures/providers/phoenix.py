"""Arize Phoenix REST: GET /v1/projects/{p}/spans (``data`` + ``next_cursor``; flat dotted
OpenInference attributes) and GET /v1/projects/{p}/span_annotations?span_ids=..."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from .base import Condition, ProviderFixture, Req, iso, parse


class PhoenixFixture(ProviderFixture):
    name = "phoenix"
    secret = "phx-api-0123456789"
    metadata_keys = ("model", "version", "tags", "user_id", "environment", "name")

    def add_trace(self, i: int, at: datetime) -> None:
        user, assistant = self.messages(i)
        p = self.remember(i, at)
        self.traces.append(
            {
                "id": f"U3Bhbjo{i}",
                "name": p["name"],
                "context": {"trace_id": f"{i:032x}", "span_id": self.trace_id(i)},
                "span_kind": "LLM",
                "parent_id": None,
                "start_time": iso(at),
                "end_time": iso(at),
                "status_code": "OK",
                "status_message": "",
                "attributes": {
                    "openinference.span.kind": "LLM",
                    "llm.model_name": "gpt-x",
                    "llm.input_messages.0.message.role": "user",
                    "llm.input_messages.0.message.content": user["content"],
                    "llm.output_messages.0.message.role": "assistant",
                    "llm.output_messages.0.message.content": assistant["content"],
                    "session.id": p["session_id"],
                    "user.id": p["user_id"],
                    "metadata": json.dumps({k: p[k] for k in ("model", "version", "environment", "tier")}),
                    "tag.tags": p["tags"],
                },
                "events": [],
            }
        )

    def add_score(self, trace_id: str, name: str, value: float, at: datetime) -> None:
        self.scores.append(
            {
                "id": f"ann-{len(self.scores)}",
                "span_id": trace_id,
                "name": name,
                "annotator_kind": "HUMAN",
                "result": {"label": "thumbs-up", "score": value, "explanation": None},
                "metadata": {},
                "identifier": "",
                "source": "API",
                "user_id": None,
                "created_at": iso(at),
                "updated_at": iso(at),
            }
        )

    def respond(self, req: Req) -> tuple[int, Any, dict[str, str]]:
        limit = int(req.arg("limit", "100") or 100)
        if req.path == "/v1/projects/default/spans":
            assert (req.arg("parent_id"), req.arg("sort"), req.arg("order")) == ("null", "start_time", "asc")
            since = parse(req.arg("start_time"))
            rows = sorted((s for s in self.traces if since is None or parse(s["start_time"]) >= since), key=lambda s: s["start_time"])
            rows = self.admit(rows, lambda s: s["context"]["span_id"], self.conditions(req))
        elif req.path == "/v1/projects/default/span_annotations":
            ids = set(req.query.get("span_ids") or [])
            assert ids, "span_ids is required"
            rows = [a for a in self.scores if a["span_id"] in ids]
        else:
            return 404, {"detail": "not found"}, {}
        chunk, cursor = self.page(rows, req.arg("cursor"), limit)
        if req.path.endswith("/spans"):
            self.serve(chunk, lambda s: s["context"]["span_id"])
        return 200, {"data": chunk, "next_cursor": cursor}, {}

    ATTRIBUTES = {"user.id": "user_id", "session.id": "session_id"}

    def conditions(self, req: Req) -> list[Condition]:
        found: list[Condition] = []
        if req.arg("end_time"):
            found.append(("start", "<", parse(req.arg("end_time"))))
        if req.query.get("name"):
            found.append(("name", "in", req.query["name"]))
        for pair in req.query.get("attribute") or []:
            key, _, value = pair.partition(":")
            found.append((self.ATTRIBUTES.get(key, key.removeprefix("metadata.")), "=", json.loads(value)))
        return found
