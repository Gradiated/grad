"""Evaluation statistics shared by recipes: binned ECE, bootstrap CIs, temperature scaling."""

from __future__ import annotations

import bisect
import math
import random
from typing import Callable, Sequence

ECE_BINS = 15
BOOTSTRAP_RESAMPLES = 1000


def expected_calibration_error(
    probs: Sequence[float], labels: Sequence[float], *, bins: int = ECE_BINS
) -> float | None:
    """Binned ECE with equal-width, right-inclusive bins, weighted by bin count.

    Bin ``i`` covers ``(i/bins, (i+1)/bins]``; ``p == 0`` goes to bin 0. Labels may be soft
    (in ``[0, 1]``). Empty bins are skipped. Returns None for no data.
    """
    if len(probs) != len(labels):
        raise ValueError("probs and labels must have the same length")
    if not probs:
        return None
    sums = [[0.0, 0.0, 0] for _ in range(bins)]
    edges = [(i + 1) / bins for i in range(bins)]
    for p, y in zip(probs, labels):
        idx = min(bins - 1, bisect.bisect_left(edges, p))
        sums[idx][0] += p
        sums[idx][1] += y
        sums[idx][2] += 1
    total = len(probs)
    return sum(abs(sp - sy) / n * (n / total) for sp, sy, n in sums if n)


def bootstrap_ci(
    values: Sequence[float],
    statistic: Callable[[Sequence[float]], float] | None = None,
    *,
    resamples: int = BOOTSTRAP_RESAMPLES,
    seed: int = 0,
    alpha: float = 0.05,
) -> tuple[float, float] | None:
    """Percentile bootstrap CI of ``statistic`` (default: mean) over ``values``."""
    if not values:
        return None
    stat = statistic or (lambda xs: sum(xs) / len(xs))
    rng = random.Random(seed)
    n = len(values)
    samples = sorted(stat([values[rng.randrange(n)] for _ in range(n)]) for _ in range(resamples))
    lo = samples[int(math.floor((alpha / 2) * (resamples - 1)))]
    hi = samples[int(math.ceil((1 - alpha / 2) * (resamples - 1)))]
    return lo, hi


def temperature_grid() -> list[float]:
    # Log-spaced 0.05 .. 20, plus exactly 1.0.
    grid = [math.exp(math.log(0.05) + i * (math.log(20.0) - math.log(0.05)) / 120) for i in range(121)]
    return sorted(set(grid + [1.0]))


def fit_temperature(nll_at: Callable[[float], float]) -> float:
    """Pick the temperature minimizing held-out NLL on a fixed grid (ties -> closest to 1)."""
    best_t, best = 1.0, nll_at(1.0)
    for t in temperature_grid():
        value = nll_at(t)
        if value < best - 1e-12 or (abs(value - best) <= 1e-12 and abs(math.log(t)) < abs(math.log(best_t))):
            best_t, best = t, value
    return best_t


def sigmoid(x: float) -> float:
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    z = math.exp(x)
    return z / (1.0 + z)


def binary_nll(logits: Sequence[float], labels: Sequence[float], temperature: float) -> float:
    total = 0.0
    for z, y in zip(logits, labels):
        p = min(1 - 1e-7, max(1e-7, sigmoid(z / temperature)))
        total -= y * math.log(p) + (1 - y) * math.log(1 - p)
    return total / max(1, len(logits))


def softmax(logits: Sequence[float], temperature: float = 1.0) -> list[float]:
    scaled = [z / temperature for z in logits]
    m = max(scaled)
    exps = [math.exp(z - m) for z in scaled]
    s = sum(exps)
    return [e / s for e in exps]


def per_class_report(
    labels: Sequence[str], predictions: Sequence[str], options: Sequence[str]
) -> dict[str, object]:
    """Accuracy, per-option precision/recall/F1/support, macro F1 and a confusion matrix."""
    index = {o: i for i, o in enumerate(options)}
    matrix = [[0] * len(options) for _ in options]
    for y, p in zip(labels, predictions):
        matrix[index[y]][index[p]] += 1
    per_option: dict[str, dict[str, float | int | None]] = {}
    f1s: list[float] = []
    for i, option in enumerate(options):
        tp = matrix[i][i]
        support = sum(matrix[i])
        predicted = sum(row[i] for row in matrix)
        precision = tp / predicted if predicted else None
        recall = tp / support if support else None
        f1 = (
            2 * precision * recall / (precision + recall)
            if precision is not None and recall is not None and (precision + recall) > 0
            else (0.0 if support else None)
        )
        if f1 is not None:
            f1s.append(f1)
        per_option[option] = {"precision": precision, "recall": recall, "f1": f1, "support": support}
    correct = sum(matrix[i][i] for i in range(len(options)))
    return {
        "accuracy": correct / len(labels) if labels else None,
        "macro_f1": sum(f1s) / len(f1s) if f1s else None,
        "per_option": per_option,
        "confusion_matrix": {"labels": list(options), "matrix": matrix},
    }
