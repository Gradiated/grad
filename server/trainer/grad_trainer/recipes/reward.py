"""RewardModelRecipe: a scalar reward head on an LLM backbone (LoRA or frozen).

The input is the whole conversation (prompt plus the answer to score) rendered with the
pinned chat template, without a generation header; the feature is the final hidden state of
its last token, and ``reward_head.safetensors`` holds one float32 linear layer
(``weight [1, hidden_size]``, ``bias [1]``) that maps it to the raw reward ``r``. The score a
caller sees is ``sigmoid(r)``.

Objectives, from the records:

- pairwise (Bradley-Terry) on preference pairs, in the same formats as DPO: ``{"prompt",
  "chosen", "rejected"}`` (or the implicit-prompt ``trl`` form) and ``grad.trajectory/1``
  records sharing a ``group_id`` with ``role: chosen | rejected``. Loss
  ``-log sigmoid(r_chosen - r_rejected)``.
- pointwise, when ``recipe_params.rubric`` names a score: records ending in an assistant turn
  with ``scores[rubric]`` in ``[0, 1]`` train ``BCEWithLogits(r, score)``.

Both can be mixed in one run. Pairs stay on one side of the split (``by_group``). The
selection metric is held-out pair accuracy (``preference_accuracy``), or ``eval_loss`` when
there are no held-out pairs. The artifact is a ``reward_bundle``: the PEFT adapter (LoRA runs),
the head and ``reward_config.json``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as F

from ..backends.torch_common import chunk_by_tokens
from ..config import TrainSpec
from ..errors import RecipeConfigError, RecipeDataError
from ..trainer import EvalResult
from .base import RecipeRunner
from .classifier import PooledLMTask
from .data import TRAJECTORY_SCHEMA, record_id, record_messages
from .dpo import extract_pairs

REWARD_FORMAT_VERSION = 1


def split_pointwise(records: list[dict[str, Any]], score: str | None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(records for pairs, records scored pointwise under ``score``)."""
    if score is None:
        return records, []
    pairs, points = [], []
    for rec in records:
        is_pair = rec.get("chosen") is not None or (rec.get("schema") == TRAJECTORY_SCHEMA and rec.get("role") in ("chosen", "rejected"))
        value = (rec.get("scores") or {}).get(score)
        (points if value is not None and not is_pair else pairs).append(rec)
    return pairs, points


class RewardTask(PooledLMTask):
    kind = "reward"
    artifact_format = "reward_bundle"
    head_file = "reward_head.safetensors"

    def __init__(self, spec: TrainSpec, train: list[dict[str, Any]], held_out: list[dict[str, Any]], workdir: Path) -> None:
        super().__init__(spec, workdir)
        score = spec.params.get("rubric")
        if score is not None and (not isinstance(score, str) or not score):
            raise RecipeConfigError("RewardModelRecipe rubric must be the name of a score on your records.")
        self.score_name: str | None = score
        self.dropped = 0
        self.truncated = 0
        self.train = self._encode(train)
        self.held_out = self._encode(held_out)
        if not self.train:
            raise RecipeDataError(
                "RewardModelRecipe needs preference pairs ({prompt, chosen, rejected} or grad.trajectory/1 groups)"
                + (f" or answers with a '{score}' score in [0, 1]." if score else "; pass rubric= to also train on scored answers.")
            )
        if self.dropped:
            self.warnings.append(f"{self.dropped} records were not usable as pairs or scored answers and were dropped.")
        has_pairs = any(it["kind"] == "pair" for it in self.held_out)
        self.metric_name = "preference_accuracy" if has_pairs else "eval_loss"
        self.metric_mode = "max" if has_pairs else "min"
        self.build_backbone(torch.nn.Linear(self.hidden_size, 1))

    # -- encoding -----------------------------------------------------------------------------
    def _ids(self, messages: list[dict[str, Any]], rid: str) -> list[int]:
        ids = list(self.tokenize(self.render(messages, rid, train_on="all_assistant"), None).input_ids)
        if len(ids) > self.max_len:
            self.truncated += 1
            ids = ids[-self.max_len :]  # the pooled last token must survive
        return ids

    def _encode(self, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        pair_records, point_records = split_pointwise(records, self.score_name)
        pairs, dropped = extract_pairs(pair_records)
        self.dropped += dropped
        items: list[dict[str, Any]] = [
            {"kind": "pair", "chosen": self._ids(p + c, rid), "rejected": self._ids(p + r, rid)} for p, c, r, rid in pairs
        ]
        for index, rec in enumerate(point_records):
            messages = record_messages(rec)
            value = rec["scores"][self.score_name]
            if not messages or messages[-1].get("role") != "assistant":
                self.dropped += 1
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0.0 <= float(value) <= 1.0:
                raise RecipeDataError(f"Record '{record_id(rec, index)}': score '{self.score_name}' must be in [0, 1].")
            items.append({"kind": "point", "ids": self._ids(messages, record_id(rec, index)), "score": float(value)})
        return items

    @staticmethod
    def _sequences(item: dict[str, Any]) -> list[list[int]]:
        return [item["chosen"], item["rejected"]] if item["kind"] == "pair" else [item["ids"]]

    # -- loss -----------------------------------------------------------------------------------
    def _rewards(self, items: list[dict[str, Any]], *, grad: bool) -> torch.Tensor:
        sequences = [s for it in items for s in self._sequences(it)]
        return self.heads(self.pooled(sequences, grad=grad))[:, 0]

    def _losses(self, items: list[dict[str, Any]], rewards: torch.Tensor) -> tuple[torch.Tensor, list[dict[str, float]]]:
        losses, rows, cursor = [], [], 0
        for item in items:
            if item["kind"] == "pair":
                margin = rewards[cursor] - rewards[cursor + 1]
                losses.append(-F.logsigmoid(margin))
                rows.append({"kind": 0.0, "margin": float(margin.detach())})
                cursor += 2
            else:
                r = rewards[cursor]
                target = torch.tensor(item["score"], device=r.device)
                losses.append(F.binary_cross_entropy_with_logits(r, target))
                rows.append({"kind": 1.0, "error": (float(torch.sigmoid(r.detach())) - item["score"]) ** 2})
                cursor += 1
        return torch.stack(losses), rows

    def _chunks(self, indices: list[int], items: list[dict[str, Any]]) -> list[list[int]]:
        lengths = [max(len(s) for s in self._sequences(it)) for it in items]
        return chunk_by_tokens(indices, lengths, max(1, self.spec.micro_batch_tokens // 2))

    def num_train_items(self) -> int:
        return len(self.train)

    def item_tokens(self, index: int) -> int:
        return sum(len(s) for s in self._sequences(self.train[index]))

    def accumulate(self, indices: list[int]) -> dict[str, float]:
        total = 0.0
        margins: list[float] = []
        for chunk in self._chunks(indices, self.train):
            items = [self.train[i] for i in chunk]
            losses, rows = self._losses(items, self._rewards(items, grad=True))
            loss = losses.sum() / len(indices)
            loss.backward()
            total += float(loss.detach())
            margins += [r["margin"] for r in rows if r["kind"] == 0.0]
        stats = {"loss": total}
        if margins:
            stats["reward_margin"] = sum(margins) / len(margins)
            stats["reward_accuracy"] = sum(m > 0 for m in margins) / len(margins)
        return stats

    def _held_out(self) -> dict[str, Any]:
        loss = 0.0
        rows: list[dict[str, float]] = []
        with torch.no_grad():
            for chunk in self._chunks(list(range(len(self.held_out))), self.held_out):
                items = [self.held_out[i] for i in chunk]
                losses, part = self._losses(items, self._rewards(items, grad=False))
                loss += float(losses.sum())
                rows += part
        margins = [r["margin"] for r in rows if r["kind"] == 0.0]
        errors = [r["error"] for r in rows if r["kind"] == 1.0]
        return {
            "eval_loss": loss / len(rows),
            "preference_accuracy": sum(m > 0 for m in margins) / len(margins) if margins else None,
            "reward_margin": sum(margins) / len(margins) if margins else None,
            "pointwise_brier": sum(errors) / len(errors) if errors else None,
        }

    def evaluate(self) -> EvalResult | None:
        if not self.held_out:
            return None
        metrics = self._held_out()
        return EvalResult(score=metrics.pop(self.metric_name), metrics=metrics)

    # -- export -----------------------------------------------------------------------------------
    def reward_config(self) -> dict[str, Any]:
        objectives = sorted({"pairwise" if it["kind"] == "pair" else "pointwise" for it in self.train})
        return {
            "format": "reward_bundle",
            "format_version": REWARD_FORMAT_VERSION,
            **self.backbone_manifest(),
            "input_format": "chat template over the whole conversation (prompt + answer), no generation header",
            "head_file": self.head_file,
            "score": "sigmoid(head(last_token_hidden_state))",
            "objectives": objectives,
            "score_name": self.score_name,
        }

    def export(self, directory: Path) -> None:
        self.export_backbone(directory)
        (directory / "reward_config.json").write_text(json.dumps(self.reward_config(), indent=2, sort_keys=True))

    def manifest(self) -> dict[str, Any]:
        config = self.reward_config()
        return {**self.backbone_manifest(), "objectives": config["objectives"], "score_name": self.score_name}

    def final_report(self) -> dict[str, Any]:
        metrics = self._held_out() if self.held_out else {}
        warnings = []
        if not self.held_out:
            warnings.append("No held-out pairs or scored answers: eval metrics are null.")
        elif metrics.get("preference_accuracy") is None:
            warnings.append("No held-out pairs: preference_accuracy is null; selected by eval_loss.")
        count = lambda kind, items: sum(it["kind"] == kind for it in items)  # noqa: E731
        return {
            "preference_accuracy": metrics.get("preference_accuracy"),
            "reward_margin": metrics.get("reward_margin"),
            "eval_loss": metrics.get("eval_loss"),
            "pointwise_brier": metrics.get("pointwise_brier"),
            "train_pairs": count("pair", self.train),
            "eval_pairs": count("pair", self.held_out),
            "train_points": count("point", self.train),
            "eval_points": count("point", self.held_out),
            "dropped_records": self.dropped,
            "truncated": self.truncated,
            "warnings": warnings,
        }


class RewardRunner(RecipeRunner):
    kind = "reward"

    def split_strategy(self, spec: TrainSpec) -> str:
        # Keep both sides of a pair together: by_group falls back to session_id, then id.
        return "by_group" if spec.split.strategy == "by_session" else spec.split.strategy

    def build_task(self, spec, train, held_out, workdir, base):  # type: ignore[no-untyped-def]
        return RewardTask(spec, train, held_out, workdir)
