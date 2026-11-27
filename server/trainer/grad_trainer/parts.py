"""The dataset parts an import writes: gzip JSONL files the worker uploads straight to storage.

An import buffers its records into parts of up to ``PART_RECORDS`` records or ``PART_BYTES``
of JSONL (``GRAD_IMPORT_PART_RECORDS`` / ``GRAD_IMPORT_PART_BYTES``) and hands each full part
to ``upload``: the worker PUTs it to a presigned URL (content-addressed key, checksum) and
registers it with ``/parts``, keyed by (job, attempt, seq). grad-server checks the object and
never reads the records, so it stays off the data path. A small import is one small part.

Before a record is written it is checked against the API's ``DatasetRecord`` schema
(``record.schema.json``, generated from ``spec/openapi.yaml``), and a record without an id gets
a deterministic one, so a retried attempt writes the same bytes.
"""

from __future__ import annotations

import functools
import gzip
import hashlib
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

from jsonschema import Draft202012Validator
from jsonschema.exceptions import best_match

from .records import is_reset, is_score_update

PART_RECORDS = int(os.environ.get("GRAD_IMPORT_PART_RECORDS") or 50_000)
PART_BYTES = int(os.environ.get("GRAD_IMPORT_PART_BYTES") or 64 * 1024 * 1024)
MAX_REASONS = 100
SCHEMA = Path(__file__).resolve().parent / "record.schema.json"


@functools.cache
def _validator() -> Draft202012Validator:
    return Draft202012Validator(json.loads(SCHEMA.read_text()))


def record_error(record: Any) -> str | None:
    """Why ``record`` is not a valid DatasetRecord, or ``None``."""
    validator = _validator()
    if validator.is_valid(record):
        return None
    error = best_match(validator.iter_errors(record))
    where = "/".join(str(p) for p in error.absolute_path) if error else ""
    return f"{where or 'record'}: {error.message if error else 'invalid'}"[:300]


@dataclass
class Part:
    seq: int
    path: Path
    sha256: str  # of the uncompressed JSONL: readers verify it
    upload_sha256: str  # of the gzip file: the upload id and its checksum
    size: int
    records: int
    count: int  # distinct records after the last reset marker (what the dataset gains)
    resets: bool
    score_updates: int
    scores: list[str]


@dataclass
class PartWriter:
    workdir: Path
    upload: Callable[[Part], None]
    #: Names deterministic ids: ``rec_<sha256(f"{id_prefix}:{seq}:{index}")[:16]>``.
    id_prefix: str
    max_records: int = field(default_factory=lambda: PART_RECORDS)
    max_bytes: int = field(default_factory=lambda: PART_BYTES)
    dropped: int = 0
    reasons: list[str] = field(default_factory=list)
    seq: int = 0
    _file: Any = field(default=None, repr=False)

    def write(self, records: Iterable[dict[str, Any]]) -> None:
        for record in records:
            self._add(record)

    def close(self) -> None:
        """Uploads the last, partial part (nothing if it holds no records)."""
        self._flush()

    def _add(self, record: dict[str, Any]) -> None:
        error = record_error(record)
        if error is not None:
            self.dropped += 1
            if len(self.reasons) < MAX_REASONS:
                self.reasons.append(f"invalid record: {error}")
            return
        if self._file is None:
            self._open()
        if not record.get("id"):
            digest = hashlib.sha256(f"{self.id_prefix}:{self.seq}:{self._records}".encode()).hexdigest()
            record = {**record, "id": f"rec_{digest[:16]}"}
        line = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        self._file.write(line)
        self._sha.update(line)
        self._bytes += len(line)
        self._records += 1
        if is_reset(record):
            self._resets, self._ids = True, set()
        elif is_score_update(record):
            self._updates += 1
        else:
            self._ids.add(str(record["id"]))
        self._scores.update(str(k) for k in (record.get("scores") or {}))
        if self._records >= self.max_records or self._bytes >= self.max_bytes:
            self._flush()

    def _open(self) -> None:
        self._path = self.workdir / f"part-{self.seq}.jsonl.gz"
        # mtime=0: the same records always make the same bytes (and upload id).
        self._file = gzip.GzipFile(self._path, "wb", compresslevel=6, mtime=0)
        self._sha = hashlib.sha256()
        self._bytes = self._records = self._updates = 0
        self._resets = False
        self._ids: set[str] = set()
        self._scores: set[str] = set()

    def _flush(self) -> None:
        if self._file is None:
            return
        self._file.close()
        self._file = None
        upload_sha = hashlib.sha256()
        with self._path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                upload_sha.update(chunk)
        part = Part(
            seq=self.seq,
            path=self._path,
            sha256=self._sha.hexdigest(),
            upload_sha256=upload_sha.hexdigest(),
            size=self._path.stat().st_size,
            records=self._records,
            count=len(self._ids),
            resets=self._resets,
            score_updates=self._updates,
            scores=sorted(self._scores),
        )
        try:
            self.upload(part)
        finally:
            self._path.unlink(missing_ok=True)
        self.seq += 1
