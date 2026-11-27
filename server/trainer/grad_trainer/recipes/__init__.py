"""Registry of v0 recipe runners.

``get_recipe_runner(kind)`` returns the real torch runner unless ``GRAD_TRAINER_BACKEND`` is
``reference`` (a stdlib test double whose artifacts are marked ``format: reference``).
Torch is imported lazily, so the reference backend and the connectors work without it.
"""

from __future__ import annotations

import importlib
import os

from ..errors import BackendUnavailableError
from ..runner_types import RunCallbacks, RunOutput
from .base import RecipeRunner

V0_RECIPES: dict[str, tuple[str, str]] = {
    "sft": ("sft", "SFTRunner"),
    "dpo": ("dpo", "DPORunner"),
    "router": ("router", "RouterRunner"),
    "decision": ("decision", "DecisionRunner"),
    "cartridge": ("cartridge", "CartridgeRunner"),
    "embedding": ("embedding", "EmbeddingRunner"),
    "distill": ("distill", "DistillRunner"),
    "reward": ("reward", "RewardRunner"),
}
BACKENDS = ("torch", "reference")
_TORCH_STACK = {"torch", "transformers", "peft", "safetensors", "tokenizers", "accelerate"}


def backend_name() -> str:
    name = os.environ.get("GRAD_TRAINER_BACKEND", "torch").strip().lower() or "torch"
    if name not in BACKENDS:
        raise BackendUnavailableError(
            f"GRAD_TRAINER_BACKEND='{name}' is not supported; use 'torch' (default) or 'reference' (tests only)."
        )
    return name


def get_recipe_runner(kind: str) -> RecipeRunner:
    if kind not in V0_RECIPES:
        raise ValueError(
            f"Unsupported recipe kind '{kind}'. Supported v0 recipes: {', '.join(sorted(V0_RECIPES))}."
        )
    if backend_name() == "reference":
        from ..backends.reference import ReferenceRunner

        return ReferenceRunner(kind)
    try:
        module = importlib.import_module(f".{V0_RECIPES[kind][0]}", __name__)
    except ImportError as exc:
        if (exc.name or "").split(".")[0] not in _TORCH_STACK:
            raise
        raise BackendUnavailableError(
            f"The torch training backend needs torch, transformers and peft ({exc}). "
            "Install the trainer's pinned requirements."
        ) from exc
    return getattr(module, V0_RECIPES[kind][1])()


__all__ = ["V0_RECIPES", "RecipeRunner", "RunCallbacks", "RunOutput", "backend_name", "get_recipe_runner"]
