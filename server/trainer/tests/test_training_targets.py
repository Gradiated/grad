"""Which tokens a record trains on, for every prompt-plus-answer shape and for synced corrections.

The cases live in ``tests/fixtures/records/training-targets.json``, which the server's planner
test reads too, so the plan counts exactly the records the trainer can train on.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from helpers import QWEN_ID, TorchCase

from grad_trainer.config import parse_train_spec
from grad_trainer.recipes.data import correction_pair, extract_pairs, prompt_messages, record_messages

FIXTURE = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "records" / "training-targets.json"
CASES = json.loads(FIXTURE.read_text())["cases"]
CONFIG = {"model": QWEN_ID, "batch_size": 2, "epochs": 1, "adapter": {"kind": "lora", "rank": 4, "alpha": 8}}


def answer_text(conversation: list[dict]) -> str:
    return conversation[-1]["content"]


class TrainingTargetTests(unittest.TestCase):
    def test_each_record_trains_on_its_documented_conversation(self) -> None:
        for case in CASES:
            with self.subTest(case["name"]):
                self.assertEqual(record_messages(case["record"]), case["conversation"])

    def test_a_correction_pairs_as_chosen_against_the_logged_answer(self) -> None:
        for case in CASES:
            with self.subTest(case["name"]):
                pair = correction_pair(case["record"])
                want = case["correction_pair"]
                self.assertEqual(None if pair is None else {"chosen": pair[1], "rejected": pair[2]}, want)
                if pair is not None:
                    self.assertEqual(pair[0], prompt_messages(case["record"]))
        pairs, dropped = extract_pairs([c["record"] for c in CASES])
        self.assertEqual(len(pairs), sum(1 for c in CASES if c["correction_pair"]))
        self.assertEqual(dropped, len(CASES) - len(pairs), "every other record is counted as dropped")


class TrainingTokenMaskTests(TorchCase):
    """The SFT and DPO tasks' rendered token masks: the prompt is context, only the answer trains."""

    def sft_task(self, records: list[dict], **config: object):
        from grad_trainer.recipes.sft import SFTTask

        return SFTTask(parse_train_spec("sft", {**CONFIG, **config}), records, [], self.tmpdir())

    def test_sft_trains_only_the_answer_with_the_prompt_as_context(self) -> None:
        usable = [c for c in CASES if c["sft_usable"]]
        task = self.sft_task([c["record"] for c in CASES])
        self.assertEqual(len(task.train_examples), len(usable))
        self.assertEqual(task.stats["skipped_no_messages"], len(CASES) - len(usable) - 1)  # "a prompt without an answer"
        self.assertEqual(task.stats["skipped_no_trained_tokens"], 1)
        for case, (ids, trained) in zip(usable, task.train_examples):
            with self.subTest(case["name"]):
                text = task.tokenizer.decode(list(ids))
                target = task.tokenizer.decode([i for i, t in zip(ids, trained) if t])
                context = task.tokenizer.decode([i for i, t in zip(ids, trained) if not t])
                self.assertEqual(target.removesuffix("<|im_end|>").strip(), answer_text(case["conversation"]))
                for message in case["conversation"][:-1]:
                    self.assertIn(message["content"], context)
                    self.assertIn(f"<|im_start|>{message['role']}", text)
                rejected = (case["correction_pair"] or {}).get("rejected")
                if rejected:
                    self.assertNotIn(rejected[0]["content"], text, "the logged answer a correction replaced is gone")
        warnings = task.final_report()["warnings"]
        self.assertIn("2 records had no prompt and answer to train on and were skipped.", warnings)
        self.assertTrue(any("1 records had no trained tokens left" in w for w in warnings), warnings)

    def test_all_assistant_trains_earlier_answers_too(self) -> None:
        case = next(c for c in CASES if c["record"]["id"] == "mt")
        last = self.sft_task([case["record"]])
        every = self.sft_task([case["record"]], train_on="all_assistant")
        decode = lambda task: task.tokenizer.decode([i for i, t in zip(*task.train_examples[0]) if t])  # noqa: E731
        self.assertNotIn("First A", decode(last))
        self.assertIn("First A", decode(every))
        self.assertIn("Second A", decode(every))
        self.assertNotIn("Second Q", decode(every))

    def test_dpo_trains_the_correction_as_chosen(self) -> None:
        from grad_trainer.recipes.dpo import DPOTask

        records = [c["record"] for c in CASES]
        task = DPOTask(parse_train_spec("dpo", CONFIG), records, [], self.tmpdir())
        paired = [c for c in CASES if c["correction_pair"]]
        self.assertEqual(len(task.train_pairs), len(paired))
        self.assertEqual(task.dropped, len(CASES) - len(paired))
        for case, (chosen, rejected) in zip(paired, task.train_pairs):
            with self.subTest(case["name"]):
                for side, (ids, trained) in (("chosen", chosen), ("rejected", rejected)):
                    target = task.tokenizer.decode([i for i, t in zip(ids, trained) if t])
                    self.assertEqual(target.removesuffix("<|im_end|>").strip(), case["correction_pair"][side][0]["content"])
                    self.assertIn(case["conversation"][-2]["content"], task.tokenizer.decode(list(ids)))


if __name__ == "__main__":
    unittest.main()
