"""Training recipes: eight managed v0 recipes plus the typed Wave 2 ``GRPORecipe``.

Every recipe works with only ``model=`` (often not even that) and a dataset; anything
left unset takes the server's resolved default, which ``client.runs.plan(...)`` prints.
Only the fields you set are sent, so server-side default improvements reach old code.

Settings the docs describe but the v0 server contract (``RecipeSpec``) cannot carry yet
raise :class:`grad.NotAvailableInV0Error` when the recipe is built, instead of being
silently dropped. The Wave 2 ``GRPORecipe`` can be constructed with its documented fields,
and raises the same error from ``runs.plan`` / ``runs.create``.
"""

from __future__ import annotations

import difflib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, fields
from typing import Any, ClassVar, Literal

from ._errors import NotAvailableInV0Error
from ._generated.client import SCHEMA_FIELDS
from .records import Context
from .rubrics import coerce_rubric, model_ref
from .specs import AdamWSpec, AdapterSpec, LossSpec, PoolingSpec, SplitSpec, adapters

__all__ = [
    "CartridgeRecipe",
    "DPORecipe",
    "DecisionModelRecipe",
    "DistillRecipe",
    "EmbeddingRecipe",
    "GRPORecipe",
    "OffPolicy",
    "OnPolicy",
    "Recipe",
    "RewardModelRecipe",
    "RouterRecipe",
    "SFTRecipe",
    "V0_RECIPE_KINDS",
    "WAVE2_RECIPE_KINDS",
    "coerce_recipe",
]

V0_RECIPE_KINDS = ("sft", "dpo", "router", "decision", "cartridge", "embedding", "distill", "reward")
WAVE2_RECIPE_KINDS = ("grpo",)
RECIPE_FIELDS: frozenset[str] = SCHEMA_FIELDS["RecipeSpec"]

Thinking = Literal["auto", "on", "off"] | bool


def _dict_of(value: Any, what: str) -> dict[str, Any]:
    if isinstance(value, Mapping):
        return dict(value)
    to_dict = getattr(value, "to_dict", None)
    if callable(to_dict):
        return dict(to_dict())
    raise TypeError(f"{what} must be a spec object or a dict, got {type(value).__name__}.")


def _thinking(value: Any) -> Any:
    """The wire value: ``"auto"``, ``"on"`` or ``"off"`` (``True``/``False`` map to on/off)."""
    if isinstance(value, bool):
        return "on" if value else "off"
    if value is None or value in ("auto", "on", "off"):
        return value
    raise ValueError(f'thinking must be "auto", "on", "off" or a bool, got {value!r}.')


def _unsupported(recipe: str, setting: str, reason: str, alternative: str | None = None) -> NotAvailableInV0Error:
    return NotAvailableInV0Error(f"{recipe}({setting})", reason, alternative=alternative)


@dataclass(kw_only=True)
class Recipe:
    """Settings shared by every recipe (see the training parameters reference).

    Attributes:
        model: Base model id, or a previous :class:`grad.Artifact` to keep training its LoRA
            adapter (``SFTRecipe`` and ``DPORecipe``; DPO uses it as the reference model).
        adapter: ``adapters.LoRA(rank=32)`` by default.
        lr: ``"auto"`` (calibrated per model and objective) or a float.
        lr_scale: Multiplies the resolved ``lr``.
        optimizer: ``optim.AdamW(lr=, betas=, weight_decay=, grad_clip=)``.
        batch_size, epochs, schedule, warmup: Optimisation schedule.
        train_on: ``"last"`` or ``"all_assistant"``.
        thinking: ``"auto"``, ``"on"``/``True`` or ``"off"``/``False``.
        preserve_thinking: Keep earlier turns' reasoning in the prompt.
        reduction: ``"per_example"`` or ``"per_token"``.
        select: ``"best"`` or ``"last"`` checkpoint becomes ``run.artifact``.
        checkpoint_ttl_days: Retention of intermediate checkpoints.
        split: Train/eval split (``splits.BySession(0.10)`` by default); sent with the run.
        eval_every: ``"auto"`` (every 10% of steps) or a number of optimizer steps.
    """

    kind: ClassVar[str] = ""

    model: Any = None
    adapter: AdapterSpec | Mapping[str, Any] | None = None
    lr: float | Literal["auto"] | None = None
    lr_scale: float | None = None
    optimizer: AdamWSpec | Mapping[str, Any] | None = None
    batch_size: int | None = None
    epochs: int | None = None
    schedule: Literal["linear", "cosine", "constant"] | None = None
    warmup: float | None = None
    train_on: Literal["last", "all_assistant"] | None = None
    thinking: Thinking | None = None
    preserve_thinking: bool | None = None
    reduction: Literal["per_example", "per_token"] | None = None
    select: Literal["best", "last"] | None = None
    checkpoint_ttl_days: int | None = None
    split: SplitSpec | Mapping[str, Any] | None = None
    eval_every: Any = None

    def __post_init__(self) -> None:
        name = type(self).__name__
        if self.eval_every not in (None, "auto") and (
            isinstance(self.eval_every, bool) or not isinstance(self.eval_every, int) or self.eval_every < 1
        ):
            raise ValueError(f'{name}: eval_every must be "auto" or a positive number of steps, got {self.eval_every!r}.')
        self.thinking = _thinking(self.thinking)
        if self.optimizer is not None:
            opt = self.optimizer
            if isinstance(opt, Mapping):
                opt = AdamWSpec(
                    kind=str(opt.get("kind", "adamw")),
                    lr=opt.get("lr", "auto"),
                    betas=tuple(opt.get("betas", (0.9, 0.95))),
                    weight_decay=float(opt.get("weight_decay", 0.0)),
                    grad_clip=float(opt.get("grad_clip", 1.0)),
                )
            if not isinstance(opt, AdamWSpec) or opt.kind != "adamw":
                raise _unsupported(name, "optimizer=", "v0 recipes train with AdamW.")
            if opt.lr != "auto":
                if self.lr is not None and self.lr != opt.lr:
                    raise ValueError(f"{name}: lr={self.lr!r} conflicts with optimizer=AdamW(lr={opt.lr!r}).")
                self.lr = opt.lr  # type: ignore[assignment]
            self.optimizer = opt

    # ------------------------------------------------------------------ wire mapping

    def _common_spec(self) -> dict[str, Any]:
        out: dict[str, Any] = {"kind": self.kind}
        if self.model is not None:
            out["model"] = model_ref(self.model)
        if self.adapter is not None:
            out["adapter"] = _dict_of(self.adapter, "adapter")
        if isinstance(self.optimizer, AdamWSpec) and not self.optimizer.is_default:
            opt = self.optimizer
            out["optimizer"] = {"kind": "adamw", "betas": list(opt.betas), "weight_decay": opt.weight_decay, "grad_clip": opt.grad_clip}
        if self.eval_every not in (None, "auto"):
            out["eval_every"] = self.eval_every
        for key in (
            "lr",
            "lr_scale",
            "batch_size",
            "epochs",
            "schedule",
            "warmup",
            "train_on",
            "thinking",
            "preserve_thinking",
            "reduction",
            "select",
            "checkpoint_ttl_days",
        ):
            value = getattr(self, key)
            if value is not None:
                out[key] = value
        return out

    def _extra_spec(self) -> dict[str, Any]:
        return {}

    def to_spec(self) -> dict[str, Any]:
        """The ``RecipeSpec`` wire dict: ``kind`` plus every field you set."""
        return {**self._common_spec(), **self._extra_spec()}

    def request_split(self) -> dict[str, Any] | None:
        """The run-level ``split`` this recipe carries, if any."""
        return None if self.split is None else _dict_of(self.split, "split")


@dataclass(kw_only=True)
class SFTRecipe(Recipe):
    """Supervised fine-tuning with LoRA on chat records (trains the final assistant turn).

    Attributes:
        model: ``"qwen/qwen3-8b"`` by default.
        merge_on_export: Export standalone merged safetensors instead of a PEFT adapter.
        loss: ``losses.CrossEntropy(reduction=...)``.
    """

    kind: ClassVar[str] = "sft"
    merge_on_export: bool | None = None
    loss: LossSpec | Mapping[str, Any] | None = None

    def __post_init__(self) -> None:
        super().__post_init__()
        if self.loss is not None:
            loss = _dict_of(self.loss, "loss")
            if loss.get("kind") != "cross_entropy":
                raise _unsupported("SFTRecipe", "loss=", f"SFT trains with cross-entropy, got {loss.get('kind')!r}.")
            if loss.get("reduction") is not None:
                if self.reduction is not None and self.reduction != loss["reduction"]:
                    raise ValueError("SFTRecipe: reduction= conflicts with loss=CrossEntropy(reduction=...).")
                self.reduction = loss["reduction"]
        if self.merge_on_export is not None:
            adapter = _dict_of(self.adapter, "adapter") if self.adapter is not None else adapters.LoRA().to_dict()
            if adapter.get("kind") != "lora":
                raise ValueError("SFTRecipe(merge_on_export=...) applies to LoRA adapters only.")
            adapter["merge_on_export"] = bool(self.merge_on_export)
            self.adapter = adapter


@dataclass(kw_only=True)
class DPORecipe(Recipe):
    """Direct Preference Optimization on chosen/rejected pairs.

    Attributes:
        loss: ``losses.DPO(beta=0.1)`` by default; higher ``beta`` stays closer to the start.
        beta: Shorthand for ``loss=losses.DPO(beta=...)``.
    """

    kind: ClassVar[str] = "dpo"
    loss: LossSpec | Mapping[str, Any] | None = None
    beta: float | None = None

    def __post_init__(self) -> None:
        super().__post_init__()
        if self.loss is not None:
            if isinstance(self.loss, type) or (hasattr(self.loss, "compute") and not isinstance(self.loss, (Mapping, LossSpec))):
                raise _unsupported("DPORecipe", "loss=CustomLoss", "custom losses need the interactive Trainer API (Wave 2).")
            loss = _dict_of(self.loss, "loss")
            if loss.get("kind") != "dpo":
                raise _unsupported("DPORecipe", "loss=", f"the v0 DPO recipe trains with losses.DPO, got {loss.get('kind')!r}.")
            if loss.get("beta") is not None:
                if self.beta is not None and self.beta != loss["beta"]:
                    raise ValueError("DPORecipe: beta= conflicts with loss=losses.DPO(beta=...).")
                self.beta = float(loss["beta"])
        if self.beta is not None and self.beta <= 0:
            raise ValueError(f"DPO beta must be positive, got {self.beta}.")

    def _extra_spec(self) -> dict[str, Any]:
        return {} if self.beta is None else {"beta": self.beta}


@dataclass(kw_only=True)
class RouterRecipe(Recipe):
    """Learns which candidate model to call per request, within ``max_quality_drop`` of the best.

    Attributes:
        model: Router backbone, ``"qwen/qwen3-0.6b"`` by default.
        models: Candidate models; by default the models scored in your records.
        max_quality_drop: Quality the router may trade for cost (``0.02``).
        rubric: How quality is measured: a score name already on your records
            (``"task_success"``), or a ``Judge``/``Rubric`` of judges and validators, in which
            case the server replays your prompts against ``models`` and scores the answers
            (a labeling eval, billed as an eval) before training. Python functions need a
            sandbox, which is not available in v0.
        pricing: USD per request for each candidate (overrides ``metrics.cost_usd``).
        fallback: The candidate that gets every request the router doesn't offload
            (default: the best-scoring candidate).
    """

    kind: ClassVar[str] = "router"
    models: Sequence[Any] | None = None
    rubric: Any = None
    max_quality_drop: float | None = None
    pricing: Mapping[str, Any] | None = None
    fallback: Any = None

    def __post_init__(self) -> None:
        super().__post_init__()
        if self.rubric is not None and not isinstance(self.rubric, str):
            rubric = coerce_rubric(self.rubric)
            if rubric.local_scorers:
                raise _unsupported(
                    "RouterRecipe",
                    "rubric=Scorer(fn=...)",
                    "Python scorers in training recipes need a managed sandbox, which is deferred past v0.",
                    'Use a Judge or validators, or score your logs first and pass the score name: rubric="resolved".',
                )
            if self.models is None:
                raise ValueError("RouterRecipe(rubric=Judge/Rubric) replays your prompts against the candidates: pass models=[...].")
            self.rubric = rubric.to_wire_items()
        if self.pricing is not None:
            self.pricing = {model_ref(m): float(v) for m, v in self.pricing.items()}
            if any(v < 0 for v in self.pricing.values()):
                raise ValueError("RouterRecipe(pricing=...) needs non-negative USD per request.")
        if self.fallback is not None:
            self.fallback = model_ref(self.fallback)
        if self.models is not None:
            self.models = [model_ref(m) for m in self.models]
            if len(self.models) < 2:
                raise ValueError("RouterRecipe(models=...) needs at least two candidate models.")
        if self.max_quality_drop is not None and not 0.0 <= self.max_quality_drop <= 0.5:
            raise ValueError(f"max_quality_drop must be between 0 and 0.5, got {self.max_quality_drop}.")

    def _extra_spec(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.models is not None:
            out["models"] = list(self.models)
        for key in ("max_quality_drop", "rubric", "pricing", "fallback"):
            value = getattr(self, key)
            if value is not None:
                out[key] = value
        return out


@dataclass(kw_only=True)
class DecisionModelRecipe(Recipe):
    """Calibrated multi-head decision model (``choice`` / ``noul`` / ``score`` questions).

    Attributes:
        model: ``gradiated/linden-1``, chosen by the recipe.
        loss: Chosen per question type; overriding it is not available in v0.
        split: ``splits.BySession(0.15)`` by default.
    """

    kind: ClassVar[str] = "decision"
    loss: Any = None

    def __post_init__(self) -> None:
        super().__post_init__()
        if self.loss is not None:
            raise _unsupported("DecisionModelRecipe", "loss=", "the loss is chosen per question type by the recipe.")


@dataclass(kw_only=True)
class CartridgeRecipe(Recipe):
    """Compresses a long document into a trainable PrefixKV cartridge.

    Attributes:
        context: Required. ``Context.from_text(...)`` or ``Context.from_file(...)``
            (a plain string is read as text).
        num_tokens: Size of the prefix (``256``).
        teacher: The model reading the full context (the base model by default).
        loss: ``losses.TopKKLDistill(top_k=20)`` by default.
        max_new_tokens: Teacher answer length per prompt during distillation (``256``).
    """

    kind: ClassVar[str] = "cartridge"
    context: Context | str | None = None
    num_tokens: int | None = None
    teacher: Any = None
    loss: LossSpec | Mapping[str, Any] | None = None
    max_new_tokens: int | None = None

    def __post_init__(self) -> None:
        super().__post_init__()
        if self.context is None:
            raise ValueError("CartridgeRecipe needs context=: Context.from_file(path) or Context.from_text(...).")
        if isinstance(self.context, str):
            self.context = Context.from_text(self.context)
        if not isinstance(self.context, Context):
            raise TypeError(f"CartridgeRecipe context must be a Context or str, got {type(self.context).__name__}.")
        if self.loss is not None:
            loss = _dict_of(self.loss, "loss")
            if loss.get("kind") != "top_k_kl_distill":
                raise _unsupported("CartridgeRecipe", "loss=", f"the v0 cartridge recipe trains with losses.TopKKLDistill, got {loss.get('kind')!r}.")
        if self.num_tokens is not None and not 16 <= self.num_tokens <= 4096:
            raise ValueError(f"num_tokens must be between 16 and 4096, got {self.num_tokens}.")

    def _extra_spec(self) -> dict[str, Any]:
        assert isinstance(self.context, Context)
        out: dict[str, Any] = dict(self.context.to_recipe_fields())
        if self.num_tokens is not None:
            out["num_tokens"] = self.num_tokens
        if self.teacher is not None:
            out["teacher"] = model_ref(self.teacher)
        if self.loss is not None:
            out["loss"] = _dict_of(self.loss, "loss")
        if self.max_new_tokens is not None:
            out["max_new_tokens"] = self.max_new_tokens
        return out


@dataclass(kw_only=True)
class EmbeddingRecipe(Recipe):
    """Contrastive fine-tuning of a full embedding encoder on query/positive(/negatives) records.

    Attributes:
        model: ``baai/bge-small-en-v1.5``, chosen by the recipe.
        pool: ``pooling.Mean()`` (default) or ``pooling.CLS()``.
        loss: ``losses.InfoNCE(temp=0.05)``.
        temp: Shorthand for ``loss=losses.InfoNCE(temp=...)``.
    """

    kind: ClassVar[str] = "embedding"
    pool: PoolingSpec | Mapping[str, Any] | None = None
    loss: LossSpec | Mapping[str, Any] | None = None
    temp: float | None = None

    def __post_init__(self) -> None:
        super().__post_init__()
        if self._pool_kind() not in (None, "mean", "cls"):
            raise _unsupported("EmbeddingRecipe", "pool=", "the v0 server trains embeddings with mean or CLS pooling.", "Use pooling.Mean() or pooling.CLS().")
        if self.loss is not None:
            loss = _dict_of(self.loss, "loss")
            if loss.get("kind") != "infonce":
                raise _unsupported("EmbeddingRecipe", "loss=", f"the v0 embedding recipe trains with losses.InfoNCE, got {loss.get('kind')!r}.")
            if loss.get("temp") is not None:
                if self.temp is not None and self.temp != loss["temp"]:
                    raise ValueError("EmbeddingRecipe: temp= conflicts with loss=losses.InfoNCE(temp=...).")
                self.temp = float(loss["temp"])
        if self.temp is not None and self.temp <= 0:
            raise ValueError(f"InfoNCE temp must be positive, got {self.temp}.")

    def _extra_spec(self) -> dict[str, Any]:
        out: dict[str, Any] = {} if self.temp is None else {"temp": self.temp}
        if self._pool_kind() == "cls":
            out["pool"] = {"kind": "cls"}
        return out

    def _pool_kind(self) -> str | None:
        return None if self.pool is None else _dict_of(self.pool, "pool").get("kind")


@dataclass(frozen=True)
class OnPolicy:
    """Distillation rollouts: the student writes each answer and the teacher scores those tokens.

    Attributes:
        max_new_tokens: Length of each student answer; ``"auto"`` sizes it from the assistant
            turns in your records (256 without any).
    """

    max_new_tokens: int | Literal["auto"] = "auto"

    def __post_init__(self) -> None:
        if self.max_new_tokens != "auto" and (
            isinstance(self.max_new_tokens, bool) or not isinstance(self.max_new_tokens, int) or not 1 <= self.max_new_tokens <= 8192
        ):
            raise ValueError(f'OnPolicy(max_new_tokens=...) must be "auto" or 1-8192, got {self.max_new_tokens!r}.')

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"kind": "on_policy"}
        if self.max_new_tokens != "auto":
            out["max_new_tokens"] = self.max_new_tokens
        return out


@dataclass(frozen=True)
class OffPolicy:
    """Distillation on the teacher's own answers: the teacher answers each prompt once through
    the inference endpoint (a labeling eval, billed as an eval) and the student trains on them.

    Attributes:
        max_new_tokens: Longest teacher answer (the eval default, 1024, when unset).
    """

    max_new_tokens: int | None = None

    def __post_init__(self) -> None:
        if self.max_new_tokens is not None and (
            isinstance(self.max_new_tokens, bool) or not isinstance(self.max_new_tokens, int) or not 1 <= self.max_new_tokens <= 8192
        ):
            raise ValueError(f"OffPolicy(max_new_tokens=...) must be 1-8192, got {self.max_new_tokens!r}.")

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"kind": "off_policy"}
        if self.max_new_tokens is not None:
            out["max_new_tokens"] = self.max_new_tokens
        return out


@dataclass(kw_only=True)
class DistillRecipe(Recipe):
    """Train a smaller student (a LoRA) to copy a teacher on your prompts.

    Attributes:
        teacher: Required. A catalog model sharing the student's tokenizer (on-policy), or with
            ``rollout=OffPolicy()`` also an :class:`grad.Artifact` or any model your inference
            endpoint serves.
        rollout: ``OnPolicy(max_new_tokens="auto")`` (default) or ``OffPolicy()``.
        loss: ``losses.TopKKLDistill(top_k=32)`` on-policy; ``losses.CrossEntropy()`` off-policy.
        context: A :class:`grad.Context` (or text) the teacher reads and the student doesn't
            (on-policy only).
    """

    kind: ClassVar[str] = "distill"
    teacher: Any = None
    rollout: OnPolicy | OffPolicy | Mapping[str, Any] | None = None
    loss: LossSpec | Mapping[str, Any] | None = None
    context: Context | str | None = None

    def __post_init__(self) -> None:
        super().__post_init__()
        if self.teacher is None:
            raise ValueError("DistillRecipe requires teacher=: a larger catalog model such as 'qwen/qwen3-32b', or an Artifact.")
        self.teacher = model_ref(self.teacher)
        if self.rollout is not None and not isinstance(self.rollout, (OnPolicy, OffPolicy)):
            rollout = dict(self.rollout)
            kind = rollout.pop("kind", None)
            if kind not in ("on_policy", "off_policy"):
                raise ValueError(f"DistillRecipe rollout must be OnPolicy() or OffPolicy(), got {self.rollout!r}.")
            self.rollout = (OnPolicy if kind == "on_policy" else OffPolicy)(**rollout)
        off_policy = isinstance(self.rollout, OffPolicy)
        if self.loss is not None:
            kind = _dict_of(self.loss, "loss").get("kind")
            expected = "cross_entropy" if off_policy else "top_k_kl_distill"
            if kind != expected:
                raise _unsupported(
                    "DistillRecipe",
                    "loss=",
                    f"{'off' if off_policy else 'on'}-policy distillation trains with "
                    f"{'losses.CrossEntropy' if off_policy else 'losses.TopKKLDistill'}, got {kind!r}.",
                )
        if isinstance(self.context, str):
            self.context = Context.from_text(self.context)
        if self.context is not None:
            if not isinstance(self.context, Context):
                raise TypeError(f"DistillRecipe context must be a Context or str, got {type(self.context).__name__}.")
            if off_policy:
                raise ValueError("DistillRecipe(context=...) is read by the teacher during on-policy distillation; drop rollout=OffPolicy().")

    def _extra_spec(self) -> dict[str, Any]:
        out: dict[str, Any] = {"teacher": self.teacher}
        if self.rollout is not None:
            out["rollout"] = self.rollout.to_dict()  # type: ignore[union-attr]
        if self.loss is not None:
            out["loss"] = _dict_of(self.loss, "loss")
        if isinstance(self.context, Context):
            out.update(self.context.to_recipe_fields())
        return out


@dataclass(kw_only=True)
class RewardModelRecipe(Recipe):
    """A reward model: a scalar head on a base model that scores answers in ``[0, 1]``.

    Trains Bradley-Terry on ``(chosen, rejected)`` pairs (the DPO record formats); pairs stay
    on one side of the split and ``run.artifact`` is the checkpoint with the best held-out
    pair accuracy.

    Attributes:
        model: ``"qwen/qwen3-8b"`` by default.
        adapter: ``adapters.LoRA(rank=32)`` (``adapters.FrozenHead()`` trains only the head).
        rubric: Optional name of a score in ``[0, 1]`` on records that end in an assistant turn,
            trained pointwise next to the pairs.
    """

    kind: ClassVar[str] = "reward"
    rubric: str | None = None

    def __post_init__(self) -> None:
        super().__post_init__()
        if self.rubric is not None and (not isinstance(self.rubric, str) or not self.rubric):
            raise _unsupported(
                "RewardModelRecipe",
                "rubric=",
                "it takes the name of a score already on your records.",
                'Score your records first, then pass rubric="resolved".',
            )

    def _extra_spec(self) -> dict[str, Any]:
        return {} if self.rubric is None else {"rubric": self.rubric}


# ----------------------------------------------------------------------------- Wave 2


class _Wave2Recipe(Recipe):
    def to_spec(self) -> dict[str, Any]:
        """Wave 2 recipes cannot be submitted to a v0 server."""
        raise NotAvailableInV0Error(
            type(self).__name__,
            "it is a Wave 2 recipe; v0 servers train SFTRecipe, DPORecipe, RouterRecipe, DecisionModelRecipe, "
            "CartridgeRecipe, EmbeddingRecipe, DistillRecipe and RewardModelRecipe.",
        )


@dataclass(kw_only=True)
class GRPORecipe(_Wave2Recipe):
    """Group-relative RL from a rubric (single-turn) or an environment (Wave 2; typed today).

    Attributes:
        rubric: How single-turn answers are scored.
        env: An :class:`grad.Environment` (``environments.Tools``, ``Remote``, a subclass).
        group_size: Attempts per prompt (``8``).
        max_new_tokens: ``"auto"``.
        temperature: ``1.0``.
        loss: ``"auto"`` (``losses.GRPO(clip_low=0.2, clip_high=0.28)``).
        advantage: ``advantages.GroupStd()``.
        max_staleness: ``0``.
        kl_coef: ``0.0``.
        max_turns: The environment's own limit.
    """

    kind: ClassVar[str] = "grpo"
    rubric: Any = None
    env: Any = None
    group_size: int = 8
    max_new_tokens: int | Literal["auto"] = "auto"
    temperature: float = 1.0
    loss: Any = "auto"
    advantage: Any = None
    max_staleness: int = 0
    kl_coef: float = 0.0
    max_turns: int | None = None


def coerce_recipe(recipe: Any) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Return ``(recipe_spec, split)`` for a typed recipe or a plain dict.

    Dict recipes are checked against the ``RecipeSpec`` contract so a typo such as
    ``"lerning_rate"`` fails here instead of being ignored by the server.
    """
    if isinstance(recipe, Recipe):
        return recipe.to_spec(), recipe.request_split()
    if isinstance(recipe, Mapping):
        spec = dict(recipe)
        split = spec.pop("split", None)
        kind = spec.get("kind")
        if not isinstance(kind, str):
            raise ValueError('A dict recipe needs "kind", e.g. {"kind": "sft", "model": "qwen/qwen3-8b"}.')
        if kind in WAVE2_RECIPE_KINDS:
            raise NotAvailableInV0Error(f"recipe kind {kind!r}", f"it is a Wave 2 recipe; v0 recipes are {', '.join(V0_RECIPE_KINDS)}.")
        unknown = sorted(set(spec) - RECIPE_FIELDS)
        if unknown:
            hints = []
            for key in unknown:
                close = difflib.get_close_matches(key, RECIPE_FIELDS, n=1)
                hints.append(f"'{key}'" + (f" (did you mean '{close[0]}'?)" if close else ""))
            raise ValueError(f"Unknown recipe field(s) {', '.join(hints)}; RecipeSpec accepts {', '.join(sorted(RECIPE_FIELDS))}.")
        if "model" in spec and not isinstance(spec["model"], str):
            spec["model"] = model_ref(spec["model"])
        if isinstance(spec.get("adapter"), AdapterSpec):
            spec["adapter"] = spec["adapter"].to_dict()
        return spec, (None if split is None else _dict_of(split, "split"))
    raise TypeError(f"recipe must be a recipe object (e.g. SFTRecipe(...)) or a dict, got {type(recipe).__name__}.")


def recipe_fields(cls: type[Recipe]) -> list[str]:
    """Names of a recipe class's settings (for docs and tooling)."""
    return [f.name for f in fields(cls)]

