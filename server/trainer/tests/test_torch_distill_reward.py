"""DistillRecipe (tiny student and teacher) and RewardModelRecipe on tiny real Qwen3 models (torch)."""

from __future__ import annotations

import json
import math

from helpers import QWEN_ID, QWEN_TEACHER_ID, Recorder, TorchCase, run_recipe

from grad_trainer.errors import RecipeConfigError, RecipeDataError
from grad_trainer.runner_types import ResumeState

PROMPTS = [{"id": f"p{i}", "messages": [{"role": "user", "content": f"How do I rotate my API key {i}?"}]} for i in range(10)]
PROMPTS.append({"id": "sys", "messages": [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "Refunds?"}, {"role": "assistant", "content": "ignored"}]})
DISTILL = {
    "model": QWEN_ID,
    "batch_size": 4,
    "epochs": 2,
    "lr": 5e-3,
    "warmup": 0.0,
    "thinking": "off",
    "adapter": {"kind": "lora", "rank": 4, "alpha": 8},
    "split": {"eval_fraction": 0.3, "seed": 4},
    "recipe_params": {
        "teacher": QWEN_TEACHER_ID,
        "rollout": {"kind": "on_policy", "max_new_tokens": 6},
        "loss": {"kind": "top_k_kl_distill", "top_k": 8},
        "teacher_token_weight": 2.0,
    },
}

PAIRS = [
    {"id": f"d{i}", "prompt": f"Merge diff {i}", "chosen": "clean merged code", "rejected": "truncated code error"}
    for i in range(12)
]
POINTS = [
    {
        "id": f"s{i}",
        "messages": [{"role": "user", "content": f"Count users {i}"}, {"role": "assistant", "content": "SELECT 1" if i % 2 else "no idea"}],
        "scores": {"ok": float(i % 2)},
    }
    for i in range(8)
]
REWARD = {
    "model": QWEN_ID,
    "batch_size": 6,
    "epochs": 4,
    "lr": 1e-2,
    "warmup": 0.0,
    "adapter": {"kind": "lora", "rank": 4, "alpha": 8},
    "split": {"eval_fraction": 0.3, "seed": 1},
}


class OnPolicyDistillTests(TorchCase):
    def test_trains_lora_against_teacher_and_meters_teacher_tokens(self) -> None:
        rec = Recorder(self.tmpdir())
        out = run_recipe("distill", DISTILL, PROMPTS, self.tmpdir(), recorder=rec)
        self.assertEqual((out.status, out.artifact_format), ("completed", "peft_lora"))
        config = json.loads((out.artifact_dir / "adapter_config.json").read_text())
        self.assertEqual((config["peft_type"], config["r"], config["lora_alpha"]), ("LORA", 4, 8))
        self.assertTrue((out.artifact_dir / "adapter_model.safetensors").is_file())
        self.assertEqual(out.manifest["teacher"], QWEN_TEACHER_ID)
        self.assertEqual(out.manifest["rollout"], {"kind": "on_policy", "max_new_tokens": 6})
        self.assertEqual(out.manifest["loss"], {"kind": "topk_kl_distill", "top_k": 8})

        report = out.eval_report
        self.assertEqual((report["metric_name"], report["rollout"], report["teacher"]), ("eval_kl", "on_policy", QWEN_TEACHER_ID))
        self.assertIsNotNone(report["eval_kl"])
        self.assertIsNotNone(report["base_kl"])
        self.assertLess(report["eval_kl"], report["base_kl"])
        self.assertGreater(report["kl_reduction"], 0)
        self.assertGreater(report["mean_answer_tokens"], 0)
        self.assertLessEqual(report["mean_answer_tokens"], 6)
        self.assertLessEqual(report["truncation_rate"], 1.0)

        # Every step meters what it used, never more than the reserved upper bound.
        from grad_trainer.config import parse_train_spec
        from grad_trainer.recipes.distill import OnPolicyDistillTask

        self.assertTrue(all(0 < m["answer_tokens"] <= 6 for m in rec.metrics))
        task = OnPolicyDistillTask(parse_train_spec("distill", DISTILL), PROMPTS[:4], [], self.tmpdir())
        item = task.train[0]
        self.assertEqual(task._tokens(item, 3), 2 * (len(item["student"]) + 3) + math.ceil(2.0 * (len(item["teacher"]) + 3)))
        self.assertGreaterEqual(out.tokens_processed, sum(m["tokens"] for m in rec.metrics[-1:]))
        self.assertNotIn("metered_tokens", rec.metrics[0])

    def test_generation_runs_in_eval_mode_and_restores_train_mode(self) -> None:
        from grad_trainer.config import parse_train_spec
        from grad_trainer.recipes.distill import OnPolicyDistillTask

        task = OnPolicyDistillTask(parse_train_spec("distill", DISTILL), PROMPTS[:2], [], self.tmpdir())
        task.model.train()
        modes: list[bool] = []
        generate = task.model.generate
        task.model.generate = lambda **kw: modes.append(task.model.training) or generate(**kw)  # type: ignore[method-assign]
        task._generate(task.model, [task.train[0]["student"]], sample=True)
        self.assertEqual((modes, task.model.training), ([False], True))

    def test_context_is_read_by_the_teacher_only_and_resume_continues(self) -> None:
        from grad_trainer.config import parse_train_spec
        from grad_trainer.recipes.distill import OnPolicyDistillTask

        params = {**DISTILL["recipe_params"], "teacher": QWEN_ID, "context_text": "Refunds take five days."}
        spec = parse_train_spec("distill", {**DISTILL, "recipe_params": params})
        task = OnPolicyDistillTask(spec, PROMPTS[-1:], [], self.tmpdir())
        self.assertGreater(len(task.train[0]["teacher"]), len(task.train[0]["student"]))

        rec = Recorder(self.tmpdir(), stop_after=2)
        first = run_recipe("distill", {**DISTILL, "checkpoint_every_steps": 1}, PROMPTS, self.tmpdir(), recorder=rec)
        self.assertEqual(first.status, "cancelled")
        step, _, ckpt, _ = rec.checkpoints[-1]
        resumed = run_recipe("distill", DISTILL, PROMPTS, self.tmpdir(), resume=ResumeState(step=step, checkpoint_dir=ckpt))
        self.assertEqual((resumed.status, resumed.manifest["steps_completed"]), ("completed", resumed.manifest["total_steps"]))

    def test_budget_and_config_errors(self) -> None:
        stopped = run_recipe("distill", DISTILL, PROMPTS, self.tmpdir(), max_cost_usd=1e-9)
        self.assertEqual((stopped.status, stopped.tokens_processed), ("stopped_budget", 0))
        same = {**DISTILL, "recipe_params": {**DISTILL["recipe_params"], "teacher": QWEN_ID}}
        with self.assertRaisesRegex(RecipeConfigError, "teacher is the student"):
            run_recipe("distill", same, PROMPTS, self.tmpdir())
        with self.assertRaisesRegex(RecipeConfigError, "rollout"):
            run_recipe("distill", {**DISTILL, "recipe_params": {"teacher": QWEN_TEACHER_ID, "rollout": {"kind": "x"}}}, PROMPTS, self.tmpdir())
        with self.assertRaisesRegex(RecipeConfigError, "needs a teacher"):
            run_recipe("distill", {**DISTILL, "recipe_params": {}}, PROMPTS, self.tmpdir())
        with self.assertRaisesRegex(RecipeDataError, "prompts"):
            run_recipe("distill", DISTILL, [{"id": "x", "messages": [{"role": "system", "content": "s"}]}], self.tmpdir())
        long = {**DISTILL, "max_seq_len": 16}
        with self.assertRaisesRegex(RecipeDataError, "no room"):
            run_recipe("distill", long, PROMPTS, self.tmpdir())


class OffPolicyDistillTests(TorchCase):
    def test_trains_on_the_teacher_answers_like_sft(self) -> None:
        labelled = [
            {"id": f"l{i}", "group_id": f"e:{i}", "metadata": {"model": "big/teacher"},
             "messages": [{"role": "user", "content": f"Question {i}"}, {"role": "assistant", "content": "Open Settings."}]}
            for i in range(10)
        ]
        params = {"teacher": "big/teacher", "rollout": {"kind": "off_policy", "max_new_tokens": 64}, "loss": {"kind": "cross_entropy"}}
        out = run_recipe("distill", {**DISTILL, "recipe_params": params}, labelled, self.tmpdir())
        self.assertEqual((out.status, out.artifact_format), ("completed", "peft_lora"))
        self.assertEqual(out.eval_report["metric_name"], "eval_loss")
        self.assertEqual((out.eval_report["rollout"], out.eval_report["teacher"]), ("off_policy", "big/teacher"))
        self.assertEqual(out.manifest["rollout"], {"kind": "off_policy", "max_new_tokens": 64})
        self.assertEqual(out.manifest["loss"], {"kind": "cross_entropy"})


class RewardModelTests(TorchCase):
    def test_pairwise_bundle_scores_chosen_above_rejected(self) -> None:
        rec = Recorder(self.tmpdir())
        out = run_recipe("reward", REWARD, PAIRS, self.tmpdir(), recorder=rec)
        self.assertEqual((out.status, out.artifact_format), ("completed", "reward_bundle"))
        files = sorted(p.name for p in out.artifact_dir.iterdir())
        self.assertEqual(files, ["adapter_config.json", "adapter_model.safetensors", "reward_config.json", "reward_head.safetensors"])
        config = json.loads((out.artifact_dir / "reward_config.json").read_text())
        self.assertEqual((config["format"], config["format_version"], config["objectives"], config["score"]), ("reward_bundle", 2, ["pairwise"], "sigmoid"))
        self.assertEqual((config["pooling"], config["head_file"], config["hidden_size"]), ("last_token", "reward_head.safetensors", 32))

        report = out.eval_report
        self.assertEqual(report["metric_name"], "preference_accuracy")
        self.assertEqual(report["preference_accuracy"], 1.0)
        self.assertGreater(report["reward_margin"], 0)
        self.assertEqual(report["train_pairs"] + report["eval_pairs"], 12)
        self.assertEqual(report["train_points"], 0)
        self.assertIn("reward_accuracy", rec.metrics[0])

        scores = score_bundle(out.artifact_dir, [
            [{"role": "user", "content": "Merge diff 99"}, {"role": "assistant", "content": "clean merged code"}],
            [{"role": "user", "content": "Merge diff 99"}, {"role": "assistant", "content": "truncated code error"}],
        ])
        self.assertTrue(all(0.0 < s < 1.0 for s in scores))
        # The loader's chat template renders exactly what the trainer scored.
        from transformers import AutoTokenizer

        from fixtures.tiny_models import ensure_tiny_models
        from grad_trainer.templates import render_chat

        tok = AutoTokenizer.from_pretrained(str(ensure_tiny_models()[QWEN_ID]))
        convo = [{"role": "user", "content": "Merge diff 1"}, {"role": "assistant", "content": "clean merged code"}]
        self.assertEqual(render_chat(convo, train_on="all_assistant").text, tok.apply_chat_template(convo, tokenize=False))
        self.assertGreater(scores[0], scores[1])

    def test_pointwise_and_mixed_objectives(self) -> None:
        mixed = run_recipe("reward", {**REWARD, "recipe_params": {"rubric": "ok"}}, PAIRS + POINTS, self.tmpdir())
        report = mixed.eval_report
        self.assertEqual(report["train_points"] + report["eval_points"], 8)
        self.assertIsNotNone(report["pointwise_brier"])
        self.assertEqual(json.loads((mixed.artifact_dir / "reward_config.json").read_text())["objectives"], ["pairwise", "pointwise"])

        frozen = {**REWARD, "adapter": {"kind": "frozen_head"}, "recipe_params": {"rubric": "ok"}}
        only = run_recipe("reward", frozen, POINTS, self.tmpdir())
        self.assertEqual(only.eval_report["metric_name"], "eval_loss")
        self.assertIsNone(only.eval_report["preference_accuracy"])
        self.assertEqual(sorted(p.name for p in only.artifact_dir.iterdir()), ["reward_config.json", "reward_head.safetensors"])

    def test_errors(self) -> None:
        with self.assertRaisesRegex(RecipeDataError, "pass rubric="):
            run_recipe("reward", REWARD, POINTS, self.tmpdir())
        bad = [{**POINTS[0], "scores": {"ok": 3}}]
        with self.assertRaisesRegex(RecipeDataError, r"must be in \[0, 1\]"):
            run_recipe("reward", {**REWARD, "recipe_params": {"rubric": "ok"}}, bad + POINTS, self.tmpdir())
        with self.assertRaisesRegex(RecipeConfigError, "name of a score"):
            run_recipe("reward", {**REWARD, "recipe_params": {"rubric": 3}}, PAIRS, self.tmpdir())


def score_bundle(directory, conversations):  # type: ignore[no-untyped-def]
    """The documented reference loader: transformers + peft + safetensors, no trainer code."""
    import torch
    from peft import PeftModel
    from safetensors.torch import load_file
    from transformers import AutoModelForCausalLM, AutoTokenizer

    from fixtures.tiny_models import ensure_tiny_models

    config = json.loads((directory / "reward_config.json").read_text())
    base_dir = str(ensure_tiny_models()[config["base_model"]])
    tokenizer = AutoTokenizer.from_pretrained(base_dir)
    model = AutoModelForCausalLM.from_pretrained(base_dir, dtype=torch.float32)
    if (directory / "adapter_config.json").is_file():
        model = PeftModel.from_pretrained(model, str(directory))
    head = load_file(str(directory / config["head_file"]))
    scores = []
    with torch.no_grad():
        for messages in conversations:
            ids = tokenizer.apply_chat_template(messages, tokenize=True, return_tensors="pt", return_dict=True)["input_ids"]
            lm = model.get_base_model() if isinstance(model, PeftModel) else model
            hidden = lm.model(input_ids=ids).last_hidden_state[0, -1]
            scores.append(float(torch.sigmoid(hidden @ head["weight"][0] + head["bias"][0])))
    return scores
