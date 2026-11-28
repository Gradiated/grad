"""DistillRecipe: a LoRA student on a smaller base learns from a teacher.

``rollout`` picks where the training tokens come from:

- ``on_policy`` (default). Every optimizer step the student samples an answer to each prompt
  in the batch (temperature 1, up to ``max_new_tokens``). The teacher, loaded in the trainer
  with the student's tokenizer, scores those exact tokens, and the student matches the
  teacher's top-k next-token distribution at every answer position
  (``losses.TopKKLDistill(top_k=32)``, the same KL as the cartridge recipe), averaged per
  answer and then over the batch. ``context_text`` (``context=``) is read by the teacher
  only: it is prepended to the teacher's system prompt, so the student learns to answer as
  if it had read it. The selection metric is ``eval_kl``: the student's KL to the teacher on
  the teacher's own greedy answers to the held-out prompts (computed once, before training);
  ``base_kl`` is the same KL for the untrained student.
- ``off_policy``. The server has the teacher answer every prompt once through the inference
  endpoint (a labeling eval) and sends those answers as the records; the student trains on
  them with cross-entropy, exactly like SFT. The selection metric is ``eval_loss``.

Metering (shared with ``server/api/src/distill-plan.ts``): an on-policy prompt costs
``2 * (student prompt + answer)`` tokens (the student writes the answer, then trains on it)
plus ``teacher_token_weight * (teacher prompt + answer)`` for the teacher's scoring, where the
weight is the teacher's catalog price over the student's. Each held-out answer costs the
teacher's generation and scoring once: ``2 * teacher_token_weight * (teacher prompt + answer)``. The artifact is a PEFT LoRA adapter on the student.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import torch

from ..backends import torch_common as tc
from ..backends.torch_task import TorchTask
from ..config import TrainSpec
from ..errors import RecipeConfigError, RecipeDataError
from ..runner_types import BaseArtifact
from ..trainer import EvalResult
from .base import RecipeRunner
from .cartridge import DEFAULT_SEPARATOR, topk_kl
from .data import prompt_messages, record_id
from .sft import SFTTask

DEFAULT_TOP_K = 32
DEFAULT_MAX_NEW_TOKENS = 256


def distill_settings(params: dict[str, Any]) -> tuple[str, int, int, float]:
    """(rollout kind, max_new_tokens, top_k, teacher_token_weight) from ``recipe_params``."""
    rollout = params.get("rollout") or {"kind": "on_policy"}
    if not isinstance(rollout, dict) or rollout.get("kind") not in ("on_policy", "off_policy"):
        raise RecipeConfigError("DistillRecipe rollout must be OnPolicy() or OffPolicy().")
    max_new = rollout.get("max_new_tokens", DEFAULT_MAX_NEW_TOKENS)
    if max_new in (None, "auto"):
        max_new = DEFAULT_MAX_NEW_TOKENS
    loss = params.get("loss") or {}
    top_k = loss.get("top_k", DEFAULT_TOP_K) if isinstance(loss, dict) else DEFAULT_TOP_K
    weight = params.get("teacher_token_weight", 1.0)
    if (
        isinstance(max_new, bool)
        or not isinstance(max_new, int)
        or max_new < 1
        or not isinstance(top_k, int)
        or top_k < 1
        or not isinstance(weight, (int, float))
        or not math.isfinite(weight)
        or weight < 0
    ):
        raise RecipeConfigError("max_new_tokens and top_k must be positive integers and teacher_token_weight >= 0.")
    return str(rollout["kind"]), max_new, top_k, float(weight)


def _teacher_id(spec: TrainSpec) -> str:
    teacher = str(spec.params.get("teacher") or "").strip().lower()
    if not teacher:
        raise RecipeConfigError("DistillRecipe needs a teacher.")
    return teacher


class OnPolicyDistillTask(TorchTask):
    kind = "distill"
    artifact_format = "peft_lora"
    metric_name = "eval_kl"
    metric_mode = "min"

    def __init__(self, spec: TrainSpec, train: list[dict[str, Any]], held_out: list[dict[str, Any]], workdir: Path) -> None:
        super().__init__(spec, workdir)
        _, self.max_new_tokens, self.top_k, self.teacher_weight = distill_settings(spec.params)
        self.teacher_id = _teacher_id(spec)
        context = spec.params.get("context_text")
        self.context = context if isinstance(context, str) and context.strip() else None

        self.resolved = self.resolve(spec.model, "causal_lm")
        self._template = self.template_revision(self.resolved)
        self.tokenizer = tc.load_tokenizer(self.resolved)
        teacher_resolved = self.resolve(self.teacher_id, "causal_lm")
        if teacher_resolved.model_id == self.resolved.model_id and self.context is None:
            raise RecipeConfigError("The teacher is the student; pass a larger teacher or a context.")
        if tc.load_tokenizer(teacher_resolved).get_vocab() != self.tokenizer.get_vocab():
            raise RecipeConfigError(
                f"Teacher '{self.teacher_id}' must share the student's tokenizer for token-level KL; "
                "use rollout=OffPolicy() to train on its answers instead."
            )
        self.teacher_repo = teacher_resolved.repo
        base_lm = self.load_lm(self.resolved)
        self.merge = bool(spec.adapter.get("merge_on_export", False))
        if self.merge:
            tc.check_merged_export_fits(base_lm)
        self.max_len = tc.model_max_len(base_lm, spec)
        if teacher_resolved.model_id == self.resolved.model_id:
            self.teacher = tc.load_causal_lm(self.resolved, self.device)
        else:
            self.teacher = tc.load_causal_lm(teacher_resolved, self.device)
        self.teacher.requires_grad_(False)
        self.eos_id = int(self.tokenizer.convert_tokens_to_ids("<|im_end|>"))
        self.pad_id = int(self.tokenizer.pad_token_id)

        self.skipped = 0
        self.train = self._prompts(train)
        self.held_out = self._prompts(held_out)
        if not self.train:
            raise RecipeDataError("DistillRecipe needs prompts: chat records with a user turn.")
        self.model, self.lora = self.lora_model(base_lm, self.resolved, None)
        self.lm = tc.base_causal_lm(self.model)
        self.init_optimizer(self.model)
        self.prepared = False
        self.base_kl: float | None = None
        self.answers = {"tokens": 0, "count": 0, "truncated": 0}

    # -- encoding -----------------------------------------------------------------------------
    def _teacher_messages(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if self.context is None:
            return messages
        if messages and messages[0].get("role") == "system":
            system = f"{self.context}{DEFAULT_SEPARATOR}{messages[0].get('content') or ''}"
            return [{"role": "system", "content": system}] + messages[1:]
        return [{"role": "system", "content": self.context}] + messages

    def _prompts(self, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        budget = self.max_len - self.max_new_tokens
        for index, rec in enumerate(records):
            messages = prompt_messages(rec)
            if not any(m.get("role") == "user" for m in messages):
                self.skipped += 1
                continue
            rid = record_id(rec, index)
            student = self.generation_ids(messages, rid)
            teacher = self.generation_ids(self._teacher_messages(messages), rid)
            if len(teacher) > budget or len(student) > budget:
                raise RecipeDataError(
                    f"Record '{rid}' leaves no room for a {self.max_new_tokens}-token answer within {self.max_len} "
                    "tokens; shorten the prompt or lower rollout.max_new_tokens."
                )
            out.append({"student": student, "teacher": teacher})
        return out

    def _tokens(self, item: dict[str, Any], answer: int) -> int:
        """Metered tokens of one prompt with an ``answer``-token reply (see the module doc)."""
        student = 2 * (len(item["student"]) + answer)
        return student + math.ceil(self.teacher_weight * (len(item["teacher"]) + answer))

    # -- generation and teacher scoring -------------------------------------------------------
    def _generate(self, model: Any, prompts: list[list[int]], *, sample: bool) -> list[list[int]]:
        from transformers import GenerationConfig

        width = max(len(p) for p in prompts)
        ids = torch.full((len(prompts), width), self.pad_id, dtype=torch.long)
        mask = torch.zeros((len(prompts), width), dtype=torch.long)
        for i, prompt in enumerate(prompts):  # left padding for batched generation
            ids[i, width - len(prompt) :] = torch.tensor(prompt, dtype=torch.long)
            mask[i, width - len(prompt) :] = 1
        config = GenerationConfig(
            max_new_tokens=self.max_new_tokens,
            do_sample=sample,
            temperature=1.0,
            top_k=0 if sample else 50,
            top_p=1.0,
            eos_token_id=self.eos_id,
            pad_token_id=self.pad_id,
            use_cache=True,
        )
        # Gradient checkpointing keeps the student in train mode, which disables the KV cache.
        training = model.training
        model.eval()
        try:
            with torch.no_grad():
                out = model.generate(input_ids=ids.to(self.device), attention_mask=mask.to(self.device), generation_config=config)
        finally:
            model.train(training)
        answers = []
        for row in out[:, width:].tolist():
            if self.eos_id in row:
                row = row[: row.index(self.eos_id) + 1]
            answers.append(row or [self.eos_id])
        return answers

    def _score(self, items: list[dict[str, Any]], answers: list[list[int]]) -> list[tuple[torch.Tensor, torch.Tensor]]:
        """The teacher's top-k (token ids, log-probs) at every answer position."""
        ids, mask = tc.padded_batch([it["teacher"] + a for it, a in zip(items, answers)], self.pad_id, self.device)
        out = []
        with torch.no_grad():
            hidden = self.teacher.model(input_ids=ids, attention_mask=mask).last_hidden_state
            for b, (item, answer) in enumerate(zip(items, answers)):
                start = len(item["teacher"]) - 1
                logits = self.teacher.lm_head(hidden[b, start : start + len(answer)]).float()
                top = torch.log_softmax(logits, dim=-1).topk(min(self.top_k, logits.shape[-1]), dim=-1)
                out.append((top.indices, top.values))
        return out

    def _kl(self, items: list[dict[str, Any]], answers: list[list[int]], targets: list[Any], *, grad: bool) -> torch.Tensor:
        ids, mask = tc.padded_batch([it["student"] + a for it, a in zip(items, answers)], self.pad_id, self.device)
        with torch.set_grad_enabled(grad):
            hidden = self.lm.model(input_ids=ids, attention_mask=mask).last_hidden_state
            losses = []
            for b, (item, answer, (top_ids, top_logp)) in enumerate(zip(items, answers, targets)):
                start = len(item["student"]) - 1
                h = hidden[b, start : start + len(answer)]
                losses.append(topk_kl(self.lm.lm_head(h), top_ids.to(self.device), top_logp.to(self.device)).mean())
        return torch.stack(losses)

    def _chunks(self, indices: list[int], items: list[dict[str, Any]]) -> list[list[int]]:
        lengths = [max(len(it["student"]), len(it["teacher"])) + self.max_new_tokens for it in items]
        return tc.chunk_by_tokens(indices, lengths, self.micro_batch_tokens)

    # -- held-out answers ---------------------------------------------------------------------
    def planned_prep_tokens(self) -> int:
        return sum(2 * math.ceil(self.teacher_weight * (len(it["teacher"]) + self.max_new_tokens)) for it in self.held_out)

    def prepare(self) -> int:
        tokens = 0
        for chunk in self._chunks(list(range(len(self.held_out))), self.held_out):
            items = [self.held_out[i] for i in chunk]
            answers = self._generate(self.teacher, [it["teacher"] for it in items], sample=False)
            for item, answer, target in zip(items, answers, self._score(items, answers)):
                item["answer"], item["target"] = answer, (target[0].cpu(), target[1].cpu())
                tokens += 2 * math.ceil(self.teacher_weight * (len(item["teacher"]) + len(answer)))
        self.prepared = True
        if self.held_out:
            with self.model.disable_adapter():
                self.base_kl = self._held_out_kl()
        return tokens

    def _held_out_kl(self) -> float:
        total = 0.0
        with torch.no_grad():
            for chunk in self._chunks(list(range(len(self.held_out))), self.held_out):
                items = [self.held_out[i] for i in chunk]
                kl = self._kl(items, [it["answer"] for it in items], [it["target"] for it in items], grad=False)
                total += float(kl.sum())
        return total / len(self.held_out)

    # -- loop protocol ------------------------------------------------------------------------
    def num_train_items(self) -> int:
        return len(self.train)

    def item_tokens(self, index: int) -> int:
        return self._tokens(self.train[index], self.max_new_tokens)

    def accumulate(self, indices: list[int]) -> dict[str, float]:
        total = 0.0
        metered = 0
        lengths: list[int] = []
        truncated = 0
        for chunk in self._chunks(indices, self.train):
            items = [self.train[i] for i in chunk]
            answers = self._generate(self.model, [it["student"] for it in items], sample=True)
            targets = self._score(items, answers)
            loss = self._kl(items, answers, targets, grad=True).sum() / len(indices)
            loss.backward()
            total += float(loss.detach())
            lengths += [len(a) for a in answers]
            truncated += sum(a[-1] != self.eos_id for a in answers)
            metered += sum(self._tokens(it, len(a)) for it, a in zip(items, answers))
        self.answers["tokens"] += sum(lengths)
        self.answers["count"] += len(lengths)
        self.answers["truncated"] += truncated
        return {
            "loss": total,
            "answer_tokens": sum(lengths) / len(lengths),
            "truncation_rate": truncated / len(lengths),
            "metered_tokens": float(metered),
        }

    def evaluate(self) -> EvalResult | None:
        if not self.held_out or not self.prepared:
            return None
        return EvalResult(score=self._held_out_kl(), metrics={})

    def export(self, directory: Path, params: dict[str, Any] | None = None) -> None:
        tc.export_peft_adapter(self.model, directory, self.resolved, state_dict=params)

    def export_final(self, directory: Path) -> None:
        if self.merge:
            tc.export_merged(self.model, self.tokenizer, directory, self.resolved)
            self.artifact_format = "merged_safetensors"
        else:
            self.export(directory)

    def manifest(self) -> dict[str, Any]:
        return {
            **self.base_manifest(self.resolved),
            "adapter": {**self.lora, "kind": "lora", "merge_on_export": self.merge},
            "teacher": self.teacher_id,
            "teacher_repo": self.teacher_repo,
            "rollout": {"kind": "on_policy", "max_new_tokens": self.max_new_tokens},
            "loss": {"kind": "topk_kl_distill", "top_k": self.top_k},
            "teacher_token_weight": self.teacher_weight,
            "context_tokens": 0 if self.context is None else len(self.tokenizer(self.context)["input_ids"]),
            "max_seq_len": self.max_len,
        }

    def final_report(self) -> dict[str, Any]:
        result = self.evaluate()
        eval_kl = None if result is None else result.score
        reduction = None
        if eval_kl is not None and self.base_kl:
            reduction = 1.0 - eval_kl / self.base_kl
        warnings = []
        if result is None:
            warnings.append("No held-out prompts: eval_kl is null.")
        if self.skipped:
            warnings.append(f"{self.skipped} records had no user prompt and were skipped.")
        count = self.answers["count"]
        if count and self.answers["truncated"] / count > 0.05:
            warnings.append(
                f"{self.answers['truncated']} of {count} student answers hit max_new_tokens={self.max_new_tokens}; "
                "raise rollout.max_new_tokens."
            )
        return {
            "eval_kl": eval_kl,
            "base_kl": self.base_kl,
            "kl_reduction": reduction,
            "teacher": self.teacher_id,
            "rollout": "on_policy",
            "train_examples": len(self.train),
            "eval_examples": len(self.held_out),
            "mean_answer_tokens": self.answers["tokens"] / count if count else None,
            "truncation_rate": self.answers["truncated"] / count if count else None,
            "skipped_records": self.skipped,
            "warnings": warnings,
        }


class OffPolicyDistillTask(SFTTask):
    """SFT on the teacher's answers (the labeling eval's records)."""

    kind = "distill"

    def __init__(
        self,
        spec: TrainSpec,
        train: list[dict[str, Any]],
        held_out: list[dict[str, Any]],
        workdir: Path,
        base: BaseArtifact | None = None,
    ) -> None:
        self.teacher_id = _teacher_id(spec)
        _, self.max_new_tokens, _, _ = distill_settings(spec.params)
        super().__init__(spec, train, held_out, workdir, base)

    def manifest(self) -> dict[str, Any]:
        return {
            **super().manifest(),
            "teacher": self.teacher_id,
            "rollout": {"kind": "off_policy", "max_new_tokens": self.max_new_tokens},
            "loss": {"kind": "cross_entropy"},
        }

    def final_report(self) -> dict[str, Any]:
        return {**super().final_report(), "teacher": self.teacher_id, "rollout": "off_policy"}


class DistillRunner(RecipeRunner):
    kind = "distill"

    def build_task(self, spec, train, held_out, workdir, base):  # type: ignore[no-untyped-def]
        rollout, *_ = distill_settings(spec.params)
        if rollout == "off_policy":
            return OffPolicyDistillTask(spec, train, held_out, workdir)
        return OnPolicyDistillTask(spec, train, held_out, workdir)
