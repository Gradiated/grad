"""GPU memory helpers that never import torch themselves (the worker also runs without it)."""

from __future__ import annotations

import gc
import sys
from typing import Any

ALLOC_CONF = "expandable_segments:True"


def _torch() -> Any:
    return sys.modules.get("torch")


def _cuda_ready(torch: Any) -> bool:
    try:
        return bool(torch.cuda.is_available() and torch.cuda.is_initialized())
    except Exception:  # pragma: no cover - a broken CUDA install
        return False


def is_out_of_memory(exc: BaseException) -> bool:
    """True for torch's CUDA OOM, and for the allocator failures that surface as RuntimeError."""
    torch = _torch()
    oom_type = getattr(torch, "OutOfMemoryError", None) if torch is not None else None
    if oom_type is not None and isinstance(exc, oom_type):
        return True
    text = str(exc)
    return isinstance(exc, RuntimeError) and ("out of memory" in text.lower() or "CUBLAS_STATUS_ALLOC_FAILED" in text)


def describe_gpu() -> str:
    """`NVIDIA H100 80GB HBM3 (79.2 GiB, peak 78.4 GiB allocated)`, or `CPU` without CUDA."""
    torch = _torch()
    if torch is None or not _cuda_ready(torch):
        return "CPU"
    try:
        props = torch.cuda.get_device_properties(torch.cuda.current_device())
        peak = torch.cuda.max_memory_allocated() / 1024**3
        return f"{props.name} ({props.total_memory / 1024**3:.1f} GiB, peak {peak:.1f} GiB allocated)"
    except Exception:  # pragma: no cover - best effort for an error message
        return "a CUDA GPU"


def release_gpu_memory() -> None:
    """Drop unreachable tensors and hand cached GPU memory back to the driver.

    Call it after the job's runner and outputs are out of scope, so another process (or the
    next job) can use the memory.
    """
    gc.collect()
    torch = _torch()
    if torch is not None and _cuda_ready(torch):
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
