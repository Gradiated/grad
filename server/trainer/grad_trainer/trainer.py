"""Backend-agnostic training loop: batching, LR schedule, metering, budget, checkpoints, resume.

A recipe supplies a ``TrainingTask`` (the model-specific parts). The loop owns everything that
must behave the same for every recipe:

- Data order: epoch ``e`` visits train items in a permutation seeded by ``(seed, e)``; step
  ``s`` is batch ``s % batches_per_epoch`` of epoch ``s // batches_per_epoch``. The data cursor
  is therefore just the step number, and resuming at step ``k`` replays the same batches.
- Metering: each step's tokens are known before it runs (``task.item_tokens``). A step runs only
  if ``(tokens so far + step tokens) * price`` stays within ``max_cost_usd``; otherwise the run
  stops with ``stopped_budget`` and a final checkpoint. The meter is never rolled back:
  ``select="best"`` restores weights only.
- Checkpoints hold the exported artifact files plus ``trainer_state/`` (loop state, task state
  with optimizer and RNG, current weights, best weights), so a checkpoint is both promotable
  and resumable.
- Evaluation runs every ``eval_every`` steps (default: the checkpoint interval) and at the end.
  With no held-out data, eval metrics are null, ``select`` falls back to ``"last"`` and a
  warning is recorded.
"""

from __future__ import annotations

import json
import math
import random
import shutil
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from .config import TrainSpec, lr_multiplier
from .errors import ResumeMismatchError
from .runner_types import Budget, ResumeState, RunCallbacks, RunStatus

STATE_DIR = "trainer_state"
LOOP_STATE_FILE = "loop.json"


@dataclass
class EvalResult:
    score: float | None
    metrics: dict[str, Any]


class TrainingTask(Protocol):
    kind: str
    artifact_format: str
    metric_name: str
    metric_mode: str  # "min" | "max"
    warnings: list[str]

    def num_train_items(self) -> int: ...

    def item_tokens(self, index: int) -> int: ...

    def train_step(self, indices: list[int], lr: float) -> dict[str, float]: ...

    def evaluate(self) -> EvalResult | None: ...

    def save_weights(self, directory: Path) -> None: ...

    def load_weights(self, directory: Path) -> None: ...

    def save_state(self, directory: Path) -> None: ...

    def load_state(self, directory: Path) -> None: ...

    def export(self, directory: Path) -> None: ...

    def manifest(self) -> dict[str, Any]: ...

    def final_report(self) -> dict[str, Any]: ...


@dataclass
class LoopResult:
    status: RunStatus
    step: int
    total_steps: int
    tokens_total: int
    tokens_at_start: int
    selected_step: int
    best_step: int | None
    best_score: float | None
    last_eval: dict[str, Any] | None
    select: str
    warnings: list[str] = field(default_factory=list)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def cost_usd(tokens: int, budget: Budget) -> float:
    return tokens * budget.price_per_million_tokens / 1_000_000


def default_checkpoint_every(total_steps: int) -> int:
    # Docs: every 10% of steps, and at least every 20 steps.
    return max(1, min(20, int(total_steps * 0.1)))


def epoch_order(n: int, seed: int, epoch: int) -> list[int]:
    order = list(range(n))
    random.Random(f"grad-epoch:{seed}:{epoch}").shuffle(order)
    return order


def _better(score: float | None, best: float | None, mode: str) -> bool:
    if score is None or (isinstance(score, float) and math.isnan(score)):
        return False
    if best is None:
        return True
    # Ties go to the later checkpoint (it has seen more data).
    return score <= best if mode == "min" else score >= best


class TrainingLoop:
    def __init__(
        self,
        task: TrainingTask,
        spec: TrainSpec,
        *,
        budget: Budget,
        callbacks: RunCallbacks | None,
        resume: ResumeState | None,
        workdir: Path,
        checkpoint_metadata: dict[str, Any],
    ) -> None:
        self.task = task
        self.spec = spec
        self.budget = budget
        self.callbacks = callbacks or RunCallbacks()
        self.resume = resume
        self.workdir = workdir
        self.checkpoint_metadata = checkpoint_metadata
        self.n_items = task.num_train_items()
        self.batches_per_epoch = max(1, math.ceil(self.n_items / spec.batch_size))
        self.total_steps = self.batches_per_epoch * spec.epochs
        self.checkpoint_every = spec.checkpoint_every or default_checkpoint_every(self.total_steps)
        self.eval_every = spec.eval_every or self.checkpoint_every
        self.best_dir = workdir / "best"
        self.step = 0
        self.tokens_total = 0
        self.best_score: float | None = None
        self.best_step: int | None = None
        self.last_eval: dict[str, Any] | None = None
        self.last_eval_step: int | None = None
        self.last_checkpoint_step: int | None = None
        self._order_cache: tuple[int, list[int]] | None = None

    # -- data ---------------------------------------------------------------------------
    def batch_indices(self, step: int) -> list[int]:
        epoch, b = divmod(step, self.batches_per_epoch)
        if self._order_cache is None or self._order_cache[0] != epoch:
            self._order_cache = (epoch, epoch_order(self.n_items, self.spec.seed, epoch))
        order = self._order_cache[1]
        return order[b * self.spec.batch_size : (b + 1) * self.spec.batch_size]

    # -- state --------------------------------------------------------------------------
    def _loop_state(self) -> dict[str, Any]:
        return {
            "version": 1,
            "step": self.step,
            "tokens_total": self.tokens_total,
            "best_score": self.best_score,
            "best_step": self.best_step,
            "last_eval": self.last_eval,
            "last_eval_step": self.last_eval_step,
            "total_steps": self.total_steps,
            "n_items": self.n_items,
            "fingerprint": self.spec.fingerprint(),
        }

    def _restore(self, resume: ResumeState) -> None:
        state_dir = resume.checkpoint_dir / STATE_DIR
        try:
            state = json.loads((state_dir / LOOP_STATE_FILE).read_text())
        except (OSError, json.JSONDecodeError) as exc:
            raise ResumeMismatchError(
                f"Checkpoint at {resume.checkpoint_dir} has no readable {STATE_DIR}/{LOOP_STATE_FILE}."
            ) from exc
        if state.get("fingerprint") != self.spec.fingerprint() or state.get("n_items") != self.n_items:
            raise ResumeMismatchError(
                "Checkpoint was written by a different run configuration or dataset version."
            )
        if int(state["step"]) != resume.step:
            raise ResumeMismatchError(
                f"Checkpoint is at step {state['step']}, but resume asked for step {resume.step}."
            )
        self.step = int(state["step"])
        self.tokens_total = int(state["tokens_total"])
        self.best_score = state.get("best_score")
        self.best_step = state.get("best_step")
        self.last_eval = state.get("last_eval")
        self.last_eval_step = state.get("last_eval_step")
        self.last_checkpoint_step = self.step
        self.task.load_weights(state_dir / "weights")
        self.task.load_state(state_dir / "task")
        if (state_dir / "best").is_dir():
            shutil.rmtree(self.best_dir, ignore_errors=True)
            shutil.copytree(state_dir / "best", self.best_dir)

    def _write_checkpoint(self) -> None:
        directory = self.workdir / "checkpoints" / f"step-{self.step:06d}"
        shutil.rmtree(directory, ignore_errors=True)
        directory.mkdir(parents=True)
        self.task.export(directory)
        state_dir = directory / STATE_DIR
        state_dir.mkdir()
        self.task.save_weights(state_dir / "weights")
        self.task.save_state(state_dir / "task")
        if self.best_dir.is_dir():
            shutil.copytree(self.best_dir, state_dir / "best")
        (state_dir / LOOP_STATE_FILE).write_text(json.dumps(self._loop_state(), sort_keys=True))

        eval_score = self.last_eval_score if self.last_eval_step == self.step else None
        metadata = {
            **self.checkpoint_metadata,
            "step": self.step,
            "tokens_total": self.tokens_total,
            "metric_name": self.task.metric_name,
            "metric_mode": self.task.metric_mode,
            "eval_metrics": self.last_eval if self.last_eval_step == self.step else None,
            "manifest": {
                **self.checkpoint_metadata.get("manifest", {}),
                "format": self.task.artifact_format,
                "checkpoint_step": self.step,
                **self.task.manifest(),
            },
        }
        if self.callbacks.on_checkpoint:
            self.callbacks.on_checkpoint(self.step, eval_score, directory, metadata)
        self.last_checkpoint_step = self.step
        # Only the newest checkpoint is kept on local disk; uploaded copies live on the server.
        for old in (self.workdir / "checkpoints").iterdir():
            if old != directory:
                shutil.rmtree(old, ignore_errors=True)

    @property
    def last_eval_score(self) -> float | None:
        return None if self.last_eval is None else self.last_eval.get(self.task.metric_name)

    def _evaluate(self) -> dict[str, Any] | None:
        result = self.task.evaluate()
        self.last_eval_step = self.step
        if result is None:
            self.last_eval = None
            return None
        self.last_eval = {self.task.metric_name: result.score, **result.metrics}
        if _better(result.score, self.best_score, self.task.metric_mode):
            self.best_score = result.score
            self.best_step = self.step
            shutil.rmtree(self.best_dir, ignore_errors=True)
            self.task.save_weights(self.best_dir)
        return self.last_eval

    # -- main ---------------------------------------------------------------------------
    def run(self) -> LoopResult:
        warnings: list[str] = []
        if self.resume is not None:
            self._restore(self.resume)
        tokens_at_start = self.tokens_total
        status: RunStatus = "completed"

        prepare = getattr(self.task, "prepare", None)
        if prepare is not None:
            # Recipe preparation that costs compute (cartridge teacher generations) is metered
            # like training, and is skipped when its planned tokens would exceed the budget.
            planned = self.task.planned_prep_tokens()  # type: ignore[attr-defined]
            if (
                self.budget.max_cost_usd is not None
                and cost_usd(self.tokens_total + planned, self.budget) > self.budget.max_cost_usd
            ):
                status = "stopped_budget"
            else:
                self.tokens_total += int(prepare())

        while status == "completed" and self.step < self.total_steps:
            indices = self.batch_indices(self.step)
            step_tokens = sum(self.task.item_tokens(i) for i in indices)
            if (
                self.budget.max_cost_usd is not None
                and cost_usd(self.tokens_total + step_tokens, self.budget) > self.budget.max_cost_usd
            ):
                status = "stopped_budget"
                break

            lr = self.spec.lr * lr_multiplier(
                self.step, self.total_steps, schedule=self.spec.schedule, warmup=self.spec.warmup
            )
            started = time.perf_counter()
            stats = self.task.train_step(indices, lr)
            elapsed = max(time.perf_counter() - started, 1e-9)
            self.step += 1
            self.tokens_total += step_tokens

            eval_metrics = None
            if self.step % self.eval_every == 0 or self.step == self.total_steps:
                eval_metrics = self._evaluate()

            metric: dict[str, Any] = {
                "step": self.step,
                "epoch": (self.step - 1) // self.batches_per_epoch,
                **{k: float(v) for k, v in stats.items()},
                "lr": lr,
                "tokens": self.tokens_total,
                "cost_usd": round(cost_usd(self.tokens_total, self.budget), 8),
                "tokens_per_sec": step_tokens / elapsed,
                "timestamp": utc_now_iso(),
            }
            if eval_metrics is not None:
                metric["eval_metrics"] = eval_metrics
            stop_requested = bool(self.callbacks.on_step and self.callbacks.on_step(metric))

            if stop_requested:
                status = "cancelled"
                break
            if self.step % self.checkpoint_every == 0 or self.step == self.total_steps:
                self._write_checkpoint()

        if self.last_eval_step != self.step:
            self._evaluate()
        if self.step > 0 and self.last_checkpoint_step != self.step:
            self._write_checkpoint()

        select = self.spec.select
        if self.last_eval is None and self.best_step is None:
            if select == "best":
                warnings.append("No held-out examples: eval metrics are null and select='last' was used.")
            select = "last"
        selected = self.step
        if select == "best" and self.best_step is not None and self.best_step != self.step:
            self.task.load_weights(self.best_dir)
            selected = self.best_step
        if status == "stopped_budget" and self.step == 0:
            warnings.append("The budget did not cover a single optimizer step; the artifact is untrained.")

        return LoopResult(
            status=status,
            step=self.step,
            total_steps=self.total_steps,
            tokens_total=self.tokens_total,
            tokens_at_start=tokens_at_start,
            selected_step=selected,
            best_step=self.best_step,
            best_score=self.best_score,
            last_eval=self.last_eval,
            select=select,
            warnings=warnings,
        )
