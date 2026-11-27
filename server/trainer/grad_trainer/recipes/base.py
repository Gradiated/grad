"""The recipe runner seam: ``runner.run(config, records, *, budget, callbacks, resume, workdir)``."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, Sequence

from ..config import TrainSpec, parse_train_spec
from ..errors import RecipeConfigError
from ..runner_types import BaseArtifact, Budget, ResumeState, RunCallbacks, RunOutput
from ..splits import split_records
from ..trainer import TrainingLoop, TrainingTask


class RecipeRunner:
    """Base runner: parse config, split, build the recipe's task, run the shared loop, export."""

    kind = ""
    backend = "torch"
    #: Whether the recipe can start from an earlier artifact's LoRA adapter.
    continues_adapters = False

    def build_task(
        self,
        spec: TrainSpec,
        train: list[dict[str, Any]],
        held_out: list[dict[str, Any]],
        workdir: Path,
        base: BaseArtifact | None,
    ) -> TrainingTask:  # pragma: no cover - abstract
        raise NotImplementedError

    def split_strategy(self, spec: TrainSpec) -> str:
        return spec.split.strategy

    def prepare_records(self, spec: TrainSpec, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Hook to annotate records before the split (e.g. grouping keys)."""
        return records

    def run(
        self,
        config: dict[str, Any],
        records: Sequence[dict[str, Any]],
        *,
        budget: Budget,
        callbacks: RunCallbacks | None = None,
        resume: ResumeState | None = None,
        workdir: Path,
        base: BaseArtifact | None = None,
    ) -> RunOutput:
        spec = parse_train_spec(self.kind, config)
        if (base is not None) != (spec.base_artifact_id is not None):
            raise RecipeConfigError(
                "The run config's base_artifact and the starting adapter the worker loaded don't match."
            )
        if base is not None and not self.continues_adapters:
            raise RecipeConfigError(f"Recipe '{self.kind}' can't continue training from an artifact.")
        if base is not None and base.artifact_id != spec.base_artifact_id:
            raise RecipeConfigError(
                f"Worker loaded artifact '{base.artifact_id}', but the run starts from '{spec.base_artifact_id}'."
            )
        workdir = Path(workdir)
        workdir.mkdir(parents=True, exist_ok=True)
        train, held_out = split_records(
            self.prepare_records(spec, list(records)),
            strategy=self.split_strategy(spec),
            eval_fraction=spec.split.eval_fraction,
            seed=spec.split.seed,
        )
        task = self.build_task(spec, train, held_out, workdir, base)

        common = {
            "recipe_kind": self.kind,
            "backend": self.backend,
            "lr": spec.lr,
            "lr_source": spec.lr_source,
            "rule_version": spec.rule_version,
            "seed": spec.seed,
            "select": spec.select,
            "base_artifact": spec.base_artifact_id,
            **task.manifest(),
        }
        loop = TrainingLoop(
            task,
            spec,
            budget=budget,
            callbacks=callbacks,
            resume=resume,
            workdir=workdir,
            checkpoint_metadata={**common, "manifest": common},
        ).run()

        # Report on the selected weights before export: a merged export consumes the adapter.
        report = task.final_report()
        artifact_dir = workdir / "artifact"
        shutil.rmtree(artifact_dir, ignore_errors=True)
        artifact_dir.mkdir(parents=True)
        export_final = getattr(task, "export_final", task.export)
        export_final(artifact_dir)

        warnings = list(task.warnings) + loop.warnings + list(report.pop("warnings", []))
        eval_report = {
            **report,
            "metric_name": task.metric_name,
            "metric_mode": task.metric_mode,
            "selected_step": loop.selected_step,
            "best_step": loop.best_step,
            "final_step": loop.step,
            "train_records": len(train),
            "eval_records": len(held_out),
            "warnings": warnings,
        }
        manifest = {
            **common,
            **task.manifest(),
            "kind": "final",
            "format": task.artifact_format,
            "status": loop.status,
            "select": loop.select,
            "selected_step": loop.selected_step,
            "steps_completed": loop.step,
            "total_steps": loop.total_steps,
            "tokens_total": loop.tokens_total,
        }
        return RunOutput(
            status=loop.status,
            artifact_dir=artifact_dir,
            artifact_format=task.artifact_format,
            manifest=manifest,
            eval_report=eval_report,
            tokens_processed=loop.tokens_total - loop.tokens_at_start,
        )
