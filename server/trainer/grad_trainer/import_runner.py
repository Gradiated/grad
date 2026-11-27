"""Import jobs: parse a source with the Tier-1 connectors and emit DatasetRecord batches.

``run(source, connector, *, emit_batch, workdir) -> ImportSummary``

``source`` is ``{"type": "file", "path": ...}`` (the worker downloads the upload first) or
``{"type": "hf", "repo": ..., "split": ..., "config": ..., "columns": {field: column}, "limit": n}``
(column mappings may also be given as top-level keys, e.g. ``"messages": "messages"``).
``connector`` forces one of the Tier-1 parsers; ``None`` auto-detects per row. Bad rows are
skipped and reported in ``errors`` (capped), never fatal; an unreadable source raises
``SourceUnavailableError``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from .connectors.parsers import SUPPORTED_CONNECTORS, parse_row
from .errors import SourceUnavailableError
from .runner_types import ImportSummary
from .sources import file_rows, hf_rows

DEFAULT_BATCH_SIZE = 500
MAX_ERRORS = 100


def run(
    source: dict[str, Any],
    connector: str | None,
    *,
    emit_batch: Callable[[list[dict[str, Any]]], None],
    workdir: Path,
) -> ImportSummary:
    if connector is not None and connector not in SUPPORTED_CONNECTORS:
        raise SourceUnavailableError(
            f"Unknown connector '{connector}'. Supported: {', '.join(SUPPORTED_CONNECTORS)}."
        )
    kind = str(source.get("type") or source.get("kind") or "file").lower()
    if kind == "file":
        if not source.get("path"):
            raise SourceUnavailableError("File source needs a local 'path'.")
        rows = file_rows(Path(source["path"]))
    elif kind in ("hf", "huggingface"):
        rows = hf_rows(source)
    else:
        raise SourceUnavailableError(f"Unknown import source type '{kind}' (file or hf).")

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
