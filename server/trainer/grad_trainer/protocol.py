"""Recipe-runner seam between the trainer worker and the recipe implementations.

The worker (``grad_trainer.worker``) speaks the grad-server trainer protocol;
recipes implement :class:`RecipeRunner` and import connectors implement
:class:`ImportRunner`. Both sides depend only on the types in this module.
"""

from __future__ import annotations

import importlib
from pathlib import Path
from typing import Any, Callable, Protocol, Sequence

from .runner_types import Budget, ImportSummary, ResumeState, RunCallbacks, RunOutput, RunStatus

__all__ = [
    "Budget",
    "ImportRunner",
    "ImportSummary",
    "RecipeRunner",
    "ResumeState",
    "RunCallbacks",
    "RunOutput",
    "RunStatus",
    "resolve_import_runner",
    "resolve_recipe_runner",
    "supported_recipe_kinds",
]


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
    registry = getattr(recipes, "V0_RECIPES", None)
    if isinstance(registry, dict) and registry:
        return sorted(str(k) for k in registry)
    return None


IMPORT_RUNNER_MODULES = ("grad_trainer.import_runner",)


def resolve_import_runner() -> ImportRunner | None:
    """Find the connector-backed import runner, or None when none is installed.

    Looks in ``grad_trainer.import_runner`` for a ``get_import_runner()``
    factory, an ``import_runner`` object with ``run``, or a module-level ``run``.
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
        if callable(getattr(module, "run", None)):
            return module  # type: ignore[return-value]
    return None
