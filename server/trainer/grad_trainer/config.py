"""Parse and validate the server's resolved run config into a typed ``TrainSpec``.

The server resolves ``"auto"`` values in ``runs.plan`` (see ``server/api/src/planner.ts``).
The trainer still accepts ``lr="auto"`` and applies the documented per-recipe defaults so a
config written by hand behaves like the docs say.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Mapping

from .errors import RecipeConfigError

# Documented defaults (reference/training-parameters.mdx, "Typical resolved learning rates").
DEFAULT_LR: dict[str, float] = {
    "sft": 5e-4,
    "dpo": 2e-5,
    "router": 5e-4,
    "decision": 3e-4,
    "cartridge": 1e-2,
    "embedding": 2e-5,
}
DEFAULT_BATCH_SIZE = 128
DEFAULT_EVAL_FRACTION: dict[str, float] = {"router": 0.15, "decision": 0.15}
DEFAULT_MODEL: dict[str, str] = {
    "router": "qwen/qwen3-0.6b",
    "decision": "gradiated/linden-1",
    "embedding": "baai/bge-small-en-v1.5",
}

_SCHEDULES = ("linear", "cosine", "constant")
_SPLITS = ("by_session", "by_group", "random")


@dataclass(frozen=True)
class OptimizerSpec:
    betas: tuple[float, float] = (0.9, 0.95)
    weight_decay: float = 0.0
    grad_clip: float = 1.0
    eps: float = 1e-8


@dataclass(frozen=True)
class SplitSpec:
    strategy: str = "by_session"
    eval_fraction: float = 0.1
    seed: int = 42


@dataclass(frozen=True)
class TrainSpec:
    kind: str
    name: str
    model: str
    lr: float
    lr_source: str
    batch_size: int
    epochs: int
    schedule: str
    warmup: float
    select: str
    checkpoint_every: int | None
    eval_every: int | None
    seed: int
    split: SplitSpec
    optimizer: OptimizerSpec
    train_on: str
    thinking: str
    preserve_thinking: bool
    reduction: str
    max_seq_len: int | None
    micro_batch_tokens: int
    adapter: dict[str, Any]
    params: dict[str, Any]
    template_revision: str | None
    rule_version: str
    base_artifact_id: str | None = None
    raw: dict[str, Any] = field(repr=False, default_factory=dict)

    def fingerprint(self) -> dict[str, Any]:
        """Fields that must match between a checkpoint and the run resuming from it."""
        return {
            "kind": self.kind,
            "model": self.model,
            "batch_size": self.batch_size,
            "epochs": self.epochs,
            "seed": self.seed,
            "split": [self.split.strategy, self.split.eval_fraction, self.split.seed],
            "adapter": self.adapter,
            "base_artifact": self.base_artifact_id,
        }


def _num(value: Any, name: str, *, minimum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RecipeConfigError(f"'{name}' must be a number, got {value!r}.")
    if not math.isfinite(value) or (minimum is not None and value < minimum):
        raise RecipeConfigError(f"'{name}' must be >= {minimum}, got {value!r}.")
    return float(value)


def _int(value: Any, name: str, *, minimum: int = 1) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise RecipeConfigError(f"'{name}' must be an integer >= {minimum}, got {value!r}.")
    return value


def _choice(value: Any, name: str, options: tuple[str, ...]) -> str:
    if value not in options:
        raise RecipeConfigError(f"'{name}' must be one of {list(options)}, got {value!r}.")
    return str(value)


def _optional_int(config: Mapping[str, Any], key: str) -> int | None:
    value = config.get(key)
    if value is None or value == "auto":
        return None
    return _int(value, key)


def _optimizer(raw: Any) -> OptimizerSpec:
    if raw is None:
        return OptimizerSpec()
    if not isinstance(raw, Mapping):
        raise RecipeConfigError("'optimizer' must be an object.")
    kind = str(raw.get("kind", raw.get("type", "adamw"))).lower()
    if kind != "adamw":
        raise RecipeConfigError(f"Unsupported optimizer '{kind}'; v0 recipes use AdamW.")
    betas = raw.get("betas", (0.9, 0.95))
    if not isinstance(betas, (list, tuple)) or len(betas) != 2:
        raise RecipeConfigError("'optimizer.betas' must be a pair of numbers.")
    return OptimizerSpec(
        betas=(_num(betas[0], "betas[0]", minimum=0), _num(betas[1], "betas[1]", minimum=0)),
        weight_decay=_num(raw.get("weight_decay", 0.0), "weight_decay", minimum=0),
        grad_clip=_num(raw.get("grad_clip", 1.0), "grad_clip", minimum=0),
        eps=_num(raw.get("eps", 1e-8), "eps", minimum=0),
    )


def resolve_lr(kind: str, config: Mapping[str, Any], batch_size: int) -> tuple[float, str]:
    lr = config.get("lr", "auto")
    scale = _num(config.get("lr_scale", 1.0), "lr_scale", minimum=0)
    if lr == "auto" or lr is None:
        base = DEFAULT_LR[kind]
        value = base * math.sqrt(batch_size / DEFAULT_BATCH_SIZE) * scale
        return value, f"auto: {base:g} at batch {DEFAULT_BATCH_SIZE}, sqrt-scaled to {batch_size}"
    value = _num(lr, "lr", minimum=0)
    if value <= 0:
        raise RecipeConfigError("'lr' must be positive.")
    # The server already folded lr_scale into a resolved numeric lr.
    return value, str(config.get("lr_source", "explicit"))


def parse_train_spec(kind: str, config: Mapping[str, Any]) -> TrainSpec:
    if not isinstance(config, Mapping):
        raise RecipeConfigError("Run config must be an object.")
    if kind not in DEFAULT_LR:
        raise RecipeConfigError(f"Unknown recipe kind '{kind}'.")

    model = str(config.get("model") or DEFAULT_MODEL.get(kind, "qwen/qwen3-8b")).strip()
    batch_size = _int(config.get("batch_size", DEFAULT_BATCH_SIZE), "batch_size")
    lr, lr_source = resolve_lr(kind, config, batch_size)

    split_raw = config.get("split") or {}
    if not isinstance(split_raw, Mapping):
        raise RecipeConfigError("'split' must be an object.")
    eval_fraction = split_raw.get("eval_fraction")
    split = SplitSpec(
        strategy=_choice(split_raw.get("strategy", "by_session"), "split.strategy", _SPLITS),
        eval_fraction=(
            DEFAULT_EVAL_FRACTION.get(kind, 0.1)
            if eval_fraction is None
            else _num(eval_fraction, "split.eval_fraction", minimum=0)
        ),
        seed=int(split_raw.get("seed", 42)),
    )
    if split.eval_fraction > 0.5:
        raise RecipeConfigError("'split.eval_fraction' must be <= 0.5.")

    adapter = dict(config.get("adapter") or {})
    base = config.get("base_artifact")
    if base is not None and (not isinstance(base, Mapping) or not isinstance(base.get("id"), str)):
        raise RecipeConfigError("'base_artifact' must be an object with an 'id'.")
    params = dict(config.get("recipe_params") or {})
    max_seq_len = config.get("max_seq_len")

    return TrainSpec(
        kind=kind,
        name=str(config.get("name") or kind),
        model=model,
        lr=lr,
        lr_source=lr_source,
        batch_size=batch_size,
        epochs=_int(config.get("epochs", 1), "epochs"),
        schedule=_choice(config.get("schedule", "linear"), "schedule", _SCHEDULES),
        warmup=_num(config.get("warmup", 0.03), "warmup", minimum=0),
        select=_choice(config.get("select", "best"), "select", ("best", "last")),
        checkpoint_every=_optional_int(config, "checkpoint_every_steps"),
        eval_every=_optional_int(config, "eval_every_steps"),
        seed=int(config.get("seed", split.seed)),
        split=split,
        optimizer=_optimizer(config.get("optimizer")),
        train_on=_choice(config.get("train_on", "last"), "train_on", ("last", "all_assistant")),
        thinking=str(config.get("thinking", "auto")),
        preserve_thinking=bool(config.get("preserve_thinking", False)),
        reduction=_choice(
            config.get("reduction", "per_example"), "reduction", ("per_example", "per_token")
        ),
        max_seq_len=None if max_seq_len is None else _int(max_seq_len, "max_seq_len", minimum=8),
        micro_batch_tokens=_int(config.get("micro_batch_tokens", 16384), "micro_batch_tokens", minimum=8),
        adapter=adapter,
        params=params,
        template_revision=config.get("template_revision"),
        rule_version=str(config.get("rule_version", "auto@1")),
        base_artifact_id=None if base is None else str(base["id"]),
        raw=dict(config),
    )


def lr_multiplier(step: int, total_steps: int, *, schedule: str, warmup: float) -> float:
    """LR multiplier for 0-indexed optimizer ``step``: warmup, then decay to zero.

    Warmup is linear over ``round(total_steps * warmup)`` steps. After warmup, ``linear``
    and ``cosine`` decay so the multiplier reaches 0 at ``step == total_steps``.
    """
    total = max(1, total_steps)
    warmup_steps = int(round(total * warmup))
    if warmup_steps > 0 and step < warmup_steps:
        return (step + 1) / warmup_steps
    if schedule == "constant":
        return 1.0
    progress = (step - warmup_steps) / max(1, total - warmup_steps)
    progress = min(1.0, max(0.0, progress))
    if schedule == "cosine":
        return 0.5 * (1.0 + math.cos(math.pi * progress))
    return 1.0 - progress
