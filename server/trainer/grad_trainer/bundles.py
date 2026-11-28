"""Deterministic ``.grad.tar.gz`` artifact bundles and a hardened reader/extractor.

A bundle is a gzip'd tar of regular files with ``manifest.json`` at the root. The manifest
(``schema: grad.artifact/1``) maps every payload file to its SHA-256 in ``files`` and records
``eval_report_sha256``, so a tampered ``eval_report.json`` fails verification. ``manifest.json``
and ``eval_report.json`` are reserved names. Checksums give integrity, not authenticity.
The layout and every format are specified in ``docs/ARTIFACT_FORMATS.md``; ``bundle_directory``
stamps ``format_version`` and ``created_by`` and validates the bundle against the JSON Schemas.

Bundles are byte-for-byte reproducible for the same inputs and zlib build: sorted entries,
``mtime=0``, uid/gid 0, empty owner names, an empty gzip filename and fixed compression.

Reading never trusts the archive: members are counted while iterating (no ``getmembers()``),
only regular files with safe relative paths are accepted, duplicates are rejected, and both
declared and actually-read sizes are capped.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import shutil
import tarfile
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any, Iterator

from . import artifact_formats

SCHEMA = "grad.artifact/1"
RESERVED = ("manifest.json", "eval_report.json")
MAX_BUNDLE_UNCOMPRESSED_BYTES = 64 * 1024 * 1024  # in-memory reads
MAX_EXTRACT_BYTES = 512 * 1024**3  # on-disk extraction (imports of large local models)
MAX_BUNDLE_MEMBERS = 1024
# grad-server's cap on one upload (MAX_UPLOAD_BYTES in server/api/src/contracts/datasets.ts):
# a bundle goes to storage as a single PutObject, which S3 limits to 5 GiB.
MAX_UPLOAD_BYTES = 5 * 1024**3
_CHUNK = 1024 * 1024


@dataclass(frozen=True)
class BundleInfo:
    path: Path
    sha256: str
    size_bytes: int
    manifest: dict[str, Any]


def _validate_member_path(name: str) -> None:
    if (
        not name
        or name.startswith("/")
        or "\\" in name
        or "\x00" in name
        or any(seg in ("", ".", "..") for seg in name.split("/"))
    ):
        raise ValueError(f"Unsafe archive entry path: {name!r}")


def _tarinfo(name: str, size: int) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name=name)
    info.size = size
    info.mtime = 0
    info.mode = 0o644
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    return info


def _encode_json(value: Any) -> bytes:
    return json.dumps(value, indent=2, sort_keys=True).encode("utf-8")


def _enrich(manifest: dict[str, Any], checksums: dict[str, str], report: bytes | None) -> dict[str, Any]:
    if not isinstance(manifest, dict):
        raise ValueError("manifest must be an object")
    enriched = {**artifact_formats.stamp(manifest), "schema": SCHEMA, "files": dict(sorted(checksums.items()))}
    if report is not None:
        enriched["eval_report_sha256"] = hashlib.sha256(report).hexdigest()
    else:
        enriched.pop("eval_report_sha256", None)
    return enriched


def _check_payload_names(names: list[str]) -> None:
    for name in names:
        _validate_member_path(name)
        if name in RESERVED:
            raise ValueError(f"'{name}' is reserved and can't be a payload file.")


def build_artifact_bundle(
    *,
    manifest: dict[str, Any],
    files: dict[str, bytes],
    eval_report: dict[str, Any] | None = None,
) -> bytes:
    """Build a small bundle in memory."""
    _check_payload_names(list(files))
    report = _encode_json(eval_report) if eval_report is not None else None
    checksums = {name: hashlib.sha256(content).hexdigest() for name, content in files.items()}
    entries: dict[str, bytes] = {"manifest.json": _encode_json(_enrich(manifest, checksums, report)), **files}
    if report is not None:
        entries["eval_report.json"] = report
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", fileobj=buf, mode="wb", mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tf:
            for name in sorted(entries):
                tf.addfile(_tarinfo(name, len(entries[name])), io.BytesIO(entries[name]))
    return buf.getvalue()


def _directory_files(src: Path) -> list[tuple[str, Path]]:
    out: list[tuple[str, Path]] = []
    for path in sorted(src.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"Refusing to bundle symlink {path}.")
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError(f"Refusing to bundle non-regular file {path}.")
        out.append((path.relative_to(src).as_posix(), path))
    _check_payload_names([name for name, _ in out])
    return out


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bundle_directory(
    src_dir: Path,
    out_path: Path,
    *,
    manifest: dict[str, Any],
    eval_report: dict[str, Any] | None = None,
    compresslevel: int = 1,
    validate: bool = True,
) -> BundleInfo:
    """Stream every regular file under ``src_dir`` into a deterministic bundle at ``out_path``.

    ``validate`` checks the manifest and the format's config file against the JSON Schemas
    first; only tests that build arbitrary bundles turn it off.
    """
    src_dir, out_path = Path(src_dir), Path(out_path)
    files = _directory_files(src_dir)
    report = _encode_json(eval_report) if eval_report is not None else None
    checksums = {name: _sha256_file(path) for name, path in files}
    enriched = _enrich(manifest, checksums, report)
    if validate:
        artifact_formats.validate_bundle(enriched, src_dir)
    entries: list[tuple[str, Path | bytes]] = [("manifest.json", _encode_json(enriched))]
    if report is not None:
        entries.append(("eval_report.json", report))
    entries.extend(files)
    entries.sort(key=lambda e: e[0])

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wb") as raw:
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0, compresslevel=compresslevel) as gz:
            with tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tf:
                for name, content in entries:
                    if isinstance(content, bytes):
                        tf.addfile(_tarinfo(name, len(content)), io.BytesIO(content))
                    else:
                        with open(content, "rb") as fh:
                            tf.addfile(_tarinfo(name, content.stat().st_size), fh)
    return BundleInfo(path=out_path, sha256=_sha256_file(out_path), size_bytes=out_path.stat().st_size, manifest=enriched)


def _members(tf: tarfile.TarFile, max_members: int, max_bytes: int) -> Iterator[tarfile.TarInfo]:
    count = 0
    declared = 0
    seen: set[str] = set()
    while True:
        member = tf.next()
        if member is None:
            return
        count += 1
        if count > max_members:
            raise ValueError(f"Artifact bundle exceeds {max_members} entries.")
        if not member.isfile():
            raise ValueError(f"Unsupported non-regular tar entry '{member.name}' in artifact bundle.")
        _validate_member_path(member.name)
        if member.name in seen:
            raise ValueError(f"Duplicate tar entry '{member.name}' in artifact bundle.")
        seen.add(member.name)
        declared += member.size
        if declared > max_bytes:
            raise ValueError(f"Artifact bundle exceeds uncompressed limit of {max_bytes} bytes.")
        yield member


def _copy_bounded(src: IO[bytes], dst: IO[bytes] | None, limit: int) -> tuple[int, str]:
    digest = hashlib.sha256()
    total = 0
    while True:
        chunk = src.read(min(_CHUNK, limit - total + 1))
        if not chunk:
            return total, digest.hexdigest()
        total += len(chunk)
        if total > limit:
            raise ValueError(f"Artifact bundle exceeds uncompressed limit of {limit} bytes.")
        digest.update(chunk)
        if dst is not None:
            dst.write(chunk)


def _verify_manifest(manifest_bytes: bytes | None, digests: dict[str, str]) -> dict[str, Any]:
    if manifest_bytes is None:
        raise ValueError("Artifact bundle is missing manifest.json.")
    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except ValueError as exc:
        raise ValueError(f"manifest.json is not valid JSON: {exc}") from exc
    if not isinstance(manifest, dict):
        raise ValueError("manifest.json must be a JSON object.")
    if manifest.get("schema") != SCHEMA:
        raise ValueError(f"Unsupported artifact manifest schema: {manifest.get('schema')!r}")
    declared = manifest.get("files")
    if not isinstance(declared, dict):
        raise ValueError("Artifact manifest is missing a 'files' checksum map.")
    payload = {k: v for k, v in digests.items() if k not in RESERVED}
    undeclared = set(payload) - set(declared)
    if undeclared:
        raise ValueError(f"Artifact bundle contains undeclared files: {sorted(undeclared)}")
    for name, expected in declared.items():
        if name not in payload:
            raise ValueError(f"Artifact bundle missing declared file '{name}'.")
        if payload[name] != expected:
            raise ValueError(f"Checksum mismatch for '{name}': expected {expected}, got {payload[name]}.")
    report_sha = manifest.get("eval_report_sha256")
    if "eval_report.json" in digests and report_sha != digests["eval_report.json"]:
        raise ValueError("eval_report.json does not match eval_report_sha256 in the manifest.")
    if report_sha is not None and "eval_report.json" not in digests:
        raise ValueError("Artifact bundle is missing eval_report.json.")
    return manifest


def read_artifact_bundle(
    bundle: bytes | Path,
    *,
    max_uncompressed_bytes: int = MAX_BUNDLE_UNCOMPRESSED_BYTES,
    max_members: int = MAX_BUNDLE_MEMBERS,
) -> tuple[dict[str, Any], dict[str, bytes]]:
    """Read and verify a (small) bundle into memory."""
    fileobj: IO[bytes] = open(bundle, "rb") if isinstance(bundle, Path) else io.BytesIO(bundle)
    files: dict[str, bytes] = {}
    digests: dict[str, str] = {}
    remaining = max_uncompressed_bytes
    with fileobj, tarfile.open(fileobj=fileobj, mode="r:gz") as tf:
        for member in _members(tf, max_members, max_uncompressed_bytes):
            extracted = tf.extractfile(member)
            assert extracted is not None
            buf = io.BytesIO()
            size, digest = _copy_bounded(extracted, buf, remaining)
            remaining -= size
            files[member.name] = buf.getvalue()
            digests[member.name] = digest
    manifest = _verify_manifest(files.get("manifest.json"), digests)
    return manifest, files


def extract_bundle(
    bundle_path: Path,
    dest_dir: Path,
    *,
    max_uncompressed_bytes: int = MAX_EXTRACT_BYTES,
    max_members: int = MAX_BUNDLE_MEMBERS,
) -> dict[str, Any]:
    """Extract and verify a bundle into an empty ``dest_dir``; removes it again on failure."""
    dest_dir = Path(dest_dir)
    if dest_dir.exists() and any(dest_dir.iterdir()):
        raise ValueError(f"Destination {dest_dir} is not empty.")
    dest_dir.mkdir(parents=True, exist_ok=True)
    digests: dict[str, str] = {}
    manifest_bytes: bytes | None = None
    remaining = max_uncompressed_bytes
    try:
        with open(bundle_path, "rb") as raw, tarfile.open(fileobj=raw, mode="r:gz") as tf:
            for member in _members(tf, max_members, max_uncompressed_bytes):
                extracted = tf.extractfile(member)
                assert extracted is not None
                target = dest_dir / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                with open(target, "xb") as out:
                    size, digest = _copy_bounded(extracted, out, remaining)
                remaining -= size
                digests[member.name] = digest
                if member.name == "manifest.json":
                    manifest_bytes = target.read_bytes()
        return _verify_manifest(manifest_bytes, digests)
    except BaseException:
        shutil.rmtree(dest_dir, ignore_errors=True)
        raise
