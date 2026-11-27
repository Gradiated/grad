"""Deterministic .grad.tar.gz artifact bundle builder and hardened reader."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import shutil
import stat
import tarfile
from pathlib import Path
from typing import Any, BinaryIO

MAX_BUNDLE_UNCOMPRESSED_BYTES = 64 * 1024 * 1024
MAX_BUNDLE_MEMBERS = 128


def _validate_member_path(name: str) -> None:
    if (
        not name
        or name.startswith("/")
        or "\\" in name
        or "\x00" in name
        or any(seg in ("", ".", "..") for seg in name.split("/"))
    ):
        raise ValueError(f"Unsafe archive entry path: {name!r}")


def build_artifact_bundle(
    *,
    manifest: dict[str, Any],
    files: dict[str, bytes],
    eval_report: dict[str, Any] | None = None,
) -> bytes:
    """Package manifest, optional eval_report, and weight files into a deterministic .grad.tar.gz."""
    file_checksums = {
        name: hashlib.sha256(content).hexdigest()
        for name, content in sorted(files.items())
    }
    enriched_manifest = {
        "schema": "grad.artifact/1",
        **manifest,
        "files": file_checksums,
    }

    all_entries: dict[str, bytes] = {
        "manifest.json": json.dumps(enriched_manifest, indent=2, sort_keys=True).encode(
            "utf-8"
        ),
        **files,
    }
    if eval_report is not None:
        all_entries["eval_report.json"] = json.dumps(
            eval_report, indent=2, sort_keys=True
        ).encode("utf-8")

    buf = io.BytesIO()
    with gzip.GzipFile(filename="", fileobj=buf, mode="wb", mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode="w") as tf:
            for name in sorted(all_entries):
                _validate_member_path(name)
                raw = all_entries[name]
                info = tarfile.TarInfo(name=name)
                info.size = len(raw)
                info.mtime = 0
                info.mode = 0o644
                info.uid = 0
                info.gid = 0
                info.uname = ""
                info.gname = ""
                tf.addfile(info, io.BytesIO(raw))

    return buf.getvalue()


def read_artifact_bundle(
    bundle_bytes: bytes,
    *,
    max_uncompressed_bytes: int = MAX_BUNDLE_UNCOMPRESSED_BYTES,
) -> tuple[dict[str, Any], dict[str, bytes]]:
    """Read and SHA-256-verify a .grad.tar.gz artifact bundle safely."""
    files: dict[str, bytes] = {}
    total_read = 0

    with tarfile.open(fileobj=io.BytesIO(bundle_bytes), mode="r:gz") as tf:
        members = tf.getmembers()
        if len(members) > MAX_BUNDLE_MEMBERS:
            raise ValueError(f"Artifact bundle exceeds {MAX_BUNDLE_MEMBERS} entries.")

        for member in members:
            if not member.isfile():
                raise ValueError(
                    f"Unsupported non-regular tar entry '{member.name}' in artifact bundle."
                )
            _validate_member_path(member.name)
            if member.name in files:
                raise ValueError(
                    f"Duplicate tar entry '{member.name}' in artifact bundle."
                )
            extracted = tf.extractfile(member)
            if extracted is None:
                raise ValueError(f"Could not read tar entry '{member.name}'.")

            remaining = max_uncompressed_bytes - total_read
            chunk = extracted.read(remaining + 1)
            if len(chunk) > remaining:
                raise ValueError(
                    f"Artifact bundle exceeds uncompressed limit of {max_uncompressed_bytes} bytes."
                )
            total_read += len(chunk)
            files[member.name] = chunk

    if "manifest.json" not in files:
        raise ValueError("Artifact bundle is missing manifest.json.")

    manifest = json.loads(files["manifest.json"].decode("utf-8"))
    if manifest.get("schema") != "grad.artifact/1":
        raise ValueError(
            f"Unsupported artifact manifest schema: {manifest.get('schema')!r}"
        )

    declared_files = manifest.get("files")
    if not isinstance(declared_files, dict):
        raise ValueError("Artifact manifest is missing a 'files' checksum map.")

    allowed_names = {"manifest.json", "eval_report.json", *declared_files.keys()}
    undeclared = set(files.keys()) - allowed_names
    if undeclared:
        raise ValueError(
            f"Artifact bundle contains undeclared files: {sorted(undeclared)}"
        )

    for name, expected_sha in declared_files.items():
        if name not in files:
            raise ValueError(f"Artifact bundle missing declared file '{name}'.")
        actual_sha = hashlib.sha256(files[name]).hexdigest()
        if actual_sha != expected_sha:
            raise ValueError(
                f"Checksum mismatch for '{name}': expected {expected_sha}, got {actual_sha}."
            )

    return manifest, files


MAX_DIRECTORY_BUNDLE_MEMBERS = 4096
_CHUNK = 1024 * 1024
_RESERVED_NAMES = frozenset({"manifest.json", "eval_report.json"})


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(_CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def _directory_files(src_dir: Path) -> list[tuple[str, Path]]:
    """Regular files under ``src_dir`` as sorted (archive name, path) pairs."""
    files: list[tuple[str, Path]] = []
    for root, dirs, names in os.walk(src_dir, followlinks=False):
        root_path = Path(root)
        for name in list(dirs):
            if (root_path / name).is_symlink():
                raise ValueError(
                    f"Refusing to bundle symlinked directory {root_path / name}."
                )
        for name in names:
            path = root_path / name
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode):
                raise ValueError(f"Refusing to bundle symlink {path}.")
            if not stat.S_ISREG(mode):
                raise ValueError(f"Refusing to bundle non-regular file {path}.")
            rel = path.relative_to(src_dir).as_posix()
            _validate_member_path(rel)
            files.append((rel, path))
    files.sort(key=lambda item: item[0])
    if len(files) + 2 > MAX_DIRECTORY_BUNDLE_MEMBERS:
        raise ValueError(
            f"Directory has more than {MAX_DIRECTORY_BUNDLE_MEMBERS} files."
        )
    return files


def _tar_info(name: str, size: int) -> tarfile.TarInfo:
    info = tarfile.TarInfo(name=name)
    info.size = size
    info.mtime = 0
    info.mode = 0o644
    info.uid = 0
    info.gid = 0
    info.uname = ""
    info.gname = ""
    return info


def bundle_directory(
    src_dir: str | os.PathLike[str],
    out_path: str | os.PathLike[str],
    *,
    manifest: dict[str, Any],
    eval_report: dict[str, Any] | None = None,
) -> tuple[str, int]:
    """Stream a directory into a deterministic ``.grad.tar.gz`` at ``out_path``.

    File contents are never held in memory. ``manifest.json`` carries a sha256
    for every member, including ``eval_report.json``. Returns the archive's
    (sha256, size).
    """
    src = Path(src_dir)
    if not src.is_dir():
        raise ValueError(f"Bundle source {src} is not a directory.")
    files = _directory_files(src)
    clashes = sorted(_RESERVED_NAMES & {name for name, _ in files})
    if clashes:
        raise ValueError(f"Bundle source contains reserved file names: {clashes}")

    report_bytes = (
        json.dumps(eval_report, indent=2, sort_keys=True).encode("utf-8")
        if eval_report is not None
        else None
    )
    checksums = {name: _sha256_file(path) for name, path in files}
    if report_bytes is not None:
        checksums["eval_report.json"] = hashlib.sha256(report_bytes).hexdigest()
    manifest_bytes = json.dumps(
        {"schema": "grad.artifact/1", **manifest, "files": checksums},
        indent=2,
        sort_keys=True,
    ).encode("utf-8")

    entries: list[tuple[str, bytes | Path]] = [("manifest.json", manifest_bytes)]
    if report_bytes is not None:
        entries.append(("eval_report.json", report_bytes))
    entries.extend(files)
    entries.sort(key=lambda item: item[0])

    out = Path(out_path)
    with out.open("wb") as raw:
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tf:
                for name, content in entries:
                    if isinstance(content, bytes):
                        tf.addfile(_tar_info(name, len(content)), io.BytesIO(content))
                    else:
                        with content.open("rb") as fh:
                            size = os.fstat(fh.fileno()).st_size
                            tf.addfile(_tar_info(name, size), fh)
    return _sha256_file(out), out.stat().st_size


def _copy_bounded(src: BinaryIO, dst: BinaryIO, limit: int) -> tuple[int, str]:
    digest = hashlib.sha256()
    total = 0
    for block in iter(lambda: src.read(_CHUNK), b""):
        total += len(block)
        if total > limit:
            raise ValueError(f"Bundle exceeds uncompressed limit of {limit} bytes.")
        digest.update(block)
        dst.write(block)
    return total, digest.hexdigest()


def extract_bundle(
    path: str | os.PathLike[str],
    dest_dir: str | os.PathLike[str],
    *,
    max_bytes: int = 64 * 1024 * 1024 * 1024,
) -> dict[str, Any]:
    """Extract and verify a ``.grad.tar.gz`` into ``dest_dir``; returns the manifest.

    Rejects unsafe paths, links and special entries, duplicate names, more than
    ``MAX_DIRECTORY_BUNDLE_MEMBERS`` entries, archives over ``max_bytes``
    uncompressed, undeclared files and checksum mismatches. ``manifest.json``
    stays in ``dest_dir``. ``dest_dir`` must be missing or empty; it is removed
    again when verification fails.
    """
    dest = Path(dest_dir).resolve()
    if dest.exists() and any(dest.iterdir()):
        raise ValueError(f"Bundle destination {dest} is not empty.")
    dest.mkdir(parents=True, exist_ok=True)
    actual: dict[str, str] = {}
    total = 0
    try:
        with tarfile.open(Path(path), mode="r:gz") as tf:
            for count, member in enumerate(tf, start=1):
                if count > MAX_DIRECTORY_BUNDLE_MEMBERS:
                    raise ValueError(
                        f"Bundle exceeds {MAX_DIRECTORY_BUNDLE_MEMBERS} entries."
                    )
                if not member.isfile():
                    raise ValueError(
                        f"Unsupported non-regular tar entry '{member.name}'."
                    )
                _validate_member_path(member.name)
                if member.name in actual:
                    raise ValueError(f"Duplicate tar entry '{member.name}'.")
                target = (dest / member.name).resolve()
                if dest not in target.parents:
                    raise ValueError(f"Unsafe archive entry path: {member.name!r}")
                extracted = tf.extractfile(member)
                if extracted is None:
                    raise ValueError(f"Could not read tar entry '{member.name}'.")
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as out:
                    size, sha = _copy_bounded(extracted, out, max_bytes - total)
                total += size
                actual[member.name] = sha

        manifest_path = dest / "manifest.json"
        if "manifest.json" not in actual:
            raise ValueError("Bundle is missing manifest.json.")
        manifest = json.loads(manifest_path.read_text("utf-8"))
        if manifest.get("schema") != "grad.artifact/1":
            raise ValueError(
                f"Unsupported artifact manifest schema: {manifest.get('schema')!r}"
            )
        declared = manifest.get("files")
        if not isinstance(declared, dict):
            raise ValueError("Bundle manifest is missing a 'files' checksum map.")
        undeclared = set(actual) - {"manifest.json", *declared}
        if undeclared:
            raise ValueError(f"Bundle contains undeclared files: {sorted(undeclared)}")
        for name, expected in declared.items():
            if name not in actual:
                raise ValueError(f"Bundle missing declared file '{name}'.")
            if actual[name] != expected:
                raise ValueError(
                    f"Checksum mismatch for '{name}': expected {expected}, got {actual[name]}."
                )
        return manifest
    except Exception:
        shutil.rmtree(dest, ignore_errors=True)
        raise
