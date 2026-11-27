"""Langfuse public API: GET /api/public/v2/observations and GET /api/public/v3/scores.
Shapes from the OpenAPI spec (ObservationsV2Response, GetScoresV3Response): ``data`` plus
``meta.cursor`` (omitted on the last page); observations newest first; io fields are strings."""

from __future__ import annotations

import base64
import json
from datetime import datetime
from typing import Any

from .base import ProviderFixture, Req, iso, parse


class LangfuseFixture(ProviderFixture):
    name = "langfuse"
    secret = "pk-lf-test:sk-lf-0123456789"
    metadata_keys = ("model", "version", "tags", "user_id")

    def authorized(self, req: Req) -> bool:
        return req.headers.get("authorization") == "Basic " + base64.b64encode(self.secret.encode()).decode()

    def add_trace(self, i: int, at: datetime) -> None:
        user, assistant = self.messages(i)
        self.traces.append(
            {
                "id": f"obs-{i}",
                "traceId": self.trace_id(i),
                "startTime": iso(at),
                "endTime": iso(at),
                "projectId": "proj",
                "parentObservationId": None,
                "type": "SPAN",
                "name": "answer",
                "level": "DEFAULT",
                "version": f"v-{i}",
                "environment": "default",
                "userId": "user-7",
                "sessionId": f"sess-{i}",
                "isRootObservation": True,
                "input": json.dumps([user]),
                "output": json.dumps(assistant),
                "metadata": {"model": f"m-{i}"},
                "model": None,
                "tags": ["prod"],
                "release": "support-bot@2026-11-27",
                "traceName": "answer",
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

    def respond(self, req: Req) -> tuple[int, Any, dict[str, str]]:
        limit = int(req.arg("limit", "50") or 50)
        if req.path == "/api/public/v2/observations":
            assert req.arg("isRootObservation") == "true" and "io" in (req.arg("fields") or "")
            since = parse(req.arg("fromStartTime"))
            rows = sorted((t for t in self.traces if since is None or parse(t["startTime"]) >= since), key=lambda t: t["startTime"], reverse=True)
        elif req.path == "/api/public/v3/scores":
            assert limit <= 100
            since = parse(req.arg("fromTimestamp"))
            rows = [s for s in self.scores if since is None or parse(s["timestamp"]) >= since]
        else:
            return 404, {"message": "not found"}, {}
        chunk, cursor = self.page(rows, req.arg("cursor"), limit)
        return 200, {"data": chunk, "meta": {"limit": limit, **({"cursor": cursor} if cursor else {})}}, {}
