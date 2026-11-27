"""Import jobs: file uploads, Hugging Face datasets and source syncs → DatasetRecord batches.

``run(source, connector, *, emit_batch, workdir, source_page=None) -> ImportSummary``

``source`` is one of

- ``{"kind": "file", "path": ..., "format": ...}`` (the worker downloads the upload first);
- ``{"kind": "hf", "repo": ..., "split": ..., "config": ..., "columns": {field: column},
  "limit": n}`` (column mappings may also be top-level keys, e.g. ``"prompt": "question"``);
- ``{"kind": "provider", "provider": "langfuse", "host": ..., "secret": ..., "project": ...,
  "watermark": {...} | None, "full": bool}``: a sync from an observability provider. The
  summary carries the new ``watermark``; ``source_page`` is the worker's job-scoped page
  function for providers that read through grad-server (``gradiated``).

For files and HF, ``connector`` forces one parser (``None`` auto-detects per row). Bad rows are
skipped and reported in ``errors`` (capped), never fatal; an unreadable source raises a
``SourceUnavailableError`` subclass.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path
from typing import Any, Callable, Iterable

from .errors import SourceUnavailableError
from .formats import FORMATS, is_otel
from .providers import PROVIDERS, SyncEngine, build_provider
from .records import is_usable
from .runner_types import ImportSummary
from .sources import file_rows, hf_rows

DEFAULT_BATCH_SIZE = 500
MAX_ERRORS = 100
SUPPORTED_CONNECTORS = (*FORMATS, *PROVIDERS)


def detect_source(row: dict[str, Any]) -> str:
    """Auto-detect the file format of a single row."""
    if is_otel(row):
        return "otel"
    for name, provider in PROVIDERS.items():
        if provider.detect(row):
            return name
    return "grad_trajectories"


def parse_row(row: Any, source: str = "auto") -> tuple[dict[str, Any] | None, str | None]:
    """Parse one row. Returns (record, None) or (None, skip reason)."""
    if source != "auto" and source not in SUPPORTED_CONNECTORS:
        raise ValueError(f"Unknown trace connector '{source}'. Supported: {', '.join(SUPPORTED_CONNECTORS)}.")
    if not isinstance(row, dict):
        return None, "not_an_object"
    name = detect_source(row) if source == "auto" else source
    record = FORMATS[name](row) if name in FORMATS else PROVIDERS[name]().to_record(row)
    if record is None or not is_usable(record):
        return None, f"{name}:no_messages"
    return record, None


def normalize_traces_with_stats(rows: Iterable[Any], *, source: str = "auto") -> tuple[list[dict[str, Any]], dict[str, int]]:
    records: list[dict[str, Any]] = []
    skipped: Counter[str] = Counter()
    for row in rows:
        record, reason = parse_row(row, source)
        if record is None:
            skipped[str(reason)] += 1
        else:
            records.append(record)
    return records, dict(skipped)


def normalize_traces(rows: Iterable[Any], *, source: str = "auto") -> list[dict[str, Any]]:
    return normalize_traces_with_stats(rows, source=source)[0]


def _sync(source: dict[str, Any], emit_batch: Callable[[list[dict[str, Any]]], None], source_page: Any) -> ImportSummary:
    provider = build_provider(source, pull=source_page)
    batch_size = int(source.get("batch_size", DEFAULT_BATCH_SIZE))
    result = SyncEngine(provider, emit_batch=emit_batch, batch_size=batch_size).run(
        source.get("watermark"), full=bool(source.get("full"))
    )
    return ImportSummary(records=result.records, skipped=result.skipped, errors=result.errors, watermark=result.watermark)


def run(
    source: dict[str, Any],
    connector: str | None,
    *,
    emit_batch: Callable[[list[dict[str, Any]]], None],
    workdir: Path,
    source_page: Callable[[str | None], dict[str, Any]] | None = None,
) -> ImportSummary:
    if connector is not None and connector not in SUPPORTED_CONNECTORS:
        raise SourceUnavailableError(f"Unknown connector '{connector}'. Supported: {', '.join(SUPPORTED_CONNECTORS)}.")
    kind = str(source.get("type") or source.get("kind") or "file").lower()
    if kind == "provider":
        return _sync(source, emit_batch, source_page)
    if kind == "file":
        if not source.get("path"):
            raise SourceUnavailableError("File source needs a local 'path'.")
        rows = file_rows(Path(source["path"]), str(source.get("format") or "auto"))
    elif kind in ("hf", "huggingface"):
        rows = hf_rows(source)
    else:
        raise SourceUnavailableError(f"Unknown import source type '{kind}' (file, hf or provider).")

    batch_size = max(1, int(source.get("batch_size", DEFAULT_BATCH_SIZE)))
    summary = ImportSummary(records=0, skipped=0, errors=[])
    batch: list[dict[str, Any]] = []

    def fail(location: str, message: str) -> None:
        summary.skipped += 1
        if len(summary.errors) < MAX_ERRORS:
            summary.errors.append(f"{location}: {message}")
        elif len(summary.errors) == MAX_ERRORS:
            summary.errors.append("further errors omitted")

    for location, row, error in rows:
        if error is not None:
            fail(location, error)
            continue
        try:
            record, reason = parse_row(row, connector or "auto")
        except Exception as exc:  # a malformed row must not stop the import
            fail(location, f"{type(exc).__name__}: {exc}")
            continue
        if record is None:
            fail(location, f"skipped ({reason})")
            continue
        batch.append(record)
        if len(batch) >= batch_size:
            emit_batch(batch)
            summary.records += len(batch)
            batch = []
    if batch:
        emit_batch(batch)
        summary.records += len(batch)
    return summary
