"""DPO on a tiny real Qwen3 (torch)."""

from __future__ import annotations

import json
import math

from helpers import QWEN_ID, Recorder, TorchCase, run_recipe

from grad_trainer.errors import RecipeConfigError, RecipeDataError

PAIRS = [
    {"id": f"d{i}", "prompt": f"Merge diff {i}", "chosen": "clean merged code", "rejected": "truncated code error"}
    for i in range(12)
]
TRAJECTORIES = [
    {
        "schema": "grad.trajectory/1",
        "group_id": f"g{i}",
        "role": role,
        "input": {"messages": [{"role": "user", "content": f"Question {i}"}]},
        "output": {"turns": [{"role": "assistant", "content": "good answer" if role == "chosen" else "bad answer"}]},
    }
    for i in range(6)
    for role in ("chosen", "rejected")
]
IMPLICIT = [
    {
        "id": f"u{i}",
        "chosen": [{"role": "user", "content": f"hi {i}"}, {"role": "assistant", "content": "hello there"}],
        "rejected": [{"role": "user", "content": f"hi {i}"}, {"role": "assistant", "content": "go away"}],
    }
    for i in range(6)
]
CONFIG = {
    "model": QWEN_ID,
    "batch_size": 6,
    "epochs": 3,
    "lr": 1e-2,
    "warmup": 0.0,
    "adapter": {"kind": "lora", "rank": 4, "alpha": 8},
    "split": {"eval_fraction": 0.25, "seed": 3},
    "recipe_params": {"beta": 0.1},
}


class DPOMathTests(TorchCase):
    def test_sigmoid_dpo_loss_matches_hand_computed_value(self) -> None:
        import torch

        from grad_trainer.recipes.dpo import dpo_loss, resolve_beta

        loss, margin = dpo_loss(torch.tensor([-1.0]), torch.tensor([-2.0]), torch.tensor([-1.5]), torch.tensor([-1.5]), 0.1)
        self.assertAlmostEqual(float(margin), 0.1)
        self.assertAlmostEqual(float(loss), math.log1p(math.exp(-0.1)), places=6)  # 0.644396...
        loss, _ = dpo_loss(torch.zeros(1), torch.zeros(1), torch.zeros(1), torch.zeros(1), 0.5)
        self.assertAlmostEqual(float(loss), math.log(2), places=6)
        self.assertEqual(resolve_beta({}), 0.1)
        self.assertEqual(resolve_beta({"loss": {"kind": "dpo", "beta": 0.3}}), 0.3)
        self.assertEqual(resolve_beta({"loss": "sigmoid", "beta": 0.2}), 0.2)
        for bad in ({"loss": "ipo"}, {"loss": {"type": "simpo"}}, {"beta": -1}, {"beta": float("inf")}):
            with self.subTest(bad), self.assertRaises(RecipeConfigError):
                resolve_beta(bad)

    def test_pair_extraction(self) -> None:
        from grad_trainer.recipes.dpo import extract_pairs

        pairs, dropped = extract_pairs(
            PAIRS[:2]
            + TRAJECTORIES[:2]
            + IMPLICIT[:1]
            + [
                {"prompt": "p", "chosen": "only chosen"},
                {"prompt": "p", "chosen": "same", "rejected": "same"},
                {"messages": [{"role": "user", "content": "m"}], "chosen": "a", "rejected": "b"},
                {"schema": "grad.trajectory/1", "group_id": "lonely", "role": "chosen", "input": {"messages": []}, "output": {}},
                {"schema": "grad.trajectory/1", "role": "rejected"},
            ]
        )
        self.assertEqual(len(pairs), 5)
        self.assertEqual(dropped, 4)
        implicit = [p for p in pairs if p[3] == "u0"][0]
        self.assertEqual(implicit[0], [{"role": "user", "content": "hi 0"}])
        self.assertEqual(implicit[1], [{"role": "assistant", "content": "hello there"}])
        with self.assertRaisesRegex(RecipeDataError, "different prompts"):
            extract_pairs([TRAJECTORIES[0], {**TRAJECTORIES[1], "input": {"messages": [{"role": "user", "content": "x"}]}}])
        with self.assertRaisesRegex(RecipeDataError, "assistant turns"):
            extract_pairs([{"prompt": "p", "chosen": [{"role": "user", "content": "x"}], "rejected": "r"}])


class DPOTrainingTests(TorchCase):
    def test_trains_toward_chosen_and_exports_adapter(self) -> None:
        import torch
        from peft import PeftModel
        from transformers import AutoModelForCausalLM

        from fixtures.tiny_models import ensure_tiny_models

        rec = Recorder(self.tmpdir())
        out = run_recipe("dpo", CONFIG, PAIRS + TRAJECTORIES + IMPLICIT, self.tmpdir(), recorder=rec)
        self.assertEqual((out.status, out.artifact_format), ("completed", "peft_lora"))
        first = rec.metrics[0]
        self.assertAlmostEqual(first["loss"], math.log(2), places=4)  # policy == reference at init
        self.assertAlmostEqual(first["reward_margin"], 0.0, places=5)
        self.assertGreater(rec.metrics[-1]["reward_margin"], 0.05)
        self.assertLess(rec.metrics[-1]["loss"], math.log(2))
        report = out.eval_report
        self.assertEqual(report["preference_accuracy"], 1.0)
        self.assertGreater(report["reward_margin"], 0.0)
        self.assertEqual(report["beta"], 0.1)
        self.assertEqual(report["train_pairs"] + report["eval_pairs"], 24)
        self.assertEqual(out.manifest["loss"], {"kind": "dpo", "beta": 0.1})
        config = json.loads((out.artifact_dir / "adapter_config.json").read_text())
        self.assertEqual(config["r"], 4)
        base = AutoModelForCausalLM.from_pretrained(str(ensure_tiny_models()[QWEN_ID])).eval()
        ids = torch.tensor([[2, 4, 6, 8]])
        with torch.no_grad():
            before = base(input_ids=ids).logits
            after = PeftModel.from_pretrained(base, str(out.artifact_dir)).eval()(input_ids=ids).logits
        self.assertGreater(float((after - before).abs().max()), 1e-4)

    def test_pairs_stay_together_in_the_split(self) -> None:
        out = run_recipe("dpo", {**CONFIG, "epochs": 1, "split": {"eval_fraction": 0.5, "seed": 9}}, TRAJECTORIES, self.tmpdir())
        self.assertEqual(out.eval_report["dropped_records"], 0)
        self.assertEqual(out.eval_report["train_pairs"] + out.eval_report["eval_pairs"], 6)

    def test_errors_and_null_eval(self) -> None:
        with self.assertRaisesRegex(RecipeDataError, "preference pairs"):
            run_recipe("dpo", CONFIG, [{"prompt": "p", "chosen": "c"}], self.tmpdir())
        out = run_recipe("dpo", {**CONFIG, "epochs": 1, "split": {"eval_fraction": 0.0}}, PAIRS + [{"prompt": "x"}], self.tmpdir())
        self.assertIsNone(out.eval_report["preference_accuracy"])
        self.assertTrue(any("dropped" in w for w in out.eval_report["warnings"]))
