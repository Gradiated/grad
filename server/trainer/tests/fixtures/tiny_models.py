"""Tiny randomly initialised models and tokenizers built locally (no network) for tests.

They are the dev models of ``grad_trainer.dev_models`` (``grad local up --dev-models``).

Models are built once per process into ``$TMPDIR/grad-trainer-fixtures-<pid>`` and registered
through ``GRAD_MODEL_PATHS`` under the ids ``test/tiny-qwen3`` and ``test/tiny-bert``.
"""

from __future__ import annotations

import atexit
import json
import os
import shutil
import tempfile
from pathlib import Path

from grad_trainer.dev_models import BERT_ID, QWEN3_TEMPLATE, QWEN_ID, QWEN_TEACHER_ID, build_bert, build_qwen

__all__ = ["BERT_ID", "QWEN3_TEMPLATE", "QWEN_ID", "QWEN_TEACHER_ID", "ensure_tiny_models", "torch_available"]

_root: Path | None = None


def ensure_tiny_models() -> dict[str, Path]:
    """Build the tiny models once and register them in GRAD_MODEL_PATHS."""
    global _root
    if _root is None:
        import torch

        torch.set_num_threads(int(os.environ.get("GRAD_TEST_THREADS", "4")))
        _root = Path(tempfile.mkdtemp(prefix=f"grad-trainer-fixtures-{os.getpid()}-"))
        atexit.register(shutil.rmtree, _root, True)
        build_qwen(_root / "tiny-qwen3", seed=1)
        build_qwen(_root / "tiny-qwen3-teacher", seed=2)
        build_bert(_root / "tiny-bert", seed=3)
    paths = {
        QWEN_ID: _root / "tiny-qwen3",
        QWEN_TEACHER_ID: _root / "tiny-qwen3-teacher",
        BERT_ID: _root / "tiny-bert",
    }
    os.environ["GRAD_MODEL_PATHS"] = json.dumps({k: str(v) for k, v in paths.items()})
    os.environ["GRAD_OFFLINE"] = "1"
    return paths


def torch_available() -> bool:
    try:
        import peft  # noqa: F401
        import torch  # noqa: F401
        import transformers  # noqa: F401
    except ImportError:
        return False
    return True
