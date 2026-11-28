"""Pure helpers of the resource classes (no network I/O here; files only)."""

from __future__ import annotations

import datetime
import hashlib
import json
import math
import os
import re
import shutil
import stat
import tarfile
import tempfile
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any

from ._errors import ChecksumMismatchError, UnsafeArchiveError, ValidationError
from .records import coerce_record
from .recipes import coerce_recipe
from .rubrics import Rubric, Scorer, coerce_rubric, model_ref

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
MAX_PUSH_RECORDS = 50_000
DEFAULT_CHUNK_RECORDS = 5_000
# Scores per POST /v1/evals/{id}/scores (the server takes up to 10,000).
SCORES_PER_REQUEST = 1_000
DEFAULT_CHUNK_BYTES = 16 * 1024 * 1024
MAX_BUNDLE_MEMBERS = 10_000
MAX_EXTRACT_BYTES = 512 * 1024**3
RESERVED_BUNDLE_FILES = ("manifest.json", "eval_report.json")
CONNECTORS = ("auto", "grad_trajectories", "openai_chat", "gradiated", "otel", "langfuse", "posthog", "braintrust", "langsmith")
FILE_FORMATS = {".jsonl": "jsonl", ".ndjson": "jsonl", ".json": "json", ".parquet": "parquet"}


def check_slug(value: str, what: str) -> str:
    """Validate a resource name (``[a-z0-9][a-z0-9._-]{0,63}``)."""
    if not isinstance(value, str) or not SLUG_RE.match(value):
        raise ValueError(f"Invalid {what} {value!r}: use 1-64 lowercase letters, digits, '.', '_' or '-', starting with a letter or digit.")
    return value


def dataset_name(dataset: Any) -> str:
    """Name of a dataset given a :class:`grad.Dataset`, a name, or a dict with ``name``."""
    if isinstance(dataset, str):
        return check_slug(dataset, "dataset name")
    name = getattr(dataset, "name", None)
    if isinstance(name, str) and getattr(dataset, "record_count", None) is not None:
        return name
    if isinstance(dataset, Mapping) and isinstance(dataset.get("name"), str):
        return str(dataset["name"])
    if isinstance(dataset, (list, tuple)):
        raise TypeError(
            "dataset= takes a Dataset or a dataset name. Push the records first: "
            "dataset = client.datasets.push('my-data', records)."
        )
    raise TypeError(f"dataset= must be a Dataset or a dataset name, got {type(dataset).__name__}.")


def run_body(*, dataset: Any, name: str, recipe: Any, split: Any, max_cost_usd: float | None) -> dict[str, Any]:
    """The ``PlanRunRequest`` body for ``runs.plan`` / ``runs.create``."""
    if dataset is None:
        raise TypeError("runs.plan/create need dataset= (a Dataset or a dataset name).")
    if recipe is None:
        raise TypeError("runs.plan/create need recipe=, e.g. SFTRecipe(model='qwen/qwen3-8b').")
    spec, recipe_split = coerce_recipe(recipe)
    body: dict[str, Any] = {"dataset": dataset_name(dataset), "name": check_slug(name, "run name"), "recipe": spec}
    chosen = split if split is not None else recipe_split
    if chosen is not None:
        body["split"] = chosen if isinstance(chosen, Mapping) else chosen.to_dict()
    if max_cost_usd is not None:
        if isinstance(max_cost_usd, bool) or not isinstance(max_cost_usd, (int, float)) or not math.isfinite(max_cost_usd) or max_cost_usd <= 0:
            raise ValueError(f"max_cost_usd must be a positive number, got {max_cost_usd!r}.")
        body["max_cost_usd"] = max_cost_usd
    return body


def rubric_items(rubric: Any) -> tuple[list[dict[str, Any]] | None, Rubric | None]:
    """``(wire items, Rubric)`` for an eval rubric (a Rubric, an item, a list, or wire dicts)."""
    if rubric is None:
        return None, None
    if isinstance(rubric, (list, tuple)) and rubric and all(isinstance(i, Mapping) for i in rubric):
        return [dict(i) for i in rubric], None
    coerced = coerce_rubric(rubric)
    return coerced.to_wire_items(), coerced


def time_bound(value: Any) -> str:
    """A filter time bound: a ``datetime`` (naive means UTC), a ``date`` or an ISO string."""
    if isinstance(value, datetime.datetime) and value.tzinfo is None:
        value = value.replace(tzinfo=datetime.timezone.utc)
    if isinstance(value, datetime.date):
        return str(value.isoformat())
    return str(value)


def eval_body(
    *,
    models: Sequence[Any],
    name: str | None,
    dataset: Any,
    dataset_version: int | None,
    rubric: Any,
    baseline: Any,
    samples: int | None,
    temperature: float | None,
    max_tokens: int | None,
    limit: int | None,
    pass_threshold: float | None,
) -> tuple[dict[str, Any], Rubric | None]:
    """The ``PlanEvalRequest`` body plus the local :class:`Rubric` (for local scorers)."""
    if isinstance(models, (str, bytes)) or not isinstance(models, Sequence):
        models = [models]
    if not models:
        raise ValueError("evals need at least one model in models=[...].")
    body: dict[str, Any] = {"models": [model_ref(m) for m in models]}
    if name is not None:
        body["name"] = check_slug(name, "eval name")
    if dataset is not None:
        body["dataset"] = dataset_name(dataset)
    for key, value in (
        ("dataset_version", dataset_version),
        ("samples", samples),
        ("temperature", temperature),
        ("max_tokens", max_tokens),
        ("limit", limit),
        ("pass_threshold", pass_threshold),
    ):
        if value is not None:
            body[key] = value
    if baseline is not None:
        body["baseline"] = model_ref(baseline)
    items, local = rubric_items(rubric)
    if items is not None:
        body["rubric"] = items
    return body, local


def renumber_validation(exc: ValidationError, offset: int, count: int) -> ValidationError:
    """Rewrite ``records.<i>`` paths of a chunk's 422 to indices in the caller's full list."""

    def shift(text: str) -> str:
        return re.sub(r"\brecords\.(\d+)", lambda m: f"records.{int(m.group(1)) + offset}", text)

    detail = shift(exc.detail)
    if offset or count:
        detail = f"{detail} (in records {offset}–{offset + count - 1} of the push)"
    return ValidationError(
        status=exc.status or 422,
        code=exc.code or "validation_error",
        title=exc.title,
        detail=detail,
        request_id=exc.request_id,
        method=exc.method,
        url=exc.url,
        headers=exc.headers,
        body=exc.body,
        errors=[type(e)(shift(e.path), e.message) for e in exc.errors],
    )


def chunk_records(
    records: Iterable[Any],
    *,
    max_records: int = DEFAULT_CHUNK_RECORDS,
    max_bytes: int = DEFAULT_CHUNK_BYTES,
) -> Iterator[tuple[int, list[dict[str, Any]]]]:
    """Yield ``(offset, chunk)`` with at most ``max_records`` records / ``max_bytes`` of JSON each."""
    if not 1 <= max_records <= MAX_PUSH_RECORDS:
        raise ValueError(f"chunk_size must be between 1 and {MAX_PUSH_RECORDS}.")
    chunk: list[dict[str, Any]] = []
    size = 0
    offset = 0
    index = 0
    for item in records:
        record = coerce_record(item)
        encoded = len(json.dumps(record, separators=(",", ":"), default=str))
        if chunk and (len(chunk) >= max_records or size + encoded > max_bytes):
            yield offset, chunk
            offset = index
            chunk, size = [], 0
        chunk.append(record)
        size += encoded + 1
        index += 1
    if chunk:
        yield offset, chunk


def is_path_like(value: Any) -> bool:
    """True for ``str`` paths that exist or look like data files, and for ``os.PathLike``."""
    if isinstance(value, os.PathLike):
        return True
    if isinstance(value, str):
        return value.lower().endswith(tuple(FILE_FORMATS)) or os.path.isfile(value)
    return False


def file_format(path: Path, requested: str) -> str:
    """``format`` for an upload import, from ``requested`` or the file suffix."""
    if requested != "auto":
        if requested not in ("jsonl", "json", "parquet"):
            raise ValueError(f"format must be 'auto', 'jsonl', 'json' or 'parquet', got {requested!r}.")
        return requested
    return FILE_FORMATS.get(path.suffix.lower(), "auto")


def check_connector(connector: str) -> str:
    """Validate an import connector name."""
    if connector not in CONNECTORS:
        raise ValueError(f"Unknown connector {connector!r}; use one of {', '.join(CONNECTORS)}.")
    return connector


def sha256_file(path: Path) -> tuple[str, int]:
    """``(hex digest, size)`` of a file, streamed."""
    digest = hashlib.sha256()
    size = 0
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(block)
            size += len(block)
    return digest.hexdigest(), size


def upload_request(path: Path) -> dict[str, Any]:
    """The ``CreateUploadRequest`` body for a local file."""
    if not path.is_file():
        raise FileNotFoundError(f"No such file: {path}")
    sha, size = sha256_file(path)
    if size == 0:
        raise ValueError(f"{path} is empty.")
    return {"purpose": "dataset_import", "filename": path.name[:255], "size_bytes": size, "sha256": sha}


def artifact_upload_request(path: Path) -> dict[str, Any]:
    """The ``CreateUploadRequest`` body for a packed artifact."""
    return {**upload_request(path), "purpose": "artifact_import"}


def hf_source(
    repo: str,
    *,
    split: str,
    config: str | None,
    revision: str | None,
    columns: Mapping[str, str] | None,
    column_kwargs: Mapping[str, str | None],
    limit: int | None,
) -> dict[str, Any]:
    """The ``ImportSource`` for a Hugging Face dataset."""
    source: dict[str, Any] = {"kind": "hf", "repo": repo, "split": split}
    if config is not None:
        source["config"] = config
    if revision is not None:
        source["revision"] = revision
    mapping = dict(columns or {})
    for key, value in column_kwargs.items():
        if value is not None:
            if key in mapping and mapping[key] != value:
                raise ValueError(f"Column {key!r} is given twice (columns= and {key}=).")
            mapping[key] = value
    allowed = {"messages", "prompt", "completion", "chosen", "rejected", "answer", "query", "positive"}
    unknown = sorted(set(mapping) - allowed)
    if unknown:
        raise ValueError(f"Unknown column mapping(s) {unknown}; use {sorted(allowed)}.")
    if mapping:
        source["columns"] = mapping
    if limit is not None:
        source["limit"] = limit
    return source


def hf_dataset_name(repo: str, split: str, config: str | None) -> str:
    """A default dataset name for a Hugging Face import (``owner-repo[-config][-split]``)."""
    parts = [repo.replace("/", "-")]
    if config:
        parts.append(config)
    if split and split != "train":
        parts.append(split)
    slug = re.sub(r"[^a-z0-9._-]+", "-", "-".join(parts).lower()).strip("-._") or "hf-dataset"
    return slug[:64].rstrip("-._")


ARTIFACT_FORMATS = ("peft_lora", "merged_safetensors", "cartridge", "encoder_safetensors", "router_bundle", "decision_bundle", "reward_bundle")
_ARCHIVE_SUFFIXES = (".tar.gz", ".tgz", ".tar")
_HF_URI = re.compile(r"^(?:hf://)?([A-Za-z0-9][\w.-]*(?:/[A-Za-z0-9][\w.-]*)?)(?:@([^@\s]+))?$")


def check_artifact_format(fmt: str) -> str:
    """Validate an upload's ``format``."""
    if fmt not in ARTIFACT_FORMATS:
        raise ValueError(f"Unknown artifact format {fmt!r}; use one of {', '.join(ARTIFACT_FORMATS)}.")
    return fmt


def artifact_name(path: Path) -> str:
    """The default artifact name for an upload: its file or directory name as a slug."""
    base = path.name
    for suffix in (".grad.tar.gz", *_ARCHIVE_SUFFIXES):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    slug = re.sub(r"[^a-z0-9._-]+", "-", base.lower()).lstrip("-._")
    return slug[:64].rstrip("-._") or "upload"


def parse_hf_uri(uri: str, revision: str | None = None) -> tuple[str, str | None]:
    """``(repo, revision)`` of ``hf://owner/name[@revision]`` (or ``owner/name``)."""
    match = _HF_URI.match(uri.strip())
    if not match or ".." in match.group(1):
        raise ValueError(f"{uri!r} is not a Hugging Face repo: use hf://owner/name or hf://owner/name@revision.")
    repo, pinned = match.group(1), match.group(2)
    if pinned and revision and pinned != revision:
        raise ValueError(f"{uri!r} pins revision {pinned!r}, but revision={revision!r} was passed too.")
    return repo, pinned or revision


def pack_artifact(path: Path, workdir: Path) -> Path:
    """The file to upload for ``path``: a ``.tar``/``.tar.gz`` as is, else a gzip tar of it.

    A directory's regular files go in at their relative paths (sorted, no symlinks); a single
    file goes in at the root.
    """
    if not path.exists():
        raise FileNotFoundError(f"No such file or directory: {path}")
    if path.is_file() and path.name.endswith(_ARCHIVE_SUFFIXES):
        return path
    if path.is_dir():
        files = []
        for item in sorted(path.rglob("*")):
            if item.is_symlink():
                raise ValueError(f"Refusing to upload symlink {item}; copy the file instead.")
            if item.is_file():
                files.append((item.relative_to(path).as_posix(), item))
        if not files:
            raise ValueError(f"{path} has no files to upload.")
    else:
        files = [(path.name, path)]
    out = workdir / "upload.tar.gz"
    with tarfile.open(out, "w:gz", format=tarfile.PAX_FORMAT) as tar:
        for name, item in files:
            info = tar.gettarinfo(str(item), arcname=name)
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mtime = 0
            with open(item, "rb") as fh:
                tar.addfile(info, fh)
    return out


class Backoff:
    """Polling delays for ``wait()``: 0.5 s growing ×1.5 to a 5 s cap."""

    def __init__(self, initial: float = 0.5, factor: float = 1.5, cap: float = 5.0) -> None:
        self._next = initial
        self._factor = factor
        self._cap = cap

    def next(self) -> float:
        """The next delay."""
        value = self._next
        self._next = min(self._cap, self._next * self._factor)
        return value

    def reset(self, initial: float = 0.5) -> None:
        """Start over (after progress)."""
        self._next = initial


def local_scorers_for(rubric: Any, needed: Sequence[str], eval_id: str) -> dict[str, Scorer]:
    """The local scorers an eval needs, or a clear error naming what is missing."""
    from ._errors import GradError

    if rubric is None:
        raise GradError(
            f"Eval {eval_id} is awaiting scores from local Python scorers ({', '.join(needed)}). "
            "Pass the same rubric to wait(rubric=...) so they can run in this process.",
            code="local_scorers_required",
        )
    available = coerce_rubric(rubric).local_scorers
    missing = [n for n in needed if n not in available]
    if missing:
        raise GradError(
            f"Eval {eval_id} needs local scorers {', '.join(missing)} but the rubric passed to wait() does not define them.",
            code="local_scorers_required",
        )
    return {n: available[n] for n in needed}


# ---------------------------------------------------------------------------- downloads


_UNSAFE_FILE_CHARS = re.compile(r"[^A-Za-z0-9._@-]+")


def safe_file_name(name: str) -> str:
    """A server-supplied name as a single path component, like the TypeScript and Go SDKs:
    its base name with unusual characters replaced, never ``.``, ``..`` or empty."""
    base = _UNSAFE_FILE_CHARS.sub("_", name.replace("\\", "/").rsplit("/", 1)[-1])
    return base if base.strip(".") else "artifact"


@dataclass
class DownloadPlan:
    """Where an artifact download goes."""

    format: str
    target: Path
    temp_dir: Path


def plan_download(path: str | os.PathLike[str], *, fmt: str, filename: str, overwrite: bool) -> DownloadPlan:
    """Resolve the destination for ``artifacts.download`` and check it is safe to write."""
    if fmt not in ("peft", "files", "bundle"):
        raise ValueError(f"format must be 'peft', 'files' or 'bundle', got {fmt!r}.")
    target = Path(path).expanduser()
    if fmt == "bundle":
        if target.is_dir() or str(path).endswith(("/", os.sep)):
            target = target / filename
        if target.exists() and not overwrite:
            raise FileExistsError(f"{target} exists; pass overwrite=True to replace it.")
    else:
        if target.exists():
            if not target.is_dir():
                raise FileExistsError(f"{target} exists and is not a directory.")
            if any(target.iterdir()) and not overwrite:
                raise FileExistsError(f"{target} is not empty; pass overwrite=True to replace it.")
    parent = target.parent
    parent.mkdir(parents=True, exist_ok=True)
    return DownloadPlan(format=fmt, target=target, temp_dir=parent)


def _umask_mode(base: int = 0o666) -> int:
    current = os.umask(0)
    os.umask(current)
    return base & ~current


def fsync_dir(path: Path) -> None:
    """Best-effort fsync of a directory (durable renames)."""
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:  # pragma: no cover - platforms without directory fds
        return
    try:
        os.fsync(fd)
    except OSError:  # pragma: no cover
        pass
    finally:
        os.close(fd)


class HashingWriter:
    """Writes chunks to a temp file while hashing them."""

    def __init__(self, directory: Path, prefix: str) -> None:
        fd, name = tempfile.mkstemp(dir=directory, prefix=prefix, suffix=".part")
        self.path = Path(name)
        self._fh: IO[bytes] = os.fdopen(fd, "wb")
        self._digest = hashlib.sha256()
        self.size = 0

    def write(self, chunk: bytes) -> None:
        """Append a chunk."""
        self._fh.write(chunk)
        self._digest.update(chunk)
        self.size += len(chunk)

    def finish(self) -> str:
        """Flush, fsync and close; return the hex digest."""
        self._fh.flush()
        os.fsync(self._fh.fileno())
        self._fh.close()
        return self._digest.hexdigest()

    def discard(self) -> None:
        """Close and delete the temp file."""
        try:
            self._fh.close()
        finally:
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass


def expected_sha(header: str | None, declared: str | None, url: str) -> str:
    """The SHA-256 a download must match (header first, else the artifact's ``sha256``)."""
    value = (header or declared or "").strip().lower()
    if not SHA256_RE.match(value):
        raise ChecksumMismatchError(
            f"{url} did not declare a valid SHA-256 (X-Artifact-Sha256); refusing to trust the download.",
            expected=value,
            actual="",
        )
    if declared and declared.lower() != value:
        raise ChecksumMismatchError(
            f"{url}: X-Artifact-Sha256 {value} differs from the artifact's recorded sha256 {declared}.",
            expected=declared.lower(),
            actual=value,
        )
    return value


def verify_digest(actual: str, expected: str, url: str) -> None:
    """Raise :class:`ChecksumMismatchError` when digests differ."""
    if actual != expected:
        raise ChecksumMismatchError(
            f"Downloaded bytes from {url} have SHA-256 {actual}, expected {expected}; the file was discarded. Retry the download.",
            expected=expected,
            actual=actual,
        )


def _check_member_name(name: str) -> str:
    if not name or "\x00" in name or "\\" in name or name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        raise UnsafeArchiveError(f"Refusing to extract unsafe archive entry {name!r}.")
    parts = name.split("/")
    if parts and parts[-1] == "":
        parts = parts[:-1]
    if any(p in ("", ".", "..") for p in parts):
        raise UnsafeArchiveError(f"Refusing to extract unsafe archive entry {name!r} (path traversal).")
    return "/".join(parts)


def safe_extract_bundle(bundle: Path, dest: Path, *, max_members: int = MAX_BUNDLE_MEMBERS, max_bytes: int = MAX_EXTRACT_BYTES) -> dict[str, Any]:
    """Extract a ``.grad.tar.gz`` into the empty directory ``dest`` and verify it.

    Only regular files with safe relative paths are written (no links, devices or
    traversal); every payload file must match the SHA-256 listed in ``manifest.json``.
    Returns the manifest.
    """
    seen: dict[str, str] = {}
    total = 0
    count = 0
    try:
        tf = tarfile.open(bundle, mode="r|gz")
    except (tarfile.TarError, OSError) as exc:
        raise UnsafeArchiveError(f"{bundle.name} is not a valid .grad.tar.gz bundle: {exc}") from exc
    with tf:
        try:
            for member in tf:
                count += 1
                if count > max_members:
                    raise UnsafeArchiveError(f"Bundle has more than {max_members} entries.")
                name = _check_member_name(member.name)
                if member.isdir():
                    continue
                if not member.isfile():
                    raise UnsafeArchiveError(f"Refusing to extract {name!r}: only regular files are allowed (no links or devices).")
                if name in seen:
                    raise UnsafeArchiveError(f"Duplicate archive entry {name!r}.")
                total += member.size
                if total > max_bytes:
                    raise UnsafeArchiveError(f"Bundle expands beyond {max_bytes} bytes.")
                out_path = dest.joinpath(*name.split("/"))
                out_path.parent.mkdir(parents=True, exist_ok=True)
                src = tf.extractfile(member)
                if src is None:  # pragma: no cover - isfile() members always have data
                    raise UnsafeArchiveError(f"Cannot read archive entry {name!r}.")
                digest = hashlib.sha256()
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
                try:
                    fd = os.open(out_path, flags, _umask_mode())
                except FileExistsError:
                    raise UnsafeArchiveError(f"Refusing to overwrite {name!r}: the extraction directory is not empty.") from None
                with os.fdopen(fd, "wb") as fh:
                    written = 0
                    for block in iter(lambda: src.read(1024 * 1024), b""):
                        written += len(block)
                        if written > member.size:
                            raise UnsafeArchiveError(f"Entry {name!r} is larger than declared.")
                        digest.update(block)
                        fh.write(block)
                seen[name] = digest.hexdigest()
        except tarfile.TarError as exc:
            raise UnsafeArchiveError(f"Corrupt bundle {bundle.name}: {exc}") from exc
    if "manifest.json" not in seen:
        raise UnsafeArchiveError("Bundle has no manifest.json.")
    try:
        manifest = json.loads((dest / "manifest.json").read_text(encoding="utf-8"))
    except ValueError as exc:
        raise UnsafeArchiveError(f"manifest.json is not valid JSON: {exc}") from exc
    listed = manifest.get("files") if isinstance(manifest, Mapping) else None
    if not isinstance(listed, Mapping):
        raise UnsafeArchiveError("manifest.json has no 'files' checksum map.")
    payload = {n for n in seen if n not in RESERVED_BUNDLE_FILES}
    unlisted = sorted(payload - set(listed))
    if unlisted:
        raise UnsafeArchiveError(f"Bundle contains files not listed in manifest.json: {', '.join(unlisted)}.")
    for name, digest in listed.items():
        if name not in seen:
            raise UnsafeArchiveError(f"manifest.json lists {name!r}, which is missing from the bundle.")
        if str(digest).lower() != seen[name]:
            raise ChecksumMismatchError(f"Bundle file {name!r} does not match its manifest checksum.", expected=str(digest), actual=seen[name])
    report_sha = manifest.get("eval_report_sha256")
    if report_sha is not None and seen.get("eval_report.json") != report_sha:
        raise ChecksumMismatchError("eval_report.json does not match manifest.eval_report_sha256.", expected=str(report_sha), actual=seen.get("eval_report.json", ""))
    return dict(manifest)


def check_peft_dir(directory: Path, artifact_format: str | None) -> None:
    """Make sure an extracted directory is loadable as PEFT (or merged) weights."""
    has_adapter = (directory / "adapter_config.json").is_file() and any(directory.glob("adapter_model.*"))
    has_merged = (directory / "config.json").is_file() and any(directory.glob("*.safetensors"))
    if not (has_adapter or has_merged):
        raise ValueError(
            f"This artifact (format {artifact_format!r}) is not PEFT/merged LLM weights, so it cannot be served on vLLM. "
            "Use format='files' to extract it anyway, or format='bundle' to keep the .grad.tar.gz."
        )


def finalize_dir(staging: Path, target: Path, *, overwrite: bool) -> None:
    """Move an extracted staging directory into place."""
    if target.exists():
        if any(target.iterdir()):
            if not overwrite:  # pragma: no cover - checked in plan_download
                raise FileExistsError(f"{target} is not empty.")
            shutil.rmtree(target)
        else:
            target.rmdir()
    os.replace(staging, target)
    fsync_dir(target.parent)


def finalize_file(temp: Path, target: Path) -> None:
    """Move a verified temp file into place with umask-respecting permissions."""
    os.chmod(temp, _umask_mode() & ~stat.S_IXUSR)
    os.replace(temp, target)
    fsync_dir(target.parent)
