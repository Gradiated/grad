"""Context Cartridge: learned input embeddings distilled from the model reading the context.

The artifact is ``cartridge.safetensors`` in the ``gradiated.cartridge/1`` format consumed by
the serving stack (docs/CARTRIDGE_SERVING_PLAN.md): ``embeddings [K, hidden_size]`` (bf16) and
``slot_token_ids [K]`` (int64), placed at the start of the system prompt and followed by
``separator``. After prefill the cartridge is ordinary KV cache, i.e. a learned KV prefix.

Training mirrors serving exactly. The student prompt's system message is
``slot_text + separator + <original system>``, where ``slot_text`` is ``K`` copies of a reserved
special token (``<|vision_pad|>`` on Qwen3 by default) that tokenizes to exactly ``K`` ids; the
input embeddings at those positions are replaced by the trainable cartridge. The teacher
(``teacher=``, default: the same base model) reads ``context + separator + <original system>``
instead, answers each prompt greedily, and the student is trained to match the teacher's
top-k next-token distribution on those answers (``losses.TopKKLDistill(top_k=20)``). The
cartridge is initialised from the token embeddings of the context's first ``K`` tokens.

The selection metric is the held-out top-k KL to the teacher; the report also gives the KL of
the base model with no context at all, so the gain is visible.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import torch
from safetensors.torch import save_file

from ..backends import torch_common as tc
from ..backends.torch_task import TorchTask
from ..config import TrainSpec
from ..errors import RecipeConfigError, RecipeDataError
from ..safetensors_io import CARTRIDGE_FORMAT
from ..trainer import EvalResult
from .base import RecipeRunner
from .data import prompt_messages, record_id

SLOT_TOKEN_CANDIDATES = ("<|vision_pad|>", "<|image_pad|>", "<|video_pad|>", "<|fim_pad|>")
DEFAULT_SEPARATOR = "\n\n"


def topk_kl(student_logits: torch.Tensor, teacher_ids: torch.Tensor, teacher_logp: torch.Tensor) -> torch.Tensor:
    """KL(teacher_topk || student) per position, teacher renormalized over its top-k."""
    p = torch.softmax(teacher_logp, dim=-1)
    log_q = torch.log_softmax(student_logits.float(), dim=-1).gather(-1, teacher_ids)
    return (p * (torch.log(p.clamp_min(1e-30)) - log_q)).sum(-1)


class CartridgeTask(TorchTask):
    kind = "cartridge"
    artifact_format = "cartridge"
    metric_name = "eval_kl"
    metric_mode = "min"

    def __init__(self, spec: TrainSpec, train: list[dict[str, Any]], held_out: list[dict[str, Any]], workdir: Path) -> None:
        super().__init__(spec, workdir)
        params = spec.params
        self.context = params.get("context_text")
        if not isinstance(self.context, str) or not self.context.strip():
            if params.get("context_uri"):
                raise RecipeConfigError(
                    "CartridgeRecipe got context_uri but no context_text; the server must resolve the "
                    "URI and pass the text (the trainer does not fetch URIs)."
                )
            raise RecipeConfigError("CartridgeRecipe needs a non-empty context.")
        self.num_tokens = int(spec.adapter.get("num_tokens", params.get("num_tokens", 256)))
        self.separator = str(params.get("separator", DEFAULT_SEPARATOR))
        self.max_new_tokens = int(params.get("max_new_tokens", 256))
        loss = params.get("loss") or {}
        self.top_k = int(loss.get("top_k", 20) if isinstance(loss, dict) else 20)
        if self.num_tokens < 1 or self.max_new_tokens < 1 or self.top_k < 1:
            raise RecipeConfigError("num_tokens, max_new_tokens and top_k must be positive.")

        self.resolved = self.resolve(spec.model, "causal_lm")
        self._template = self.template_revision(self.resolved)
        self.tokenizer = tc.load_tokenizer(self.resolved)
        self.base = tc.load_causal_lm(self.resolved, self.device)
        self.base.requires_grad_(False)
        self.teacher_id = str(params.get("teacher") or spec.model).strip().lower()
        self.teacher = self.base
        if self.teacher_id != self.resolved.model_id:
            teacher_resolved = self.resolve(self.teacher_id, "causal_lm")
            if tc.load_tokenizer(teacher_resolved).get_vocab() != self.tokenizer.get_vocab():
                raise RecipeConfigError(
                    f"Teacher '{self.teacher_id}' must share the student's tokenizer for token-level KL."
                )
            self.teacher = tc.load_causal_lm(teacher_resolved, self.device)
            self.teacher.requires_grad_(False)

        max_pos = int(getattr(self.base.config, "max_position_embeddings", 32768))
        if self.num_tokens >= max_pos:
            raise RecipeConfigError(f"num_tokens must be below the model's context length ({max_pos}).")
        self.max_len = tc.model_max_len(self.base, spec)
        self.slot_token, self.slot_id = self._slot_token(params.get("slot_token"))
        self.eos_id = int(self.tokenizer.convert_tokens_to_ids("<|im_end|>"))
        self.pad_id = int(self.tokenizer.pad_token_id)

        self.skipped = 0
        self.train = self._prompts(train)
        self.held_out = self._prompts(held_out)
        if not self.train:
            raise RecipeDataError("CartridgeRecipe needs prompts (chat records ending in a user turn).")

        embed = self.base.get_input_embeddings().weight
        context_ids = self.tokenizer(self.context, add_special_tokens=False)["input_ids"] or [self.pad_id]
        init = [context_ids[i % len(context_ids)] for i in range(self.num_tokens)]
        self.cartridge = torch.nn.Parameter(embed[torch.tensor(init, device=self.device)].detach().float().clone())
        self.hidden_size = int(embed.shape[1])
        self.params = {"cartridge": self.cartridge}
        self.optimizer = tc.make_optimizer([self.cartridge], spec)
        self.prepared = False
        self.no_context_kl: float | None = None

    def _slot_token(self, requested: Any) -> tuple[str, int]:
        vocab = self.tokenizer.get_vocab()
        names = [requested] if requested else [t for t in SLOT_TOKEN_CANDIDATES if t in vocab]
        for name in names:
            if name not in vocab:
                break
            ids = self.tokenizer(name * 3, add_special_tokens=False)["input_ids"]
            if ids == [vocab[name]] * 3:
                return name, vocab[name]
        raise RecipeConfigError(
            "No reserved slot token tokenizes atomically for this model; pass recipe_params.slot_token."
        )

    def _system(self, messages: list[dict[str, Any]], prefix: str | None) -> list[dict[str, Any]]:
        original = ""
        rest = messages
        if messages and messages[0].get("role") == "system":
            original = str(messages[0].get("content") or "")
            rest = messages[1:]
        if prefix is None:
            return messages
        return [{"role": "system", "content": prefix + self.separator + original}] + rest

    def _ids(self, messages: list[dict[str, Any]], rid: str) -> list[int]:
        rendered = self.render(messages, rid, add_generation_prompt=True, enable_thinking=self.spec.thinking != "off")
        return list(self.tokenize(rendered, None).input_ids)

    def _prompts(self, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for index, rec in enumerate(records):
            messages = prompt_messages(rec)
            if not messages or messages[-1].get("role") != "user":
                self.skipped += 1
                continue
            rid = record_id(rec, index)
            student = self._ids(self._system(messages, self.slot_token * self.num_tokens), rid)
            slots = [i for i, t in enumerate(student) if t == self.slot_id]
            if len(slots) != self.num_tokens:
                raise RecipeDataError(f"Record '{rid}' already contains the cartridge slot token.")
            out.append(
                {
                    "student": student,
                    "slots": slots,
                    "teacher": self._ids(self._system(messages, self.context), rid),
                    "plain": self._ids(messages, rid),
                }
            )
        return out

    # -- teacher preparation ------------------------------------------------------------------
    def planned_prep_tokens(self) -> int:
        return sum(len(p["teacher"]) + self.max_new_tokens for p in self.train + self.held_out)

    def prepare(self) -> int:
        tokens = 0
        for item in self.train + self.held_out:
            prompt = torch.tensor([item["teacher"]], device=self.device)
            with torch.no_grad():
                generated = self.teacher.generate(
                    prompt,
                    attention_mask=torch.ones_like(prompt),
                    max_new_tokens=self.max_new_tokens,
                    do_sample=False,
                    eos_token_id=self.eos_id,
                    pad_token_id=self.pad_id,
                    use_cache=True,
                )[0, prompt.shape[1] :].tolist()
            if self.eos_id in generated:
                generated = generated[: generated.index(self.eos_id) + 1]
            item["response"] = generated or [self.eos_id]
            full = torch.tensor([item["teacher"] + item["response"]], device=self.device)
            with torch.no_grad():
                logits = self.teacher(input_ids=full).logits[0].float()
            start = len(item["teacher"]) - 1
            logp = torch.log_softmax(logits[start : start + len(item["response"])], dim=-1)
            top = logp.topk(min(self.top_k, logp.shape[-1]), dim=-1)
            item["top_ids"], item["top_logp"] = top.indices.cpu(), top.values.cpu()
            tokens += full.shape[1]
        self.prepared = True
        self.no_context_kl = self._mean_kl(self.held_out, "plain") if self.held_out else None
        return tokens

    # -- student ----------------------------------------------------------------------------
    def _kl_batch(self, items: list[dict[str, Any]], field: str, *, grad: bool) -> torch.Tensor:
        sequences = [it[field] + it["response"] for it in items]
        ids, mask = tc.padded_batch(sequences, self.pad_id, self.device)
        embeds = self.base.get_input_embeddings()(ids)
        if field == "student":
            rows = torch.tensor([b for b, it in enumerate(items) for _ in it["slots"]], device=self.device)
            cols = torch.tensor([s for it in items for s in it["slots"]], device=self.device)
            values = self.cartridge.to(embeds.dtype).repeat(len(items), 1)
            embeds = embeds.index_put((rows, cols), values)
        with torch.set_grad_enabled(grad):
            hidden = self.base.model(inputs_embeds=embeds, attention_mask=mask).last_hidden_state
            losses = []
            for b, it in enumerate(items):
                start = len(it[field]) - 1
                h = hidden[b, start : start + len(it["response"])]
                kl = topk_kl(self.base.lm_head(h), it["top_ids"].to(self.device), it["top_logp"].to(self.device))
                losses.append(kl.mean())
        return torch.stack(losses)

    def _mean_kl(self, items: list[dict[str, Any]], field: str) -> float:
        with torch.no_grad():
            total = sum(float(self._kl_batch(items[s : s + 8], field, grad=False).sum()) for s in range(0, len(items), 8))
        return total / len(items)

    def num_train_items(self) -> int:
        return len(self.train)

    def item_tokens(self, index: int) -> int:
        item = self.train[index]
        return len(item["student"]) + len(item.get("response", ()))

    def accumulate(self, indices: list[int]) -> dict[str, float]:
        lengths = [len(it["student"]) + len(it["response"]) for it in self.train]
        total = 0.0
        for chunk in tc.chunk_by_tokens(indices, lengths, self.spec.micro_batch_tokens):
            loss = self._kl_batch([self.train[i] for i in chunk], "student", grad=True).sum() / len(indices)
            loss.backward()
            total += float(loss.detach())
        return {"loss": total}

    def evaluate(self) -> EvalResult | None:
        if not self.held_out or not self.prepared:
            return None
        return EvalResult(score=self._mean_kl(self.held_out, "student"), metrics={})

    def export(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        values = self.cartridge.detach().to("cpu", torch.bfloat16).contiguous()
        if not bool(torch.isfinite(values.float()).all()):
            raise RecipeDataError("Cartridge training diverged (non-finite embeddings); lower lr.")
        save_file(
            {"embeddings": values, "slot_token_ids": torch.full((self.num_tokens,), self.slot_id, dtype=torch.int64)},
            str(directory / "cartridge.safetensors"),
            metadata={
                "format": CARTRIDGE_FORMAT,
                "placement": "system_prompt_start",
                "separator": self.separator,
                "base_model": self.resolved.repo,
                "num_tokens": str(self.num_tokens),
                "hidden_size": str(self.hidden_size),
                "slot_token": self.slot_token,
            },
        )

    def manifest(self) -> dict[str, Any]:
        return {
            **self.base_manifest(self.resolved),
            "cartridge_format": CARTRIDGE_FORMAT,
            "num_tokens": self.num_tokens,
            "hidden_size": self.hidden_size,
            "placement": "system_prompt_start",
            "separator": self.separator,
            "slot_token": self.slot_token,
            "slot_token_id": self.slot_id,
            "teacher": self.teacher_id,
            "loss": {"kind": "topk_kl_distill", "top_k": self.top_k},
            "max_new_tokens": self.max_new_tokens,
        }

    def final_report(self) -> dict[str, Any]:
        result = self.evaluate()
        eval_kl = None if result is None else result.score
        reduction = None
        if eval_kl is not None and self.no_context_kl and self.no_context_kl > 0:
            reduction = 1.0 - eval_kl / self.no_context_kl
        warnings = []
        if result is None:
            warnings.append("No held-out prompts (or no teacher answers): eval_kl is null.")
        return {
            "eval_kl": eval_kl,
            "no_context_kl": self.no_context_kl,
            "kl_reduction": reduction,
            "num_tokens": self.num_tokens,
            "hidden_size": self.hidden_size,
            "teacher": self.teacher_id,
            "train_prompts": len(self.train),
            "eval_prompts": len(self.held_out),
            "skipped_records": self.skipped,
            "cartridge_format": CARTRIDGE_FORMAT,
            "warnings": warnings,
        }


class CartridgeRunner(RecipeRunner):
    kind = "cartridge"

    def build_task(self, spec, train, held_out, workdir):  # type: ignore[no-untyped-def]
        return CartridgeTask(spec, train, held_out, workdir)


