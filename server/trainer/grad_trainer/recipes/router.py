"""Model Router recipe runner with temperature calibration & Pareto threshold solver."""

from __future__ import annotations

import json
import math
from typing import Any, Sequence

from ..bundles import build_artifact_bundle
from ..templates import estimate_text_tokens
from ..trainer import CpuReferenceBackend, Trainer, TrainingExample, sigmoid
from .base import (
    RunCallbacks,
    RunOutput,
    price_for_model,
    run_training_loop,
    split_records,
)


def _extract_prompt(rec: dict[str, Any]) -> str:
    if isinstance(rec.get("messages"), list):
        return "\n".join(
            f"{m.get('role', 'user')}: {m.get('content', '')}"
            for m in rec["messages"]
            if isinstance(m, dict)
        )
    return str(rec.get("prompt") or rec.get("query") or json.dumps(rec))


def _apply_temperature(prob: float, temperature: float) -> float:
    t = max(0.05, temperature)
    p = max(1e-6, min(1.0 - 1e-6, prob))
    logit = math.log(p / (1.0 - p))
    return sigmoid(logit / t)


def _calibrate_temperature(probs: Sequence[float], labels: Sequence[float]) -> float:
    """Grid-search scalar temperature T > 0 minimizing NLL on held-out split."""
    if not probs:
        return 1.0
    best_t = 1.0
    best_nll = float("inf")
    for idx in range(5, 31):
        t = idx / 10.0
        nll = 0.0
        for p, y in zip(probs, labels):
            cal_p = _apply_temperature(p, t)
            nll += -(
                y * math.log(max(cal_p, 1e-7))
                + (1.0 - y) * math.log(max(1.0 - cal_p, 1e-7))
            )
        if nll < best_nll:
            best_nll = nll
            best_t = t
    return round(best_t, 3)


def _solve_pareto_threshold(
    eval_pairs: Sequence[tuple[float, float, float]],
    *,
    max_quality_drop: float,
    cheap_cost: float,
    strong_cost: float,
) -> tuple[float, float, float]:
    """Select the lowest calibrated probability threshold keeping quality drop <= max_quality_drop."""
    if not eval_pairs:
        return 0.65, 0.5, 0.0

    baseline_quality = sum(strong_q for _, _, strong_q in eval_pairs) / len(eval_pairs)
    best_threshold = 0.95
    best_savings = 0.0
    best_drop = 0.0

    for step in range(5, 96, 5):
        thresh = step / 100.0
        routed_quality = 0.0
        routed_cost = 0.0
        for cal_prob, cheap_q, strong_q in eval_pairs:
            if cal_prob >= thresh:
                routed_quality += cheap_q
                routed_cost += cheap_cost
            else:
                routed_quality += strong_q
                routed_cost += strong_cost

        avg_quality = routed_quality / len(eval_pairs)
        avg_cost = routed_cost / len(eval_pairs)
        drop = max(0.0, baseline_quality - avg_quality)
        savings = max(0.0, 1.0 - (avg_cost / strong_cost)) if strong_cost > 0 else 0.0
        if drop <= max_quality_drop and savings >= best_savings:
            best_threshold = thresh
            best_savings = savings
            best_drop = drop

    return round(best_threshold, 4), round(best_savings, 4), round(best_drop, 4)


class RouterRunner:
    kind = "router"

    def run(
        self,
        config: dict[str, Any],
        records: Sequence[dict[str, Any]],
        *,
        max_cost_usd: float | None = None,
        callbacks: RunCallbacks | None = None,
    ) -> RunOutput:
        params = config.get("recipe_params", {})
        candidates = list(params.get("models") or ["qwen/qwen3-8b", "qwen/qwen3-32b"])
        if len(candidates) < 2:
            candidates.append("qwen/qwen3-32b")
        cheap_model, strong_model = candidates[0], candidates[-1]
        max_quality_drop = float(params.get("max_quality_drop", 0.02))

        split_cfg = config.get("split", {})
        train_raw, eval_raw = split_records(
            records,
            strategy=split_cfg.get("strategy", "by_session"),
            eval_fraction=float(split_cfg.get("eval_fraction", 0.15)),
            seed=int(split_cfg.get("seed", 42)),
        )

        def to_examples(rows: Sequence[dict[str, Any]]) -> list[TrainingExample]:
            out: list[TrainingExample] = []
            for rec in rows:
                prompt = _extract_prompt(rec)
                scores = rec.get("scores") or {}
                cheap_score = float(scores.get(cheap_model, scores.get("cheap", 0.85)))
                strong_score = float(
                    scores.get(strong_model, scores.get("strong", 0.95))
                )
                label = 1.0 if cheap_score >= strong_score - 0.05 else 0.0
                out.append(
                    TrainingExample(
                        text=prompt,
                        target=label,
                        tokens=max(16, estimate_text_tokens(prompt)),
                    )
                )
            return out

        train_examples = to_examples(train_raw)
        eval_examples = to_examples(eval_raw)
        if not train_examples:
            raise ValueError("RouterRunner requires at least one training record.")

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

        cal_source = eval_raw if eval_raw else train_raw
        raw_probs: list[float] = []
        labels: list[float] = []
        raw_qualities: list[tuple[float, float]] = []
        for rec in cal_source:
            prompt = _extract_prompt(rec)
            scores = rec.get("scores") or {}
            cheap_q = float(scores.get(cheap_model, scores.get("cheap", 0.85)))
            strong_q = float(scores.get(strong_model, scores.get("strong", 0.95)))
            raw_probs.append(backend.predict(prompt))
            labels.append(1.0 if cheap_q >= strong_q - 0.05 else 0.0)
            raw_qualities.append((cheap_q, strong_q))

        temperature = _calibrate_temperature(raw_probs, labels)
        calibrated_rows = [
            (_apply_temperature(p, temperature), cheap_q, strong_q)
            for p, (cheap_q, strong_q) in zip(raw_probs, raw_qualities)
        ]
        threshold, cost_savings, quality_drop = _solve_pareto_threshold(
            calibrated_rows,
            max_quality_drop=max_quality_drop,
            cheap_cost=price_for_model(cheap_model),
            strong_cost=price_for_model(strong_model),
        )

        router_config = {
            "candidates": candidates,
            "fallback_model": strong_model,
            "threshold": threshold,
            "temperature": temperature,
            "max_quality_drop": max_quality_drop,
        }
        eval_report = {
            "threshold": threshold,
            "temperature": temperature,
            "expected_cost_savings": cost_savings,
            "expected_quality_drop": quality_drop,
            "eval_records": len(cal_source),
        }
        manifest = {
            "recipe": "router",
            "format": "router_bundle",
            "base_model": config["model"],
            "router_config": router_config,
            "rule_version": config.get("rule_version", "auto@1"),
        }
        bundle = build_artifact_bundle(
            manifest=manifest,
            eval_report=eval_report,
            files={
                "router_config.json": json.dumps(
                    router_config, indent=2, sort_keys=True
                ).encode("utf-8"),
                "router_head.safetensors": backend.export_weights_safetensors(
                    metadata={"format": "router_bundle", "base_model": config["model"]}
                ),
            },
        )
        return RunOutput(
            status=loop.status,
            artifact_format="router_bundle",
            artifact_bytes=bundle,
            manifest=manifest,
            eval_report=eval_report,
            tokens_processed=trainer.tokens_processed,
            cost_usd=trainer.cost_usd,
            metrics=loop.metrics,
        )
