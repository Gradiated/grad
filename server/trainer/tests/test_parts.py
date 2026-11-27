"""PartWriter: the gzip JSONL dataset parts an import uploads straight to storage."""

from __future__ import annotations

import gzip
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from grad_trainer.parts import Part, PartWriter, record_error
from grad_trainer.records import RESET_RECORD

MSG = [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]


class PartWriterTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.parts: list[tuple[Part, bytes]] = []

    def upload(self, part: Part) -> None:
        self.parts.append((part, part.path.read_bytes()))

    def writer(self, **kw: Any) -> PartWriter:
        return PartWriter(self.dir, self.upload, id_prefix="imp_1:1", **kw)

    def test_parts_split_by_records_and_bytes_and_carry_their_counts(self) -> None:
        w = self.writer(max_records=3)
        w.write([{"id": f"t{i}", "messages": MSG, "scores": {"q": 1.0}} for i in range(4)])
        w.write([{"id": "t0", "scores": {"r": 0.5}, "metadata": {"score_update": True}}])
        w.close()
        w.close()  # nothing left: no empty part
        self.assertEqual([(p.seq, p.records, p.count, p.score_updates) for p, _ in self.parts], [(0, 3, 3, 0), (1, 2, 1, 1)])
        self.assertEqual(self.parts[1][0].scores, ["q", "r"])
        part, blob = self.parts[0]
        jsonl = gzip.decompress(blob)
        self.assertEqual(hashlib.sha256(jsonl).hexdigest(), part.sha256)
        self.assertEqual(hashlib.sha256(blob).hexdigest(), part.upload_sha256)
        self.assertEqual(len(blob), part.size)
        self.assertEqual([json.loads(line)["id"] for line in jsonl.splitlines()], ["t0", "t1", "t2"])
        self.assertFalse(part.path.exists(), "the local file goes once uploaded")
        small = self.writer(max_bytes=10)
        small.write([{"messages": MSG}, {"messages": MSG}])
        self.assertEqual(len(self.parts), 4, "a part past max_bytes is uploaded at once")

    def test_same_records_make_the_same_bytes_and_ids(self) -> None:
        for _ in range(2):
            w = self.writer()
            w.write([{"messages": MSG}, {"messages": MSG}])
            w.close()
        (first, a), (second, b) = self.parts
        self.assertEqual((a, first.upload_sha256), (b, second.upload_sha256))
        ids = [json.loads(line)["id"] for line in gzip.decompress(a).splitlines()]
        self.assertEqual(len(set(ids)), 2)
        self.assertTrue(all(i.startswith("rec_") for i in ids))

    def test_a_reset_restarts_the_count_and_invalid_records_are_dropped(self) -> None:
        w = self.writer()
        w.write([{"id": "old", "messages": MSG}, dict(RESET_RECORD), {"id": "new", "messages": MSG}, {"messages": "nope"}, {"foo": 1}])
        w.close()
        part, _ = self.parts[0]
        self.assertEqual((part.records, part.count, part.resets), (3, 1, True))
        self.assertEqual(w.dropped, 2)
        self.assertEqual(len(w.reasons), 2)
        self.assertIn("messages", w.reasons[0])

    def test_the_schema_is_the_apis(self) -> None:
        self.assertIsNone(record_error({"id": "x", "messages": MSG, "scores": {"q": 1}, "metadata": {"a": [1]}}))
        self.assertIn("scores", record_error({"scores": {"q": "high"}}) or "")
        self.assertIsNotNone(record_error({"unknown_field": 1}))
        self.assertIsNotNone(record_error([]))


if __name__ == "__main__":
    unittest.main()
