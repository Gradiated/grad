"""Langfuse: root observations (one per trace) from ``GET /api/public/v2/observations`` and scores
from ``GET /api/public/v3/scores``. The v1 ``GET /api/public/traces`` read API was removed from
Langfuse Cloud on 2026-11-16; file exports of v1 trace objects still import through
``to_record``.

Secret: ``PUBLIC_KEY:SECRET_KEY`` (HTTP Basic). Keys are scoped to one project.
Docs: https://langfuse.com/docs/api-and-data-platform/features/public-api
"""

from __future__ import annotations

import base64
from typing import Any

from ..errors import SourceAuthError
from ..records import coerce_messages, coerce_scores, maybe_json, record_metadata, score_value
from .base import Page, Provider, Raw, ScoreUpdate, iso_or_none

OBSERVATION_FIELDS = "core,basic,io,metadata,model,trace_context"


class LangfuseProvider(Provider):
    name = "langfuse"
    default_host = "https://cloud.langfuse.com"
    page_size = 1000  # v2 observations max; v3 scores max is 100
    requests_per_minute = 30  # the Hobby tier's general API limit (Core 100, Pro 1000)

    def auth_headers(self, secret: str) -> dict[str, str]:
        public, sep, private = secret.partition(":")
        if not (sep and public and private):
            raise SourceAuthError("The Langfuse secret must be 'PUBLIC_KEY:SECRET_KEY' (pk-lf-...:sk-lf-...).")
        return {"Authorization": "Basic " + base64.b64encode(f"{public}:{private}".encode()).decode()}

    def fetch_traces(self, since: str | None, cursor: str | None) -> Page:
        body = self.http.get(
            "/api/public/v2/observations",
            isRootObservation="true",
            fields=OBSERVATION_FIELDS,
            limit=self.page_size,
            fromStartTime=since,
            cursor=cursor,
        )
        return Page(self.items(body, "data"), (body.get("meta") or {}).get("cursor"))

    def fetch_scores(self, since: str | None, cursor: str | None) -> Page:
        body = self.http.get(
            "/api/public/v3/scores", fields="details,subject", limit=100, fromTimestamp=since, cursor=cursor
        )
        return Page(self.items(body, "data"), (body.get("meta") or {}).get("cursor"))

    @classmethod
    def detect(cls, row: Raw) -> bool:
        return "sessionId" in row or "traceId" in row or ("input" in row and "output" in row and row.get("schema") is None)

    def to_record(self, raw: Raw) -> Raw | None:
        """A v2 root observation, or a v1 trace object from an export file."""
        messages = coerce_messages(maybe_json(raw.get("input")), default_role="user")
        messages += coerce_messages(maybe_json(raw.get("output")), default_role="assistant")
        meta = maybe_json(raw.get("metadata"))
        meta = meta if isinstance(meta, dict) else {}
        record: Raw = {"messages": messages}
        trace_id = raw.get("traceId") or raw.get("id")
        if trace_id:
            record["id"] = str(trace_id)
        if raw.get("sessionId"):
            record["session_id"] = str(raw["sessionId"])
        timestamp = iso_or_none(raw.get("startTime") or raw.get("timestamp"))
        if timestamp:
            record["timestamp"] = timestamp
        scores = coerce_scores(raw.get("scores"))
        if scores:
            record["scores"] = scores
        record["metadata"] = record_metadata(
            "langfuse",
            meta,
            model=meta.get("model") or raw.get("model"),
            version=raw.get("version"),
            release=raw.get("release"),
            tags=raw.get("tags") or None,
            user_id=raw.get("userId"),
        )
        return record

    def to_score_update(self, raw: Raw) -> ScoreUpdate | None:
        subject: dict[str, Any] = raw.get("subject") or {}
        kind = subject.get("kind")
        trace_id = subject.get("id") if kind == "trace" else subject.get("traceId") if kind == "observation" else None
        trace_id = trace_id or raw.get("traceId")  # v1 score objects in export files
        if not trace_id:
            return None  # session and experiment scores have no trace
        data_type = str(raw.get("dataType") or "NUMERIC").upper()
        updated = iso_or_none(raw.get("updatedAt") or raw.get("timestamp"))
        if data_type == "CORRECTION":
            return ScoreUpdate(str(trace_id), expected_output=raw.get("value") or None, updated_at=updated)
        value = score_value(raw.get("value")) if data_type in ("NUMERIC", "BOOLEAN") else None
        if value is None or not raw.get("name"):
            return None  # categorical and text scores aren't numbers
        return ScoreUpdate(str(trace_id), {str(raw["name"]): value}, updated_at=updated)
