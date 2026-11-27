"""Direct Preference Optimization (DPO) recipe runner (LoRA)."""

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


def _flatten_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(
            f"{m.get('role', 'user')}: {m.get('content', '')}"
            for m in value
            if isinstance(m, dict)
        )
    return json.dumps(value) if value is not None else ""


def _records_to_dpo_examples(records: Sequence[dict[str, Any]]) -> list[TrainingExample]:
    examples: list[TrainingExample] = []
    for rec in records:
        prompt = _flatten_text(rec.get("prompt") or rec.get("messages") or "")
        chosen = _flatten_text(rec.get("chosen") or rec.get("expected_output") or "")
        rejected = _flatten_text(rec.get("rejected") or "")
        if not chosen and not rejected:
            continue
        chosen_full = f"{prompt}\n{chosen}".strip()
        rejected_full = f"{prompt}\n{rejected}".strip()
        tokens = max(
            16, estimate_text_tokens(chosen_full) + estimate_text_tokens(rejected_full)
        )
        examples.append(
            TrainingExample(
                text=chosen_full,
                aux_text=rejected_full,
                target=1.0,
                tokens=tokens,
            )
        )
    return examples


class DPORunner:
    kind = "dpo"

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
            eval_fraction=float(split_cfg.get("eval_fraction", 0.1)),
            seed=int(split_cfg.get("seed", 42)),
        )
        train_examples = _records_to_dpo_examples(train_raw)
        eval_examples = _records_to_dpo_examples(eval_raw)
        if not train_examples:
            raise ValueError("DPORunner requires preference pairs with chosen/rejected.")

        params = config.get("recipe_params", {})
        beta = float(params.get("beta", 0.1))
        adapter_cfg = config.get("adapter", {"kind": "lora", "rank": 32, "alpha": 32})
        rank = int(adapter_cfg.get("rank", 32))
        alpha = int(adapter_cfg.get("alpha", 32))

        backend = CpuReferenceBackend(dim=64, rank=min(16, rank))
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
            loss_kind="dpo",
            beta=beta,
            max_cost_usd=max_cost_usd,
            callbacks=callbacks,
        )

        eval_report = {
            "eval_loss": round(loop.final_eval_loss, 6),
            "preference_accuracy": round(loop.final_eval_metric, 4),
            "beta": beta,
            "train_pairs": len(train_examples),
            "eval_pairs": len(eval_examples),
        }
        adapter_config = {
            "peft_type": "LORA",
            "base_model_name_or_path": config["model"],
            "r": rank,
            "lora_alpha": alpha,
            "beta": beta,
        }
        manifest = {
            "recipe": "dpo",
            "format": "peft_lora",
            "base_model": config["model"],
            "beta": beta,
            "template_revision": config.get("template_revision", "qwen3@3"),
            "rule_version": config.get("rule_version", "auto@1"),
        }
        bundle = build_artifact_bundle(
            manifest=manifest,
            eval_report=eval_report,
            files={
                "adapter_config.json": json.dumps(
                    adapter_config, indent=2, sort_keys=True
                ).encode("utf-8"),
                "adapter_model.safetensors": backend.export_weights_safetensors(
                    metadata={"format": "peft_lora", "recipe": "dpo"}
                ),
            },
        )
        return RunOutput(
            status=loop.status,
            artifact_format="peft_lora",
            artifact_bytes=bundle,
            manifest=manifest,
            eval_report=eval_report,
            tokens_processed=trainer.tokens_processed,
            cost_usd=trainer.cost_usd,
            metrics=loop.metrics,
        )
