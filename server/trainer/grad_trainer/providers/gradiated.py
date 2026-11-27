"""Gradiated Cloud gateway traces and feedback.

Cloud-only. The worker never talks to the Cloud API itself: it calls the job-scoped
``POST /v1/trainer-jobs/{id}/source-page {worker_id, attempt, cursor}`` on grad-server, which adds
the workspace and service token and forwards to ``POST /api/internal/v1/training/traces:pull``
(r7-cloud-integration.md §4). One page is ``{"records": [{"type": "trace" | "score", ...}],
"cursor": "<opaque>", "has_more": bool}``. The Cloud cursor already covers late scores (it
reads feedback by ingestion time), so it is the watermark.

File imports also accept the gateway's export rows (``request``/``response``).
"""

from __future__ import annotations

from ..errors import SourceUnavailableError
from ..records import coerce_messages, coerce_scores, record_metadata, score_value
from .base import Page, Provider, Raw, ScoreUpdate, iso_or_none


class GradiatedProvider(Provider):
    name = "gradiated"
    page_size = 500
    rescan_window = None
    cursor_watermark = True

    def auth_headers(self, secret: str) -> dict[str, str]:
        return {}  # the worker authenticates to grad-server

    def _pull(self, kind: str, since: str | None, cursor: str | None) -> Page:
        if self.spec.pull is None:
            raise SourceUnavailableError("The gradiated source is only available on Gradiated Cloud.")
        body = self.spec.pull(cursor or since)
        records = self.items(body, "records")
        resume = body.get("cursor")
        return Page([r for r in records if r.get("type") == kind], resume if body.get("has_more") else None, resume)

    # Traces and scores share one Cloud stream; each pass keeps its own type.
    def fetch_traces(self, since: str | None, cursor: str | None) -> Page:
        return self._pull("trace", since, cursor)

    def fetch_scores(self, since: str | None, cursor: str | None) -> Page:
        return self._pull("score", since, cursor)

    @classmethod
    def detect(cls, row: Raw) -> bool:
        return isinstance(row.get("request"), dict) and isinstance(row.get("response"), dict)

    def to_record(self, raw: Raw) -> Raw | None:
        if raw.get("type") == "score":
            return None
        req = raw.get("request") or {}
        resp = raw.get("response") or {}
        if raw.get("type") == "trace":
            messages = coerce_messages(raw.get("messages"))
            tools, model = raw.get("tools"), None
        else:  # gateway export row
            messages = coerce_messages(req.get("messages"))
            choices = resp.get("choices") or []
            if choices and isinstance(choices[0], dict):
                messages += coerce_messages(choices[0].get("message"), default_role="assistant")
            tools, model = req.get("tools"), raw.get("model") or req.get("model")
        record: Raw = {"messages": messages}
        if isinstance(tools, list) and tools:
            record["tools"] = tools
        trace_id = raw.get("trace_id") or raw.get("id")
        if trace_id:
            record["id"] = str(trace_id)
        if raw.get("session_id"):
            record["session_id"] = str(raw["session_id"])
        meta = raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {}
        timestamp = iso_or_none(meta.get("started_at") or raw.get("created_at"))
        if timestamp:
            record["timestamp"] = timestamp
        scores = coerce_scores(raw.get("scores"))
        if scores:
            record["scores"] = scores
        record["metadata"] = record_metadata("gradiated", meta, model=meta.get("model") or model)
        return record

    def to_score_update(self, raw: Raw) -> ScoreUpdate | None:
        value = score_value(raw.get("value"))
        if not raw.get("trace_id"):
            return None
        scores = {str(raw["name"]): value} if value is not None and raw.get("name") else {}
        return ScoreUpdate(str(raw["trace_id"]), scores, raw.get("expected_output"), iso_or_none(raw.get("updated_at")))
