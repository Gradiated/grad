"""MergedDataset (the trainer's on-disk merged records) against the in-memory merge_records."""

from __future__ import annotations

import gzip
import json
import random
import tempfile
import unittest
from pathlib import Path
from typing import Any

from grad_trainer.records import RESET_RECORD, MergedDataset, merge_records
from grad_trainer.splits import split_indices, split_records


def stream(rnd: random.Random, n: int) -> list[dict[str, Any]]:
    """Dataset parts in order: traces (some re-synced with new content), score updates (some for
    traces that arrive later), corrections, score-filtered traces, id-less rows and resets."""
    out: list[dict[str, Any]] = []
    for i in range(n):
        rid = f"t{rnd.randrange(n // 3 + 1)}"
        roll = rnd.random()
        if roll < 0.02:
            out.append(dict(RESET_RECORD))
        elif roll < 0.3:
            update: dict[str, Any] = {"id": rid, "metadata": {"score_update": True}}
            if rnd.random() < 0.7:
                update["scores"] = {rnd.choice("ab"): rnd.random()}
            if rnd.random() < 0.3:
                update["expected_output"] = f"fix {i}"
            out.append(update)
        elif roll < 0.35:
            out.append({"messages": [{"role": "user", "content": f"no id {i}"}]})
        else:
            rec: dict[str, Any] = {"id": rid, "session_id": f"s{i % 7}", "messages": [{"role": "user", "content": "é" * rnd.randrange(3) + f"q{i}"}]}
            if rnd.random() < 0.4:
                rec["scores"] = {} if rnd.random() < 0.2 else {rnd.choice("ab"): rnd.random()}
            if rnd.random() < 0.3:
                rec["expected_output"] = {"answer": f"a{i}"} if rnd.random() < 0.5 else None
            if rnd.random() < 0.2:
                rec["metadata"] = {"source": "x", "score_filter": rnd.choice([{"has_feedback": True}, {"min_score": 0.5}])}
            out.append(rec)
    return out


def write_parts(path: Path, records: list[dict[str, Any]], parts: int) -> None:
    # One gzip member per stored part, back to back, as grad-server streams them; blank lines too.
    size = max(1, len(records) // parts)
    with open(path, "wb") as fh:
        for start in range(0, len(records), size):
            body = "".join(json.dumps(r, ensure_ascii=False) + "\n\n" for r in records[start : start + size])
            fh.write(gzip.compress(body.encode()))


class MergedDatasetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, True))

    def load(self, records: list[dict[str, Any]], parts: int = 3) -> MergedDataset:
        write_parts(self.tmp / "d.jsonl.gz", records, parts)
        return MergedDataset.from_parts(self.tmp / "d.jsonl.gz", self.tmp / "d.jsonl")

    def test_matches_the_in_memory_merge(self) -> None:
        for seed in range(40):
            records = stream(random.Random(seed), 120)
            expected = merge_records(json.loads(json.dumps(records)))
            merged = self.load(records, parts=1 + seed % 4)
            self.assertEqual(list(merged), expected, f"seed {seed}")
            self.assertEqual(len(merged), len(expected))
            if expected:
                self.assertEqual(merged[len(expected) - 1], expected[-1])
                self.assertEqual(merged[1:3], expected[1:3])

    def test_splits_on_heads_like_on_records(self) -> None:
        records = stream(random.Random(7), 400)
        expected = merge_records(json.loads(json.dumps(records)))
        merged = self.load(records)
        for strategy in ("by_session", "by_group", "random"):
            train_idx, eval_idx = split_indices(merged.heads, strategy=strategy, eval_fraction=0.2, seed=3)
            train, held = split_records(expected, strategy=strategy, eval_fraction=0.2, seed=3)
            self.assertEqual((list(merged.select(train_idx)), list(merged.select(eval_idx))), (train, held))

    def test_heads_are_a_fraction_of_the_records(self) -> None:
        records = [{"id": f"r{i}", "session_id": f"s{i}", "messages": [{"role": "user", "content": "x" * 2000}]} for i in range(50)]
        merged = self.load(records)
        self.assertNotIn("messages", merged.heads[0])
        self.assertEqual(merged[49]["messages"][0]["content"], "x" * 2000)

    def test_matches_the_parity_fixture_server_api_replays(self) -> None:
        # merge_parity.json: parts -> merge_records(). server/api/test/trainer-parity.test.ts
        # checks mergeRecords and the dataset page index against the same file.
        for case in json.loads((Path(__file__).parent / "fixtures" / "merge_parity.json").read_text()):
            with self.subTest(case["name"]):
                flat = [r for part in case["parts"] for r in part]
                self.assertEqual(merge_records(json.loads(json.dumps(flat))), case["merged"])
                write_parts(self.tmp / "d.jsonl.gz", flat, len(case["parts"]))
                merged = MergedDataset.from_parts(self.tmp / "d.jsonl.gz", self.tmp / "d.jsonl")
                self.assertEqual(list(merged), case["merged"])

    def test_a_truncated_download_raises(self) -> None:
        write_parts(self.tmp / "d.jsonl.gz", stream(random.Random(1), 50), 1)
        data = (self.tmp / "d.jsonl.gz").read_bytes()
        (self.tmp / "d.jsonl.gz").write_bytes(data[:-10])
        with self.assertRaises(EOFError):
            MergedDataset.from_parts(self.tmp / "d.jsonl.gz", self.tmp / "d.jsonl")


if __name__ == "__main__":
    unittest.main()
