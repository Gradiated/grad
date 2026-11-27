"""Built-in benchmark transforms: HF rows (real shapes from the pinned revisions) -> chat records."""

from __future__ import annotations

import os
import sys
import types
import unittest
from unittest import mock

from helpers import TempDirCase

from grad_trainer import benchmarks, import_runner
from grad_trainer.errors import SourceUnavailableError

GSM8K_ROW = {
    "question": "Janet's ducks lay 16 eggs per day. How much does she make?",
    "answer": "Janet sells 16 - 3 - 4 = <<16-3-4=9>>9 duck eggs a day.\nShe makes 9 * 2 = $<<9*2=18>>18.\n#### 1,018",
}
MMLU_ROW = {"question": "Find the degree of Q(sqrt(2)) over Q.", "subject": "abstract_algebra", "choices": ["0", "4", "2", "6"], "answer": 2}
MMLU_PRO_ROW = {"question_id": 70, "question": "Adverts must not:", "options": ["a", "b", "c"], "answer": "B", "answer_index": 1, "category": "business"}
ARC_ROW = {"id": "Mercury_7175875", "question": "Which effect?", "choices": {"text": ["x", "y", "z", "w"], "label": ["A", "B", "C", "D"]}, "answerKey": "C"}


class TransformTests(unittest.TestCase):
    def test_gsm8k_keeps_the_final_number(self) -> None:
        rec = benchmarks.to_record("gsm8k", GSM8K_ROW, 4)
        self.assertEqual(rec["id"], "gsm8k:4")
        self.assertEqual(rec["expected_output"], "1018")
        self.assertIn("#### <number>", rec["messages"][0]["content"])
        self.assertEqual(rec["metadata"], {"benchmark": "gsm8k"})

    def test_multiple_choice_benchmarks_answer_with_a_letter(self) -> None:
        rec = benchmarks.to_record("mmlu", MMLU_ROW, 0)
        self.assertEqual(rec["expected_output"], "C")
        self.assertIn("A. 0\nB. 4\nC. 2\nD. 6", rec["messages"][0]["content"])
        self.assertEqual(rec["metadata"]["subject"], "abstract_algebra")
        pro = benchmarks.to_record("mmlu_pro", MMLU_PRO_ROW, 0)
        self.assertEqual((pro["id"], pro["expected_output"]), ("mmlu_pro:70", "B"))
        arc = benchmarks.to_record("arc_challenge", ARC_ROW, 0)
        self.assertEqual((arc["id"], arc["expected_output"]), ("arc_challenge:Mercury_7175875", "C"))
        numeric = {**ARC_ROW, "choices": {"text": ["x", "y"], "label": ["1", "2"]}, "answerKey": "2"}
        self.assertEqual(benchmarks.to_record("arc_challenge", numeric, 0)["expected_output"], "B")

    def test_unknown_benchmark_and_changed_columns_fail_clearly(self) -> None:
        with self.assertRaisesRegex(SourceUnavailableError, "Unknown benchmark 'ifeval'"):
            benchmarks.to_record("ifeval", {}, 0)
        with self.assertRaisesRegex(SourceUnavailableError, "expected columns"):
            benchmarks.to_record("mmlu", {"question": "q"}, 3)


class BenchmarkImportTests(TempDirCase):
    def test_hf_import_applies_the_benchmark_transform(self) -> None:
        calls = []

        def load_dataset(repo, config, **kwargs):
            calls.append((repo, config, kwargs))
            return iter([GSM8K_ROW, GSM8K_ROW, GSM8K_ROW])

        fake = types.SimpleNamespace(load_dataset=load_dataset)
        batches: list[list[dict]] = []
        source = {"type": "hf", "repo": "openai/gsm8k", "config": "main", "split": "test", "revision": "abc", "benchmark": "gsm8k", "limit": 2}
        with mock.patch.dict(sys.modules, {"datasets": fake}), mock.patch.dict(os.environ, {"GRAD_OFFLINE": "", "HF_HUB_OFFLINE": ""}):
            summary = import_runner.run(source, None, emit_batch=batches.append, workdir=self.tmpdir())
        self.assertEqual(summary.records, 2)
        self.assertEqual(calls[0][2]["revision"], "abc")
        first = batches[0][0]
        self.assertEqual((first["id"], first["expected_output"]), ("gsm8k:0", "1018"))
        self.assertEqual(first["messages"][0]["role"], "user")


if __name__ == "__main__":
    unittest.main()
