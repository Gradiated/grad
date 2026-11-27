"""Decision model on a tiny real Qwen3 backbone (torch)."""

from __future__ import annotations

import json

from helpers import QWEN_ID, TorchCase, run_recipe

from grad_trainer.errors import RecipeDataError

QUESTIONS = {
    "category": {"type": "choice", "criteria": {"billing": "Charges", "technical": "Broken", "other": "Else"}},
    "urgent": {"type": "noul", "instructions": "Immediate?"},
    "effort": {"type": "score", "criteria": ["Can wait", "Today", "Now"]},
}
TICKETS = ["I was charged twice on my card", "The app is broken and crashes", "Hello there friend"]


def records(n: int = 48) -> list[dict]:
    return [
        {
            "id": f"t{i}",
            "state": {"ticket": f"{TICKETS[i % 3]} {i}"},
            "questions": QUESTIONS,
            "expected_output": {"category": ["billing", "technical", "other"][i % 3], "urgent": i % 3 == 1, "effort": i % 3},
        }
        for i in range(n)
    ]


CONFIG = {
    "model": QWEN_ID,
    "batch_size": 8,
    "epochs": 3,
    "lr": 1e-2,
    "warmup": 0.0,
    "adapter": {"kind": "lora", "rank": 4, "alpha": 8},
    "split": {"eval_fraction": 0.4, "seed": 2},
}


class DecisionTests(TorchCase):
    def test_trains_heads_and_reports_per_option_metrics(self) -> None:
        from safetensors.torch import load_file

        out = run_recipe("decision", CONFIG, records(), self.tmpdir())
        self.assertEqual((out.status, out.artifact_format), ("completed", "decision_bundle"))
        report = out.eval_report
        self.assertGreater(report["eval_examples"], 0)
        category = report["heads"]["category"]
        self.assertEqual(set(category["per_option"]), {"billing", "technical", "other"})
        self.assertEqual(category["confusion_matrix"]["labels"], ["billing", "technical", "other"])
        self.assertEqual(sum(map(sum, category["confusion_matrix"]["matrix"])), category["examples"])
        self.assertIsNotNone(category["ece"])
        self.assertIn("brier", report["heads"]["urgent"])
        self.assertIn("mae", report["heads"]["effort"])
        self.assertIsNotNone(report["ece"])

        heads = load_file(str(out.artifact_dir / "decision_head.safetensors"))
        self.assertEqual(tuple(heads["category.weight"].shape), (3, 32))
        self.assertEqual(tuple(heads["urgent.weight"].shape), (1, 32))
        self.assertEqual(tuple(heads["effort.thresholds"].shape), (2,))
        config = json.loads((out.artifact_dir / "decision_config.json").read_text())
        self.assertEqual(config["losses"], {"category": "cross_entropy", "urgent": "bce_with_logits", "effort": "ordinal_bce"})
        self.assertEqual(set(config["temperatures"]), set(QUESTIONS))
        self.assertTrue((out.artifact_dir / "adapter_model.safetensors").is_file())

    def test_labels_never_reach_the_model(self) -> None:
        leaky = [{k: v for k, v in r.items() if k != "state"} for r in records(6)]
        with self.assertRaisesRegex(RecipeDataError, "no 'state' or 'messages'"):
            run_recipe("decision", CONFIG, leaky, self.tmpdir())
        from grad_trainer.recipes.decision import state_text

        rec = records(1)[0]
        self.assertNotIn("billing", json.dumps(state_text(rec, 0)))

    def test_zero_eval_examples_report_null(self) -> None:
        out = run_recipe("decision", {**CONFIG, "epochs": 1, "split": {"eval_fraction": 0.0}}, records(12), self.tmpdir())
        self.assertEqual(out.eval_report["eval_examples"], 0)
        self.assertIsNone(out.eval_report["ece"])
        self.assertEqual(out.eval_report["heads"], {name: None for name in QUESTIONS})
        self.assertTrue(any("null" in w for w in out.eval_report["warnings"]))

    def test_frozen_head_and_messages_state(self) -> None:
        recs = [
            {
                "id": f"m{i}",
                "messages": [{"role": "user", "content": TICKETS[i % 2]}],
                "questions": {"urgent": {"type": "noul"}},
                "expected_output": {"urgent": float(i % 2)},
            }
            for i in range(10)
        ] + [{"id": "skip", "state": "x", "questions": {"urgent": {"type": "noul"}}, "expected_output": {}}]
        out = run_recipe("decision", {**CONFIG, "epochs": 1, "adapter": {"kind": "frozen_head"}}, recs, self.tmpdir())
        self.assertFalse((out.artifact_dir / "adapter_model.safetensors").exists())
        self.assertTrue(any("skipped" in w for w in out.eval_report["warnings"]))

    def test_schema_and_answer_validation(self) -> None:
        from grad_trainer.recipes.decision import encode_answer, ordinal_probs, parse_questions

        self.assertAlmostEqual(sum(ordinal_probs([2.0, -1.0], 1.0)), 1.0)
        self.assertEqual(encode_answer({"type": "score", "options": ["a", "b"]}, "b", "q"), 1)
        self.assertEqual(encode_answer({"type": "noul", "options": []}, True, "q"), 1.0)
        self.assertIsNone(encode_answer({"type": "noul", "options": []}, None, "q"))
        for question, answer in (
            ({"type": "noul", "options": []}, 2.0),
            ({"type": "choice", "options": ["a"]}, "z"),
            ({"type": "score", "options": ["a", "b"]}, 5),
        ):
            with self.assertRaises(RecipeDataError):
                encode_answer(question, answer, "q")
        for bad in (
            [{"questions": {"q": {"type": "choice", "criteria": ["only"]}}}],
            [{"questions": {"q": {"type": "score", "criteria": {"a": 1}}}}],
            [{"questions": {"q": {"type": "essay"}}}],
            [{"questions": {"q": "noul"}}],
            [{"questions": {"a.b": {"type": "noul"}}}],
            [{"questions": {"q": {"type": "noul"}}}, {"questions": {"q": {"type": "choice", "criteria": ["a", "b"]}}}],
            [{}],
        ):
            with self.subTest(bad), self.assertRaises(RecipeDataError):
                parse_questions(bad)
        with self.assertRaisesRegex(RecipeDataError, "expected_output must map"):
            run_recipe("decision", CONFIG, [{**records(1)[0], "expected_output": "billing"}], self.tmpdir())
        with self.assertRaisesRegex(RecipeDataError, "expected_output answers"):
            run_recipe("decision", CONFIG, [{**records(1)[0], "expected_output": {}}], self.tmpdir())
