"""Resolve catalog model ids to local weight directories.

Resolution order for a model id:

1. ``GRAD_MODEL_PATHS``: a JSON object mapping model id -> local directory or HF repo id.
2. With ``GRAD_DEV_MODELS=1``, the tiny test models of ``dev_models`` (built locally).
3. ``GRAD_MODELS_MIRROR``: a directory (or ``s3://bucket/prefix``) holding
   ``<mirror>/<model id>/`` or ``<mirror>/<HF repo id>/``. For air-gapped installs.
4. The built-in map below, downloaded from the Hugging Face Hub.

Offline mode (``HF_HUB_OFFLINE=1`` or ``GRAD_OFFLINE=1``) never touches the network: a model
that is not already local raises ``ModelUnavailableError`` with what to set.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import dev_models
from .errors import ModelUnavailableError


@dataclass(frozen=True)
class CatalogModel:
    repo: str | None
    family: str  # "causal_lm" | "encoder"
    template_revision: str


BUILTIN_MODELS: dict[str, CatalogModel] = {
    "qwen/qwen3-0.6b": CatalogModel("Qwen/Qwen3-0.6B", "causal_lm", "qwen3@3"),
    "qwen/qwen3-1.7b": CatalogModel("Qwen/Qwen3-1.7B", "causal_lm", "qwen3@3"),
    "qwen/qwen3-4b": CatalogModel("Qwen/Qwen3-4B", "causal_lm", "qwen3@3"),
    "qwen/qwen3-8b": CatalogModel("Qwen/Qwen3-8B", "causal_lm", "qwen3@3"),
    "qwen/qwen3-14b": CatalogModel("Qwen/Qwen3-14B", "causal_lm", "qwen3@3"),
    "qwen/qwen3-32b": CatalogModel("Qwen/Qwen3-32B", "causal_lm", "qwen3@3"),
    # linden-1 weights are not public; self-hosted installs must provide them.
    "gradiated/linden-1": CatalogModel(None, "causal_lm", "systemone@1"),
    "baai/bge-small-en-v1.5": CatalogModel("BAAI/bge-small-en-v1.5", "encoder", "bge@1"),
}

_ENCODER_TYPES = {"bert", "roberta", "xlm-roberta", "distilbert", "electra", "deberta-v2", "modernbert"}


@dataclass(frozen=True)
class ResolvedModel:
    model_id: str
    path: Path
    repo: str  # what PEFT's base_model_name_or_path / vLLM should load
    revision: str | None
    family: str
    template_revision: str
    source: str  # "path" | "mirror" | "hub" | "dev"


def is_offline() -> bool:
    return any(
        os.environ.get(var, "").strip().lower() in ("1", "true", "yes")
        for var in ("HF_HUB_OFFLINE", "GRAD_OFFLINE", "TRANSFORMERS_OFFLINE")
    )


def _model_paths() -> dict[str, str]:
    raw = os.environ.get("GRAD_MODEL_PATHS", "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ModelUnavailableError(f"GRAD_MODEL_PATHS is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise ModelUnavailableError("GRAD_MODEL_PATHS must be a JSON object of id -> path.")
    return {str(k).strip().lower(): str(v) for k, v in parsed.items()}


def _family_from_config(path: Path, default: str) -> str:
    try:
        cfg = json.loads((path / "config.json").read_text())
    except (OSError, json.JSONDecodeError):
        return default
    return "encoder" if str(cfg.get("model_type", "")).lower() in _ENCODER_TYPES else "causal_lm"


def _revision_from_path(path: Path) -> str | None:
    # huggingface_hub snapshots live in .../snapshots/<commit sha>/
    if path.parent.name == "snapshots":
        return path.name
    marker = path / ".grad_revision"
    return marker.read_text().strip() if marker.is_file() else None


def _resolved(model_id: str, path: Path, repo: str, source: str) -> ResolvedModel:
    catalog = BUILTIN_MODELS.get(model_id)
    family = _family_from_config(path, catalog.family if catalog else "causal_lm")
    template = catalog.template_revision if catalog else ("bge@1" if family == "encoder" else "qwen3@3")
    return ResolvedModel(
        model_id=model_id,
        path=path,
        repo=repo,
        revision=_revision_from_path(path),
        family=family,
        template_revision=template,
        source=source,
    )


def _sync_s3_prefix(uri: str, dest: Path) -> bool:
    """Download every object under ``uri`` into ``dest``. Returns False if nothing exists."""
    try:
        import boto3  # type: ignore[import-not-found]
    except ImportError as exc:
        raise ModelUnavailableError(
            "GRAD_MODELS_MIRROR is an s3:// URI but boto3 is not installed in the trainer image."
        ) from exc
    bucket, _, prefix = uri[len("s3://") :].partition("/")
    prefix = prefix.rstrip("/") + "/"
    client = boto3.client("s3")
    found = False
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
        for obj in page.get("Contents", []):
            rel = obj["Key"][len(prefix) :]
            if not rel or rel.endswith("/") or ".." in rel.split("/"):
                continue
            target = dest / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists() or target.stat().st_size != obj["Size"]:
                client.download_file(bucket, obj["Key"], str(target))
            found = True
    return found


def _from_mirror(model_id: str, repo: str | None, mirror: str) -> ResolvedModel | None:
    names = [model_id] + ([repo] if repo else [])
    if mirror.startswith("s3://"):
        cache = Path(os.environ.get("GRAD_MODELS_CACHE", Path.home() / ".cache" / "grad" / "models"))
        for name in names:
            dest = cache / name
            if (dest / "config.json").is_file() or _sync_s3_prefix(f"{mirror.rstrip('/')}/{name}", dest):
                return _resolved(model_id, dest, repo or model_id, "mirror")
        return None
    for name in names:
        candidate = Path(mirror) / name
        if (candidate / "config.json").is_file():
            return _resolved(model_id, candidate, repo or model_id, "mirror")
    return None


def _unavailable(model_id: str, repo: str, how: str) -> ModelUnavailableError:
    return ModelUnavailableError(
        f"Model '{model_id}' ({repo}) is unavailable: {how}. Set GRAD_MODEL_PATHS="
        f'\'{{"{model_id}": "/path/to/weights"}}\' or GRAD_MODELS_MIRROR to a directory '
        f"containing '{model_id}/' or '{repo}/'."
    )


def _from_hub(model_id: str, repo: str) -> ResolvedModel:
    offline = is_offline()
    try:
        from huggingface_hub import snapshot_download
    except ImportError as exc:
        how = "offline mode is on and" if offline else "the Hub can't be reached:"
        raise _unavailable(model_id, repo, f"{how} huggingface_hub is not installed") from exc
    try:
        path = snapshot_download(
            repo,
            local_files_only=offline,
            allow_patterns=["*.json", "*.safetensors", "*.txt", "*.model", "*.jinja", "*.tiktoken"],
        )
    except Exception as exc:
        how = (
            "offline mode is on and the weights are not in the local Hugging Face cache"
            if offline
            else f"download from the Hugging Face Hub failed ({type(exc).__name__}: {exc})"
        )
        raise _unavailable(model_id, repo, how) from exc
    return _resolved(model_id, Path(path), repo, "hub")


def resolve_model(model_id: str) -> ResolvedModel:
    key = model_id.strip().lower()
    catalog = BUILTIN_MODELS.get(key)
    repo = catalog.repo if catalog else None

    override = _model_paths().get(key)
    if not override and key in dev_models.DEV_MODELS and dev_models.enabled():
        return _resolved(key, dev_models.ensure(key), key, "dev")
    if override:
        candidate = Path(override).expanduser()
        if candidate.is_dir():
            return _resolved(key, candidate, repo or override, "path")
        if override.startswith(("/", ".", "~")):
            raise ModelUnavailableError(
                f"GRAD_MODEL_PATHS maps '{model_id}' to '{override}', which is not a directory."
            )
        repo = override

    mirror = os.environ.get("GRAD_MODELS_MIRROR", "").strip()
    if mirror:
        found = _from_mirror(key, repo, mirror)
        if found:
            return found

    if repo is None:
        hint = (
            "Its weights are not public." if catalog else "It is not in the trainer's built-in catalog."
        )
        raise ModelUnavailableError(
            f"Model '{model_id}' is unavailable. {hint} Set GRAD_MODEL_PATHS="
            f'\'{{"{model_id}": "/path/to/weights"}}\' or put the weights under GRAD_MODELS_MIRROR.'
        )
    return _from_hub(key, repo)


def describe_model(resolved: ResolvedModel) -> dict[str, Any]:
    described: dict[str, Any] = {
        "base_model": resolved.model_id,
        "base_model_repo": resolved.repo,
        "base_model_revision": resolved.revision,
    }
    if resolved.source == "dev":
        described["test_only"] = True  # random tiny weights (grad local up --dev-models)
    return described
