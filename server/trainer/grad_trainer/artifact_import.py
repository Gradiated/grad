"""Artifact imports: uploaded files or a Hugging Face repo -> a validated ``grad.artifact/1`` bundle.

``run(spec, workdir=..., download=...) -> BundleInfo`` takes the claim's ``artifact_import``:

- ``source``: ``{"kind": "upload", "download_url", "sha256"}`` (a tar, optionally gzip, of the
  files) or ``{"kind": "hf", "repo", "revision", "token"?}``;
- ``format``, ``base_model``, ``name`` and ``provenance``.

The files are checked against ``docs/ARTIFACT_FORMATS.md`` and the base model's ``config.json``
(read on its own; the base weights are never downloaded): for ``peft_lora`` that is
``adapter_config.json``, the base model and its pinned revision, target modules that exist in
the base architecture and every LoRA tensor's shape. A check that fails raises
:class:`InvalidArtifact`, whose message starts with the file it is about. The bundle is then
written with :func:`bundles.bundle_directory`, which validates it against the JSON Schemas.

Hugging Face imports read the Hub only (``HF_ENDPOINT``, default ``https://huggingface.co``):
a repo id never names a path on the worker, the workspace's token (or none) is the only
credential sent, offline mode refuses, and the commit the revision resolves to is pinned in
``provenance.uri``.
"""

from __future__ import annotations

import fnmatch
import json
import math
import os
import re
import shutil
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import IO, Any, Callable

from . import artifact_formats
from .bundles import MAX_BUNDLE_MEMBERS, MAX_EXTRACT_BYTES, RESERVED, BundleInfo, bundle_directory
from .errors import ModelUnavailableError, SourceUnavailableError
from .models import ResolvedModel, is_offline, resolve_config
from .sources import redact

_CHUNK = 1024 * 1024
_HF_REPO = re.compile(r"[A-Za-z0-9][\w.-]*(/[A-Za-z0-9][\w.-]*)?")
_COMMIT = re.compile(r"[0-9a-f]{40}")
#: Upload and Hub size cap (the server's single-PUT upload cap).
MAX_IMPORT_BYTES = 5 * 1024**3
#: An upload's uncompressed cap: a tar of safetensors barely compresses, so twice the upload cap
#: leaves room for gzip and tar padding while refusing a small archive that inflates to fill the disk.
MAX_UPLOAD_EXTRACT_BYTES = 2 * MAX_IMPORT_BYTES
#: A JSON config file's size cap (config.json, adapter_config.json, tokenizer configs are KBs).
MAX_JSON_BYTES = 16 * 1024 * 1024
#: An HF import's wall-clock cap, on top of the 60 s per-read socket timeout.
HF_DEADLINE_SECONDS = 3600

#: The files each format keeps (everything else in an upload or repo is left out of the bundle).
FORMAT_FILES: dict[str, tuple[str, ...]] = {
    "peft_lora": ("adapter_config.json", "adapter_model.safetensors"),
    "merged_safetensors": (
        "config.json",
        "generation_config.json",
        "model.safetensors",
        "model-*-of-*.safetensors",
        "model.safetensors.index.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "chat_template.jinja",
        "vocab.json",
        "merges.txt",
        "added_tokens.json",
    ),
    "cartridge": ("cartridge.safetensors",),
    "encoder_safetensors": (
        "config.json",
        "model.safetensors",
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "vocab.txt",
        "grad_embedding.json",
        "modules.json",
        "sentence_bert_config.json",
        "1_Pooling/config.json",
        "2_Normalize/.keep",
    ),
    "router_bundle": ("router_config.json", "router_head.safetensors", "adapter_config.json", "adapter_model.safetensors"),
    "decision_bundle": ("decision_config.json", "decision_head.safetensors", "adapter_config.json", "adapter_model.safetensors"),
    "reward_bundle": ("reward_config.json", "reward_head.safetensors", "adapter_config.json", "adapter_model.safetensors"),
}
RECIPE_KINDS = {
    "peft_lora": "sft",
    "merged_safetensors": "sft",
    "cartridge": "cartridge",
    "encoder_safetensors": "embedding",
    "router_bundle": "router",
    "decision_bundle": "decision",
    "reward_bundle": "reward",
}
#: Pickle weights a loader would torch.load: refused, with the safetensors file to send instead.
_PICKLES = (".bin", ".pt", ".pth", ".pkl", ".ckpt")
#: Decoder layouts whose linear layers (and their shapes) follow from config.json.
_DECODERS = ("qwen3", "qwen2", "llama", "mistral")
_ATTENTION = ("q_proj", "k_proj", "v_proj", "o_proj")
_MLP = ("gate_proj", "up_proj", "down_proj")
_DTYPE_BYTES = {"F64": 8, "F32": 4, "F16": 2, "BF16": 2, "I64": 8, "I32": 4, "I16": 2, "I8": 1, "U8": 1, "BOOL": 1}
_LORA_TENSOR = re.compile(r"base_model\.model\.model\.layers\.(\d+)\.(self_attn|mlp)\.(\w+)\.lora_(A|B)(?:\.default)?\.weight")


class InvalidArtifact(ValueError):
    """The files break the format spec or don't fit the base model (the import's 422)."""

    def __init__(self, file: str, problem: str) -> None:
        super().__init__(f"{file}: {problem}")
        self.file = file


def matches(name: str, pattern: str) -> bool:
    """Whether ``name`` is one of the format's files: ``*`` never crosses a directory."""
    return name.count("/") == pattern.count("/") and fnmatch.fnmatchcase(name, pattern)


# --------------------------------------------------------------------------- sources


def extract_upload(archive: Path, dest: Path) -> None:
    """Extract an uploaded tar (gzip or not) into ``dest``: regular files at safe relative paths.

    Directory entries and a leading ``./`` are fine; links, devices and ``..`` are refused. When
    every file sits under one top-level directory (``tar czf x.tgz my-lora/``), it is stripped.
    """
    dest.mkdir(parents=True, exist_ok=True)
    try:
        tar = tarfile.open(archive, "r:*")
    except tarfile.TarError as exc:
        raise InvalidArtifact("upload", f"not a tar or tar.gz archive ({exc}); upload a directory or a .tar.gz of it") from exc
    names: list[str] = []
    total = 0
    with tar:
        for count, member in enumerate(iter(tar.next, None), start=1):
            if count > MAX_BUNDLE_MEMBERS:
                raise InvalidArtifact("upload", f"more than {MAX_BUNDLE_MEMBERS} entries")
            name = member.name[2:] if member.name.startswith("./") else member.name
            if member.isdir() or name in ("", "."):
                continue
            if not member.isfile() or member.issparse():
                raise InvalidArtifact(name, "links, sparse and special files are not allowed in an upload")
            if name.startswith("/") or "\\" in name or "\x00" in name or any(p in ("", ".", "..") for p in name.split("/")):
                raise InvalidArtifact(name, "unsafe path in the upload")
            total += member.size
            if total > min(MAX_EXTRACT_BYTES, MAX_UPLOAD_EXTRACT_BYTES):
                raise InvalidArtifact("upload", f"more than {MAX_UPLOAD_EXTRACT_BYTES} bytes uncompressed")
            target = dest / name
            source = tar.extractfile(member)
            assert source is not None
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                with open(target, "xb") as out:
                    shutil.copyfileobj(source, out, _CHUNK)
            except (FileExistsError, NotADirectoryError) as exc:
                raise InvalidArtifact(name, "appears twice in the upload, or as both a file and a directory") from exc
            names.append(name)
    if not names:
        raise InvalidArtifact("upload", "the archive holds no files")
    tops = {n.split("/", 1)[0] for n in names}
    if len(tops) == 1 and all("/" in n for n in names):
        top = dest / tops.pop()
        staging = dest.parent / f"{dest.name}.strip"
        top.rename(staging)
        dest.rmdir()
        staging.rename(dest)


class _NoAuthOnRedirect(urllib.request.HTTPRedirectHandler):
    """Follow the Hub's redirects (to its CDN) without forwarding the token to another origin.

    A redirect leaves http(s) never, and https never for plain http."""

    def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
        old, new_url = urllib.parse.urlsplit(req.full_url), urllib.parse.urlsplit(newurl)
        if new_url.scheme not in ("http", "https") or (old.scheme == "https" and new_url.scheme != "https"):
            raise urllib.error.HTTPError(req.full_url, code, f"refused redirect to a {new_url.scheme or 'relative'}:// URL", headers, fp)
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and (new_url.scheme, new_url.netloc) != (old.scheme, old.netloc):
            new.remove_header("Authorization")
        return new


def _hub_open(url: str, token: str | None) -> IO[bytes]:
    request = urllib.request.Request(url, headers={"User-Agent": "grad-trainer"})
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    # No proxy handler: HTTP(S)_PROXY from the worker's environment would bypass the egress rules.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoAuthOnRedirect)
    return opener.open(request, timeout=60)  # noqa: S310 - the Hub endpoint only


def hf_snapshot(repo: str, revision: str | None, token: str | None, dest: Path, keep: tuple[str, ...]) -> tuple[str, list[str]]:
    """Download the files of ``repo`` at ``revision`` that match ``keep`` into ``dest``.

    Returns the commit the revision resolved to and every file name the repo lists."""
    if not _HF_REPO.fullmatch(repo) or ".." in repo or os.path.exists(repo):
        raise SourceUnavailableError(f"'{repo}' is not a Hugging Face repo id (expected 'owner/name').")
    if is_offline():
        raise SourceUnavailableError(
            f"Can't import '{repo}' from the Hugging Face Hub: offline mode is on (HF_HUB_OFFLINE/GRAD_OFFLINE). "
            "Download it elsewhere and use `grad artifacts upload` instead."
        )
    endpoint = os.environ.get("HF_ENDPOINT", "https://huggingface.co").rstrip("/")
    rev = urllib.parse.quote(revision or "main", safe="")
    try:
        with _hub_open(f"{endpoint}/api/models/{repo}/revision/{rev}", token) as resp:
            info = json.loads(resp.read(16 * 1024 * 1024))
        commit = str(info.get("sha") or "")
        files = [str(s.get("rfilename")) for s in info.get("siblings") or [] if isinstance(s, dict)]
        if not _COMMIT.fullmatch(commit):
            raise SourceUnavailableError(f"The Hub did not report a commit for '{repo}' at '{revision or 'main'}'.")
        wanted = [name for name in files if any(matches(name, pattern) for pattern in keep)]
        if len(wanted) > MAX_BUNDLE_MEMBERS:
            raise SourceUnavailableError(f"'{repo}' lists more than {MAX_BUNDLE_MEMBERS} files for this format.")
        total, deadline = 0, time.monotonic() + HF_DEADLINE_SECONDS
        for name in wanted:
            if name.startswith("/") or any(p in ("", ".", "..") for p in name.split("/")):
                raise SourceUnavailableError(f"The Hub listed an unsafe file name {name!r} in '{repo}'.")
            target = dest / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with _hub_open(f"{endpoint}/{repo}/resolve/{commit}/{urllib.parse.quote(name)}", token) as resp, open(target, "wb") as out:
                while chunk := resp.read(_CHUNK):
                    total += len(chunk)
                    if total > MAX_IMPORT_BYTES:
                        raise SourceUnavailableError(f"'{repo}' is larger than {MAX_IMPORT_BYTES} bytes.")
                    if time.monotonic() > deadline:
                        raise SourceUnavailableError(f"'{repo}' took longer than {HF_DEADLINE_SECONDS} s to download.")
                    out.write(chunk)
    except urllib.error.HTTPError as exc:
        # The Hub answers 401 for a repo that doesn't exist too, so say both.
        hint = (
            " (check the repo id; if it exists it is gated or private: pass a workspace secret with an HF token)"
            if exc.code in (401, 403)
            else ""
        )
        raise SourceUnavailableError(f"Hugging Face Hub: '{repo}' at '{revision or 'main'}' answered HTTP {exc.code}{hint}.") from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        if isinstance(exc, SourceUnavailableError):
            raise
        raise SourceUnavailableError(redact(f"Can't download '{repo}' from the Hugging Face Hub: {exc}", token)) from exc
    return commit, files


# --------------------------------------------------------------------------- checks


def _json(root: Path, name: str) -> dict[str, Any]:
    try:
        if (root / name).stat().st_size > MAX_JSON_BYTES:
            raise InvalidArtifact(name, f"larger than {MAX_JSON_BYTES} bytes")
        value = json.loads((root / name).read_text())
    except FileNotFoundError as exc:
        raise InvalidArtifact(name, "missing") from exc
    except RecursionError as exc:
        raise InvalidArtifact(name, "nested too deeply") from exc
    except (OSError, ValueError) as exc:
        if isinstance(exc, InvalidArtifact):
            raise
        raise InvalidArtifact(name, f"not valid JSON ({exc})") from exc
    if not isinstance(value, dict):
        raise InvalidArtifact(name, "must be a JSON object")
    return value


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def safetensors(root: Path, name: str) -> dict[str, Any]:
    """A safetensors file's header, after checking every tensor's offsets against its bytes."""
    path = root / name
    if not path.is_file():
        raise InvalidArtifact(name, "missing")
    try:
        header = artifact_formats.safetensors_header(path)
    except (ValueError, OSError) as exc:
        raise InvalidArtifact(name, f"not a safetensors file ({exc})") from exc
    with open(path, "rb") as fh:
        header_len = int.from_bytes(fh.read(8), "little")
    data = path.stat().st_size - 8 - header_len
    spans = []
    for tensor, info in header.items():
        if tensor == "__metadata__":
            continue
        try:
            dtype, shape, (begin, end) = info["dtype"], info["shape"], info["data_offsets"]
            if not isinstance(shape, list) or not all(_is_int(v) for v in (*shape, begin, end)):
                raise TypeError("shape and data_offsets must be integers")
            expected = math.prod(shape) * _DTYPE_BYTES[dtype]
        except (KeyError, TypeError, ValueError) as exc:
            raise InvalidArtifact(name, f"tensor {tensor!r} has a malformed header entry") from exc
        if not 0 <= begin <= end <= data or end - begin != expected:
            raise InvalidArtifact(name, f"tensor {tensor!r} has offsets {begin}..{end} that don't fit its {dtype} {shape} data")
        spans.append((begin, end))
    spans.sort()
    if any(a[1] > b[0] for a, b in zip(spans, spans[1:])):
        raise InvalidArtifact(name, "tensors overlap")
    return header


def decoder_modules(base: ResolvedModel, config: dict[str, Any]) -> dict[str, tuple[int, int]]:
    """``{module: (in_features, out_features)}`` of a decoder's per-layer linear layers."""
    model_type = str(config.get("model_type", ""))
    if model_type not in _DECODERS:
        raise InvalidArtifact(
            "config.json",
            f"the base {base.model_id} has model_type {model_type!r}; LoRA imports support {', '.join(_DECODERS)} bases",
        )
    hidden = int(config["hidden_size"])
    heads = int(config["num_attention_heads"])
    kv = int(config.get("num_key_value_heads") or heads)
    head_dim = int(config.get("head_dim") or hidden // heads)
    inter = int(config["intermediate_size"])
    return {
        "q_proj": (hidden, heads * head_dim),
        "k_proj": (hidden, kv * head_dim),
        "v_proj": (hidden, kv * head_dim),
        "o_proj": (heads * head_dim, hidden),
        "gate_proj": (hidden, inter),
        "up_proj": (hidden, inter),
        "down_proj": (inter, hidden),
    }


def check_lora(root: Path, base: ResolvedModel, config: dict[str, Any]) -> dict[str, Any]:
    """Validate a PEFT LoRA (``adapter_config.json`` + ``adapter_model.safetensors``) for ``base``.

    Normalizes ``base_model_name_or_path`` and ``revision`` to the base's repo and pinned revision
    (what serving and continued training load) and returns the manifest's ``adapter``.
    """
    name = "adapter_config.json"
    cfg = _json(root, name)
    if cfg.get("peft_type") != "LORA" or cfg.get("task_type") != "CAUSAL_LM":
        raise InvalidArtifact(name, f"peft_type must be LORA and task_type CAUSAL_LM, not {cfg.get('peft_type')!r}/{cfg.get('task_type')!r}")
    declared = str(cfg.get("base_model_name_or_path") or "")
    if declared.lower() not in {base.repo.lower(), base.model_id.lower()}:
        raise InvalidArtifact(name, f"base_model_name_or_path is {declared!r}, expected {base.repo!r} (the base {base.model_id})")
    revision = cfg.get("revision")
    if revision and base.revision and revision != base.revision:
        raise InvalidArtifact(name, f"revision is {revision!r}, but {base.model_id} is pinned to {base.revision}")
    for key, ok, why in (
        ("use_dora", not cfg.get("use_dora"), "DoRA adapters are not supported"),
        ("use_rslora", not cfg.get("use_rslora"), "rsLoRA scaling is not supported"),
        ("modules_to_save", not cfg.get("modules_to_save"), "fully trained modules (modules_to_save) are not supported"),
        ("bias", cfg.get("bias", "none") == "none", "only bias 'none' is supported"),
        ("rank_pattern", not cfg.get("rank_pattern"), "per-module ranks are not supported"),
        ("alpha_pattern", not cfg.get("alpha_pattern"), "per-module alphas are not supported"),
    ):
        if not ok:
            raise InvalidArtifact(name, f"{key}: {why}")
    rank, alpha = cfg.get("r"), cfg.get("lora_alpha")
    if not isinstance(rank, int) or rank < 1 or not isinstance(alpha, (int, float)) or alpha <= 0:
        raise InvalidArtifact(name, f"r must be a positive integer and lora_alpha positive, not {rank!r}/{alpha!r}")
    targets = cfg.get("target_modules")
    if not isinstance(targets, list) or not targets or not all(isinstance(t, str) for t in targets):
        raise InvalidArtifact(name, "target_modules must be a list of module names (a regex is not supported)")
    modules = decoder_modules(base, config)
    for target in targets:
        if target not in modules:
            raise InvalidArtifact(name, f"target module {target!r} is not a linear layer of {base.model_id} ({', '.join(modules)})")
    layers = int(config["num_hidden_layers"])

    weights = "adapter_model.safetensors"
    header = safetensors(root, weights)
    seen: set[tuple[int, str, str]] = set()
    for tensor, info in header.items():
        if tensor == "__metadata__":
            continue
        match = _LORA_TENSOR.fullmatch(tensor)
        if not match:
            raise InvalidArtifact(weights, f"unexpected tensor {tensor!r} (a LoRA holds base_model.model.model.layers.<i>.<module>.lora_A/lora_B.weight only)")
        layer, group, module, side = int(match[1]), match[2], match[3], match[4]
        if layer >= layers:
            raise InvalidArtifact(weights, f"{tensor} is for layer {layer}, but {base.model_id} has {layers} layers")
        if module not in targets or group != ("self_attn" if module in _ATTENTION else "mlp"):
            raise InvalidArtifact(weights, f"{tensor} is not one of the target modules {targets}")
        if info["dtype"] not in ("F32", "F16", "BF16"):
            raise InvalidArtifact(weights, f"{tensor} has dtype {info['dtype']}; LoRA weights are F32, F16 or BF16")
        fan_in, fan_out = modules[module]
        expected = [rank, fan_in] if side == "A" else [fan_out, rank]
        if list(info["shape"]) != expected:
            raise InvalidArtifact(
                weights,
                f"{tensor} has shape {list(info['shape'])}, expected {expected} (r={rank}; {base.model_id} hidden_size={config['hidden_size']})",
            )
        seen.add((layer, module, side))
    if not seen:
        raise InvalidArtifact(weights, "holds no LoRA tensors")
    for layer, module, side in sorted(seen):
        if (layer, module, "B" if side == "A" else "A") not in seen:
            raise InvalidArtifact(weights, f"layer {layer} {module} has lora_{side} but no lora_{'B' if side == 'A' else 'A'}")

    cfg.update(base_model_name_or_path=base.repo, revision=base.revision)
    (root / name).write_text(json.dumps(cfg, indent=2, sort_keys=True) + "\n")
    return {"kind": "lora", "rank": rank, "alpha": alpha, "target_modules": sorted(targets)}


def _hidden_size(file: str, value: Any, config: dict[str, Any], base: ResolvedModel) -> None:
    if value != config.get("hidden_size"):
        raise InvalidArtifact(file, f"hidden size is {value!r}, but {base.model_id} has hidden_size {config.get('hidden_size')}")


def _check_base_fields(root: Path, file: str, base: ResolvedModel) -> dict[str, Any]:
    """A JSON config carrying base_model_repo/base_model_revision, normalized to ``base``."""
    cfg = _json(root, file)
    declared = str(cfg.get("base_model_repo") or base.repo)
    if declared.lower() not in {base.repo.lower(), base.model_id.lower()}:
        raise InvalidArtifact(file, f"base_model_repo is {declared!r}, expected {base.repo!r} (the base {base.model_id})")
    cfg.update(base_model=base.model_id, base_model_repo=base.repo, base_model_revision=base.revision)
    (root / file).write_text(json.dumps(cfg, indent=2, sort_keys=True) + "\n")
    return cfg


def check_format(fmt: str, root: Path, base: ResolvedModel, config: dict[str, Any]) -> dict[str, Any]:
    """Format-specific checks against the base; returns extra manifest fields."""
    if fmt == "peft_lora":
        return {"adapter": check_lora(root, base, config)}
    if fmt == "cartridge":
        file = "cartridge.safetensors"
        header = safetensors(root, file)
        meta = header.get("__metadata__") or {}
        embeddings, slots = header.get("embeddings"), header.get("slot_token_ids")
        if not embeddings or not slots or len(embeddings["shape"]) != 2:
            raise InvalidArtifact(file, "needs an 'embeddings' [K, hidden_size] and a 'slot_token_ids' [K] tensor")
        tokens, width = embeddings["shape"]
        _hidden_size(file, width, config, base)
        if slots["shape"] != [tokens] or str(meta.get("num_tokens")) != str(tokens) or str(meta.get("hidden_size")) != str(width):
            raise InvalidArtifact(file, f"embeddings hold {tokens} slots of width {width}, but slot_token_ids or the metadata disagree")
        if str(meta.get("base_model", "")).lower() not in {base.repo.lower(), base.model_id.lower()}:
            raise InvalidArtifact(file, f"metadata base_model is {meta.get('base_model')!r}, expected {base.repo!r}")
        return {"thinking": "auto"}
    if fmt in ("merged_safetensors", "encoder_safetensors"):
        model = _json(root, "config.json")
        for key in ("model_type", "hidden_size", "num_hidden_layers"):
            if model.get(key) != config.get(key):
                raise InvalidArtifact("config.json", f"{key} is {model.get(key)!r}, but {base.model_id} has {config.get(key)!r}")
        shards = sorted(p.name for p in root.glob("*.safetensors"))
        if not shards:
            raise InvalidArtifact("model.safetensors", "missing")
        for shard in shards:
            safetensors(root, shard)
        if fmt == "encoder_safetensors":
            embedding = _check_base_fields(root, "grad_embedding.json", base)
            _hidden_size("grad_embedding.json", embedding.get("dimensions"), config, base)
        return {}
    # router_bundle, decision_bundle, reward_bundle: the backbone fields, the heads and the adapter.
    file = artifact_formats.CONFIG_FILES[fmt]
    cfg = _check_base_fields(root, file, base)
    _hidden_size(file, cfg.get("hidden_size"), config, base)
    head_file = str(cfg.get("head_file") or "")
    expected_head = next(f for f in FORMAT_FILES[fmt] if f.endswith("_head.safetensors"))
    if head_file != expected_head:
        raise InvalidArtifact(file, f"head_file must be {expected_head!r}, not {head_file!r}")
    for tensor, info in safetensors(root, head_file).items():
        if tensor != "__metadata__" and len(info["shape"]) == 2 and info["shape"][1] != cfg["hidden_size"]:
            raise InvalidArtifact(head_file, f"{tensor} has width {info['shape'][1]}, expected hidden_size {cfg['hidden_size']}")
    adapter = cfg.get("adapter") or {}
    if adapter.get("kind") == "lora":
        checked = check_lora(root, base, config)
        if (checked["rank"], checked["alpha"]) != (adapter.get("rank"), adapter.get("alpha")):
            raise InvalidArtifact(file, f"adapter rank/alpha {adapter.get('rank')}/{adapter.get('alpha')} don't match adapter_config.json ({checked['rank']}/{checked['alpha']})")
    return {"adapter": adapter}


# --------------------------------------------------------------------------- run


def refuse_pickles(fmt: str, names: list[str]) -> None:
    """A required ``.safetensors`` file sent as pickle weights (``adapter_model.bin``) is refused by name."""
    present = set(names)
    for wanted in FORMAT_FILES[fmt]:
        if not wanted.endswith(".safetensors") or "*" in wanted or wanted in present:
            continue
        stem = wanted[: -len(".safetensors")]
        pickle = next((stem + ext for ext in _PICKLES if stem + ext in present), None)
        if pickle:
            raise InvalidArtifact(pickle, f"pickle weights are refused; save them as {wanted} (safe_serialization=True)")


def _keep_files(root: Path, fmt: str) -> None:
    """Drop everything the format doesn't list (READMEs, optimizer state, an old manifest.json)."""
    patterns = FORMAT_FILES[fmt]
    for path in sorted(root.rglob("*"), reverse=True):
        rel = path.relative_to(root).as_posix()
        if path.is_dir():
            if not any(path.iterdir()):
                path.rmdir()
            continue
        if rel in RESERVED or not any(matches(rel, p) for p in patterns):
            path.unlink()


def run(spec: dict[str, Any], *, workdir: Path, download: Callable[[str, Path], None]) -> BundleInfo:
    """Fetch, validate and bundle one artifact import; raises InvalidArtifact or SourceUnavailableError."""
    fmt = str(spec["format"])
    if fmt not in FORMAT_FILES:
        raise InvalidArtifact("format", f"{fmt!r} is not an importable format ({', '.join(FORMAT_FILES)})")
    source = dict(spec.get("source") or {})
    provenance = {k: v for k, v in dict(spec.get("provenance") or {}).items() if v is not None}
    payload = workdir / "payload"
    if source.get("kind") == "upload":
        archive = workdir / "upload"
        download(str(source["download_url"]), archive)
        extract_upload(archive, payload)
        archive.unlink(missing_ok=True)
        refuse_pickles(fmt, [p.relative_to(payload).as_posix() for p in payload.rglob("*") if p.is_file()])
    elif source.get("kind") == "hf":
        payload.mkdir(parents=True)
        repo = str(source["repo"])
        commit, listed = hf_snapshot(repo, source.get("revision"), source.get("token"), payload, FORMAT_FILES[fmt])
        refuse_pickles(fmt, listed)
        provenance = {"source": "import", "uri": f"hf://{repo}@{commit}"}
    else:
        raise SourceUnavailableError(f"Unknown artifact import source {source.get('kind')!r}.")

    try:
        base, config = resolve_config(str(spec["base_model"]))
    except ModelUnavailableError as exc:
        raise SourceUnavailableError(str(exc)) from exc
    _keep_files(payload, fmt)
    try:
        extra = check_format(fmt, payload, base, config)
    except (KeyError, TypeError, AttributeError, IndexError, RecursionError) as exc:
        # A value of the wrong type somewhere in the tenant's files: their 422, not a worker crash.
        raise InvalidArtifact(artifact_formats.CONFIG_FILES.get(fmt, "upload"), f"malformed ({type(exc).__name__}: {exc})") from exc
    manifest = {
        "kind": "final",
        "format": fmt,
        "recipe_kind": RECIPE_KINDS[fmt],
        "base_model": base.model_id,
        "base_model_repo": base.repo,
        "base_model_revision": base.revision,
        "deployable": True,
        "provenance": provenance,
        **({"test_only": True} if base.source == "dev" else {}),
        **extra,
    }
    try:
        return bundle_directory(payload, workdir / "artifact.grad.tar.gz", manifest=manifest)
    except ValueError as exc:
        # The format's JSON Schema (config file or manifest): name the file it reports.
        message = str(exc)
        file = message.split(" ", 1)[0] if " does not match " in message else artifact_formats.CONFIG_FILES.get(fmt, "manifest.json")
        raise InvalidArtifact(file, message.split(" ", 1)[1] if message.startswith(file) else message) from exc
