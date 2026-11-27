"""Recipe-runner seam between the trainer worker and the recipe implementations.

The worker (``grad_trainer.worker``) speaks the grad-server trainer protocol;
recipes implement :class:`RecipeRunner` and import connectors implement
:class:`ImportRunner`. Both sides depend only on the types in this module.
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Literal, Protocol, Sequence

RunStatus = Literal["completed", "stopped_budget", "cancelled", "failed"]


@dataclass(frozen=True)
class Budget:
    """Spend cap for one attempt: ``max_cost_usd`` is the remaining budget (None = uncapped)."""

    max_cost_usd: float | None
    price_per_million_tokens: float


@dataclass
class RunCallbacks:
    """``on_step`` returns True to request a stop; ``on_checkpoint`` persists a checkpoint dir."""

    on_step: Callable[[dict[str, Any]], bool]
    on_checkpoint: Callable[[int, float | None, Path, dict[str, Any]], None]


@dataclass(frozen=True)
class ResumeState:
    step: int
    checkpoint_dir: Path


@dataclass
class RunOutput:
    status: RunStatus
    artifact_dir: Path
    artifact_format: str
    manifest: dict[str, Any] = field(default_factory=dict)
    eval_report: dict[str, Any] = field(default_factory=dict)
    tokens_processed: int = 0


@dataclass
class ImportSummary:
    imported_count: int
    dropped_count: int
    detected_scores: list[str] = field(default_factory=list)


class RecipeRunner(Protocol):
    def run(
        self,
        config: dict[str, Any],
        records: Sequence[dict[str, Any]],
        *,
        budget: Budget,
        callbacks: RunCallbacks,
        resume: ResumeState | None,
        workdir: Path,
    ) -> RunOutput: ...


class ImportRunner(Protocol):
    def run(
        self,
        source: dict[str, Any],
        connector: str | None,
        *,
        emit_batch: Callable[[list[dict[str, Any]]], None],
        workdir: Path,
    ) -> ImportSummary: ...


def resolve_recipe_runner(kind: str) -> RecipeRunner:
    """Look up the runner for a recipe kind in ``grad_trainer.recipes``."""
    from .recipes import get_recipe_runner

    return get_recipe_runner(kind)  # type: ignore[return-value]


def supported_recipe_kinds() -> list[str] | None:
    """Recipe kinds the local registry can run, or None when not discoverable."""
    try:
        from . import recipes
    except Exception:  # pragma: no cover - registry import failure
        return None
    registry = getattr(recipes, "RECIPE_REGISTRY", None)
    if isinstance(registry, dict) and registry:
        return sorted(str(k) for k in registry)
    return None


IMPORT_RUNNER_MODULES = ("grad_trainer.imports", "grad_trainer.connectors")


def resolve_import_runner() -> ImportRunner | None:
    """Find the connector-backed import runner, or None when none is installed.

    Looks in ``grad_trainer.imports`` then ``grad_trainer.connectors`` for a
    ``get_import_runner()`` factory or an ``import_runner`` object with ``run``.
    """
    for module_name in IMPORT_RUNNER_MODULES:
        try:
            module = importlib.import_module(module_name)
        except ImportError:
            continue
        factory = getattr(module, "get_import_runner", None)
        if callable(factory):
            runner = factory()
            if runner is not None and callable(getattr(runner, "run", None)):
                return runner
        runner = getattr(module, "import_runner", None)
        if runner is not None and callable(getattr(runner, "run", None)):
            return runner
    return None
