"""Langfuse public API: GET /api/public/v2/observations and GET /api/public/v3/scores.
Shapes from the OpenAPI spec (ObservationsV2Response, GetScoresV3Response): ``data`` plus
``meta.cursor`` (omitted on the last page); observations newest first; io fields are strings."""

from __future__ import annotations

import base64
import json
from datetime import datetime
from typing import Any

from .base import Condition, ProviderFixture, Req, iso, parse


class LangfuseFixture(ProviderFixture):
    name = "langfuse"
    secret = "pk-lf-test:sk-lf-0123456789"
    metadata_keys = ("model", "version", "tags", "user_id", "environment", "name")

    def authorized(self, req: Req) -> bool:
        return req.headers.get("authorization") == "Basic " + base64.b64encode(self.secret.encode()).decode()

    def add_trace(self, i: int, at: datetime) -> None:
        user, assistant = self.messages(i)
        p = self.remember(i, at)
        self.traces.append(
            {
                "id": f"obs-{i}",
                "traceId": self.trace_id(i),
                "startTime": iso(at),
                "endTime": iso(at),
                "projectId": "proj",
                "parentObservationId": None,
                "type": "SPAN",
                "name": p["name"],
                "level": "DEFAULT",
                "version": p["version"],
                "environment": p["environment"],
                "userId": p["user_id"],
                "sessionId": p["session_id"],
                "isRootObservation": True,
                "input": json.dumps([user]),
                "output": json.dumps(assistant),
                "metadata": {"model": p["model"], "tier": p["tier"]},
                "model": None,
                "tags": p["tags"],
                "release": "support-bot@2026-11-27",
                "traceName": p["name"],
            }
        )

    def add_score(self, trace_id: str, name: str, value: float, at: datetime) -> None:
        self.scores.append(
            {
                "id": f"score-{len(self.scores)}",
                "projectId": "proj",
                "name": name,
                "dataType": "NUMERIC",
                "value": value,
                "source": "API",
                "timestamp": iso(at),
                "environment": "default",
                "createdAt": iso(at),
                "updatedAt": iso(at),
                "comment": None,
                "metadata": None,
                "configId": None,
                "subject": {"kind": "trace", "id": trace_id},
            }
        )

    def add_correction(self, trace_id: str, answer: str, at: datetime) -> None:
        # A CORRECTION score: the corrected output as a string value.
        self.add_score(trace_id, "correction", 0.0, at)
        self.scores[-1].update(dataType="CORRECTION", value=answer)

    def respond(self, req: Req) -> tuple[int, Any, dict[str, str]]:
        limit = int(req.arg("limit", "50") or 50)
        if req.path == "/api/public/v2/observations":
            assert req.arg("isRootObservation") == "true" and "io" in (req.arg("fields") or "")
            since = parse(req.arg("fromStartTime"))
            rows = sorted((t for t in self.traces if since is None or parse(t["startTime"]) >= since), key=lambda t: t["startTime"], reverse=True)
            rows = self.admit(rows, lambda t: t["traceId"], self.conditions(req))
        elif req.path == "/api/public/v3/scores":
            assert limit <= 100
            since = parse(req.arg("fromTimestamp"))
            rows = [s for s in self.scores if since is None or parse(s["timestamp"]) >= since]
        else:
            return 404, {"message": "not found"}, {}
        chunk, cursor = self.page(rows, req.arg("cursor"), limit)
        if req.path == "/api/public/v2/observations":
            self.serve(chunk, lambda t: t["traceId"])
        return 200, {"data": chunk, "meta": {"limit": limit, **({"cursor": cursor} if cursor else {})}}, {}

    COLUMNS = {"tags": "tags", "traceName": "name", "version": "version", "userId": "user_id", "sessionId": "session_id"}

    def conditions(self, req: Req) -> list[Condition]:
        found: list[Condition] = []
        if req.arg("toStartTime"):
            found.append(("start", "<", parse(req.arg("toStartTime"))))
        if req.query.get("environment"):
            found.append(("environment", "in", req.query["environment"]))
        for c in json.loads(req.arg("filter") or "[]"):
            if c["type"] == "stringObject":
                assert c["column"] == "metadata" and c["operator"] == "="
                found.append((c["key"], "=", c["value"]))
            else:
                assert (c["type"], c["operator"]) in (("arrayOptions", "all of"), ("stringOptions", "any of")), c
                found.append((self.COLUMNS[c["column"]], "all" if c["type"] == "arrayOptions" else "in", c["value"]))
        return found
