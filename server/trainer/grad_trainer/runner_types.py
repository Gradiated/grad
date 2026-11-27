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

    ``on_step(metric) -> bool | "checkpoint"``: called after every optimizer step; return
    True to stop (the loop evaluates and checkpoints the current step first), or
    ``"checkpoint"`` to stop at once with a checkpoint of the current step and no eval
    (an emergency checkpoint before the worker's compute goes away).
    ``on_checkpoint(step, eval_score, checkpoint_dir, metadata)``: called after a
    checkpoint directory is complete. The directory is only valid during the call.
    ``on_phase(phase, step)``: the loop entered ``training``, ``evaluating`` or
    ``checkpointing`` at ``step``.
    """

    on_step: Callable[[dict[str, Any]], bool | str] | None = None
    on_checkpoint: Callable[[int, float | None, Path, dict[str, Any]], None] | None = (
        None
    )
    on_phase: Callable[[str, int], None] | None = None


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
    # Source syncs only: the provider watermark to store when the job completes.
    watermark: dict[str, Any] | None = None
