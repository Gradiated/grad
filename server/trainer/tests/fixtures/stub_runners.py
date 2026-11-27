"""Recipe/import runner doubles for the worker's recipe-runner seam (grad_trainer.runner_types)."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from grad_trainer.runner_types import ImportSummary, RunOutput

#: The stable manifest fields of a peft_lora bundle (docs/ARTIFACT_FORMATS.md).
STUB_MANIFEST = {
    "recipe_kind": "sft",
    "base_model": "qwen/qwen3-0.6b",
    "base_model_repo": "Qwen/Qwen3-0.6B",
    "base_model_revision": "c1899de289a04d12100db370d81485cdf75e47ca",
    "deployable": True,
}


def write_lora(directory: Path) -> None:
    """A fake PEFT LoRA adapter whose adapter_config.json matches peft_lora.schema.json."""
    directory.mkdir(parents=True, exist_ok=True)
    config = {
        "peft_type": "LORA",
        "task_type": "CAUSAL_LM",
        "r": 8,
        "lora_alpha": 16,
        "target_modules": ["q_proj", "v_proj"],
        "base_model_name_or_path": STUB_MANIFEST["base_model_repo"],
        "revision": STUB_MANIFEST["base_model_revision"],
        "bias": "none",
    }
    (directory / "adapter_config.json").write_text(json.dumps(config))
    (directory / "adapter_model.safetensors").write_bytes(b"weights")


class StubRunner:
    """Recipe runner double: emits `steps` metrics, checkpoints at `checkpoint_at`,
    writes a real artifact dir; on a stop request it returns `cancelled` like the
    v0 recipes do."""

    def __init__(
        self,
        *,
        steps: int = 3,
        checkpoint_at: int | None = 2,
        raise_at: int | None = None,
        step_sleep: float = 0.0,
        status: str = "completed",
        manifest: dict[str, Any] | None = None,
    ) -> None:
        self.steps = steps
        self.checkpoint_at = checkpoint_at
        self.raise_at = raise_at
        self.step_sleep = step_sleep
        self.status = status
        self.manifest = manifest if manifest is not None else {**STUB_MANIFEST, "kind": "final"}
        self.calls: list[dict[str, Any]] = []

    def run(self, config, records, *, budget, callbacks, resume, workdir, base=None):  # type: ignore[no-untyped-def]
        resume_files = (
            sorted(p.name for p in resume.checkpoint_dir.iterdir()) if resume else None
        )
        self.calls.append(
            {
                "config": config,
                "records": list(records),
                "budget": budget,
                "resume": resume,
                "resume_files": resume_files,
                "base": base,
                "base_files": sorted(p.name for p in base.directory.iterdir()) if base else None,
            }
        )
        start = resume.step + 1 if resume else 1
        tokens = 0
        status = self.status
        for step in range(start, start + self.steps):
            if self.raise_at == step:
                raise RuntimeError("CUDA out of memory")
            tokens += 100
            if callbacks.on_step(
                {"step": step, "loss": 1.0 / step, "tokens": tokens, "cost_usd": 0.0}
            ):
                status = "cancelled"
                break
            if self.checkpoint_at == step:
                ckpt = Path(workdir) / f"ckpt-{step}"
                write_lora(ckpt)
                callbacks.on_checkpoint(
                    step, 0.5, ckpt, {"artifact_format": "peft_lora", "manifest": STUB_MANIFEST}
                )
            time.sleep(self.step_sleep)
        out = Path(workdir) / "artifact"
        write_lora(out)
        return RunOutput(
            status=status,
            artifact_dir=out,
            artifact_format="peft_lora",
            manifest=self.manifest,
            # Shaped like RecipeRunner's report: the server validates its core fields.
            eval_report={
                "metric_name": "eval_loss",
                "selected_step": start + self.steps - 1,
                "best_step": None,
                "final_step": start + self.steps - 1,
                "train_records": len(records),
                "eval_records": 0,
                "warnings": [],
                "eval_loss": 0.1,
            },
            tokens_processed=tokens // 2,
        )


class StubImporter:
    def __init__(self, *, batches: int = 2, batch_size: int = 3) -> None:
        self.batches = batches
        self.batch_size = batch_size
        self.sources: list[dict[str, Any]] = []

    def run(self, source, connector, *, emit_batch, workdir, source_page=None):  # type: ignore[no-untyped-def]
        self.sources.append(
            {
                **source,
                "content": Path(source["path"]).read_bytes()
                if source.get("kind") == "file"
                else None,
                "connector": connector,
            }
        )
        for b in range(self.batches):
            emit_batch(
                [
                    {"messages": [{"role": "user", "content": f"{b}-{i}"}]}
                    for i in range(self.batch_size)
                ]
            )
        return ImportSummary(
            records=self.batches * self.batch_size,
            skipped=1,
            errors=["line 4: invalid JSON (Expecting value)"],
        )
