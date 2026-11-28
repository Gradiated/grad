"""DPO: a LoRA policy against a frozen reference, the starting point of the run.

The reference is the base model with the adapter disabled or, when the run continues an
earlier artifact (for example SFT then DPO), that artifact's adapter, scored once before
any update.

Loss (``losses.DPO(beta)``, sigmoid form)::

    margin = beta * ((logp_policy(chosen) - logp_ref(chosen)) - (logp_policy(rejected) - logp_ref(rejected)))
    loss   = -log(sigmoid(margin))

where ``logp`` sums log-probabilities over the completion tokens. Accepted records:

- ``{"prompt": str | messages, "chosen": str | messages, "rejected": str | messages}``;
  with no ``prompt``, the shared leading messages of ``chosen``/``rejected`` are the prompt
  (the ``trl`` implicit-prompt format, e.g. ``trl-lib/ultrafeedback_binarized``).
- ``grad.trajectory/1`` records sharing a ``group_id`` with ``role: "chosen" | "rejected"``.

Pairs always stay on the same side of the split (``by_session`` is applied ``by_group``).
"""

from __future__ import annotations

import contextlib
import math
from pathlib import Path
from typing import Any

import numpy as np
import torch
import torch.nn.functional as F

from ..backends import torch_common as tc
from ..backends.torch_task import TorchTask
from ..config import TrainSpec
from ..errors import RecipeConfigError, RecipeDataError
from ..runner_types import BaseArtifact
from ..trainer import EvalResult
from .base import RecipeRunner
from .data import Pair, iter_pairs

def dpo_loss(
    policy_chosen: torch.Tensor,
    policy_rejected: torch.Tensor,
    ref_chosen: torch.Tensor,
    ref_rejected: torch.Tensor,
    beta: float,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Per-pair sigmoid DPO loss and reward margin."""
    margin = beta * ((policy_chosen - ref_chosen) - (policy_rejected - ref_rejected))
    return -F.logsigmoid(margin), margin


def resolve_beta(params: dict[str, Any]) -> float:
    loss = params.get("loss")
    beta = params.get("beta")
    if isinstance(loss, dict):
        kind = str(loss.get("kind", loss.get("type", "dpo"))).lower()
        beta = loss.get("beta", beta)
    else:
        kind = str(loss or "dpo").lower()
    if kind not in ("dpo", "sigmoid"):
        raise RecipeConfigError(
            f"DPORecipe supports loss=losses.DPO(beta=...) in v0; '{kind}' needs a custom loop."
        )
    beta = 0.1 if beta is None else float(beta)
    if not math.isfinite(beta) or beta <= 0:
        raise RecipeConfigError("DPO beta must be a positive number.")
    return beta


class DPOTask(TorchTask):
    kind = "dpo"
    metric_name = "preference_accuracy"
    metric_mode = "max"
    artifact_format = "peft_lora"

    def __init__(
        self,
        spec: TrainSpec,
        train: list[dict[str, Any]],
        held_out: list[dict[str, Any]],
        workdir: Path,
        base: BaseArtifact | None = None,
    ) -> None:
        super().__init__(spec, workdir)
        self.beta = resolve_beta(spec.params)
        self.resolved = self.resolve(spec.model, "causal_lm")
        self._template = self.template_revision(self.resolved)
        self.tokenizer = tc.load_tokenizer(self.resolved)
        base_lm = self.load_lm(self.resolved)
        self.max_len = tc.model_max_len(base_lm, spec)
        self.truncated = 0
        # Pairs are encoded as they are read: only their tokens are kept.
        self.dropped = 0  # _encode adds pairs with nothing left to train
        dropped = [0]
        self.train_pairs = [p for p in (self._encode(pair) for pair in iter_pairs(train, dropped)) if p]
        self.eval_pairs = [p for p in (self._encode(pair) for pair in iter_pairs(held_out, dropped)) if p]
        self.dropped += dropped[0]
        if not self.train_pairs:
            raise RecipeDataError(
                "DPO needs preference pairs: records with non-empty, different 'chosen' and 'rejected' "
                "(or grad.trajectory/1 records sharing a group_id with role chosen/rejected)."
            )
        if self.dropped:
            self.warnings.append(f"{self.dropped} records were not usable as preference pairs and were dropped.")
        self.model, self.lora = self.lora_model(base_lm, self.resolved, base)
        self.lm = tc.base_causal_lm(self.model)
        self.init_optimizer(self.model)
        self.pad_id = int(self.tokenizer.pad_token_id)
        self._ref_cache: dict[tuple[str, int], tuple[float, float]] = {}
        # The reference model is the starting point: the base model with the adapter
        # disabled, or the starting artifact's adapter, scored before any update.
        self.reference_model = "base model (adapter disabled)"
        if base is not None:
            self.reference_model = f"starting artifact {base.artifact_id}"
            self._score_reference("train", self.train_pairs)
            self._score_reference("eval", self.eval_pairs)

    def _encode_side(self, prompt: list[dict[str, Any]], completion: list[dict[str, Any]], rid: str) -> tuple[np.ndarray, np.ndarray] | None:
        messages = [{**m, "train": False} if m.get("role") == "assistant" else dict(m) for m in prompt]
        messages += [{**m, "train": True} for m in completion]
        tok = self.tokenize(self.render(messages, rid), self.max_len)
        self.truncated += int(tok.truncated)
        if not tok.trained[1:].any():
            return None
        return tok.input_ids, tok.trained

    def _encode(self, pair: Pair) -> tuple[Any, Any] | None:
        prompt, chosen, rejected, rid = pair
        c = self._encode_side(prompt, chosen, rid)
        r = self._encode_side(prompt, rejected, rid)
        if c is None or r is None:
            self.dropped += 1
            return None
        return c, r

    def num_train_items(self) -> int:
        return len(self.train_pairs)

    def item_tokens(self, index: int) -> int:
        c, r = self.train_pairs[index]
        return len(c[0]) + len(r[0])

    def _sequence_logps(self, sequences: list[tuple[np.ndarray, np.ndarray]]) -> torch.Tensor:
        ids, mask = tc.padded_batch([s[0] for s in sequences], self.pad_id, self.device)
        trained = torch.zeros_like(ids, dtype=torch.bool)
        for i, (_, t) in enumerate(sequences):
            trained[i, : len(t)] = torch.tensor(t, dtype=torch.bool)
        hidden = self.lm.model(input_ids=ids, attention_mask=mask).last_hidden_state
        target = trained[:, 1:]
        losses, _ = tc.chunked_cross_entropy(self.lm.lm_head, hidden[:, :-1][target], ids[:, 1:][target])
        token_logp = -losses
        rows = torch.arange(ids.shape[0], device=self.device)[:, None].expand_as(target)[target]
        return torch.zeros(ids.shape[0], device=self.device).index_add(0, rows, token_logp)

    def _score_reference(self, split: str, pairs: list[Any]) -> None:
        lengths = [max(len(c[0]), len(r[0])) for c, r in pairs]
        for chunk in tc.chunk_by_tokens(range(len(pairs)), lengths, max(1, self.micro_batch_tokens // 2)):
            self._reference(split, chunk, pairs, adapter=True)

    def _reference(
        self, split: str, indices: list[int], pairs: list[Any], *, adapter: bool = False
    ) -> tuple[torch.Tensor, torch.Tensor]:
        missing = [i for i in indices if (split, i) not in self._ref_cache]
        if missing:
            seqs = [s for i in missing for s in pairs[i]]
            with torch.no_grad(), contextlib.nullcontext() if adapter else self.model.disable_adapter():
                logps = self._sequence_logps(seqs).tolist()
            for k, i in enumerate(missing):
                self._ref_cache[(split, i)] = (logps[2 * k], logps[2 * k + 1])
        ref = [self._ref_cache[(split, i)] for i in indices]
        return (
            torch.tensor([r[0] for r in ref], device=self.device),
            torch.tensor([r[1] for r in ref], device=self.device),
        )

    def _run(self, split: str, indices: list[int], *, grad: bool) -> dict[str, float]:
        pairs = self.train_pairs if split == "train" else self.eval_pairs
        lengths = [max(len(pairs[i][0][0]), len(pairs[i][1][0])) for i in range(len(pairs))]
        n = len(indices)
        totals = {"loss": 0.0, "margin": 0.0, "accuracy": 0.0, "chosen_reward": 0.0, "rejected_reward": 0.0}
        for chunk in tc.chunk_by_tokens(indices, lengths, max(1, self.micro_batch_tokens // 2)):
            ref_c, ref_r = self._reference(split, chunk, pairs)
            with torch.set_grad_enabled(grad):
                logps = self._sequence_logps([s for i in chunk for s in pairs[i]])
                pol_c, pol_r = logps[0::2], logps[1::2]
                losses, margins = dpo_loss(pol_c, pol_r, ref_c, ref_r, self.beta)
                loss = losses.sum() / n
                if grad:
                    loss.backward()
            totals["loss"] += float(loss.detach())
            totals["margin"] += float(margins.detach().sum()) / n
            totals["accuracy"] += float((margins.detach() > 0).float().sum()) / n
            totals["chosen_reward"] += float((self.beta * (pol_c - ref_c)).detach().sum()) / n
            totals["rejected_reward"] += float((self.beta * (pol_r - ref_r)).detach().sum()) / n
        return totals

    def accumulate(self, indices: list[int]) -> dict[str, float]:
        t = self._run("train", indices, grad=True)
        return {
            "loss": t["loss"],
            "reward_margin": t["margin"],
            "reward_accuracy": t["accuracy"],
            "chosen_reward": t["chosen_reward"],
            "rejected_reward": t["rejected_reward"],
        }

    def evaluate(self) -> EvalResult | None:
        if not self.eval_pairs:
            return None
        t = self._run("eval", list(range(len(self.eval_pairs))), grad=False)
        return EvalResult(
            score=t["accuracy"],
            metrics={"eval_loss": t["loss"], "eval_reward_margin": t["margin"]},
        )

    def export(self, directory: Path, params: dict[str, Any] | None = None) -> None:
        tc.export_peft_adapter(self.model, directory, self.resolved, state_dict=params)

    def manifest(self) -> dict[str, Any]:
        return {
            **self.base_manifest(self.resolved),
            "loss": {"kind": "dpo", "beta": self.beta},
            "reference_model": self.reference_model,
            "max_seq_len": self.max_len,
            "adapter": {**self.lora, "kind": "lora"},
        }

    def final_report(self) -> dict[str, Any]:
        result = self.evaluate()
        report: dict[str, Any] = {
            "preference_accuracy": None if result is None else result.score,
            "eval_loss": None if result is None else result.metrics["eval_loss"],
            "reward_margin": None if result is None else result.metrics["eval_reward_margin"],
            "beta": self.beta,
            "train_pairs": len(self.train_pairs),
            "eval_pairs": len(self.eval_pairs),
            "dropped_records": self.dropped,
            "truncated": self.truncated,
            "warnings": [] if result else ["No held-out pairs: preference_accuracy is null."],
        }
        return report


class DPORunner(RecipeRunner):
    kind = "dpo"
    continues_adapters = True

    def split_strategy(self, spec: TrainSpec) -> str:
        # Keep both sides of a pair together: by_group falls back to session_id, then id.
        return "by_group" if spec.split.strategy == "by_session" else spec.split.strategy

    def build_task(self, spec, train, held_out, workdir, base):  # type: ignore[no-untyped-def]
        return DPOTask(spec, train, held_out, workdir, base)
