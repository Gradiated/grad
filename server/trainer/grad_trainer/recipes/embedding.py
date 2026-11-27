"""Embedding recipe runner (InfoNCE contrastive loss + mean pooling on full encoder)."""

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


def _records_to_embedding_examples(
    records: Sequence[dict[str, Any]],
) -> list[TrainingExample]:
    examples: list[TrainingExample] = []
    for rec in records:
        query = str(rec.get("query") or rec.get("prompt") or "")
        positive = str(rec.get("positive") or rec.get("expected_output") or "")
        if not query and not positive:
            continue
        raw_negs = rec.get("negatives") or []
        negatives = tuple(str(n) for n in raw_negs if n)
        tokens = max(
            16,
            estimate_text_tokens(query)
            + estimate_text_tokens(positive)
            + sum(estimate_text_tokens(n) for n in negatives),
        )
        examples.append(
            TrainingExample(
                text=query,
                aux_text=positive,
                negatives=negatives,
                target=1.0,
                tokens=tokens,
            )
        )
    return examples


class EmbeddingRunner:
    kind = "embedding"

    def run(
        self,
        config: dict[str, Any],
        records: Sequence[dict[str, Any]],
        *,
        max_cost_usd: float | None = None,
        callbacks: RunCallbacks | None = None,
    ) -> RunOutput:
        params = config.get("recipe_params", {})
        temp = float(params.get("temp", 0.05))

        split_cfg = config.get("split", {})
        train_raw, eval_raw = split_records(
            records,
            strategy=split_cfg.get("strategy", "by_session"),
            eval_fraction=float(split_cfg.get("eval_fraction", 0.1)),
            seed=int(split_cfg.get("seed", 42)),
        )
        train_examples = _records_to_embedding_examples(train_raw)
        eval_examples = _records_to_embedding_examples(eval_raw)
        if not train_examples:
            raise ValueError("EmbeddingRunner requires query/positive pairs.")

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
            config={**config, "lr": config.get("lr", 2e-5)},
            loss_kind="infonce",
            temp=temp,
            max_cost_usd=max_cost_usd,
            callbacks=callbacks,
        )

        encoder_config = {
            "base_model": config["model"],
            "adapter": "encoder_full",
            "pooling": "mean",
            "normalize": True,
            "temp": temp,
            "dimensions": 64,
        }
        eval_report = {
            "eval_loss": round(loop.final_eval_loss, 6),
            "recall_at_1": round(loop.final_eval_metric, 4),
            "temp": temp,
            "train_pairs": len(train_examples),
            "eval_pairs": len(eval_examples),
        }
        manifest = {
            "recipe": "embedding",
            "format": "encoder_safetensors",
            "base_model": config["model"],
            "pooling": "mean",
            "rule_version": config.get("rule_version", "auto@1"),
        }
        bundle = build_artifact_bundle(
            manifest=manifest,
            eval_report=eval_report,
            files={
                "config.json": json.dumps(
                    encoder_config, indent=2, sort_keys=True
                ).encode("utf-8"),
                "model.safetensors": backend.export_weights_safetensors(
                    metadata={"format": "encoder_safetensors", "pooling": "mean"}
                ),
            },
        )
        return RunOutput(
            status=loop.status,
            artifact_format="encoder_safetensors",
            artifact_bytes=bundle,
            manifest=manifest,
            eval_report=eval_report,
            tokens_processed=trainer.tokens_processed,
            cost_usd=trainer.cost_usd,
            metrics=loop.metrics,
        )
