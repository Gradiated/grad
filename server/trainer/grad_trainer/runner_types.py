"""Types of the recipe-runner seam shared with the worker (`worker.py`).

The worker calls::

    runner = get_recipe_runner(kind)
    output = runner.run(config, records, budget=..., callbacks=..., resume=..., workdir=..., base=...)

and ``import_runner.run(source, connector, emit_batch=..., workdir=...)`` for import jobs.
Field names here are part of the worker protocol; keep them stable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Literal

RunStatus = Literal["completed", "stopped_budget", "cancelled", "failed"]


@dataclass(frozen=True)
class Budget:
    """Spend cap for one run. Cost is ``tokens * price_per_million_tokens / 1e6``."""

    max_cost_usd: float | None
    price_per_million_tokens: float


@dataclass
class RunCallbacks:
    """Hooks the recipe calls while it trains.

    ``on_step(metric) -> bool``: called after every optimizer step; return True to stop.
    ``on_checkpoint(step, eval_score, checkpoint_dir, metadata)``: called after a
    checkpoint directory is complete. The directory is only valid during the call.
    """

    on_step: Callable[[dict[str, Any]], bool] | None = None
    on_checkpoint: Callable[[int, float | None, Path, dict[str, Any]], None] | None = (
        None
    )


@dataclass(frozen=True)
class ResumeState:
    """A previously uploaded checkpoint, extracted to ``checkpoint_dir``."""

    step: int
    checkpoint_dir: Path


@dataclass(frozen=True)
class BaseArtifact:
    """Continued training: the starting artifact's PEFT LoRA adapter, extracted to ``directory``."""

    artifact_id: str
    directory: Path


@dataclass
class RunOutput:
    status: RunStatus
    artifact_dir: Path
    artifact_format: str
    manifest: dict[str, Any]
    eval_report: dict[str, Any]
    tokens_processed: int


@dataclass
class ImportSummary:
    records: int
    skipped: int
    errors: list[str] = field(default_factory=list)
