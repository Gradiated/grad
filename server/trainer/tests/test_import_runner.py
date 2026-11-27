"""Import runner: file sources through the connectors, HF sources, batching, per-row errors."""

from __future__ import annotations

import gzip
import json
import os
import sys
import types
from unittest import mock

from helpers import TempDirCase

from grad_trainer import import_runner
from grad_trainer.errors import SourceUnavailableError


class ImportRunnerTests(TempDirCase):
    def run_import(self, source, connector=None):
        batches: list[list[dict]] = []
        summary = import_runner.run(source, connector, emit_batch=batches.append, workdir=self.tmpdir())
        return summary, batches

    def test_jsonl_with_mixed_connectors_and_bad_lines(self) -> None:
        path = self.tmpdir() / "traces.jsonl"
        lines = [
            json.dumps({"messages": [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "yo"}]}),
            "{not json",
            "",
            json.dumps({"event": "$ai_generation", "properties": {"$ai_input": "q", "$ai_output_choices": [{"role": "assistant", "content": "a"}]}}),
            json.dumps([1, 2]),
            json.dumps({"messages": []}),
        ] + [json.dumps({"prompt": f"p{i}", "chosen": "c", "rejected": "r"}) for i in range(5)]
        path.write_text("\n".join(lines))
        summary, batches = self.run_import({"type": "file", "path": str(path), "batch_size": 3})
        self.assertEqual((summary.records, summary.skipped), (7, 3))
        self.assertEqual([len(b) for b in batches], [3, 3, 1])
        self.assertEqual(summary.errors[0], "line 2: invalid JSON (Expecting property name enclosed in double quotes)")
        self.assertIn("line 5: skipped (not_an_object)", summary.errors)
        self.assertEqual(batches[0][1]["metadata"]["source"], "posthog")

    def test_json_array_gzip_and_forced_connector(self) -> None:
        path = self.tmpdir() / "rows.json.gz"
        rows = [{"input": "q", "output": "a", "sessionId": "s"}] * 2
        with gzip.open(path, "wt") as fh:
            json.dump(rows, fh)
        summary, batches = self.run_import({"path": str(path)}, connector="langfuse")
        self.assertEqual(summary.records, 2)
        self.assertEqual(batches[0][0]["session_id"], "s")

    def test_error_cap_and_parser_exceptions(self) -> None:
        path = self.tmpdir() / "bad.jsonl"
        path.write_text("\n".join(["x"] * 150 + [json.dumps({"attributes": {"gen_ai.input.messages": 5}})]))
        with mock.patch.object(import_runner, "parse_row", side_effect=[RuntimeError("boom")]):
            summary, _ = self.run_import({"path": str(path)})
        self.assertEqual(summary.skipped, 151)
        self.assertEqual(len(summary.errors), import_runner.MAX_ERRORS + 1)
        self.assertEqual(summary.errors[-1], "further errors omitted")

    def test_source_errors(self) -> None:
        with self.assertRaisesRegex(SourceUnavailableError, "does not exist"):
            self.run_import({"type": "file", "path": "/nope.jsonl"})
        with self.assertRaisesRegex(SourceUnavailableError, "needs a local 'path'"):
            self.run_import({"type": "file"})
        with self.assertRaisesRegex(SourceUnavailableError, "Unknown import source"):
            self.run_import({"type": "ftp"})
        with self.assertRaisesRegex(SourceUnavailableError, "Unknown connector"):
            self.run_import({"path": "x"}, connector="splunk")
        bad = self.tmpdir() / "bad.json"
        bad.write_text("[1, 2")
        with self.assertRaisesRegex(SourceUnavailableError, "not a valid JSON array"):
            self.run_import({"path": str(bad)})

    def test_huggingface_source_with_column_mapping(self) -> None:
        rows = [{"conv": [{"role": "user", "content": f"q{i}"}, {"role": "assistant", "content": "a"}], "other": i} for i in range(5)]
        calls = []

        def load_dataset(repo, config, **kwargs):
            calls.append((repo, config, kwargs))
            return iter(rows)

        fake = types.SimpleNamespace(load_dataset=load_dataset)
        with mock.patch.dict(sys.modules, {"datasets": fake}), mock.patch.dict(os.environ, {"GRAD_OFFLINE": "", "HF_HUB_OFFLINE": ""}):
            summary, batches = self.run_import(
                {"type": "hf", "repo": "org/chats", "split": "train_sft", "messages": "conv", "limit": 3}
            )
            self.assertEqual(summary.records, 3)
            self.assertEqual(batches[0][0]["id"], "org/chats:train_sft:0")
            self.assertEqual(batches[0][0]["messages"][0]["content"], "q0")
            self.assertEqual(calls[0][2]["split"], "train_sft")
            self.assertIsNone(calls[0][2]["token"])
            # A gated dataset: the token from the workspace secret reaches the Hub client only.
            self.run_import({"type": "hf", "repo": "org/gated", "messages": "conv", "token": "hf_secret_token"})
            self.assertEqual(calls[-1][2]["token"], "hf_secret_token")
            fake.load_dataset = mock.Mock(side_effect=ValueError("401 for token hf_secret_token"))
            with self.assertRaises(SourceUnavailableError) as raised:
                self.run_import({"type": "hf", "repo": "org/gated", "token": "hf_secret_token"})
            self.assertNotIn("hf_secret_token", str(raised.exception))
            fake.load_dataset = load_dataset
            # Without a mapping, only DatasetRecord fields are kept.
            fake.load_dataset = lambda *a, **k: iter([{"query": "q", "positive": "d", "junk": 1}])
            _, batches = self.run_import({"type": "hf", "repo": "org/pairs"})
            self.assertNotIn("junk", batches[0][0])
            with self.assertRaisesRegex(SourceUnavailableError, "no column"):
                self.run_import({"type": "hf", "repo": "org/pairs", "columns": {"messages": "missing"}})
            fake.load_dataset = mock.Mock(side_effect=ValueError("404"))
            with self.assertRaisesRegex(SourceUnavailableError, "Can't load"):
                self.run_import({"type": "hf", "repo": "org/missing"})
            with self.assertRaisesRegex(SourceUnavailableError, "needs 'repo'"):
                self.run_import({"type": "hf"})
            # Regression: completion= and answer= mappings used to be dropped.
            fake.load_dataset = lambda *a, **k: iter([{"question": "2+2?", "solution": "4", "final": "4"}])
            _, batches = self.run_import(
                {"type": "hf", "repo": "org/math", "prompt": "question", "completion": "solution", "answer": "final"}
            )
            self.assertEqual(
                {k: batches[0][0][k] for k in ("prompt", "completion", "expected_output")},
                {"prompt": "2+2?", "completion": "4", "expected_output": "4"},
            )
            _, batches = self.run_import({"type": "hf", "repo": "org/math", "columns": {"prompt": "question", "answer": "final"}})
            self.assertEqual(batches[0][0]["expected_output"], "4")
        with mock.patch.dict(os.environ, {"GRAD_OFFLINE": "1"}):
            with self.assertRaisesRegex(SourceUnavailableError, "offline mode"):
                self.run_import({"type": "hf", "repo": "org/chats"})
        with mock.patch.dict(sys.modules, {"datasets": None}), mock.patch.dict(os.environ, {"GRAD_OFFLINE": "", "HF_HUB_OFFLINE": ""}):
            with self.assertRaisesRegex(SourceUnavailableError, "datasets"):
                self.run_import({"type": "hf", "repo": "org/chats"})


class FileFormatDetectionTests(TempDirCase):
    """Uploads reach the worker without an extension, so formats are detected by content."""

    RECORD = {"messages": [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]}

    def run_import(self, path, fmt=None):
        batches: list[list[dict]] = []
        source = {"kind": "file", "path": str(path)}
        if fmt is not None:
            source["format"] = fmt
        summary = import_runner.run(source, None, emit_batch=batches.append, workdir=self.tmpdir())
        return summary, [r for b in batches for r in b]

    def test_gzip_without_suffix_is_detected_by_magic_bytes(self) -> None:
        path = self.tmpdir() / "import-input"
        path.write_bytes(gzip.compress((json.dumps(self.RECORD) + "\n").encode()))
        summary, records = self.run_import(path)
        self.assertEqual((summary.records, summary.skipped), (1, 0))
        self.assertEqual(records[0]["messages"][1]["content"], "a")

    def test_parquet_is_detected_by_magic_bytes(self) -> None:
        try:
            import pyarrow as pa
            import pyarrow.parquet as pq
        except ImportError:
            self.skipTest("pyarrow not installed")
        path = self.tmpdir() / "import-input"
        pq.write_table(pa.Table.from_pylist([self.RECORD, self.RECORD]), path)
        summary, records = self.run_import(path)
        self.assertEqual(summary.records, 2)
        self.assertEqual(records[0]["messages"][0]["role"], "user")

    def test_explicit_json_format_requires_an_array(self) -> None:
        path = self.tmpdir() / "import-input"
        path.write_text(json.dumps(self.RECORD))
        with self.assertRaises(SourceUnavailableError):
            self.run_import(path, "json")

    def test_unknown_format_is_rejected(self) -> None:
        path = self.tmpdir() / "import-input"
        path.write_text("{}")
        with self.assertRaisesRegex(SourceUnavailableError, "Unknown import file format"):
            self.run_import(path, "csv")

    def test_invalid_parquet_reports_a_clear_error(self) -> None:
        try:
            import pyarrow  # noqa: F401
        except ImportError:
            self.skipTest("pyarrow not installed")
        path = self.tmpdir() / "import-input"
        path.write_bytes(b"PAR1garbage")
        with self.assertRaisesRegex(SourceUnavailableError, "not a valid Parquet file"):
            self.run_import(path)
