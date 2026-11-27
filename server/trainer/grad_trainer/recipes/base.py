"""Shared RecipeRunner protocol, RunOutput, deterministic split, and training loop driver."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Literal, Protocol, Sequence

from ..trainer import (
    StepResult,
    Trainer,
    TrainingExample,
    compute_scheduled_lr,
)

TerminalStatus = Literal["completed", "stopped_budget", "cancelled", "failed"]

MODEL_PRICES_PER_MILLION: dict[str, float] = {
    "qwen/qwen3-0.6b": 0.15,
    "qwen/qwen3-1.7b": 0.22,
    "qwen/qwen3-4b": 0.30,
    "qwen/qwen3-8b": 0.40,
    "qwen/qwen3-14b": 0.70,
    "qwen/qwen3-32b": 1.20,
    "gradiated/linden-1": 0.20,
    "baai/bge-small-en-v1.5": 0.08,
}


def price_for_model(model: str) -> float:
    return MODEL_PRICES_PER_MILLION.get(model.strip().lower(), 0.40)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _hash_fraction(key: str, seed: int) -> float:
    digest = hashlib.sha256(f"{seed}:{key}".encode("utf-8")).digest()
    val = int.from_bytes(digest[:4], "big")
    return val / 0x1_0000_0000


def split_records(
    records: Sequence[dict[str, Any]],
    *,
    strategy: str = "by_session",
    eval_fraction: float = 0.1,
    seed: int = 42,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Deterministic split identical to server/api/src/planner.ts."""
    train: list[dict[str, Any]] = []
    eval_set: list[dict[str, Any]] = []
    for idx, rec in enumerate(records):
        if strategy == "by_session":
            key = str(rec.get("session_id") or rec.get("id") or f"row:{idx}")
        elif strategy == "by_group":
            key = str(
                rec.get("group_id")
                or rec.get("session_id")
                or rec.get("id")
                or f"row:{idx}"
            )
        else:
            key = str(rec.get("id") or f"row:{idx}")

        if _hash_fraction(key, seed) < eval_fraction:
            eval_set.append(rec)
        else:
            train.append(rec)

    if not train and eval_set:
        train.append(eval_set.pop(0))

    return train, eval_set


@dataclass
class RunCallbacks:
    """Hooks invoked by recipes to stream metrics, persist checkpoints, and check early stop."""

    on_step: Callable[[dict[str, Any]], bool] | None = None
    on_checkpoint: Callable[[int, float | None, bytes, dict[str, Any]], None] | None = (
        None
    )


@dataclass
class RunOutput:
    status: TerminalStatus
    artifact_format: str
    artifact_bytes: bytes
    manifest: dict[str, Any]
    eval_report: dict[str, Any]
    tokens_processed: int
    cost_usd: float
    metrics: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class LoopResult:
    status: TerminalStatus
    metrics: list[dict[str, Any]]
    best_eval_loss: float
    final_eval_loss: float
    final_eval_metric: float


def step_metric_payload(
    step_result: StepResult,
    *,
    eval_loss: float | None = None,
    eval_metric: float | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "step": step_result.step,
        "loss": step_result.loss,
        "grad_norm": step_result.grad_norm,
        "lr": step_result.lr,
        "tokens": step_result.tokens,
        "cost_usd": step_result.cost_usd,
        "timestamp": utc_now_iso(),
    }
    if eval_loss is not None:
        payload["eval_loss"] = round(eval_loss, 6)
    if eval_metric is not None:
        payload["eval_metric"] = round(eval_metric, 6)
    return payload


def run_training_loop(
    *,
    trainer: Trainer,
    train_examples: Sequence[TrainingExample],
    eval_examples: Sequence[TrainingExample],
    config: dict[str, Any],
    loss_kind: str = "cross_entropy",
    beta: float = 0.1,
    temp: float = 0.05,
    max_cost_usd: float | None = None,
    callbacks: RunCallbacks | None = None,
) -> LoopResult:
    """Shared epoch/batch loop with unified checkpointing, best-selection, budget & cancel stop."""
    batch_size = max(1, int(config.get("batch_size", 32)))
    epochs = max(1, int(config.get("epochs", 1)))
    base_lr = float(config.get("lr", 5e-4))
    schedule = str(config.get("schedule", "linear"))
    warmup = float(config.get("warmup", 0.03))
    reduction = str(config.get("reduction", "per_example"))
    select = str(config.get("select", "best"))
    ckpt_every = max(1, int(config.get("checkpoint_every_steps", 1)))

    batches_per_epoch = max(1, (len(train_examples) + batch_size - 1) // batch_size)
    total_steps = max(1, batches_per_epoch * epochs)

    metrics: list[dict[str, Any]] = []
    best_eval_loss = float("inf")
    best_state = trainer.save_state()
    status: TerminalStatus = "completed"
    stop_requested = False

    for _ in range(epochs):
        for start in range(0, len(train_examples), batch_size):
            batch = train_examples[start : start + batch_size]
            lr = compute_scheduled_lr(
                base_lr, trainer.step + 1, total_steps, schedule=schedule, warmup=warmup
            )
            step_res = trainer.forward_backward(
                batch,
                loss_kind=loss_kind,
                beta=beta,
                temp=temp,
                reduction=reduction,
                lr=lr,
            )
            trainer.optim_step(lr)

            eval_loss, eval_metric = (
                trainer.evaluate(
                    eval_examples, loss_kind=loss_kind, beta=beta, temp=temp
                )
                if eval_examples
                else (step_res.loss, 1.0)
            )
            metric = step_metric_payload(
                step_res, eval_loss=eval_loss, eval_metric=eval_metric
            )
            metrics.append(metric)

            if eval_loss <= best_eval_loss:
                best_eval_loss = eval_loss
                best_state = trainer.save_state()

            if callbacks and callbacks.on_checkpoint and step_res.step % ckpt_every == 0:
                callbacks.on_checkpoint(
                    step_res.step,
                    round(eval_metric, 4),
                    trainer.save_state(),
                    {
                        "template_revision": config.get("template_revision", "qwen3@3"),
                        "thinking": config.get("thinking", "auto"),
                        "lr": lr,
                        "loss": step_res.loss,
                        "rule_version": config.get("rule_version", "auto@1"),
                    },
                )

            if callbacks and callbacks.on_step and callbacks.on_step(metric):
                stop_requested = True
                if max_cost_usd is not None and trainer.cost_usd >= max_cost_usd:
                    status = "stopped_budget"
                else:
                    status = "cancelled"
                break

            if max_cost_usd is not None and trainer.cost_usd >= max_cost_usd:
                status = "stopped_budget"
                stop_requested = True
                break

        if stop_requested:
            break

    if select == "best":
        trainer.resume_state(best_state)

    final_loss, final_metric = (
        trainer.evaluate(eval_examples, loss_kind=loss_kind, beta=beta, temp=temp)
        if eval_examples
        else (metrics[-1]["loss"] if metrics else 0.0, 1.0)
    )
    return LoopResult(
        status=status,
        metrics=metrics,
        best_eval_loss=best_eval_loss if best_eval_loss < float("inf") else final_loss,
        final_eval_loss=final_loss,
        final_eval_metric=final_metric,
    )


class RecipeRunner(Protocol):
    kind: str

    def run(
        self,
        config: dict[str, Any],
        records: Sequence[dict[str, Any]],
        *,
        max_cost_usd: float | None = None,
        callbacks: RunCallbacks | None = None,
    ) -> RunOutput: ...
