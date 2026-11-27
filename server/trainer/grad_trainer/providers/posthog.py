"""PostHog: ``$ai_generation`` events and ``survey sent`` feedback events through the HogQL query
API, ``POST /api/projects/{project}/query/``, paged by ``timestamp`` (PostHog rejects OFFSET for
personal API keys and asks for keyset paging on ``timestamp``).

A trace's record is its latest generation (each generation carries the conversation so far),
keyed by ``$ai_trace_id``. PostHog's LLM feedback survey starts with a thumbs question
(1 = up, 2 = down): that answer becomes the score ``thumbs`` (1.0 / 0.0). Any other numeric
answer keeps its value under its question id; text answers are not scores. Feedback is filtered on ``created_at`` (ingestion time), so
a late event with an old client timestamp still lands within the re-scan window.

Filters go into the HogQL ``WHERE``: ``$ai_model``, ``$ai_span_name`` (the trace name),
``$ai_session_id``, ``distinct_id`` (the user), the ``environment`` and ``release`` custom
properties, ``properties.<key>`` for the ``metadata`` filter, and ``timestamp`` for from/to.
Tags and version (custom properties) are applied after fetching.

Secret: a personal API key with Query Read (Bearer). ``project`` is the numeric project id
(required). Host: the app host (us.posthog.com / eu.posthog.com), not the ``i.`` ingestion host.
Docs: https://posthog.com/docs/api/queries, https://posthog.com/docs/ai-observability
"""

from __future__ import annotations

import re
from typing import Any

from ..errors import SourceAPIChangedError, SourceUnavailableError
from ..records import coerce_messages, maybe_json, record_metadata, score_value
from .base import Page, Provider, Raw, ScoreUpdate, iso_or_none, parse_time

COLUMNS = "uuid, event, timestamp, created_at, distinct_id, properties"
THUMBS = {1: 1.0, 2: 0.0}
IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
# grad filter key -> HogQL expression of the $ai_generation event
COLUMNS_BY_FILTER = {
    "model": "properties.$ai_model",
    "name": "properties.$ai_span_name",
    "session_id": "properties.$ai_session_id",
    "user_id": "distinct_id",
    "environment": "properties.environment",
    "release": "properties.release",
}


def _quote(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def _literal(value: str | None) -> str:
    when = parse_time(value)
    return when.strftime("%Y-%m-%d %H:%M:%S.%f") if when else "1970-01-01 00:00:00.000000"


class PostHogProvider(Provider):
    name = "posthog"
    default_host = "https://us.posthog.com"
    page_size = 500
    requests_per_minute = 40  # 2400 queries per hour per project
    pushdown_filters = frozenset({*COLUMNS_BY_FILTER, "metadata", "from", "to"})

    def auth_headers(self, secret: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {secret}"}

    def fetch_traces(self, since: str | None, cursor: str | None) -> Page:
        return self._events(" AND ".join(["event = '$ai_generation'", *self._where()]), cursor or self.window_start(since))

    def _where(self) -> list[str]:
        f = self.filters
        where = [f"{column} IN ({', '.join(_quote(v) for v in f.get(key))})" for key, column in COLUMNS_BY_FILTER.items() if f.get(key)]
        where += [f"properties.{k} = {_quote(v)}" for k, v in f.metadata.items() if IDENTIFIER.match(k)]
        if f.end:
            where.append(f"timestamp < '{_literal(self.window_end())}'")
        return where

    def fetch_scores(self, since: str | None, cursor: str | None) -> Page:
        return self._events("event = 'survey sent' AND properties.$ai_trace_id IS NOT NULL", cursor or since)

    def _events(self, where: str, after: str | None) -> Page:
        project = self.require_project()
        if not project.isdigit():
            raise SourceUnavailableError(f"The PostHog project must be the numeric project id, got '{project}'.")
        sql = (
            f"SELECT {COLUMNS} FROM events WHERE {where} AND timestamp >= '{_literal(after)}' "
            f"ORDER BY timestamp ASC LIMIT {self.page_size}"
        )
        body = self.http.post(f"/api/projects/{project}/query/", {"query": {"kind": "HogQLQuery", "query": sql}})
        results = body.get("results") if isinstance(body, dict) else None
        if not isinstance(results, list):
            raise SourceAPIChangedError("posthog query response has no 'results' list")
        columns = body.get("columns") or [c.strip() for c in COLUMNS.split(",")]
        rows = [dict(zip(columns, row)) for row in results if isinstance(row, list)]
        # Keyset paging: the next page starts at this page's last timestamp (>=, so rows sharing
        # it are read again and deduped; a full page of one timestamp trips the loop guard).
        last = iso_or_none(rows[-1].get("timestamp")) if rows else None
        return Page(rows, last if len(rows) >= self.page_size else None)

    @classmethod
    def detect(cls, row: Raw) -> bool:
        props = row.get("properties")
        return "$ai_input" in row or row.get("event") == "$ai_generation" or (isinstance(props, dict) and "$ai_input" in props)

    @staticmethod
    def _props(raw: Raw) -> dict[str, Any]:
        props = maybe_json(raw.get("properties"))
        return props if isinstance(props, dict) else raw

    def to_record(self, raw: Raw) -> Raw | None:
        props = self._props(raw)
        messages = coerce_messages(maybe_json(props.get("$ai_input")), default_role="user")
        messages += coerce_messages(maybe_json(props.get("$ai_output_choices")), default_role="assistant")
        record: Raw = {"messages": messages}
        trace_id = props.get("$ai_trace_id") or raw.get("uuid") or raw.get("id")
        if trace_id:
            record["id"] = str(trace_id)
        if props.get("$ai_session_id"):
            record["session_id"] = str(props["$ai_session_id"])
        timestamp = iso_or_none(raw.get("timestamp"))
        if timestamp:
            record["timestamp"] = timestamp
        own = {k: v for k, v in props.items() if not str(k).startswith("$")}
        record["metadata"] = record_metadata(
            "posthog",
            own,
            model=props.get("$ai_model"),
            version=own.get("version") or own.get("model_version"),
            user_id=raw.get("distinct_id"),
            name=props.get("$ai_span_name"),
        )
        return record

    def to_score_update(self, raw: Raw) -> ScoreUpdate | None:
        props = self._props(raw)
        if not props.get("$ai_trace_id"):
            return None
        responses: dict[str, float] = {}  # question id ("" = the legacy first-question key) -> number
        for key, value in props.items():
            if str(key).startswith("$survey_response"):
                number = _number(value)
                if number is not None:
                    responses[str(key).removeprefix("$survey_response").lstrip("_")] = number
        thumbs = _thumbs_question(props, responses)
        scores: dict[str, float] = {}
        for question, number in responses.items():
            if question == thumbs and number in THUMBS:
                scores["thumbs"] = THUMBS[int(number)]
            else:
                scores[question or str(props.get("$survey_id") or "survey")] = number
        if not scores:
            return None
        return ScoreUpdate(str(props["$ai_trace_id"]), scores, updated_at=iso_or_none(raw.get("created_at") or raw.get("timestamp")))


def _number(value: Any) -> float | None:
    number = score_value(value)
    if number is None and isinstance(value, str):
        try:
            number = float(value)
        except ValueError:
            return None
    return number


def _thumbs_question(props: dict[str, Any], responses: dict[str, float]) -> str | None:
    """The thumbs question of an LLM-trace feedback survey: its first question. That is
    ``$survey_questions[0]`` when the event lists the questions (posthog-js does), the legacy
    ``$survey_response`` key, or else the only numeric answer (a manual capture sends the
    thumbs answer and, at most, a follow-up text answer)."""
    questions = maybe_json(props.get("$survey_questions"))
    if isinstance(questions, list) and questions and isinstance(questions[0], dict) and questions[0].get("id"):
        first = str(questions[0]["id"])
        if first in responses:
            responses.pop("", None)  # the legacy key repeats the first answer
            return first
    if "" in responses:
        return ""
    return next(iter(responses)) if len(responses) == 1 else None
