"""Row sources for import jobs: local files (JSONL / JSON array, optionally gzip) and HF datasets."""

from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import IO, Any, Iterator

from .connectors.parsers import NATIVE_FIELDS
from .errors import SourceUnavailableError
from .models import is_offline

# A row is (location for error messages, parsed object or None, error or None).
Row = tuple[str, Any, str | None]


def _open(path: Path) -> IO[str]:
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8")
    return open(path, "r", encoding="utf-8")


def file_rows(path: Path) -> Iterator[Row]:
    if not path.is_file():
        raise SourceUnavailableError(f"Import file {path} does not exist.")
    with _open(path) as fh:
        head = fh.read(4096)
        fh.seek(0)
        if head.lstrip().startswith("["):
            try:
                rows = json.load(fh)
            except ValueError as exc:
                raise SourceUnavailableError(f"{path.name} is not a valid JSON array: {exc}") from exc
            for index, row in enumerate(rows):
                yield f"item {index}", row, None
            return
        for number, line in enumerate(fh, start=1):
            if not line.strip():
                continue
            try:
                yield f"line {number}", json.loads(line), None
            except ValueError as exc:
                yield f"line {number}", None, f"invalid JSON ({exc.msg})"


def hf_rows(source: dict[str, Any]) -> Iterator[Row]:
    repo = source.get("repo") or source.get("dataset") or source.get("path")
    if not repo:
        raise SourceUnavailableError("Hugging Face source needs 'repo' (for example 'HuggingFaceH4/ultrachat_200k').")
    if is_offline():
        raise SourceUnavailableError(
            f"Can't load Hugging Face dataset '{repo}': offline mode is on (HF_HUB_OFFLINE/GRAD_OFFLINE). "
            "Download it elsewhere and import the JSONL file instead."
        )
    try:
        import datasets
    except ImportError as exc:
        raise SourceUnavailableError("Hugging Face imports need the 'datasets' package in the trainer image.") from exc

    split = source.get("split", "train")
    config = source.get("config") or source.get("subset") or source.get("name")
    columns: dict[str, str] = dict(source.get("columns") or {})
    columns.update({f: str(source[f]) for f in NATIVE_FIELDS if isinstance(source.get(f), str) and f not in ("id",)})
    limit = source.get("limit")
    try:
        ds = datasets.load_dataset(str(repo), config, split=split, revision=source.get("revision"), streaming=True)
    except Exception as exc:
        raise SourceUnavailableError(f"Can't load Hugging Face dataset '{repo}' split '{split}': {exc}") from exc

    checked = False
    for index, row in enumerate(ds):
        if limit is not None and index >= int(limit):
            return
        if not checked:
            missing = sorted(c for c in columns.values() if c not in row)
            if missing:
                raise SourceUnavailableError(
                    f"Dataset '{repo}' has no column(s) {missing}; available: {sorted(row)}."
                )
            checked = True
        if columns:
            record = {field: row[column] for field, column in columns.items()}
        else:
            record = {k: v for k, v in row.items() if k in NATIVE_FIELDS}
        record.setdefault("id", f"{repo}:{split}:{index}")
        yield f"row {index}", record, None
