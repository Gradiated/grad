"""The server planner's resolved configs reach the trainer and change what it does.

``tests/fixtures/wire/resolved-configs.json`` is written by the server's planner test
(server/api/test/recipe-params.test.ts) for requests that set every documented recipe
parameter. Each test here feeds one of them to the real recipe and checks the effect.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from helpers import QWEN_TEACHER_ID, Recorder, TorchCase, run_recipe

from grad_trainer.config import parse_train_spec

FIXTURE = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "wire" / "resolved-configs.json"
CONFIGS: dict[str, dict[str, Any]] = json.loads(FIXTURE.read_text())

CHATS = [
    {"id": f"c{i}", "messages": [{"role": "user", "content": f"question {i}"}, {"role": "assistant", "content": f"answer {i}"}]}
    for i in range(24)
]
RESPONSES = [
    {
        "id": f"{model}-{i}",
        "group_id": f"p{i}",
        "messages": [{"role": "user", "content": f"{'hard' if i % 2 else 'easy'} prompt {i}"}, {"role": "assistant", "content": "x"}],
        "metadata": {"model": model},
        "scores": {"ok": 1.0 if model == "strong/m" or i % 2 == 0 else 0.0, "latency": 0.5},
    }
    for i in range(24)
    for model in ("cheap/m", "strong/m")
]


def spec_for(kind: str):  # type: ignore[no-untyped-def]
    return parse_train_spec(kind, CONFIGS[kind])


class RecipeParamsContractTests(TorchCase):
    def test_sft_optimizer_eval_cadence_and_reduction(self) -> None:
        from grad_trainer.recipes.sft import SFTTask

        spec = spec_for("sft")
        task = SFTTask(spec, CHATS[:8], [], self.tmpdir())
        group = task.optimizer.param_groups[0]
        self.assertEqual((group["betas"], group["weight_decay"]), ((0.8, 0.9), 0.1))
        self.assertEqual((spec.optimizer.grad_clip, spec.reduction, spec.eval_every), (0.5, "per_token", 2))

        rec = Recorder(self.tmpdir())
        out = run_recipe("sft", {**CONFIGS["sft"], "checkpoint_every_steps": 100}, CHATS, self.tmpdir(), recorder=rec)
        evaluated = [m["step"] for m in rec.metrics if m.get("eval_metrics")]
        self.assertEqual(evaluated, [s for s in range(1, out.manifest["total_steps"] + 1) if s % 2 == 0 or s == out.manifest["total_steps"]])
        self.assertEqual(out.manifest["reduction"], "per_token")

    def test_dpo_beta_from_loss(self) -> None:
        from grad_trainer.recipes.dpo import DPOTask

        pairs = [{"id": f"d{i}", "prompt": f"p{i}", "chosen": f"good {i}", "rejected": f"bad {i}"} for i in range(4)]
        self.assertEqual(DPOTask(spec_for("dpo"), pairs, [], self.tmpdir()).beta, 0.3)

    def test_router_rubric_pricing_fallback_and_target(self) -> None:
        from grad_trainer.recipes.router import RouterTask

        task = RouterTask(spec_for("router"), RESPONSES[:32], RESPONSES[32:], self.tmpdir())
        self.assertEqual(task.candidates, ["cheap/m", "strong/m"])
        self.assertEqual(task.fallback, "strong/m")
        self.assertEqual(task.costs, {"cheap/m": 0.001, "strong/m": 0.01})
        self.assertEqual(task.max_quality_drop, 0.05)
        # The rubric picks 'ok' among the two scores on every record.
        self.assertEqual(sorted({tuple(sorted(i["scores"].items())) for i in task.train}), [(("cheap/m", 0.0), ("strong/m", 1.0)), (("cheap/m", 1.0), ("strong/m", 1.0))])

    def test_cartridge_loss_generation_length_slot_and_teacher(self) -> None:
        from grad_trainer.recipes.cartridge import CartridgeTask

        prompts = [{"id": f"c{i}", "messages": [{"role": "user", "content": f"q {i}"}]} for i in range(4)]
        task = CartridgeTask(spec_for("cartridge"), prompts, [], self.tmpdir())
        self.assertEqual((task.top_k, task.max_new_tokens, task.slot_token, task.num_tokens), (7, 5, "<|fim_pad|>", 16))
        self.assertEqual(task.teacher_id, QWEN_TEACHER_ID)
        self.assertIsNot(task.teacher, task.base)

    def test_embedding_pool_and_temperature(self) -> None:
        from grad_trainer.recipes.embedding import EmbeddingTask

        records = [{"query": f"q{i}", "positive": f"p{i}"} for i in range(4)]
        task = EmbeddingTask(spec_for("embedding"), records, [], self.tmpdir())
        self.assertEqual((task.pooling, task.temp), ("cls", 0.1))
