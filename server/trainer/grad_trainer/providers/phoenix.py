"""Arize Phoenix: root spans from ``GET /v1/projects/{project}/spans`` (OpenInference attributes)
and their annotations from ``GET /v1/projects/{project}/span_annotations``.

The annotations endpoint has no time filter and needs ``span_ids``, so ``fetch_scores`` pages
over the root spans in the re-scan window and asks for their annotations; ``updated_at`` then
drops the ones already synced. Exported span files import with ``--format otel`` instead.

Secret: a Phoenix API key (Bearer), optional when auth is off. ``project`` is the project name
or id (default ``default``). Host: the Phoenix URL, including a Cloud space path.
Docs: https://arize.com/docs/phoenix/sdk-api-reference/rest-api/overview
"""

from __future__ import annotations

from typing import Any

from ..formats import otel_attributes, otel_messages
from ..records import coerce_messages, maybe_json, record_metadata, score_value
from .base import Page, Provider, Raw, ScoreUpdate, iso_or_none
from .sync import pages

ANNOTATIONS_LIMIT = 1000


class PhoenixProvider(Provider):
    name = "phoenix"
    page_size = 100  # spans: up to 1000

    def auth_headers(self, secret: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {secret}"} if secret else {}

    @property
    def _base(self) -> str:
        return f"/v1/projects/{self.spec.project or 'default'}"

    def fetch_traces(self, since: str | None, cursor: str | None) -> Page:
        body = self.http.get(
            f"{self._base}/spans",
            parent_id="null",  # root spans only
            sort="start_time",
            order="asc",
            start_time=since,
            limit=self.page_size,
            cursor=cursor,
        )
        return Page(self.items(body, "data"), body.get("next_cursor"))

    def fetch_scores(self, since: str | None, cursor: str | None) -> Page:
        spans = self.fetch_traces(since, cursor)
        ids = [str((s.get("context") or {}).get("span_id")) for s in spans.items if (s.get("context") or {}).get("span_id")]
        annotations: list[Raw] = []
        if ids:
            for page in pages(lambda _since, c: self._annotations(ids, c), None):
                annotations += page.items
        return Page(annotations, spans.cursor)

    def _annotations(self, span_ids: list[str], cursor: str | None) -> Page:
        body = self.http.get(f"{self._base}/span_annotations", span_ids=span_ids, limit=ANNOTATIONS_LIMIT, cursor=cursor)
        return Page(self.items(body, "data"), body.get("next_cursor"))

    def to_record(self, raw: Raw) -> Raw | None:
        attrs = otel_attributes(raw)
        messages = otel_messages(attrs) or (
            coerce_messages(maybe_json(attrs.get("input.value")), default_role="user")
            + coerce_messages(maybe_json(attrs.get("output.value")), default_role="assistant")
        )
        context: dict[str, Any] = raw.get("context") or {}
        meta = maybe_json(attrs.get("metadata"))
        record: Raw = {"messages": messages}
        if context.get("span_id"):
            record["id"] = str(context["span_id"])
        if attrs.get("session.id"):
            record["session_id"] = str(attrs["session.id"])
        timestamp = iso_or_none(raw.get("start_time"))
        if timestamp:
            record["timestamp"] = timestamp
        record["metadata"] = record_metadata(
            "phoenix",
            meta,
            model=(meta.get("model") if isinstance(meta, dict) else None) or attrs.get("llm.model_name"),
            user_id=attrs.get("user.id"),
            tags=attrs.get("tag.tags") or None,
        )
        return record

    def to_score_update(self, raw: Raw) -> ScoreUpdate | None:
        value = score_value((raw.get("result") or {}).get("score"))
        if not raw.get("span_id") or not raw.get("name") or value is None:
            return None  # label-only annotations carry no number
        return ScoreUpdate(str(raw["span_id"]), {str(raw["name"]): value}, updated_at=iso_or_none(raw.get("updated_at")))
