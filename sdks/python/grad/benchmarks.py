"""Standard benchmarks for ``client.evals.create(benchmarks=[...])``.

Each helper returns the ``BenchmarkSpec`` dict the API accepts. The v0 server does not
bundle benchmark data yet and answers ``501 benchmarks_unavailable`` (raised as
:class:`grad.FeatureUnavailableError`); import the benchmark with
``client.datasets.from_hf(...)`` and evaluate on that dataset instead.
"""

from __future__ import annotations

from typing import Any

__all__ = ["GPQADiamond", "GSM8K", "HumanEval", "IFEval", "LiveCodeBench", "MMLUPro"]


def _spec(name: str, limit: int | None) -> dict[str, Any]:
    if limit is not None and not 1 <= limit <= 10_000:
        raise ValueError(f"Benchmark limit must be between 1 and 10000, got {limit}.")
    out: dict[str, Any] = {"name": name}
    if limit is not None:
        out["limit"] = limit
    return out


def IFEval(limit: int | None = None) -> dict[str, Any]:
    """Instruction following (``ifeval``)."""
    return _spec("ifeval", limit)


def GSM8K(limit: int | None = None) -> dict[str, Any]:
    """Grade-school math (``gsm8k``)."""
    return _spec("gsm8k", limit)


def MMLUPro(limit: int | None = None) -> dict[str, Any]:
    """Broad knowledge and reasoning (``mmlu-pro``)."""
    return _spec("mmlu-pro", limit)


def GPQADiamond(limit: int | None = None) -> dict[str, Any]:
    """Graduate-level science (``gpqa-diamond``)."""
    return _spec("gpqa-diamond", limit)


def HumanEval(limit: int | None = None) -> dict[str, Any]:
    """Python coding (``humaneval``)."""
    return _spec("humaneval", limit)


def LiveCodeBench(limit: int | None = None) -> dict[str, Any]:
    """Contamination-resistant coding (``livecodebench``)."""
    return _spec("livecodebench", limit)
