"""Shared torch/transformers/peft plumbing for the real recipes."""

from __future__ import annotations

import contextlib
import json
import os
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence

import torch
import torch.nn.functional as F
from safetensors.torch import load_file, save_file

from ..config import TrainSpec
from ..errors import RecipeConfigError
from ..models import ResolvedModel

DEFAULT_LORA_TARGETS = (
    "q_proj",
    "k_proj",
    "v_proj",
    "o_proj",
    "gate_proj",
    "up_proj",
    "down_proj",
)


def setup_torch(seed: int) -> None:
    threads = os.environ.get("GRAD_TORCH_THREADS")
    if threads:
        torch.set_num_threads(max(1, int(threads)))
    random.seed(seed)
    torch.manual_seed(seed)


def pick_device() -> torch.device:
    forced = os.environ.get("GRAD_TRAINER_DEVICE")
    if forced:
        return torch.device(forced)
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def pick_dtype(device: torch.device) -> torch.dtype:
    if device.type == "cuda" and torch.cuda.is_bf16_supported():
        return torch.bfloat16
    return torch.float32


def autocast(device: torch.device) -> Any:
    """bf16 autocast on CUDA (fp32 master weights stay fp32); a no-op on CPU."""
    if device.type == "cuda" and torch.cuda.is_bf16_supported():
        return torch.autocast(device_type="cuda", dtype=torch.bfloat16)
    return contextlib.nullcontext()


def library_versions() -> dict[str, str]:
    import peft
    import transformers

    return {"torch": torch.__version__, "transformers": transformers.__version__, "peft": peft.__version__}


def load_tokenizer(resolved: ResolvedModel) -> Any:
    from transformers import AutoTokenizer

    tok = AutoTokenizer.from_pretrained(str(resolved.path))
    if tok.pad_token_id is None:
        tok.pad_token = tok.eos_token
    return tok


def load_causal_lm(resolved: ResolvedModel, device: torch.device) -> Any:
    from transformers import AutoModelForCausalLM

    model = AutoModelForCausalLM.from_pretrained(
        str(resolved.path), dtype=pick_dtype(device), attn_implementation="sdpa"
    )
    model.config.use_cache = False
    return model.to(device)


def model_max_len(model: Any, spec: TrainSpec, cap: int = 8192) -> int:
    limit = int(getattr(model.config, "max_position_embeddings", cap) or cap)
    return min(spec.max_seq_len or min(limit, cap), limit)


def lora_settings(adapter: dict[str, Any]) -> dict[str, Any]:
    kind = adapter.get("kind", "lora")
    if kind != "lora":
        raise RecipeConfigError(f"This recipe trains LoRA adapters; adapter kind '{kind}' is not supported.")
    rank = int(adapter.get("rank", 32))
    alpha = int(adapter.get("alpha", 32))
    if rank < 1 or alpha < 1:
        raise RecipeConfigError("LoRA rank and alpha must be positive.")
    targets = adapter.get("target_modules") or list(DEFAULT_LORA_TARGETS)
    return {"rank": rank, "alpha": alpha, "target_modules": sorted(str(t) for t in targets)}


def _enable_gradient_checkpointing(model: Any) -> None:
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.enable_input_require_grads()


def apply_lora(model: Any, adapter: dict[str, Any], gradient_checkpointing: bool = False) -> Any:
    from peft import LoraConfig, get_peft_model

    settings = lora_settings(adapter)
    present = {name.rsplit(".", 1)[-1] for name, _ in model.named_modules()}
    missing = [t for t in settings["target_modules"] if t not in present]
    if missing:
        raise RecipeConfigError(f"LoRA target modules not found in the base model: {missing}.")
    config = LoraConfig(
        r=settings["rank"],
        lora_alpha=settings["alpha"],
        target_modules=settings["target_modules"],
        lora_dropout=0.0,
        bias="none",
        task_type="CAUSAL_LM",
    )
    if gradient_checkpointing:
        _enable_gradient_checkpointing(model)
    return get_peft_model(model, config)


def load_lora(
    model: Any, adapter_dir: Path, adapter: dict[str, Any], resolved: ResolvedModel, gradient_checkpointing: bool = False
) -> tuple[Any, dict[str, Any]]:
    """Continued training: load a saved PEFT LoRA adapter onto its base model, trainable.

    Returns the model and the adapter's LoRA settings (rank, alpha and target modules).
    """
    from peft import PeftModel

    try:
        config = json.loads((adapter_dir / "adapter_config.json").read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise RecipeConfigError("The starting artifact has no readable adapter_config.json.") from exc
    expected = lora_settings(adapter)
    if config.get("peft_type") != "LORA" or (config.get("r"), config.get("lora_alpha")) != (
        expected["rank"],
        expected["alpha"],
    ):
        raise RecipeConfigError(
            f"The starting artifact is not a LoRA adapter with rank {expected['rank']} and alpha {expected['alpha']}."
        )
    if config.get("base_model_name_or_path") != resolved.repo:
        raise RecipeConfigError(
            f"The starting adapter was trained on '{config.get('base_model_name_or_path')}', not '{resolved.repo}'."
        )
    if gradient_checkpointing:
        _enable_gradient_checkpointing(model)
    peft_model = PeftModel.from_pretrained(model, str(adapter_dir), is_trainable=True)
    return peft_model, {**expected, "target_modules": sorted(config.get("target_modules") or [])}


def use_gradient_checkpointing(spec: TrainSpec, device: torch.device) -> bool:
    value = spec.raw.get("gradient_checkpointing", "auto")
    if value == "auto":
        return device.type == "cuda"
    return bool(value)


def base_causal_lm(model: Any) -> Any:
    """The transformers CausalLM inside a PeftModel (LoRA layers are injected in place)."""
    return model.get_base_model() if hasattr(model, "get_base_model") else model


def trainable_named(module: torch.nn.Module) -> dict[str, torch.nn.Parameter]:
    return {n: p for n, p in module.named_parameters() if p.requires_grad}


def save_named(params: dict[str, torch.Tensor], directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    save_file({n: t.detach().to("cpu").contiguous() for n, t in params.items()}, str(directory / "weights.safetensors"))


def load_named(params: dict[str, torch.nn.Parameter], directory: Path) -> None:
    loaded = load_file(str(directory / "weights.safetensors"))
    if set(loaded) != set(params):
        raise RecipeConfigError("Saved weights don't match this model's trainable parameters.")
    with torch.no_grad():
        for name, param in params.items():
            param.copy_(loaded[name].to(param.device, param.dtype))


def make_optimizer(params: Iterable[torch.nn.Parameter], spec: TrainSpec) -> torch.optim.Optimizer:
    opt = spec.optimizer
    return torch.optim.AdamW(
        list(params), lr=spec.lr, betas=opt.betas, weight_decay=opt.weight_decay, eps=opt.eps
    )


def optimizer_step(
    optimizer: torch.optim.Optimizer, params: Sequence[torch.nn.Parameter], lr: float, grad_clip: float
) -> float:
    grads = [p for p in params if p.grad is not None]
    if grad_clip > 0:
        norm = torch.nn.utils.clip_grad_norm_(grads, grad_clip)
    else:
        norm = torch.norm(torch.stack([g.grad.detach().norm() for g in grads])) if grads else torch.tensor(0.0)
    for group in optimizer.param_groups:
        group["lr"] = lr
    optimizer.step()
    optimizer.zero_grad(set_to_none=True)
    return float(norm)


def rng_state() -> dict[str, Any]:
    state: dict[str, Any] = {"torch": torch.get_rng_state(), "python": random.getstate()}
    if torch.cuda.is_available():
        state["cuda"] = torch.cuda.get_rng_state_all()
    return state


def set_rng_state(state: dict[str, Any]) -> None:
    torch.set_rng_state(state["torch"])
    random.setstate(state["python"])
    if "cuda" in state and torch.cuda.is_available():
        torch.cuda.set_rng_state_all(state["cuda"])


def save_optimizer_state(optimizer: torch.optim.Optimizer, directory: Path, extra: dict[str, Any] | None = None) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    torch.save({"optimizer": optimizer.state_dict(), "rng": rng_state(), "extra": extra or {}}, directory / "state.pt")


def load_optimizer_state(optimizer: torch.optim.Optimizer, directory: Path) -> dict[str, Any]:
    state = torch.load(directory / "state.pt", map_location="cpu", weights_only=True)
    optimizer.load_state_dict(state["optimizer"])
    set_rng_state(state["rng"])
    return state.get("extra", {})


def export_peft_adapter(model: Any, directory: Path, resolved: ResolvedModel) -> dict[str, Any]:
    """Save a PEFT LoRA adapter whose config points at the HF base model (for PEFT and vLLM)."""
    directory.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(directory), safe_serialization=True)
    (directory / "README.md").unlink(missing_ok=True)
    config_path = directory / "adapter_config.json"
    config = json.loads(config_path.read_text())
    config["base_model_name_or_path"] = resolved.repo
    config["revision"] = resolved.revision
    config["target_modules"] = sorted(config.get("target_modules") or [])
    config["task_type"] = "CAUSAL_LM"
    config_path.write_text(json.dumps(config, indent=2, sort_keys=True))
    return {
        "kind": "lora",
        "rank": config["r"],
        "alpha": config["lora_alpha"],
        "target_modules": config["target_modules"],
    }


def export_merged(model: Any, tokenizer: Any, directory: Path, resolved: ResolvedModel) -> None:
    """Merge LoRA into the base weights and save standalone safetensors (destroys the adapter)."""
    directory.mkdir(parents=True, exist_ok=True)
    merged = model.merge_and_unload()
    declared = getattr(merged.config, "dtype", None) or getattr(merged.config, "torch_dtype", None)
    if declared in (torch.bfloat16, torch.float16, "bfloat16", "float16"):
        merged = merged.to(getattr(torch, str(declared).replace("torch.", "")))
    merged.config.use_cache = True
    merged.save_pretrained(str(directory), safe_serialization=True, max_shard_size="5GB")
    tokenizer.save_pretrained(str(directory))


# -- packing --------------------------------------------------------------------------------


@dataclass(frozen=True)
class PackedBatch:
    input_ids: torch.Tensor  # [R, L]
    attention_mask: torch.Tensor  # [R, 1, L, L] bool, block-diagonal causal
    position_ids: torch.Tensor  # [R, L]
    segment_ids: torch.Tensor  # [R, L], -1 for padding
    trained: torch.Tensor  # [R, L] bool
    tokens: int  # non-padding tokens


def pack_rows(lengths: Sequence[int], max_len: int) -> list[list[int]]:
    """First-fit-decreasing packing of example indices into rows of at most ``max_len`` tokens."""
    order = sorted(range(len(lengths)), key=lambda i: (-lengths[i], i))
    rows: list[list[int]] = []
    room: list[int] = []
    for i in order:
        for r, free in enumerate(room):
            if lengths[i] <= free:
                rows[r].append(i)
                room[r] -= lengths[i]
                break
        else:
            rows.append([i])
            room.append(max_len - lengths[i])
    return rows


def group_rows(rows: list[list[int]], lengths: Sequence[int], max_tokens: int) -> list[list[list[int]]]:
    """Group packed rows into micro-batches whose padded size stays within ``max_tokens``."""
    groups: list[list[list[int]]] = []
    current: list[list[int]] = []
    width = 0
    for row in rows:
        row_len = sum(lengths[i] for i in row)
        new_width = max(width, row_len)
        if current and new_width * (len(current) + 1) > max_tokens:
            groups.append(current)
            current, new_width = [], row_len
        current.append(row)
        width = new_width
    if current:
        groups.append(current)
    return groups


def collate_packed(
    rows: list[list[int]],
    examples: Sequence[tuple[Sequence[int], Sequence[bool]]],
    pad_id: int,
    device: torch.device,
    segment_offset: dict[int, int] | None = None,
) -> PackedBatch:
    """Build tensors for packed rows. Each example only attends to itself (no leakage)."""
    width = max(sum(len(examples[i][0]) for i in row) for row in rows)
    n = len(rows)
    ids = torch.full((n, width), pad_id, dtype=torch.long)
    pos = torch.zeros((n, width), dtype=torch.long)
    seg = torch.full((n, width), -1, dtype=torch.long)
    trained = torch.zeros((n, width), dtype=torch.bool)
    tokens = 0
    for r, row in enumerate(rows):
        cursor = 0
        for i in row:
            tok, mask = examples[i]
            length = len(tok)
            ids[r, cursor : cursor + length] = torch.tensor(tok, dtype=torch.long)
            pos[r, cursor : cursor + length] = torch.arange(length)
            seg[r, cursor : cursor + length] = i if segment_offset is None else segment_offset[i]
            trained[r, cursor : cursor + length] = torch.tensor(mask, dtype=torch.bool)
            cursor += length
            tokens += length
    causal = torch.tril(torch.ones((width, width), dtype=torch.bool))
    same = (seg[:, :, None] == seg[:, None, :]) & (seg[:, :, None] >= 0)
    eye = torch.eye(width, dtype=torch.bool)[None]
    attn = (same & causal[None]) | eye  # padding attends to itself so no row is empty
    return PackedBatch(
        input_ids=ids.to(device),
        attention_mask=attn[:, None].to(device),
        position_ids=pos.to(device),
        segment_ids=seg.to(device),
        trained=trained.to(device),
        tokens=tokens,
    )


def packed_token_losses(lm: Any, batch: PackedBatch) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    """Next-token CE at trained positions. Returns (losses [N], segment ids [N], correct [N]).

    The LM head runs only on positions whose next token is trained, which keeps memory low
    for large vocabularies.
    """
    hidden = lm.model(
        input_ids=batch.input_ids,
        attention_mask=batch.attention_mask,
        position_ids=batch.position_ids,
    ).last_hidden_state
    seg = batch.segment_ids
    target_mask = batch.trained[:, 1:] & (seg[:, 1:] == seg[:, :-1])
    h = hidden[:, :-1][target_mask]
    targets = batch.input_ids[:, 1:][target_mask]
    logits = lm.lm_head(h).float()
    losses = F.cross_entropy(logits, targets, reduction="none")
    correct = (logits.argmax(-1) == targets).float()
    return losses, seg[:, 1:][target_mask], correct


def padded_batch(
    sequences: Sequence[Sequence[int]], pad_id: int, device: torch.device
) -> tuple[torch.Tensor, torch.Tensor]:
    width = max(len(s) for s in sequences)
    ids = torch.full((len(sequences), width), pad_id, dtype=torch.long)
    mask = torch.zeros((len(sequences), width), dtype=torch.long)
    for i, seq in enumerate(sequences):
        ids[i, : len(seq)] = torch.tensor(seq, dtype=torch.long)
        mask[i, : len(seq)] = 1
    return ids.to(device), mask.to(device)


def chunk_by_tokens(indices: Sequence[int], lengths: Sequence[int], max_tokens: int) -> list[list[int]]:
    """Consecutive micro-batches whose padded size (count * longest) stays within budget."""
    chunks: list[list[int]] = []
    current: list[int] = []
    longest = 0
    for i in indices:
        new_longest = max(longest, lengths[i])
        if current and new_longest * (len(current) + 1) > max_tokens:
            chunks.append(current)
            current, new_longest = [], lengths[i]
        current.append(i)
        longest = new_longest
    if current:
        chunks.append(current)
    return chunks


def last_token_pool(hidden: torch.Tensor, attention_mask: torch.Tensor) -> torch.Tensor:
    """Hidden state of the last non-padding token of each right-padded sequence."""
    last = attention_mask.sum(dim=1) - 1
    return hidden[torch.arange(hidden.shape[0], device=hidden.device), last]
