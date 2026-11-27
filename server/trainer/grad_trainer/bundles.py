"""Deterministic .grad.tar.gz artifact bundle builder and hardened reader."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import tarfile
from typing import Any

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
