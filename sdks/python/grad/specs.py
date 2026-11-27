"""Typed training specs: ``adapters``, ``losses``, ``optim``, ``splits``, ``pooling``,
``advantages`` and ``loggers``.

Each helper returns a small frozen dataclass with ``to_dict()``. Plain dicts are
accepted wherever a spec is. Recipes translate specs into the fields the server's
``RecipeSpec`` contract accepts and reject settings it cannot carry yet, so a run
never silently trains with something other than what you asked for.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from ._errors import NotAvailableInV0Error

__all__ = [
    "AdapterSpec",
    "AdamWSpec",
    "LossSpec",
    "SplitSpec",
    "Unavailable",
    "adapters",
    "advantages",
    "heads",
    "loggers",
    "losses",
    "mergers",
    "optim",
    "pooling",
    "splits",
]


@dataclass(frozen=True)
class _Spec:
    kind: str

    def to_dict(self) -> dict[str, Any]:
        """Wire form: ``kind`` plus every field that is set."""
        return {k: (list(v) if isinstance(v, tuple) else v) for k, v in asdict(self).items() if v is not None}


# ------------------------------------------------------------------------------ adapters


@dataclass(frozen=True)
class AdapterSpec(_Spec):
    """An adapter configuration (``adapters.LoRA``, ``adapters.PrefixKV``, ``adapters.FrozenHead``)."""

    rank: int | None = None
    alpha: int | None = None
    merge_on_export: bool | None = None
    num_tokens: int | None = None


class adapters:
    """Parameter-efficient adapters. LLMs always train an adapter (there is no full fine-tune)."""

    @staticmethod
    def LoRA(rank: int = 32, *, alpha: int = 32, merge_on_export: bool = False) -> AdapterSpec:
        """LoRA adapter. ``alpha`` stays at 32 so changing ``rank`` keeps the right ``lr``.

        ``merge_on_export=True`` exports standalone merged safetensors instead of a PEFT adapter.
        """
        if not 1 <= rank <= 256:
            raise ValueError(f"LoRA rank must be between 1 and 256, got {rank}.")
        if not 1 <= alpha <= 512:
            raise ValueError(f"LoRA alpha must be between 1 and 512, got {alpha}.")
        return AdapterSpec(kind="lora", rank=rank, alpha=alpha, merge_on_export=merge_on_export)

    @staticmethod
    def PrefixKV(num_tokens: int = 256) -> AdapterSpec:
        """Prefix key/value cache adapter (what a Cartridge trains)."""
        if not 16 <= num_tokens <= 4096:
            raise ValueError(f"PrefixKV num_tokens must be between 16 and 4096, got {num_tokens}.")
        return AdapterSpec(kind="prefix_kv", num_tokens=num_tokens)

    @staticmethod
    def FrozenHead() -> AdapterSpec:
        """Train only a task head on a frozen backbone."""
        return AdapterSpec(kind="frozen_head")

    @staticmethod
    def Full() -> AdapterSpec:
        """Not offered: LLM recipes train LoRA or PrefixKV adapters only."""
        raise NotAvailableInV0Error(
            "adapters.Full()",
            "LLM recipes train LoRA or PrefixKV adapters so they can be served on shared base weights.",
            alternative="Use adapters.LoRA(rank=64 or 128) for large datasets.",
        )


# -------------------------------------------------------------------------------- losses


@dataclass(frozen=True)
class LossSpec(_Spec):
    """A loss configuration from :class:`losses`."""

    reduction: str | None = None
    beta: float | None = None
    temp: float | None = None
    top_k: int | None = None
    clip_low: float | None = None
    clip_high: float | None = None
    mask_ratio: tuple[float, float] | None = None
    head: str | None = None


class losses:
    """Losses. Each recipe documents which ones it accepts; defaults are chosen for you."""

    @staticmethod
    def CrossEntropy(reduction: Literal["per_example", "per_token"] | None = None) -> LossSpec:
        """Token cross-entropy (SFT). ``reduction`` defaults to ``"per_example"``."""
        return LossSpec(kind="cross_entropy", reduction=reduction)

    @staticmethod
    def DPO(beta: float = 0.1) -> LossSpec:
        """Direct Preference Optimization. Higher ``beta`` stays closer to the starting model."""
        if beta <= 0:
            raise ValueError(f"DPO beta must be positive, got {beta}.")
        return LossSpec(kind="dpo", beta=beta)

    @staticmethod
    def InfoNCE(temp: float = 0.05) -> LossSpec:
        """Contrastive InfoNCE for embeddings. Lower ``temp`` sharpens rankings."""
        if temp <= 0:
            raise ValueError(f"InfoNCE temp must be positive, got {temp}.")
        return LossSpec(kind="infonce", temp=temp)

    @staticmethod
    def TopKKLDistill(top_k: int = 32) -> LossSpec:
        """KL to the teacher's top-k next-token distribution (distillation, cartridges)."""
        if top_k < 1:
            raise ValueError(f"top_k must be positive, got {top_k}.")
        return LossSpec(kind="top_k_kl_distill", top_k=top_k)

    @staticmethod
    def GRPO(clip_low: float = 0.2, clip_high: float = 0.28, mask_ratio: tuple[float, float] | None = None) -> LossSpec:
        """Group-relative policy optimization (GRPORecipe, Wave 2)."""
        return LossSpec(kind="grpo", clip_low=clip_low, clip_high=clip_high, mask_ratio=mask_ratio)

    @staticmethod
    def CISPO(clip_high: float = 0.28) -> LossSpec:
        """Clipped importance-sampling policy optimization (GRPORecipe, Wave 2)."""
        return LossSpec(kind="cispo", clip_high=clip_high)

    @staticmethod
    def BCEWithLogits(head: str | None = None) -> LossSpec:
        """Binary cross-entropy on a head's logits (decision models' ``noul`` questions)."""
        return LossSpec(kind="bce_with_logits", head=head)

    @staticmethod
    def OrdinalBCE() -> LossSpec:
        """Ordinal BCE (decision models' ``score`` questions)."""
        return LossSpec(kind="ordinal_bce")

    class CustomLoss:
        """Base class for custom losses (interactive ``Trainer`` API, Wave 2).

        Subclasses are typed today so code keeps importing; using one in a recipe
        raises :class:`grad.NotAvailableInV0Error`.
        """

        outputs: tuple[str, ...] = ("logprobs",)
        kind = "custom"

        def compute(self, records: Any, out: Any) -> Any:  # pragma: no cover - user override
            """Return the scalar loss tensor for ``records`` given model ``out``puts."""
            raise NotImplementedError


# --------------------------------------------------------------------------------- optim


@dataclass(frozen=True)
class AdamWSpec(_Spec):
    """AdamW settings (``betas=(0.9, 0.95)``, ``weight_decay=0.0``, ``grad_clip=1.0`` by default)."""

    lr: float | str = "auto"
    betas: tuple[float, float] = (0.9, 0.95)
    weight_decay: float = 0.0
    grad_clip: float = 1.0

    @property
    def is_default(self) -> bool:
        """True when everything but ``lr`` is at the platform default."""
        return self.betas == (0.9, 0.95) and self.weight_decay == 0.0 and self.grad_clip == 1.0


class optim:
    """Optimizers."""

    @staticmethod
    def AdamW(
        lr: float | Literal["auto"] = "auto",
        *,
        betas: tuple[float, float] = (0.9, 0.95),
        weight_decay: float = 0.0,
        grad_clip: float = 1.0,
        param_groups: Any = None,
        weight_anchor: Any = None,
    ) -> AdamWSpec:
        """AdamW with ``betas=(0.9, 0.95)``, ``weight_decay=0.0`` and ``grad_clip=1.0`` by default."""
        if param_groups is not None or weight_anchor is not None:
            raise NotAvailableInV0Error(
                "optim.AdamW(param_groups=/weight_anchor=)",
                "per-parameter groups and weight anchors belong to the interactive Trainer API (Wave 2).",
            )
        if lr != "auto" and (isinstance(lr, bool) or not isinstance(lr, (int, float)) or lr <= 0):
            raise ValueError(f'lr must be "auto" or a positive number, got {lr!r}.')
        return AdamWSpec(kind="adamw", lr=lr, betas=tuple(betas), weight_decay=weight_decay, grad_clip=grad_clip)  # type: ignore[arg-type]

    @staticmethod
    def ParamGroup(target: Any = None, lr: float | None = None) -> Any:
        """Not available in v0 (interactive Trainer API)."""
        raise NotAvailableInV0Error("optim.ParamGroup", "it belongs to the interactive Trainer API (Wave 2).")

    @staticmethod
    def WeightAnchor(artifact: Any = None, strength: float | None = None) -> Any:
        """Not available in v0 (interactive Trainer API)."""
        raise NotAvailableInV0Error("optim.WeightAnchor", "it belongs to the interactive Trainer API (Wave 2).")


# -------------------------------------------------------------------------------- splits


@dataclass(frozen=True)
class SplitSpec(_Spec):
    """How records are split into train and held-out eval sets."""

    eval_fraction: float | None = None
    seed: int | None = None

    def to_dict(self) -> dict[str, Any]:
        """Wire form (``strategy`` plus the fields that are set)."""
        out: dict[str, Any] = {"strategy": self.kind}
        if self.eval_fraction is not None:
            out["eval_fraction"] = self.eval_fraction
        if self.seed is not None:
            out["seed"] = self.seed
        return out


def _split(kind: str, eval_fraction: float | None, seed: int | None) -> SplitSpec:
    if eval_fraction is not None and not 0.0 <= eval_fraction <= 0.5:
        raise ValueError(f"eval_fraction must be between 0 and 0.5, got {eval_fraction}.")
    return SplitSpec(kind=kind, eval_fraction=eval_fraction, seed=seed)


class splits:
    """Train/eval splits that never leak a session (or preference group) across sides.

    The default is ``BySession(0.10)``, or ``0.15`` for routers and decision models.
    """

    @staticmethod
    def BySession(eval_fraction: float | None = None, *, seed: int | None = None) -> SplitSpec:
        """Hold out whole sessions (records sharing ``session_id``)."""
        return _split("by_session", eval_fraction, seed)

    @staticmethod
    def ByGroup(eval_fraction: float | None = None, *, seed: int | None = None) -> SplitSpec:
        """Hold out whole groups (records sharing ``group_id``, e.g. preference pairs)."""
        return _split("by_group", eval_fraction, seed)

    @staticmethod
    def Random(eval_fraction: float | None = None, *, seed: int | None = None) -> SplitSpec:
        """Hold out random records."""
        return _split("random", eval_fraction, seed)


# ------------------------------------------------------------------ pooling / advantages


@dataclass(frozen=True)
class PoolingSpec(_Spec):
    """How an embedding model pools token vectors."""


class pooling:
    """Embedding pooling: the v0 server trains with ``Mean()`` (default) or ``CLS()``."""

    @staticmethod
    def Mean() -> PoolingSpec:
        """Average token vectors (the default)."""
        return PoolingSpec(kind="mean")

    @staticmethod
    def CLS() -> PoolingSpec:
        """Use the first ([CLS]) token vector."""
        return PoolingSpec(kind="cls")

    @staticmethod
    def LastToken() -> PoolingSpec:
        """Use the last token vector."""
        return PoolingSpec(kind="last_token")


@dataclass(frozen=True)
class AdvantageSpec(_Spec):
    """How RL attempt scores become advantages (GRPORecipe, Wave 2)."""


class advantages:
    """Advantage estimators for RL recipes (Wave 2)."""

    @staticmethod
    def GroupStd() -> AdvantageSpec:
        """Normalise by the group mean and standard deviation (the default)."""
        return AdvantageSpec(kind="group_std")

    @staticmethod
    def GroupMean() -> AdvantageSpec:
        """Subtract the group mean."""
        return AdvantageSpec(kind="group_mean")

    @staticmethod
    def RLOO() -> AdvantageSpec:
        """Leave-one-out baseline."""
        return AdvantageSpec(kind="rloo")


@dataclass(frozen=True)
class LoggerSpec:
    """An experiment tracker configuration."""

    kind: str
    options: dict[str, Any] = field(default_factory=dict)


class loggers:
    """Experiment trackers. Typed today; the v0 server does not forward metrics to them yet."""

    @staticmethod
    def WandB(project: str, *, tags: list[str] | None = None, entity: str | None = None) -> LoggerSpec:
        """Weights & Biases."""
        return LoggerSpec(kind="wandb", options={"project": project, "tags": tags, "entity": entity})

    @staticmethod
    def MLflow(*, tracking_uri: str | None = None, experiment: str | None = None) -> LoggerSpec:
        """MLflow."""
        return LoggerSpec(kind="mlflow", options={"tracking_uri": tracking_uri, "experiment": experiment})


class Unavailable:
    """A documented namespace that v0 does not ship; any use raises :class:`NotAvailableInV0Error`."""

    def __init__(self, name: str, reason: str, alternative: str | None = None) -> None:
        self._name = name
        self._reason = reason
        self._alternative = alternative

    def __getattr__(self, attr: str) -> Any:
        if attr.startswith("__"):
            raise AttributeError(attr)
        raise NotAvailableInV0Error(f"{self._name}.{attr}", self._reason, alternative=self._alternative)

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        raise NotAvailableInV0Error(self._name, self._reason, alternative=self._alternative)

    def __repr__(self) -> str:
        return f"<{self._name}: not available in grad v0>"


mergers = Unavailable("mergers", "artifact merging is deferred past v0.")
heads = Unavailable("heads", "custom heads belong to the interactive Trainer API (Wave 2).")
