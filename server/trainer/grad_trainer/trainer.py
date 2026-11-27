"""In-process Trainer primitive (forward_backward, optim_step, save/resume, export)."""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, field
from typing import Any, Protocol, Sequence

from .safetensors_io import TensorSpec, encode_safetensors

_TOKEN_RE = re.compile(r"[a-z0-9_]+")


def hash_features(text: str, dim: int = 64) -> list[float]:
    """Deterministic L2-normalized hashed bag-of-tokens feature vector."""
    vec = [0.0] * dim
    tokens = _TOKEN_RE.findall(text.lower())
    if not tokens:
        vec[0] = 1.0
        return vec

    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        idx = int.from_bytes(digest[:4], "big") % dim
        sign = 1.0 if (digest[4] & 1) == 0 else -1.0
        vec[idx] += sign

    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


def dot(a: Sequence[float], b: Sequence[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def sigmoid(x: float) -> float:
    clamped = max(-30.0, min(30.0, x))
    return 1.0 / (1.0 + math.exp(-clamped))


@dataclass(frozen=True)
class StepResult:
    step: int
    loss: float
    grad_norm: float
    tokens: int
    cost_usd: float
    lr: float


@dataclass
class TrainingExample:
    text: str
    target: float
    tokens: int
    aux_text: str | None = None
    negatives: tuple[str, ...] = ()
    weight: float = 1.0


class TrainerBackend(Protocol):
    def forward_backward(
        self,
        batch: Sequence[TrainingExample],
        *,
        loss_kind: str = "cross_entropy",
        beta: float = 0.1,
        temp: float = 0.05,
        reduction: str = "per_example",
    ) -> tuple[float, float, int]: ...

    def optim_step(self, lr: float, grad_clip: float = 1.0) -> None: ...

    def evaluate(
        self,
        batch: Sequence[TrainingExample],
        *,
        loss_kind: str = "cross_entropy",
        beta: float = 0.1,
        temp: float = 0.05,
    ) -> tuple[float, float]: ...

    def predict(self, text: str) -> float: ...

    def state_dict(self) -> dict[str, Any]: ...

    def load_state_dict(self, state: dict[str, Any]) -> None: ...

    def export_weights_safetensors(
        self, metadata: dict[str, str] | None = None
    ) -> bytes: ...


class CpuReferenceBackend:
    """Fast pure-Python LoRA/linear reference backend with real AdamW gradient updates.

    Runs with zero third-party dependencies for CI, unit tests, and `grad local up` CPU mode.
    """

    def __init__(
        self,
        *,
        dim: int = 64,
        rank: int = 8,
        seed: int = 42,
        weight_decay: float = 0.01,
    ) -> None:
        self.dim = dim
        self.rank = max(1, min(rank, dim))
        self.weight_decay = weight_decay
        self.weights = [0.0] * dim
        self.bias = 0.0
        self._m = [0.0] * dim
        self._v = [0.0] * dim
        self._mb = 0.0
        self._vb = 0.0
        self._grad_w = [0.0] * dim
        self._grad_b = 0.0
        self._step_t = 0
        self._seed = seed

    def _compute_loss_and_grads(
        self,
        batch: Sequence[TrainingExample],
        *,
        loss_kind: str,
        beta: float,
        temp: float,
        reduction: str,
        accumulate: bool,
    ) -> tuple[float, float, int, float]:
        if not batch:
            return 0.0, 0.0, 0, 0.0

        grad_w = [0.0] * self.dim
        grad_b = 0.0
        total_loss = 0.0
        total_tokens = 0
        correct = 0
        denom = 0.0

        for ex in batch:
            feats = hash_features(ex.text, self.dim)
            ex_weight = ex.weight * (ex.tokens if reduction == "per_token" else 1.0)
            denom += ex_weight
            total_tokens += ex.tokens

            if loss_kind == "dpo" and ex.aux_text is not None:
                rej_feats = hash_features(ex.aux_text, self.dim)
                diff = [c - r for c, r in zip(feats, rej_feats)]
                margin = beta * dot(self.weights, diff)
                prob = sigmoid(margin)
                loss = -math.log(max(prob, 1e-7))
                err = (prob - 1.0) * beta
                if margin > 0:
                    correct += 1
                if accumulate:
                    for i, d in enumerate(diff):
                        grad_w[i] += err * d * ex_weight
            elif loss_kind == "infonce" and ex.aux_text is not None:
                pos_feats = hash_features(ex.aux_text, self.dim)
                neg_texts = list(ex.negatives) + [
                    other.aux_text
                    for other in batch
                    if other is not ex and other.aux_text and other.aux_text != ex.aux_text
                ]
                scale_w = [1.0 + v for v in self.weights]
                inv_temp = 1.0 / max(temp, 1e-3)
                pos_logit = (
                    sum(scale_w[i] * feats[i] * pos_feats[i] for i in range(self.dim))
                    * inv_temp
                )
                neg_feat_list = [hash_features(nt, self.dim) for nt in neg_texts[:8]]
                logits = [pos_logit] + [
                    sum(scale_w[i] * feats[i] * nf[i] for i in range(self.dim))
                    * inv_temp
                    for nf in neg_feat_list
                ]
                max_logit = max(logits)
                exps = [math.exp(max(-40.0, min(40.0, lg - max_logit))) for lg in logits]
                sum_exp = sum(exps) or 1.0
                probs = [e / sum_exp for e in exps]
                loss = -math.log(max(probs[0], 1e-7))
                if pos_logit >= max(logits):
                    correct += 1
                if accumulate:
                    # dL/dw_i = inv_temp * f_i * ((p_0 - 1) * pos_i + sum_k p_k * neg_{k,i})
                    for i in range(self.dim):
                        weighted_neg = sum(
                            probs[k + 1] * neg_feat_list[k][i]
                            for k in range(len(neg_feat_list))
                        )
                        grad_w[i] += (
                            inv_temp
                            * feats[i]
                            * ((probs[0] - 1.0) * pos_feats[i] + weighted_neg)
                            * ex_weight
                        )
            else:
                logit = dot(self.weights, feats) + self.bias
                prob = sigmoid(logit)
                target = max(0.0, min(1.0, ex.target))
                loss = -(
                    target * math.log(max(prob, 1e-7))
                    + (1.0 - target) * math.log(max(1.0 - prob, 1e-7))
                )
                err = prob - target
                if (prob >= 0.5) == (target >= 0.5):
                    correct += 1
                if accumulate:
                    for i, f in enumerate(feats):
                        grad_w[i] += err * f * ex_weight
                    grad_b += err * ex_weight

            total_loss += loss * ex_weight

        scale = 1.0 / max(denom, 1e-8)
        avg_loss = total_loss * scale
        accuracy = correct / len(batch)

        if accumulate:
            for i in range(self.dim):
                self._grad_w[i] += grad_w[i] * scale
            self._grad_b += grad_b * scale
            grad_norm = math.sqrt(
                sum(g * g for g in self._grad_w) + self._grad_b * self._grad_b
            )
        else:
            grad_norm = 0.0

        return avg_loss, grad_norm, total_tokens, accuracy

    def forward_backward(
        self,
        batch: Sequence[TrainingExample],
        *,
        loss_kind: str = "cross_entropy",
        beta: float = 0.1,
        temp: float = 0.05,
        reduction: str = "per_example",
    ) -> tuple[float, float, int]:
        self._grad_w = [0.0] * self.dim
        self._grad_b = 0.0
        loss, grad_norm, tokens, _ = self._compute_loss_and_grads(
            batch,
            loss_kind=loss_kind,
            beta=beta,
            temp=temp,
            reduction=reduction,
            accumulate=True,
        )
        return loss, grad_norm, tokens

    def optim_step(self, lr: float, grad_clip: float = 1.0) -> None:
        self._step_t += 1
        norm = math.sqrt(
            sum(g * g for g in self._grad_w) + self._grad_b * self._grad_b
        )
        clip_scale = grad_clip / norm if norm > grad_clip > 0 else 1.0

        beta1, beta2, eps = 0.9, 0.999, 1e-8
        bias_c1 = 1.0 - beta1**self._step_t
        bias_c2 = 1.0 - beta2**self._step_t

        for i in range(self.dim):
            g = self._grad_w[i] * clip_scale
            self._m[i] = beta1 * self._m[i] + (1.0 - beta1) * g
            self._v[i] = beta2 * self._v[i] + (1.0 - beta2) * (g * g)
            m_hat = self._m[i] / bias_c1
            v_hat = self._v[i] / bias_c2
            self.weights[i] *= 1.0 - lr * self.weight_decay
            self.weights[i] -= lr * m_hat / (math.sqrt(v_hat) + eps)

        gb = self._grad_b * clip_scale
        self._mb = beta1 * self._mb + (1.0 - beta1) * gb
        self._vb = beta2 * self._vb + (1.0 - beta2) * (gb * gb)
        self.bias -= lr * (self._mb / bias_c1) / (math.sqrt(self._vb / bias_c2) + eps)

    def evaluate(
        self,
        batch: Sequence[TrainingExample],
        *,
        loss_kind: str = "cross_entropy",
        beta: float = 0.1,
        temp: float = 0.05,
    ) -> tuple[float, float]:
        loss, _, _, acc = self._compute_loss_and_grads(
            batch,
            loss_kind=loss_kind,
            beta=beta,
            temp=temp,
            reduction="per_example",
            accumulate=False,
        )
        return loss, acc

    def predict(self, text: str) -> float:
        return sigmoid(dot(self.weights, hash_features(text, self.dim)) + self.bias)

    def state_dict(self) -> dict[str, Any]:
        return {
            "dim": self.dim,
            "rank": self.rank,
            "weights": list(self.weights),
            "bias": self.bias,
            "m": list(self._m),
            "v": list(self._v),
            "mb": self._mb,
            "vb": self._vb,
            "step_t": self._step_t,
        }

    def load_state_dict(self, state: dict[str, Any]) -> None:
        self.dim = int(state["dim"])
        self.rank = int(state["rank"])
        self.weights = [float(x) for x in state["weights"]]
        self.bias = float(state["bias"])
        self._m = [float(x) for x in state["m"]]
        self._v = [float(x) for x in state["v"]]
        self._mb = float(state["mb"])
        self._vb = float(state["vb"])
        self._step_t = int(state["step_t"])

    def export_weights_safetensors(
        self, metadata: dict[str, str] | None = None
    ) -> bytes:
        lora_a = [
            self.weights[(i + r) % self.dim] * 0.1
            for r in range(self.rank)
            for i in range(self.dim)
        ]
        lora_b = [self.weights[i] for i in range(self.dim)]
        return encode_safetensors(
            [
                TensorSpec(
                    name="lora_A.weight",
                    dtype="F32",
                    shape=(self.rank, self.dim),
                    values=tuple(lora_a),
                ),
                TensorSpec(
                    name="lora_B.weight",
                    dtype="F32",
                    shape=(self.dim,),
                    values=tuple(lora_b),
                ),
                TensorSpec(
                    name="head.bias",
                    dtype="F32",
                    shape=(1,),
                    values=(self.bias,),
                ),
            ],
            metadata=metadata,
        )


class TorchLoRABackend:
    """Optional PyTorch/PEFT GPU backend loaded lazily when `grad-trainer[gpu]` is installed."""

    def __init__(self, model_id: str, rank: int = 32, alpha: int = 32) -> None:
        try:
            import torch  # noqa: F401
        except ImportError as exc:
            raise ImportError(
                "TorchLoRABackend requires the optional GPU dependencies: "
                "install with `pip install 'grad-trainer[gpu]'`."
            ) from exc
        self.model_id = model_id
        self.rank = rank
        self.alpha = alpha


def compute_scheduled_lr(
    base_lr: float,
    step: int,
    total_steps: int,
    *,
    schedule: str = "linear",
    warmup: float = 0.03,
) -> float:
    total = max(1, total_steps)
    warmup_steps = max(0, int(total * warmup))
    if warmup_steps > 0 and step <= warmup_steps:
        return base_lr * (step / warmup_steps)
    if schedule == "constant":
        return base_lr
    progress = min(
        1.0, max(0.0, (step - warmup_steps) / max(1, total - warmup_steps))
    )
    if schedule == "cosine":
        return base_lr * 0.5 * (1.0 + math.cos(math.pi * progress))
    return base_lr * max(0.05, 1.0 - progress)


@dataclass
class Trainer:
    """Minimal training loop primitive returning tokens and cost on every step."""

    model: str
    price_per_million_tokens_usd: float = 0.4
    backend: TrainerBackend = field(default_factory=CpuReferenceBackend)
    step: int = 0
    tokens_processed: int = 0
    cost_usd: float = 0.0

    def forward_backward(
        self,
        batch: Sequence[TrainingExample],
        *,
        loss_kind: str = "cross_entropy",
        beta: float = 0.1,
        temp: float = 0.05,
        reduction: str = "per_example",
        lr: float = 5e-4,
    ) -> StepResult:
        loss, grad_norm, tokens = self.backend.forward_backward(
            batch, loss_kind=loss_kind, beta=beta, temp=temp, reduction=reduction
        )
        self.step += 1
        self.tokens_processed += tokens
        self.cost_usd = round(
            (self.tokens_processed / 1_000_000.0) * self.price_per_million_tokens_usd,
            6,
        )
        return StepResult(
            step=self.step,
            loss=round(loss, 6),
            grad_norm=round(grad_norm, 6),
            tokens=self.tokens_processed,
            cost_usd=self.cost_usd,
            lr=lr,
        )

    def optim_step(self, lr: float, grad_clip: float = 1.0) -> None:
        self.backend.optim_step(lr, grad_clip=grad_clip)

    def evaluate(
        self,
        batch: Sequence[TrainingExample],
        *,
        loss_kind: str = "cross_entropy",
        beta: float = 0.1,
        temp: float = 0.05,
    ) -> tuple[float, float]:
        return self.backend.evaluate(
            batch, loss_kind=loss_kind, beta=beta, temp=temp
        )

    def save_state(self) -> bytes:
        payload = {
            "model": self.model,
            "step": self.step,
            "tokens_processed": self.tokens_processed,
            "cost_usd": self.cost_usd,
            "backend": self.backend.state_dict(),
        }
        return json.dumps(payload, sort_keys=True).encode("utf-8")

    def resume_state(self, state_bytes: bytes) -> None:
        payload = json.loads(state_bytes.decode("utf-8"))
        self.step = int(payload["step"])
        self.tokens_processed = int(payload["tokens_processed"])
        self.cost_usd = float(payload["cost_usd"])
        self.backend.load_state_dict(payload["backend"])
