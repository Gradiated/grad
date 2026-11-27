"""Shared plumbing for the GPU smoke scripts: run one recipe for a few steps, bundle it like the
worker does (schema-validated), and print a JSON summary (tokens, cost, wall time, peak GPU
memory, eval report). Nothing here talks to grad-server; the scripts exercise the trainer on
real weights so the GPU validation agent (or a human) can check them on one GPU.

Run from the repository root with the trainer's pinned requirements installed (CUDA torch):

    PYTHONPATH=server/trainer python scripts/gpu-smoke/distill.py
    PYTHONPATH=server/trainer python scripts/gpu-smoke/reward.py

Weights resolve like the worker's: the built-in catalog map downloads from Hugging Face, or set
GRAD_MODEL_PATHS / GRAD_MODELS_MIRROR. Pass --allow-cpu to try a script without a GPU (slow
with real models). The quality checks (KL drops, pair accuracy above chance) are meant for real
models: the tiny random test models only exercise the plumbing. A failed check exits non-zero.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


def record_count(args: argparse.Namespace) -> int:
    """Records for about ``--steps`` steps of ``--batch-size`` after a 20% held-out split."""
    return round(args.steps * args.batch_size / 0.8)


def parser(description: str) -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=description)
    p.add_argument("--steps", type=int, default=8, help="about this many optimizer steps (default 8)")
    p.add_argument("--batch-size", type=int, default=4)
    p.add_argument("--lr", type=float, default=None, help="default: the recipe's auto lr")
    p.add_argument("--price", type=float, default=0.15, help="student $/M tokens for the cost line (catalog: Qwen3-0.6B)")
    p.add_argument("--workdir", type=Path, default=None, help="keep outputs here (default: a temp dir)")
    p.add_argument("--allow-cpu", action="store_true", help="run without CUDA")
    return p


def run(kind: str, config: dict[str, Any], records: list[dict[str, Any]], args: argparse.Namespace) -> dict[str, Any]:
    """Train on ``records`` (about 20% held out by the recipe's own split) for about ``--steps`` steps."""
    import torch

    from grad_trainer.bundles import bundle_directory, extract_bundle
    from grad_trainer.recipes import get_recipe_runner
    from grad_trainer.runner_types import Budget, RunCallbacks

    if not torch.cuda.is_available() and not args.allow_cpu:
        sys.exit("No CUDA device: run this on a GPU (or pass --allow-cpu).")
    workdir = args.workdir or Path(tempfile.mkdtemp(prefix=f"grad-smoke-{kind}-"))
    workdir.mkdir(parents=True, exist_ok=True)
    config = {
        **config,
        "batch_size": args.batch_size,
        "epochs": 1,
        "warmup": 0.0,
        "checkpoint_every_steps": 10_000,
        "split": {"strategy": "random", "eval_fraction": 0.2, "seed": 7},
        **({} if args.lr is None else {"lr": args.lr}),
    }
    metrics: list[dict[str, Any]] = []
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    out = get_recipe_runner(kind).run(
        config,
        records,
        budget=Budget(max_cost_usd=None, price_per_million_tokens=args.price),
        callbacks=RunCallbacks(on_step=lambda m: metrics.append(m) or False),
        workdir=workdir / "run",
    )
    wall = time.perf_counter() - started
    bundle = workdir / f"{kind}.grad.tar.gz"
    info = bundle_directory(out.artifact_dir, bundle, manifest={**out.manifest, "format": out.artifact_format}, eval_report=out.eval_report)
    extracted = workdir / "bundle"
    extract_bundle(bundle, extracted)
    summary = {
        "recipe": kind,
        "status": out.status,
        "format": out.artifact_format,
        "steps": len(metrics),
        "tokens_processed": out.tokens_processed,
        "cost_usd": round(out.tokens_processed * args.price / 1e6, 6),
        "wall_seconds": round(wall, 1),
        "tokens_per_second": round(out.tokens_processed / wall, 1) if wall else None,
        "peak_gpu_memory_gb": round(torch.cuda.max_memory_allocated() / 2**30, 2) if torch.cuda.is_available() else None,
        "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
        "bundle": {"path": str(bundle), "sha256": info.sha256, "size_bytes": info.size_bytes, "files": sorted(info.manifest["files"])},
        "losses": [round(m["loss"], 4) for m in metrics],
        "eval_report": out.eval_report,
    }
    return {"summary": summary, "bundle_dir": extracted, "output": out}


def report(summary: dict[str, Any], checks: dict[str, bool]) -> None:
    summary["checks"] = checks
    print(json.dumps(summary, indent=2, default=str))
    if not all(checks.values()):
        sys.exit(f"FAILED: {[name for name, ok in checks.items() if not ok]}")
