"""Supervised Fine-Tuning (SFT) recipe runner (LoRA)."""

from __future__ import annotations

import json
from typing import Any, Sequence

from ..bundles import build_artifact_bundle
from ..templates import estimate_text_tokens, render_messages
from ..trainer import CpuReferenceBackend, Trainer, TrainingExample
from .base import (
    RunCallbacks,
    RunOutput,
    price_for_model,
    run_training_loop,
    split_records,
)


def _records_to_sft_examples(
    records: Sequence[dict[str, Any]], config: dict[str, Any]
) -> list[TrainingExample]:
    examples: list[TrainingExample] = []
    for idx, rec in enumerate(records):
        rec_id = str(rec.get("id") or f"rec_{idx + 1}")
        messages = rec.get("messages")
        if messages:
            rendered = render_messages(
                rec_id,
                messages,
                model=config["model"],
                train_on=config.get("train_on", "last"),
                thinking=config.get("thinking", "auto"),
                preserve_thinking=bool(config.get("preserve_thinking", False)),
            )
            if rendered.trained_tokens <= 0:
                continue
            examples.append(
                TrainingExample(
                    text=rendered.full_text,
                    target=1.0,
                    tokens=rendered.total_tokens,
                )
            )
        else:
            text = f"{rec.get('prompt', '')}\n{rec.get('expected_output', '')}"
            examples.append(
                TrainingExample(
                    text=text,
                    target=1.0,
                    tokens=max(16, estimate_text_tokens(text)),
                )
            )
    return examples


class SFTRunner:
    kind = "sft"

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
        train_examples = _records_to_sft_examples(train_raw, config)
        eval_examples = _records_to_sft_examples(eval_raw, config)
        if not train_examples:
            raise ValueError("SFTRunner received zero trainable examples after masking.")

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
            config=config,
            loss_kind="cross_entropy",
            max_cost_usd=max_cost_usd,
            callbacks=callbacks,
        )

        eval_report = {
            "eval_loss": round(loop.final_eval_loss, 6),
            "eval_accuracy": round(loop.final_eval_metric, 4),
            "best_eval_loss": round(loop.best_eval_loss, 6),
            "train_examples": len(train_examples),
            "eval_examples": len(eval_examples),
            "steps": len(loop.metrics),
        }
        adapter_config = {
            "peft_type": "LORA",
            "base_model_name_or_path": config["model"],
            "r": rank,
            "lora_alpha": alpha,
            "target_modules": ["q_proj", "k_proj", "v_proj", "o_proj"],
            "merge_on_export": bool(adapter_cfg.get("merge_on_export", False)),
        }
        manifest = {
            "recipe": "sft",
            "format": "peft_lora",
            "base_model": config["model"],
            "template_revision": config.get("template_revision", "qwen3@3"),
            "thinking": config.get("thinking", "auto"),
            "lr": float(config.get("lr", 5e-4)),
            "rule_version": config.get("rule_version", "auto@1"),
            "adapter": adapter_config,
        }
        bundle = build_artifact_bundle(
            manifest=manifest,
            eval_report=eval_report,
            files={
                "adapter_config.json": json.dumps(
                    adapter_config, indent=2, sort_keys=True
                ).encode("utf-8"),
                "adapter_model.safetensors": backend.export_weights_safetensors(
                    metadata={
                        "format": "peft_lora",
                        "base_model": config["model"],
                        "template_revision": str(
                            config.get("template_revision", "qwen3@3")
                        ),
                        "rule_version": str(config.get("rule_version", "auto@1")),
                    }
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
