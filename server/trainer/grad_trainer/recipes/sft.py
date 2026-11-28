"""SFT: LoRA on a causal LM with assistant-only, thinking-aware loss masks and packing.

Examples in an optimizer batch are packed into rows of up to ``max_seq_len`` tokens. Each
example gets its own position ids and a block-diagonal causal mask, so no token attends
across examples. On CUDA a micro-batch is one unpadded row cut at example boundaries for varlen
flash attention (no dense mask); on CPU it is padded rows with a dense block-diagonal mask. ``reduction="per_example"`` averages the loss within each example and then
over the batch; ``"per_token"`` averages over every trained token in the batch. Both are
normalized over the whole optimizer batch, so micro-batching (gradient accumulation) gives
the same gradient as one big batch.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import torch

from ..backends import torch_common as tc
from ..backends.torch_task import TorchTask
from ..config import TrainSpec
from ..errors import RecipeDataError
from ..runner_types import BaseArtifact
from ..trainer import EvalResult
from .base import RecipeRunner
from .data import record_id, record_messages


class SFTTask(TorchTask):
    kind = "sft"
    metric_name = "eval_loss"
    metric_mode = "min"

    def __init__(
        self,
        spec: TrainSpec,
        train: list[dict[str, Any]],
        held_out: list[dict[str, Any]],
        workdir: Path,
        base: BaseArtifact | None = None,
    ) -> None:
        super().__init__(spec, workdir)
        self.resolved = self.resolve(spec.model, "causal_lm")
        self._template = self.template_revision(self.resolved)
        self.tokenizer = tc.load_tokenizer(self.resolved)
        base_lm = self.load_lm(self.resolved, packed=True)
        self.merge = bool(spec.adapter.get("merge_on_export", False))
        if self.merge:
            tc.check_merged_export_fits(base_lm)
        self.max_len = tc.model_max_len(base_lm, spec)
        self.varlen = base_lm.config._attn_implementation == tc.VARLEN_ATTENTION
        self.stats = {"skipped_no_messages": 0, "skipped_no_trained_tokens": 0, "truncated": 0}
        self.train_examples = self._encode(train)
        self.eval_examples = self._encode(held_out)
        if not self.train_examples:
            raise RecipeDataError("SFT needs at least one training record with a trained assistant turn.")
        self.model, self.lora = self.lora_model(base_lm, self.resolved, base)
        self.lm = tc.base_causal_lm(self.model)
        self.init_optimizer(self.model)
        self.artifact_format = "peft_lora"
        self.pad_id = int(self.tokenizer.pad_token_id)

    def _encode(self, records: list[dict[str, Any]]) -> list[tuple[tuple[int, ...], tuple[bool, ...]]]:
        out = []
        for index, rec in enumerate(records):
            messages = record_messages(rec)
            if not messages:
                self.stats["skipped_no_messages"] += 1
                continue
            rendered = self.render(messages, record_id(rec, index), tools=rec.get("tools"))
            tok = self.tokenize(rendered, self.max_len)
            self.stats["truncated"] += int(tok.truncated)
            if sum(tok.trained[1:]) == 0:
                self.stats["skipped_no_trained_tokens"] += 1
                continue
            out.append((tok.input_ids, tok.trained))
        return out

    def num_train_items(self) -> int:
        return len(self.train_examples)

    def item_tokens(self, index: int) -> int:
        return len(self.train_examples[index][0])

    def _losses(self, examples: list[tuple[tuple[int, ...], tuple[bool, ...]]], *, grad: bool) -> tuple[float, float, int]:
        """Batch loss under the configured reduction (backward when ``grad``)."""
        lengths = [len(e[0]) for e in examples]
        counts = torch.tensor([sum(e[1][1:]) for e in examples], dtype=torch.float32, device=self.device)
        total_trained = float(counts.sum())
        n = len(examples)
        loss_sum = 0.0
        correct_sum = 0.0
        rows = tc.pack_rows(lengths, self.max_len)
        for group in tc.group_rows(rows, lengths, self.micro_batch_tokens):
            batch = tc.collate_packed(group, examples, self.pad_id, self.device, varlen=self.varlen)
            with torch.set_grad_enabled(grad):
                losses, seg, correct = tc.packed_token_losses(self.lm, batch)
                if self.spec.reduction == "per_example":
                    loss = (losses / (counts[seg] * n)).sum()
                else:
                    loss = losses.sum() / total_trained
                if grad:
                    loss.backward()
            loss_sum += float(loss.detach())
            correct_sum += float(correct.sum())
        return loss_sum, correct_sum / max(total_trained, 1.0), int(total_trained)

    def accumulate(self, indices: list[int]) -> dict[str, float]:
        loss, accuracy, trained = self._losses([self.train_examples[i] for i in indices], grad=True)
        return {"loss": loss, "token_accuracy": accuracy, "trained_tokens": float(trained)}

    def evaluate(self) -> EvalResult | None:
        if not self.eval_examples:
            return None
        loss_sum = 0.0
        acc_weighted = 0.0
        total = 0
        # Evaluate in chunks of the training batch size; weight chunks so the result is the
        # same per-example (or per-token) mean over the whole eval set.
        chunk = self.spec.batch_size
        for start in range(0, len(self.eval_examples), chunk):
            part = self.eval_examples[start : start + chunk]
            loss, acc, trained = self._losses(part, grad=False)
            weight = len(part) if self.spec.reduction == "per_example" else trained
            loss_sum += loss * weight
            acc_weighted += acc * trained
            total += trained
        denom = len(self.eval_examples) if self.spec.reduction == "per_example" else total
        return EvalResult(
            score=loss_sum / denom,
            metrics={"eval_token_accuracy": acc_weighted / max(total, 1)},
        )

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
            "reduction": self.spec.reduction,
            "max_seq_len": self.max_len,
            "adapter": {**self.lora, "kind": "lora", "merge_on_export": self.merge},
            "packing": "block_diagonal",
        }

    def final_report(self) -> dict[str, Any]:
        result = self.evaluate()
        total = sum(len(e[0]) for e in self.train_examples)
        trained = sum(sum(e[1][1:]) for e in self.train_examples)
        report: dict[str, Any] = {
            "eval_loss": None if result is None else result.score,
            "eval_token_accuracy": None if result is None else result.metrics["eval_token_accuracy"],
            "train_examples": len(self.train_examples),
            "eval_examples": len(self.eval_examples),
            "trained_token_fraction": trained / total if total else 0.0,
            **self.stats,
            "warnings": [],
        }
        if result is None:
            report["warnings"].append("No held-out examples: eval_loss is null.")
        if self.stats["skipped_no_messages"]:
            report["warnings"].append(
                f"{self.stats['skipped_no_messages']} records had no prompt and answer to train on and were skipped."
            )
        if self.stats["skipped_no_trained_tokens"]:
            report["warnings"].append(
                f"{self.stats['skipped_no_trained_tokens']} records had no trained tokens left (train_on='{self.spec.train_on}', "
                f"max_seq_len {self.max_len}) and were skipped."
            )
        if self.stats["truncated"]:
            report["warnings"].append(
                f"{self.stats['truncated']} records were longer than {self.max_len} tokens and were truncated."
            )
        return report


class SFTRunner(RecipeRunner):
    kind = "sft"
    continues_adapters = True

    def build_task(self, spec, train, held_out, workdir, base):  # type: ignore[no-untyped-def]
        return SFTTask(spec, train, held_out, workdir, base)
