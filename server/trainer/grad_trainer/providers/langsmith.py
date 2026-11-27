"""LangSmith: root runs from ``POST /api/v2/runs/query`` and feedback from ``GET /api/v1/feedback``.

Secret: an API key with read access (``x-api-key``). ``project`` is a tracing project name or
UUID (default ``default``). In LangSmith a run's ``session_id`` is the *project*; the
conversation is ``thread_id`` (or ``metadata.thread_id`` / ``metadata.session_id``).
Docs: https://docs.langchain.com/langsmith/smith-api/runs/query-runs
"""

from __future__ import annotations

from functools import cached_property

from ..errors import SourceUnavailableError
from ..records import coerce_messages, coerce_scores, record_metadata, score_value
from .base import UUID_RE, Page, Provider, Raw, ScoreUpdate, iso_or_none

SELECTS = ["ID", "TRACE_ID", "THREAD_ID", "NAME", "START_TIME", "INPUTS", "OUTPUTS", "METADATA", "TAGS", "FEEDBACK_STATS"]
EARLIEST = "2000-01-01T00:00:00Z"  # min_start_time defaults to one day ago


class LangSmithProvider(Provider):
    name = "langsmith"
    default_host = "https://api.smith.langchain.com"
    page_size = 100  # runs: up to 1000; feedback: up to 100
    requests_per_minute = 600  # runs query allows 300 per 10 s per key

    def auth_headers(self, secret: str) -> dict[str, str]:
        return {"x-api-key": secret}

    @cached_property
    def project_id(self) -> str:
        project = self.spec.project or "default"
        if UUID_RE.match(project):
            return project
        found = self.items({"list": self.http.get("/api/v1/sessions", name=project, limit=1)}, "list")
        if not found or not found[0].get("id"):
            raise SourceUnavailableError(f"LangSmith has no tracing project named '{project}'.")
        return str(found[0]["id"])

    def fetch_traces(self, since: str | None, cursor: str | None) -> Page:
        body = self.http.post(
            "/api/v2/runs/query",
            {
                "project_ids": [self.project_id],
                "is_root": True,
                "min_start_time": since or EARLIEST,
                "selects": SELECTS,
                "page_size": self.page_size,
                **({"cursor": cursor} if cursor else {}),
            },
        )
        return Page(self.items(body, "items"), body.get("next_cursor"))

    def fetch_scores(self, since: str | None, cursor: str | None) -> Page:
        offset = int(cursor or 0)
        body = self.http.get(
            "/api/v1/feedback", session=self.project_id, min_created_at=since, limit=self.page_size, offset=offset
        )
        rows = self.items({"list": body}, "list")
        return Page(rows, str(offset + len(rows)) if len(rows) == self.page_size else None)

    @classmethod
    def detect(cls, row: Raw) -> bool:
        return "inputs" in row and "outputs" in row

    def to_record(self, raw: Raw) -> Raw | None:
        inputs = raw.get("inputs") or {}
        outputs = raw.get("outputs") or {}
        messages = coerce_messages(inputs.get("messages", inputs) if isinstance(inputs, dict) else inputs, default_role="user")
        gens = outputs.get("generations") if isinstance(outputs, dict) else None
        if isinstance(gens, list) and gens:
            first = gens[0][0] if isinstance(gens[0], list) and gens[0] else gens[0]
            if isinstance(first, dict):
                messages += coerce_messages(first.get("message") or first.get("text"), default_role="assistant")
        else:
            messages += coerce_messages(outputs, default_role="assistant")
        extra = raw.get("extra") if isinstance(raw.get("extra"), dict) else {}
        meta = raw.get("metadata") if isinstance(raw.get("metadata"), dict) else extra.get("metadata") or {}
        record: Raw = {"messages": messages}
        if raw.get("id"):
            record["id"] = str(raw["id"])
        thread = raw.get("thread_id") or meta.get("thread_id") or meta.get("session_id") or meta.get("conversation_id")
        if thread:
            record["session_id"] = str(thread)
        timestamp = iso_or_none(raw.get("start_time"))
        if timestamp:
            record["timestamp"] = timestamp
        scores = coerce_scores(raw.get("feedback_stats"))
        if scores:
            record["scores"] = scores
        record["metadata"] = record_metadata(
            "langsmith", meta, model=meta.get("model") or meta.get("ls_model_name"), tags=raw.get("tags") or None
        )
        return record

    def to_score_update(self, raw: Raw) -> ScoreUpdate | None:
        trace_id = raw.get("trace_id") or raw.get("run_id")  # a root run's id is its trace id
        if not trace_id:
            return None
        value = score_value(raw.get("score"))
        scores = {str(raw["key"]): value} if value is not None and raw.get("key") else {}
        return ScoreUpdate(
            str(trace_id),
            scores,
            raw.get("correction"),
            iso_or_none(raw.get("modified_at") or raw.get("created_at")),
        )
