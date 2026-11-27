"""Shared test helpers. Torch tests import ``torch_case`` and skip cleanly without torch."""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any

from fixtures.tiny_models import BERT_ID, QWEN_ID, QWEN_TEACHER_ID, ensure_tiny_models, torch_available

from grad_trainer.runner_types import Budget, ResumeState, RunCallbacks, RunOutput

__all__ = ["BERT_ID", "QWEN_ID", "QWEN_TEACHER_ID", "Recorder", "TempDirCase", "TorchCase", "run_recipe"]

os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")


class TempDirCase(unittest.TestCase):
    def tmpdir(self) -> Path:
        path = Path(tempfile.mkdtemp(prefix="grad-trainer-test-"))
        self.addCleanup(shutil.rmtree, path, True)
        return path


@unittest.skipUnless(torch_available(), "torch, transformers and peft are not installed")
class TorchCase(TempDirCase):
    """Base class for tests that train tiny real models (CPU, 4 threads)."""

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        import transformers

        transformers.utils.logging.set_verbosity_error()
        transformers.utils.logging.disable_progress_bar()
        ensure_tiny_models()


class Recorder:
    """Collects callback calls; copies checkpoint directories while they are valid."""

    def __init__(self, root: Path, stop_after: int | None = None) -> None:
        self.root = root
        self.stop_after = stop_after
        self.metrics: list[dict[str, Any]] = []
        self.checkpoints: list[tuple[int, float | None, Path, dict[str, Any]]] = []

    def on_step(self, metric: dict[str, Any]) -> bool:
        self.metrics.append(metric)
        return self.stop_after is not None and metric["step"] >= self.stop_after

    def on_checkpoint(self, step: int, score: float | None, directory: Path, metadata: dict[str, Any]) -> None:
        copy = self.root / f"ckpt-{step}-{len(self.checkpoints)}"
        shutil.copytree(directory, copy)
        self.checkpoints.append((step, score, copy, metadata))

    def callbacks(self) -> RunCallbacks:
        return RunCallbacks(on_step=self.on_step, on_checkpoint=self.on_checkpoint)


def run_recipe(
    kind: str,
    config: dict[str, Any],
    records: list[dict[str, Any]],
    workdir: Path,
    *,
    max_cost_usd: float | None = None,
    price: float = 1.0,
    recorder: Recorder | None = None,
    resume: ResumeState | None = None,
) -> RunOutput:
    from grad_trainer.recipes import get_recipe_runner

    return get_recipe_runner(kind).run(
        config,
        records,
        budget=Budget(max_cost_usd=max_cost_usd, price_per_million_tokens=price),
        callbacks=recorder.callbacks() if recorder else None,
        resume=resume,
        workdir=workdir,
    )
