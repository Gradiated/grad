"""Braintrust: root spans of a project's logs through SQL on ``POST /btql``.

``logFeedback`` merges scores and ``expected`` into the span row itself and every write bumps the
row's ``_xact_id``, so one stream ordered by ``_xact_id`` returns new spans and spans with new
feedback alike; the highest ``_xact_id`` is the watermark (Braintrust's documented export
recipe). Re-emitted rows replace the earlier copy when the dataset is merged.

Filters go into the SQL ``WHERE``: ``tags IN ('..')`` for each tag, ``span_attributes.name``,
``metadata.<key>`` for model, environment, version, release and the ``metadata`` filter, and a
``created`` range for from/to. ``user_id`` and ``session_id`` (several metadata fallbacks) are
applied after fetching.

Secret: an API key (Bearer). ``project`` is the project id or name (required).
Docs: https://docs.braintrust.dev/reference/btql, https://docs.braintrust.dev/api-reference
"""

from __future__ import annotations

import re
from functools import cached_property

from ..errors import SourceAPIChangedError, SourceUnavailableError
from ..records import coerce_messages, coerce_scores, record_metadata
from .base import UUID_RE, Page, Provider, Raw, iso_or_none


def _quote(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "''") + "'"


IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,63}$")
METADATA_KEYS = ("model", "environment", "version", "release")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} IN ({', '.join(_quote(v) for v in values)})"


class BraintrustProvider(Provider):
    name = "braintrust"
    default_host = "https://api.braintrust.dev"
    page_size = 1000  # no documented maximum; queries time out after 30 s
    requests_per_minute = 20  # BTQL limits are per org and project and not published; be gentle
    rescan_window = None
    cursor_watermark = True
    pushdown_filters = frozenset({"tags", "name", *METADATA_KEYS, "metadata", "from", "to"})

    def auth_headers(self, secret: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {secret}"}

    @cached_property
    def project_id(self) -> str:
        project = self.require_project()
        if UUID_RE.match(project):
            return project
        found = self.items(self.http.get("/v1/project", project_name=project), "objects")
        match = [p for p in found if p.get("name") == project and p.get("id")]
        if not match:
            raise SourceUnavailableError(f"Braintrust has no project named '{project}'.")
        return str(match[0]["id"])

    def fetch_traces(self, since: str | None, cursor: str | None) -> Page:
        if since is not None and not since.isdigit():
            raise SourceAPIChangedError(f"Braintrust watermark must be an _xact_id, got {since[:40]!r}")
        sql = f"SELECT * FROM project_logs({_quote(self.project_id)}, shape => 'spans') WHERE is_root"
        if since:
            sql += f" AND _xact_id > {_quote(since)}"
        for condition in self._where():
            sql += f" AND {condition}"
        sql += f" ORDER BY _xact_id ASC LIMIT {self.page_size}"
        if cursor:
            sql += f" OFFSET {_quote(cursor)}"
        resp = self.http.request("POST", "/btql", body={"query": sql, "fmt": "json"})
        rows = self.items(resp.json(), "data")
        next_cursor = resp.headers.get("x-bt-cursor") or resp.headers.get("x-amz-meta-bt_cursor")
        xacts = [str(r["_xact_id"]) for r in rows if str(r.get("_xact_id", "")).isdigit()]
        resume = max(xacts, key=lambda x: (len(x), x)) if xacts else None
        return Page(rows, next_cursor if rows else None, resume)

    def _where(self) -> list[str]:
        f = self.filters
        where = [_in("tags", (tag,)) for tag in f.get("tags")]
        if f.get("name"):
            where.append(_in("span_attributes.name", f.get("name")))
        for key in METADATA_KEYS:
            if f.get(key):
                where.append(_in(f"metadata.{key}", f.get(key)))
        where += [f"metadata.{k} = {_quote(v)}" for k, v in f.metadata.items() if IDENTIFIER.match(k)]
        if f.start:
            where.append(f"created >= {_quote(self.window_start(None) or '')}")
        if f.end:
            where.append(f"created < {_quote(self.window_end() or '')}")
        return where

    @classmethod
    def detect(cls, row: Raw) -> bool:
        return "span_attributes" in row or "root_span_id" in row or ("input" in row and "expected" in row)

    def to_record(self, raw: Raw) -> Raw | None:
        messages = coerce_messages(raw.get("input"), default_role="user")
        messages += coerce_messages(raw.get("output"), default_role="assistant")
        meta = raw.get("metadata") if isinstance(raw.get("metadata"), dict) else {}
        record: Raw = {"messages": messages}
        if raw.get("id"):
            record["id"] = str(raw["id"])
        session = meta.get("session_id") or meta.get("thread_id") or raw.get("root_span_id")
        if session:
            record["session_id"] = str(session)
        timestamp = iso_or_none(raw.get("created"))
        if timestamp:
            record["timestamp"] = timestamp
        if raw.get("expected") is not None:
            record["expected_output"] = raw["expected"]
        scores = coerce_scores(raw.get("scores"))
        if scores:
            record["scores"] = scores
        attrs = raw.get("span_attributes") if isinstance(raw.get("span_attributes"), dict) else {}
        record["metadata"] = record_metadata(
            "braintrust",
            meta,
            user_id=meta.get("user_id") or meta.get("user"),
            tags=raw.get("tags") or None,
            name=attrs.get("name"),
        )
        return record
