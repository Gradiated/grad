"""Artifact bundle formats: versions, the files each format must contain, and schema validation.

The formats are specified in ``docs/ARTIFACT_FORMATS.md``. Their JSON Schemas live in
``grad_trainer/artifact_schemas/`` (the repository's ``spec/artifacts/`` points there):
``manifest.schema.json`` for ``manifest.json`` and ``<format>.schema.json`` for the format's
config file. ``bundle_directory`` validates every bundle the trainer writes.
"""

from __future__ import annotations

import functools
import json
import struct
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from . import __version__

SCHEMA_DIR = Path(__file__).resolve().parent / "artifact_schemas"
#: Bumped when a format changes in a way an existing loader can't read.
FORMAT_VERSIONS: dict[str, int] = {
    "peft_lora": 1,
    "merged_safetensors": 1,
    "cartridge": 1,
    "encoder_safetensors": 1,
    "router_bundle": 1,
    "decision_bundle": 1,
    "reference": 1,
}
#: The file each format's ``<format>.schema.json`` validates (for a cartridge, the safetensors header).
CONFIG_FILES: dict[str, str] = {
    "peft_lora": "adapter_config.json",
    "merged_safetensors": "config.json",
    "cartridge": "cartridge.safetensors",
    "encoder_safetensors": "grad_embedding.json",
    "router_bundle": "router_config.json",
    "decision_bundle": "decision_config.json",
}
ADAPTER_FILES = ("adapter_config.json", "adapter_model.safetensors")
MAX_SAFETENSORS_HEADER = 1024 * 1024


def stamp(manifest: dict[str, Any]) -> dict[str, Any]:
    """Add ``created_by`` and the writer's ``format_version`` for the manifest's ``format``."""
    out = {**manifest, "created_by": {"name": "grad-trainer", "version": __version__}}
    if manifest.get("format") in FORMAT_VERSIONS:
        out["format_version"] = FORMAT_VERSIONS[manifest["format"]]
    return out


@functools.cache
def _validator(name: str) -> Draft202012Validator:
    schema = json.loads((SCHEMA_DIR / f"{name}.schema.json").read_text())
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def check(name: str, instance: Any, label: str) -> None:
    """Raise ``ValueError`` naming the first violation of ``<name>.schema.json``."""
    error = next(iter(sorted(_validator(name).iter_errors(instance), key=lambda e: list(e.absolute_path))), None)
    if error is not None:
        where = "/".join(str(p) for p in error.absolute_path) or "(root)"
        raise ValueError(f"{label} does not match {name}.schema.json at {where}: {error.message}")


def safetensors_header(path: Path) -> dict[str, Any]:
    """The JSON header of a safetensors file (tensor dtypes, shapes and ``__metadata__``)."""
    with open(path, "rb") as fh:
        (size,) = struct.unpack("<Q", fh.read(8))
        if not 0 < size <= MAX_SAFETENSORS_HEADER:
            raise ValueError(f"{path.name} has an invalid safetensors header length.")
        header = json.loads(fh.read(size))
    if not isinstance(header, dict):
        raise ValueError(f"{path.name} has an invalid safetensors header.")
    return header


def read_config(fmt: str, root: Path) -> dict[str, Any]:
    path = Path(root) / CONFIG_FILES[fmt]
    return safetensors_header(path) if path.suffix == ".safetensors" else json.loads(path.read_text())


def validate_bundle(manifest: dict[str, Any], root: Path) -> None:
    """Check a bundle's manifest and its format's config file (in ``root``) against the schemas."""
    check("manifest", manifest, "manifest.json")
    fmt = manifest["format"]
    if fmt not in CONFIG_FILES:
        return
    config = read_config(fmt, root)
    check(fmt, config, CONFIG_FILES[fmt])
    if fmt in ("router_bundle", "decision_bundle"):
        needed = [config["head_file"]] + (list(ADAPTER_FILES) if config["adapter"]["kind"] == "lora" else [])
        missing = [name for name in needed if name not in manifest["files"]]
        if missing:
            raise ValueError(f"{fmt} bundle is missing {missing}.")
