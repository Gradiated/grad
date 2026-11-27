"""Reference backend: a stdlib-only TEST DOUBLE, selected with ``GRAD_TRAINER_BACKEND=reference``.

It runs the real training loop (batching, metering, budget, checkpoints, resume, callbacks)
over a hashed bag-of-words logistic model, so control-plane tests can exercise the worker
protocol without torch. It does not train the base model: artifacts are ``format: reference``
with ``deployable: false`` and must never be served. Token counts are whitespace words, not
tokenizer tokens.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any

from ..config import TrainSpec
from ..errors import RecipeDataError
from ..recipes.base import RecipeRunner
from ..trainer import EvalResult

DIM = 64
_TOKEN = re.compile(r"\w+", re.UNICODE)
_TEXT_FIELDS = ("messages", "prompt", "chosen", "rejected", "query", "positive", "state", "input", "output")


def features(text: str) -> list[float]:
    vec = [0.0] * DIM
    for token in _TOKEN.findall(text.lower()) or [""]:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        vec[int.from_bytes(digest[:4], "big") % DIM] += 1.0 if digest[4] & 1 else -1.0
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


def record_text(rec: dict[str, Any]) -> str:
    parts = [json.dumps(rec[f], sort_keys=True, ensure_ascii=False) for f in _TEXT_FIELDS if rec.get(f) is not None]
    return "\n".join(parts)


class ReferenceTask:
    artifact_format = "reference"
    metric_name = "eval_loss"
    metric_mode = "min"

    def __init__(self, kind: str, spec: TrainSpec, train: list[dict[str, Any]], held_out: list[dict[str, Any]]) -> None:
        self.kind = kind
        self.spec = spec
        self.warnings = ["Reference test backend: the base model was not trained; the artifact is not deployable."]
        self.train = [(features(t), len(t.split()) + 1) for t in map(record_text, train) if t]
        self.held_out = [features(t) for t in map(record_text, held_out) if t]
        if not self.train:
            raise RecipeDataError("No usable training records.")
        self.w = [0.0] * DIM
        self.b = 0.0
        self.m = [0.0] * (DIM + 1)
        self.v = [0.0] * (DIM + 1)
        self.t = 0

    def _loss(self, x: list[float]) -> tuple[float, float]:
        z = sum(wi * xi for wi, xi in zip(self.w, x)) + self.b
        p = 1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, z))))
        return -math.log(max(p, 1e-7)), p - 1.0  # target 1.0

    def num_train_items(self) -> int:
        return len(self.train)

    def item_tokens(self, index: int) -> int:
        return self.train[index][1]

    def train_step(self, indices: list[int], lr: float) -> dict[str, float]:
        grad = [0.0] * (DIM + 1)
        total = 0.0
        for i in indices:
            x, _ = self.train[i]
            loss, err = self._loss(x)
            total += loss / len(indices)
            for d in range(DIM):
                grad[d] += err * x[d] / len(indices)
            grad[DIM] += err / len(indices)
        norm = math.sqrt(sum(g * g for g in grad))
        clip = self.spec.optimizer.grad_clip
        scale = clip / norm if clip > 0 and norm > clip else 1.0
        b1, b2 = self.spec.optimizer.betas
        self.t += 1
        params = self.w + [self.b]
        for d, g in enumerate(grad):
            g *= scale
            self.m[d] = b1 * self.m[d] + (1 - b1) * g
            self.v[d] = b2 * self.v[d] + (1 - b2) * g * g
            m_hat = self.m[d] / (1 - b1**self.t)
            v_hat = self.v[d] / (1 - b2**self.t)
            params[d] -= lr * m_hat / (math.sqrt(v_hat) + self.spec.optimizer.eps)
        self.w, self.b = params[:DIM], params[DIM]
        return {"loss": total, "grad_norm": norm}

    def evaluate(self) -> EvalResult | None:
        if not self.held_out:
            return None
        return EvalResult(score=sum(self._loss(x)[0] for x in self.held_out) / len(self.held_out), metrics={})

    def _write(self, path: Path, payload: dict[str, Any]) -> None:
        path.mkdir(parents=True, exist_ok=True)
        (path / "reference_state.json").write_text(json.dumps(payload, sort_keys=True))

    def _read(self, path: Path) -> dict[str, Any]:
        return json.loads((path / "reference_state.json").read_text())

    def save_weights(self, directory: Path) -> None:
        self._write(directory, {"w": self.w, "b": self.b})

    def load_weights(self, directory: Path) -> None:
        state = self._read(directory)
        self.w, self.b = [float(x) for x in state["w"]], float(state["b"])

    def save_state(self, directory: Path) -> None:
        self._write(directory, {"m": self.m, "v": self.v, "t": self.t})

    def load_state(self, directory: Path) -> None:
        state = self._read(directory)
        self.m, self.v, self.t = state["m"], state["v"], int(state["t"])

    def export(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "reference_model.json").write_text(
            json.dumps(
                {"format": "reference", "deployable": False, "recipe": self.kind, "weights": self.w, "bias": self.b},
                sort_keys=True,
            )
        )

    def manifest(self) -> dict[str, Any]:
        return {"base_model": self.spec.model, "deployable": False, "backend": "reference"}

    def final_report(self) -> dict[str, Any]:
        result = self.evaluate()
        return {
            "eval_loss": None if result is None else result.score,
            "reference_backend": True,
            "train_examples": len(self.train),
            "eval_examples": len(self.held_out),
            "warnings": [] if result else ["No held-out examples: eval_loss is null."],
        }


class ReferenceRunner(RecipeRunner):
    backend = "reference"

    def __init__(self, kind: str) -> None:
        self.kind = kind

    def build_task(self, spec, train, held_out, workdir, base):  # type: ignore[no-untyped-def]
        return ReferenceTask(self.kind, spec, train, held_out)
