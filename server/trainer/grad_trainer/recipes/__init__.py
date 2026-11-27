"""Registry of v0 training recipes."""

from __future__ import annotations

from .base import RecipeRunner, RunCallbacks, RunOutput
from .cartridge import CartridgeRunner
from .decision import DecisionRunner
from .dpo import DPORunner
from .embedding import EmbeddingRunner
from .router import RouterRunner
from .sft import SFTRunner

RECIPE_REGISTRY: dict[str, RecipeRunner] = {
    "sft": SFTRunner(),
    "dpo": DPORunner(),
    "router": RouterRunner(),
    "decision": DecisionRunner(),
    "cartridge": CartridgeRunner(),
    "embedding": EmbeddingRunner(),
}


def get_recipe_runner(kind: str) -> RecipeRunner:
    runner = RECIPE_REGISTRY.get(kind)
    if runner is None:
        supported = ", ".join(sorted(RECIPE_REGISTRY))
        raise ValueError(
            f"Unsupported recipe kind '{kind}'. Supported v0 recipes: {supported}."
        )
    return runner


__all__ = [
    "RECIPE_REGISTRY",
    "RecipeRunner",
    "RunCallbacks",
    "RunOutput",
    "get_recipe_runner",
]
