"""Shared base for router and decision models: an LLM backbone (LoRA or frozen) with heads.

The input is the record's prompt rendered with the pinned chat template and the assistant
generation header; the feature is the hidden state of its last token. Heads are float32
linear layers saved to ``<name>_head.safetensors``; the LoRA backbone is a standard PEFT
adapter, so the artifact runs on the base model plus the heads.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import torch
from safetensors.torch import save_file

from ..backends import torch_common as tc
from ..backends.torch_task import TorchTask
from ..config import TrainSpec
from ..errors import RecipeConfigError


class PooledLMTask(TorchTask):
    head_file = "head.safetensors"

    def __init__(self, spec: TrainSpec, workdir: Path) -> None:
        super().__init__(spec, workdir)
        self.resolved = self.resolve(spec.model, "causal_lm")
        self._template = self.template_revision(self.resolved)
        self.tokenizer = tc.load_tokenizer(self.resolved)
        self.base = tc.load_causal_lm(self.resolved, self.device)
        self.max_len = tc.model_max_len(self.base, spec)
        self.hidden_size = int(self.base.config.hidden_size)
        self.pad_id = int(self.tokenizer.pad_token_id)
        self.adapter_kind = spec.adapter.get("kind", "lora")
        if self.adapter_kind not in ("lora", "frozen_head"):
            raise RecipeConfigError(f"Adapter kind '{self.adapter_kind}' is not supported for {self.kind}.")

    def build_backbone(self, heads: torch.nn.Module) -> None:
        torch.manual_seed(self.spec.seed)
        if self.adapter_kind == "lora":
            self.lora = tc.lora_settings(self.spec.adapter)
            self.model = tc.apply_lora(self.base, self.spec.adapter, tc.use_gradient_checkpointing(self.spec, self.device))
        else:
            self.lora = None
            self.base.requires_grad_(False)
            self.model = self.base
        self.lm = tc.base_causal_lm(self.model)
        self.heads = heads.to(self.device)
        container = torch.nn.ModuleDict({"backbone": self.model, "heads": self.heads})
        self.init_optimizer(container)

    def pooled(self, sequences: list[list[int]], *, grad: bool) -> torch.Tensor:
        ids, mask = tc.padded_batch(sequences, self.pad_id, self.device)
        with torch.set_grad_enabled(grad and self.adapter_kind == "lora"):
            hidden = self.lm.model(input_ids=ids, attention_mask=mask).last_hidden_state
        return tc.last_token_pool(hidden, mask).float()

    def head_tensors(self) -> dict[str, torch.Tensor]:
        return {n: p.detach().cpu().contiguous() for n, p in self.heads.state_dict().items()}

    def export_backbone(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        if self.adapter_kind == "lora":
            tc.export_peft_adapter(self.model, directory, self.resolved)
        save_file(self.head_tensors(), str(directory / self.head_file), metadata={"format": self.artifact_format})

    def backbone_manifest(self) -> dict[str, Any]:
        adapter: dict[str, Any] = {"kind": self.adapter_kind}
        if self.lora:
            adapter.update(self.lora)
        return {
            **self.base_manifest(self.resolved),
            "adapter": adapter,
            "pooling": "last_token",
            "input_format": "chat_template + assistant generation header",
            # How the prompt is rendered and cut: the base model's chat template with these
            # arguments, tokenized without special tokens, keeping the last max_seq_len tokens.
            "chat_template_kwargs": {"add_generation_prompt": True, "enable_thinking": True},
            "truncation_side": "left",
            "hidden_size": self.hidden_size,
            "max_seq_len": self.max_len,
        }
