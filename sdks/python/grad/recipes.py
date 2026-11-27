"""Typed training recipes (6 v0 recipes + forward-compatible Wave 2 definitions)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Sequence

from .types import Context


@dataclass
class _BaseRecipe:
    model: str | None = None
    adapter: dict[str, Any] | None = None
    lr: float | Literal["auto"] = "auto"
    lr_scale: float = 1.0
    batch_size: int | None = None
    epochs: int = 1
    schedule: Literal["linear", "cosine", "constant"] = "linear"
    warmup: float = 0.03
    train_on: Literal["last", "all_assistant"] = "last"
    thinking: Literal["auto", "on", "off"] = "auto"
    preserve_thinking: bool = False
    reduction: Literal["per_example", "per_token"] = "per_example"
    select: Literal["best", "last"] = "best"
    checkpoint_ttl_days: int = 30

    def _base_dict(self, kind: str) -> dict[str, Any]:
        out: dict[str, Any] = {
            "kind": kind,
            "lr": self.lr,
            "lr_scale": self.lr_scale,
            "epochs": self.epochs,
            "schedule": self.schedule,
            "warmup": self.warmup,
            "train_on": self.train_on,
            "thinking": self.thinking,
            "preserve_thinking": self.preserve_thinking,
            "reduction": self.reduction,
            "select": self.select,
            "checkpoint_ttl_days": self.checkpoint_ttl_days,
        }
        if self.model is not None:
            out["model"] = self.model
        if self.adapter is not None:
            out["adapter"] = self.adapter
        if self.batch_size is not None:
            out["batch_size"] = self.batch_size
        return out


@dataclass
class SFTRecipe(_BaseRecipe):
    """Supervised Fine-Tuning with LoRA."""

    def to_spec(self) -> dict[str, Any]:
        return self._base_dict("sft")


@dataclass
class DPORecipe(_BaseRecipe):
    """Direct Preference Optimization with LoRA."""

    beta: float = 0.1

    def to_spec(self) -> dict[str, Any]:
        out = self._base_dict("dpo")
        out["beta"] = self.beta
        return out


@dataclass
class RouterRecipe(_BaseRecipe):
    """Model Router with calibrated Pareto threshold selection."""

    models: Sequence[str] = ("qwen/qwen3-8b", "qwen/qwen3-32b")
    max_quality_drop: float = 0.02

    def to_spec(self) -> dict[str, Any]:
        out = self._base_dict("router")
        out["models"] = list(self.models)
        out["max_quality_drop"] = self.max_quality_drop
        return out


@dataclass
class DecisionModelRecipe(_BaseRecipe):
    """Multi-head calibrated decision model."""

    def to_spec(self) -> dict[str, Any]:
        return self._base_dict("decision")


@dataclass
class CartridgeRecipe(_BaseRecipe):
    """PrefixKV Cartridge exporting gradiated.cartridge/1 safetensors."""

    context: Context | str | None = None
    num_tokens: int = 256

    def to_spec(self) -> dict[str, Any]:
        out = self._base_dict("cartridge")
        out["num_tokens"] = self.num_tokens
        if isinstance(self.context, str):
            out["context_text"] = self.context
        elif isinstance(self.context, Context):
            if self.context.text is not None:
                out["context_text"] = self.context.text
            if self.context.uri is not None:
                out["context_uri"] = self.context.uri
        return out


@dataclass
class EmbeddingRecipe(_BaseRecipe):
    """Contrastive InfoNCE embedding fine-tuning on full encoder."""

    temp: float = 0.05

    def to_spec(self) -> dict[str, Any]:
        out = self._base_dict("embedding")
        out["temp"] = self.temp
        return out


# Wave 2 forward-compatible typed recipe definitions
@dataclass
class DistillRecipe(_BaseRecipe):
    teacher: str = "qwen/qwen3-32b"

    def to_spec(self) -> dict[str, Any]:
        out = self._base_dict("distill")
        out["teacher"] = self.teacher
        return out


@dataclass
class RewardModelRecipe(_BaseRecipe):
    def to_spec(self) -> dict[str, Any]:
        return self._base_dict("reward")


@dataclass
class GRPORecipe(_BaseRecipe):
    env_name: str | None = None
    group_size: int = 8

    def to_spec(self) -> dict[str, Any]:
        out = self._base_dict("grpo")
        if self.env_name:
            out["env_name"] = self.env_name
        out["group_size"] = self.group_size
        return out


def coerce_recipe(recipe: Any) -> dict[str, Any]:
    if isinstance(recipe, dict):
        return dict(recipe)
    if hasattr(recipe, "to_spec") and callable(recipe.to_spec):
        return recipe.to_spec()
    raise TypeError(
        f"Expected recipe object or dict, got {type(recipe).__name__}."
    )
