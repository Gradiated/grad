"""Decision Model recipe runner (choice / noul / score heads with calibration)."""

from __future__ import annotations

import json
from typing import Any, Sequence

from ..bundles import build_artifact_bundle
from ..templates import estimate_text_tokens
from ..trainer import CpuReferenceBackend, Trainer, TrainingExample
from .base import (
    RunCallbacks,
    RunOutput,
    price_for_model,
    run_training_loop,
    split_records,
)


def _extract_state_text(rec: dict[str, Any]) -> str:
    if rec.get("state") is not None:
        return json.dumps(rec["state"], sort_keys=True)
    if rec.get("messages"):
        return json.dumps(rec["messages"], sort_keys=True)
    return json.dumps(rec, sort_keys=True)


def _extract_target(rec: dict[str, Any]) -> float:
    scores = rec.get("scores") or {}
    if scores:
        first_val = next(iter(scores.values()))
        return max(0.0, min(1.0, float(first_val)))
    expected = rec.get("expected_output")
    if isinstance(expected, bool):
        return 1.0 if expected else 0.0
    if isinstance(expected, (int, float)):
        return max(0.0, min(1.0, float(expected)))
    return 1.0


class DecisionRunner:
    kind = "decision"

    def run(
        self,
        config: dict[str, Any],
        records: Sequence[dict[str, Any]],
        *,
        max_cost_usd: float | None = None,
        callbacks: RunCallbacks | None = None,
    ) -> RunOutput:
        split_cfg = config.get("split", {})
        train_raw, eval_raw = split_records(
            records,
            strategy=split_cfg.get("strategy", "by_session"),
            eval_fraction=float(split_cfg.get("eval_fraction", 0.15)),
            seed=int(split_cfg.get("seed", 42)),
        )

        def to_examples(rows: Sequence[dict[str, Any]]) -> list[TrainingExample]:
            return [
                TrainingExample(
                    text=_extract_state_text(r),
                    target=_extract_target(r),
                    tokens=max(16, estimate_text_tokens(_extract_state_text(r))),
                )
                for r in rows
            ]

        train_examples = to_examples(train_raw)
        eval_examples = to_examples(eval_raw)
        if not train_examples:
            raise ValueError("DecisionRunner requires at least one state record.")

        heads: dict[str, Any] = {}
        for rec in records:
            if isinstance(rec.get("questions"), dict):
                for q_name, q_spec in rec["questions"].items():
                    heads.setdefault(q_name, q_spec)
        if not heads:
            heads = {"outcome": {"kind": "score"}}

        backend = CpuReferenceBackend(dim=64, rank=8)
        trainer = Trainer(
            model=config["model"],
            price_per_million_tokens_usd=price_for_model(config["model"]),
            backend=backend,
        )
        loop = run_training_loop(
            trainer=trainer,
            train_examples=train_examples,
            eval_examples=eval_examples,
            config={**config, "epochs": config.get("epochs", 2)},
            loss_kind="cross_entropy",
            max_cost_usd=max_cost_usd,
            callbacks=callbacks,
        )

        ece = (
            sum(abs(backend.predict(ex.text) - ex.target) for ex in eval_examples)
            / len(eval_examples)
            if eval_examples
            else 0.0
        )
        decision_head = {
            "base_model": config["model"],
            "heads": heads,
            "temperature": 1.0,
        }
        eval_report = {
            "eval_loss": round(loop.final_eval_loss, 6),
            "eval_accuracy": round(loop.final_eval_metric, 4),
            "ece": round(ece, 4),
            "heads": sorted(heads.keys()),
        }
        manifest = {
            "recipe": "decision",
            "format": "decision_bundle",
            "base_model": config["model"],
            "heads": heads,
            "rule_version": config.get("rule_version", "auto@1"),
        }
        bundle = build_artifact_bundle(
            manifest=manifest,
            eval_report=eval_report,
            files={
                "decision_head.json": json.dumps(
                    decision_head, indent=2, sort_keys=True
                ).encode("utf-8"),
                "decision_weights.safetensors": backend.export_weights_safetensors(
                    metadata={"format": "decision_bundle", "base_model": config["model"]}
                ),
            },
        )
        return RunOutput(
            status=loop.status,
            artifact_format="decision_bundle",
            artifact_bytes=bundle,
            manifest=manifest,
            eval_report=eval_report,
            tokens_processed=trainer.tokens_processed,
            cost_usd=trainer.cost_usd,
            metrics=loop.metrics,
        )
