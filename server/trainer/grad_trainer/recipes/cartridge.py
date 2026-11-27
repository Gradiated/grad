"""Cartridge (PrefixKV) recipe runner exporting gradiated.cartridge/1 safetensors."""

from __future__ import annotations

import json
import math
from typing import Any, Sequence

from ..bundles import build_artifact_bundle
from ..safetensors_io import encode_cartridge_safetensors
from ..templates import estimate_text_tokens
from ..trainer import CpuReferenceBackend, Trainer, TrainingExample, hash_features
from .base import (
    RunCallbacks,
    RunOutput,
    price_for_model,
    run_training_loop,
    split_records,
)


class CartridgeRunner:
    kind = "cartridge"

    def run(
        self,
        config: dict[str, Any],
        records: Sequence[dict[str, Any]],
        *,
        max_cost_usd: float | None = None,
        callbacks: RunCallbacks | None = None,
    ) -> RunOutput:
        adapter_cfg = config.get("adapter", {"kind": "prefix_kv", "num_tokens": 256})
        params = config.get("recipe_params", {})
        num_tokens = int(adapter_cfg.get("num_tokens", params.get("num_tokens", 256)))
        hidden_size = 64
        context_text = str(params.get("context_text") or "")

        split_cfg = config.get("split", {})
        train_raw, eval_raw = split_records(
            records,
            strategy=split_cfg.get("strategy", "by_session"),
            eval_fraction=float(split_cfg.get("eval_fraction", 0.1)),
            seed=int(split_cfg.get("seed", 42)),
        )

        def to_examples(rows: Sequence[dict[str, Any]]) -> list[TrainingExample]:
            out: list[TrainingExample] = []
            for rec in rows:
                text = f"{context_text}\n{json.dumps(rec, sort_keys=True)}"
                out.append(
                    TrainingExample(
                        text=text,
                        target=1.0,
                        tokens=max(16, estimate_text_tokens(text)),
                    )
                )
            return out

        train_examples = to_examples(train_raw)
        eval_examples = to_examples(eval_raw)
        if not train_examples:
            raise ValueError("CartridgeRunner requires at least one training record.")

        backend = CpuReferenceBackend(dim=hidden_size, rank=8)
        trainer = Trainer(
            model=config["model"],
            price_per_million_tokens_usd=price_for_model(config["model"]),
            backend=backend,
        )
        loop = run_training_loop(
            trainer=trainer,
            train_examples=train_examples,
            eval_examples=eval_examples,
            config={**config, "lr": config.get("lr", 1e-2)},
            loss_kind="cross_entropy",
            max_cost_usd=max_cost_usd,
            callbacks=callbacks,
        )

        context_vec = hash_features(context_text or config["name"], hidden_size)
        embeddings: list[float] = []
        for tok in range(num_tokens):
            phase = (tok + 1) / max(1, num_tokens)
            for dim_i in range(hidden_size):
                val = (
                    backend.weights[dim_i] * math.cos(phase * (dim_i + 1))
                    + context_vec[dim_i] * 0.1
                )
                embeddings.append(round(val, 6))

        cartridge_bytes = encode_cartridge_safetensors(
            embeddings=embeddings,
            num_tokens=num_tokens,
            hidden_size=hidden_size,
            base_model=config["model"],
            slot_token_ids=list(range(151646, 151646 + num_tokens)),
            separator="\n\n",
        )

        eval_report = {
            "eval_loss": round(loop.final_eval_loss, 6),
            "eval_accuracy": round(loop.final_eval_metric, 4),
            "num_tokens": num_tokens,
            "hidden_size": hidden_size,
            "cartridge_format": "gradiated.cartridge/1",
        }
        manifest = {
            "recipe": "cartridge",
            "format": "cartridge",
            "cartridge_format": "gradiated.cartridge/1",
            "base_model": config["model"],
            "num_tokens": num_tokens,
            "hidden_size": hidden_size,
            "placement": "system_prompt_start",
            "separator": "\n\n",
            "rule_version": config.get("rule_version", "auto@1"),
        }
        bundle = build_artifact_bundle(
            manifest=manifest,
            eval_report=eval_report,
            files={"cartridge.safetensors": cartridge_bytes},
        )
        return RunOutput(
            status=loop.status,
            artifact_format="cartridge",
            artifact_bytes=bundle,
            manifest=manifest,
            eval_report=eval_report,
            tokens_processed=trainer.tokens_processed,
            cost_usd=trainer.cost_usd,
            metrics=loop.metrics,
        )
