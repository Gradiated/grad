"""Backend-agnostic training loop: batching, LR schedule, metering, budget, checkpoints, resume.

A recipe supplies a ``TrainingTask`` (the model-specific parts). The loop owns everything that
must behave the same for every recipe:

- Data order: epoch ``e`` visits train items in a permutation seeded by ``(seed, e)``; step
  ``s`` is batch ``s % batches_per_epoch`` of epoch ``s // batches_per_epoch``. The data cursor
  is therefore just the step number, and resuming at step ``k`` replays the same batches.
- Metering is per attempt: each step's tokens are bounded before it runs (``task.item_tokens``;
  a task may report fewer as ``metered_tokens`` once the step has run).
  A step runs only if ``(this attempt's tokens + step tokens) * price`` stays within
  ``max_cost_usd``, which is the budget left for this attempt (the server subtracts what earlier
  attempts were billed). Otherwise the run stops with ``stopped_budget`` and a final checkpoint.
  Metric ``tokens``/``cost_usd`` are this attempt's, so a resumed run never re-reports the tokens
  restored from its checkpoint. The meter is never rolled back: ``select="best"`` restores
  weights only.
- Checkpoints are written every ``checkpoint_every`` steps, at the end, and whenever
  ``checkpoint_every_minutes`` of wall clock have passed since the last one. Training pauses
  only for an in-memory snapshot; a background thread writes, hands over (``on_checkpoint``,
  which bundles and uploads) and deletes each checkpoint, one at a time and in order.
- Checkpoints hold the exported artifact files plus ``trainer_state/`` (loop state, task state
  with optimizer and RNG, current weights, best weights), so a checkpoint is both promotable
  and resumable.
- Evaluation runs every ``eval_every`` steps (default: every 25% of the run, at most every 20
  steps) and at the end, and each eval step is also a checkpoint, so the best one is promotable.
  With no held-out data, eval metrics are null, ``select`` falls back to ``"last"`` and a
  warning is recorded.
"""

from __future__ import annotations

import array
import json
import math
import os
import queue
import random
import shutil
import threading
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
    # Docs (and planner.ts): every 10% of steps, and at least every 20 steps; the trainer also
    # checkpoints every checkpoint_every_minutes (5) of wall clock, whichever comes first.
    return max(1, min(20, int(total_steps * 0.1)))


def default_eval_every(total_steps: int) -> int:
    # Docs (and planner.ts): every 25% of the run, at most every 20 steps. Not the checkpoint
    # interval: an eval costs far more than a checkpoint (on an H100 at 8B, about 20 s per eval
    # against under 2 s per snapshot), so evaluating at every checkpoint slowed a run by 25%.
    return max(1, min(total_steps, max(20, math.ceil(total_steps * 0.25))))


def epoch_order(n: int, seed: int, epoch: int) -> array.array[int]:
    """Epoch ``epoch``'s permutation of the train items: an int64 array (8 bytes an item, where
    a list of ints takes about 36); the same permutation a list would get."""
    order = array.array("q", range(n))
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
        self.eval_every = spec.eval_every or default_eval_every(self.total_steps)
        self.best_dir = workdir / "best"
        self.step = 0
        self.tokens_total = 0
        self.best_score: float | None = None
        self.best_step: int | None = None
        self.last_eval: dict[str, Any] | None = None
        self.last_eval_step: int | None = None
        self.last_checkpoint_step: int | None = None
        self.last_checkpoint_time = time.monotonic()
        self._checkpoint_seq = 0
        # A periodic checkpoint fell due while the writer was busy: take it once it is free.
        self._checkpoint_owed = False
        self._writer: threading.Thread | None = None
        self._writer_queue: queue.Queue[Any] = queue.Queue(maxsize=1)
        self._writer_error: BaseException | None = None
        self._order_cache: tuple[int, array.array[int]] | None = None

    # -- data ---------------------------------------------------------------------------
    def batch_indices(self, step: int) -> list[int]:
        epoch, b = divmod(step, self.batches_per_epoch)
        if self._order_cache is None or self._order_cache[0] != epoch:
            self._order_cache = (epoch, epoch_order(self.n_items, self.spec.seed, epoch))
        order = self._order_cache[1]
        return order[b * self.spec.batch_size : (b + 1) * self.spec.batch_size].tolist()

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

    def _phase(self, phase: str) -> None:
        if self.callbacks.on_phase:
            self.callbacks.on_phase(phase, self.step)

    def _write_checkpoint(self) -> None:
        """Snapshot the run state now; write, hand over (``on_checkpoint``) and delete it in the background.

        The training thread pauses only for ``task.snapshot()`` (an in-memory copy of the
        trainable weights and optimizer state) and a hard-linked copy of ``best/``. A task
        without ``snapshot`` is written to disk here and only handed over in the background.
        """
        self._phase("checkpointing")
        self._writer_check()
        self._checkpoint_seq += 1
        directory = self.workdir / "checkpoints" / f"step-{self.step:06d}-{self._checkpoint_seq}"
        shutil.rmtree(directory, ignore_errors=True)
        directory.mkdir(parents=True)
        state_dir = directory / STATE_DIR
        snapshot_fn = getattr(self.task, "snapshot", None)
        snapshot = snapshot_fn() if snapshot_fn is not None else None
        if snapshot is None:
            self.task.export(directory)
            state_dir.mkdir()
            self.task.save_weights(state_dir / "weights")
            self.task.save_state(state_dir / "task")
        else:
            state_dir.mkdir()
        if self.best_dir.is_dir():
            # Hard links: a later eval replaces best/ with new files, these keep the old ones.
            shutil.copytree(self.best_dir, state_dir / "best", copy_function=os.link)
        (state_dir / LOOP_STATE_FILE).write_text(json.dumps(self._loop_state(), sort_keys=True))

        step = self.step
        eval_score = self.last_eval_score if self.last_eval_step == step else None
        metadata = {
            **self.checkpoint_metadata,
            "step": step,
            "tokens_total": self.tokens_total,
            "metric_name": self.task.metric_name,
            "metric_mode": self.task.metric_mode,
            "eval_metrics": self.last_eval if self.last_eval_step == step else None,
            "manifest": {
                **self.checkpoint_metadata.get("manifest", {}),
                "format": self.task.artifact_format,
                "checkpoint_step": step,
                **self.task.manifest(),
            },
        }

        def finish() -> None:
            try:
                if snapshot is not None:
                    self.task.write_snapshot(snapshot, directory, state_dir / "weights", state_dir / "task")  # type: ignore[attr-defined]
                if self.callbacks.on_checkpoint:
                    self.callbacks.on_checkpoint(step, eval_score, directory, metadata)
            finally:
                shutil.rmtree(directory, ignore_errors=True)

        self._writer_submit(finish)
        self._checkpoint_owed = False
        self.last_checkpoint_step = step
        self.last_checkpoint_time = time.monotonic()

    # -- background checkpoint writer ----------------------------------------------------
    # One thread, one checkpoint at a time, in order: never two uploads in flight. A periodic
    # checkpoint is not taken while one is still being written (see _checkpoint_due); a
    # required one (the last step, an eval step, an emergency) waits for it. An error (lease
    # lost, auth) surfaces on the training thread at the next checkpoint or when the loop ends.
    def _writer_loop(self) -> None:
        while True:
            job = self._writer_queue.get()
            try:
                if job is None:
                    return
                if self._writer_error is None:
                    job()
            except BaseException as exc:  # re-raised on the training thread
                self._writer_error = exc
            finally:
                self._writer_queue.task_done()

    def _writer_busy(self) -> bool:
        return self._writer_queue.unfinished_tasks > 0

    def _writer_check(self) -> None:
        if self._writer_error is not None:
            error, self._writer_error = self._writer_error, None
            raise error

    def _writer_submit(self, job: Any) -> None:
        if self._writer is None:
            self._writer = threading.Thread(target=self._writer_loop, name="checkpoint-writer", daemon=True)
            self._writer.start()
        self._writer_queue.put(job)

    def _writer_drain(self) -> None:
        if self._writer is not None:
            self._writer_queue.put(None)
            self._writer.join()
            self._writer = None

    def _checkpoint_due(self) -> bool:
        """The last step and eval steps are always saved. A periodic checkpoint (every
        ``checkpoint_every`` steps or ``checkpoint_every_minutes``) never makes training wait
        for the previous one to finish writing: it is taken at the first step after that.
        Short steps with big checkpoints (0.6B: 0.5 s steps, 14 s to write 374 MB) otherwise
        left the GPU idle most of the run."""
        if self.step == self.total_steps or self.last_eval_step == self.step:
            return True
        minutes = self.spec.checkpoint_every_minutes
        if self.step % self.checkpoint_every == 0 or (
            minutes is not None and time.monotonic() - self.last_checkpoint_time >= minutes * 60
        ):
            self._checkpoint_owed = True
        return self._checkpoint_owed and not self._writer_busy()

    @property
    def last_eval_score(self) -> float | None:
        return None if self.last_eval is None else self.last_eval.get(self.task.metric_name)

    def _evaluate(self) -> dict[str, Any] | None:
        self._phase("evaluating")
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
        try:
            result = self._run()
        finally:
            self._writer_drain()  # every checkpoint is handed over before the run returns
        self._writer_check()
        return result

    def _run(self) -> LoopResult:
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
                and cost_usd(self.tokens_total - tokens_at_start + planned, self.budget)
                > self.budget.max_cost_usd
            ):
                status = "stopped_budget"
            else:
                self.tokens_total += int(prepare())

        emergency = False
        self._phase("training")
        while status == "completed" and self.step < self.total_steps:
            indices = self.batch_indices(self.step)
            step_tokens = sum(self.task.item_tokens(i) for i in indices)
            if (
                self.budget.max_cost_usd is not None
                and cost_usd(self.tokens_total - tokens_at_start + step_tokens, self.budget)
                > self.budget.max_cost_usd
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
            # Tasks whose step length is only known afterwards (on-policy distillation) report
            # what they used; ``item_tokens`` is the upper bound the budget check reserved.
            metered = stats.pop("metered_tokens", None)
            if metered is not None:
                step_tokens = min(step_tokens, int(metered))
            self.tokens_total += step_tokens

            eval_metrics = None
            if self.step % self.eval_every == 0 or self.step == self.total_steps:
                eval_metrics = self._evaluate()
                self._phase("training")

            metric: dict[str, Any] = {
                "step": self.step,
                "epoch": (self.step - 1) // self.batches_per_epoch,
                **{k: float(v) for k, v in stats.items()},
                "lr": lr,
                "tokens": self.tokens_total - tokens_at_start,
                "cost_usd": round(cost_usd(self.tokens_total - tokens_at_start, self.budget), 8),
                "tokens_per_sec": step_tokens / elapsed,
                "timestamp": utc_now_iso(),
            }
            if eval_metrics is not None:
                metric["eval_metrics"] = eval_metrics
            stop = self.callbacks.on_step(metric) if self.callbacks.on_step else False

            if stop == "checkpoint":
                # Emergency stop: save this step now; no eval, nothing after it.
                status, emergency = "cancelled", True
                if self.last_checkpoint_step != self.step:
                    self._write_checkpoint()
                break
            if stop:
                status = "cancelled"
                break
            if self._checkpoint_due():
                self._write_checkpoint()
                if self.step < self.total_steps:
                    self._phase("training")

        if not emergency and self.last_eval_step != self.step:
            self._evaluate()
        if not emergency and self.step > 0 and self.last_checkpoint_step != self.step:
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
