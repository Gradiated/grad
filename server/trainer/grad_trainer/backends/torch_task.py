"""Base class for torch recipe tasks: optimizer, weight/state persistence, LM encoding."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Sequence

import torch

from ..config import TrainSpec
from ..errors import RecipeConfigError, RecipeDataError
from ..models import ResolvedModel, describe_model, resolve_model
from ..runner_types import BaseArtifact
from ..templates import RenderedChat, TokenizedExample, render_chat, tokenize_rendered
from . import torch_common as tc


class TorchTask:
    kind = ""
    artifact_format = ""
    metric_name = "eval_loss"
    metric_mode = "min"

    def __init__(self, spec: TrainSpec, workdir: Path) -> None:
        self.spec = spec
        self.workdir = workdir
        self.warnings: list[str] = []
        tc.setup_torch(spec.seed)
        self.device = tc.pick_device()
        self.params: dict[str, torch.nn.Parameter] = {}
        self.optimizer: torch.optim.Optimizer | None = None
        # Tokens per forward/backward chunk; load_lm sizes it to the trained model.
        self.micro_batch_tokens = spec.micro_batch_tokens or 16384

    # -- model setup ----------------------------------------------------------------------
    def resolve(self, model_id: str, family: str) -> ResolvedModel:
        resolved = resolve_model(model_id)
        if resolved.family != family:
            raise RecipeConfigError(
                f"Model '{model_id}' is a {resolved.family} model; the {self.kind} recipe needs a {family} model."
            )
        return resolved

    def load_lm(self, resolved: ResolvedModel, *, packed: bool = False) -> Any:
        """Load the causal LM this task trains, and size micro-batches for it."""
        model = tc.load_causal_lm(resolved, self.device, packed=packed)
        if self.spec.micro_batch_tokens is None:
            self.micro_batch_tokens = tc.default_micro_batch_tokens(model)
        return model

    def init_optimizer(self, module: torch.nn.Module) -> None:
        self.params = tc.trainable_named(module)
        if not self.params:
            raise RecipeConfigError("Nothing to train: the model has no trainable parameters.")
        self.optimizer = tc.make_optimizer(self.params.values(), self.spec)

    def lora_model(
        self, base_lm: Any, resolved: ResolvedModel, base: BaseArtifact | None
    ) -> tuple[Any, dict[str, Any]]:
        """A trainable LoRA model: fresh, or the starting artifact's adapter (continued training)."""
        torch.manual_seed(self.spec.seed)
        checkpointing = tc.use_gradient_checkpointing(self.spec, self.device)
        if base is None:
            return tc.apply_lora(base_lm, self.spec.adapter, checkpointing), tc.lora_settings(self.spec.adapter)
        return tc.load_lora(base_lm, base.directory, self.spec.adapter, resolved, checkpointing)

    def template_revision(self, resolved: ResolvedModel) -> str:
        return str(self.spec.template_revision or resolved.template_revision)

    # -- encoding ---------------------------------------------------------------------------
    def render(self, messages: Sequence[dict[str, Any]], record_id: str, **kwargs: Any) -> RenderedChat:
        options: dict[str, Any] = {
            "record_id": record_id,
            "train_on": self.spec.train_on,
            "thinking": self.spec.thinking,
            "preserve_thinking": self.spec.preserve_thinking,
            "template_revision": self._template,
        }
        options.update(kwargs)
        return render_chat(messages, **options)

    def tokenize(self, rendered: RenderedChat, max_len: int | None) -> TokenizedExample:
        return tokenize_rendered(rendered, self.tokenizer, max_len=max_len)

    def encode_prompt(self, messages: Sequence[dict[str, Any]], record_id: str, max_len: int) -> list[int]:
        """Prompt tokens ending with the assistant generation header (for classifiers)."""
        if not messages:
            raise RecipeDataError(f"Record '{record_id}' has no prompt messages.")
        rendered = self.render(messages, record_id, add_generation_prompt=True, train_on="last")
        ids = list(self.tokenize(rendered, None).input_ids)
        # Keep the end of long prompts: the generation header carries the pooled state.
        return ids[-max_len:]

    # -- loop protocol ----------------------------------------------------------------------
    def accumulate(self, indices: list[int]) -> dict[str, float]:  # pragma: no cover - abstract
        raise NotImplementedError

    def train_step(self, indices: list[int], lr: float) -> dict[str, float]:
        assert self.optimizer is not None
        stats = self.accumulate(indices)
        stats["grad_norm"] = tc.optimizer_step(
            self.optimizer, list(self.params.values()), lr, self.spec.optimizer.grad_clip
        )
        return stats

    def save_weights(self, directory: Path) -> None:
        tc.save_named(dict(self.params), directory)

    def load_weights(self, directory: Path) -> None:
        tc.load_named(self.params, directory)

    def save_state(self, directory: Path) -> None:
        assert self.optimizer is not None
        tc.save_optimizer_state(self.optimizer, directory)

    def load_state(self, directory: Path) -> None:
        assert self.optimizer is not None
        tc.load_optimizer_state(self.optimizer, directory)

    def snapshot(self) -> dict[str, Any]:
        """In-memory copy of what training changes: trainable weights, optimizer state, RNG.

        This is all a checkpoint pauses training for; ``write_snapshot`` writes the files later,
        on the loop's checkpoint thread.
        """
        assert self.optimizer is not None
        return {
            "params": {n: p.detach().to("cpu", copy=True) for n, p in self.params.items()},
            "optimizer": tc.to_cpu(self.optimizer.state_dict()),
            "rng": tc.rng_state(),
        }

    def write_snapshot(self, snapshot: dict[str, Any], directory: Path, weights_dir: Path, state_dir: Path) -> None:
        """The checkpoint files from ``snapshot``: the artifact export, weights and optimizer state."""
        self.export(directory, params=snapshot["params"])
        tc.save_named(snapshot["params"], weights_dir)
        tc.save_state_dict(snapshot["optimizer"], snapshot["rng"], state_dir)

    def base_manifest(self, resolved: ResolvedModel) -> dict[str, Any]:
        return {
            **describe_model(resolved),
            "template_revision": self.template_revision(resolved),
            "thinking": self.spec.thinking,
            "train_on": self.spec.train_on,
            "preserve_thinking": self.spec.preserve_thinking,
            "versions": tc.library_versions(),
            "deployable": True,
        }
