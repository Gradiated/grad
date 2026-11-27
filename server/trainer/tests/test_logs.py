"""The trainer's structured JSON logs: fields, job context, stacks, redaction."""

from __future__ import annotations

import contextlib
import io
import json
import logging
import unittest
import warnings

from grad_trainer import logs


def _lines(out: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]


class LogsTests(unittest.TestCase):
    def test_lines_are_json_with_level_component_and_context(self) -> None:
        logs.set_worker(worker_id="w-1")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            with logs.job_context(job_id="run_1", kind="train", attempt=2, run_id="run_1", workspace_id="ws_a"):
                logs.log("info", "claimed", step=None, recipe_kind="sft")
            logs.log("warn", "idle")
        first, second = _lines(out)
        self.assertEqual(first["level"], "info")
        self.assertEqual(first["component"], "trainer")
        self.assertEqual(first["msg"], "claimed")
        self.assertEqual(
            {k: first[k] for k in ("worker_id", "job_id", "kind", "attempt", "run_id", "workspace_id", "recipe_kind")},
            {"worker_id": "w-1", "job_id": "run_1", "kind": "train", "attempt": 2, "run_id": "run_1",
             "workspace_id": "ws_a", "recipe_kind": "sft"},
        )
        self.assertNotIn("step", first)  # None fields are left out
        self.assertTrue(first["time"].endswith("Z"))
        self.assertEqual(second["worker_id"], "w-1")
        self.assertNotIn("job_id", second)  # the job context ended

    def test_exc_adds_the_error_and_its_stack(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            try:
                raise ValueError("bad shard")
            except ValueError:
                logs.log("error", "job failed", exc=True)
        (line,) = _lines(out)
        self.assertEqual(line["error"], "bad shard")
        self.assertEqual(line["error_type"], "ValueError")
        self.assertIn("Traceback (most recent call last)", line["stack"])

    def test_credentials_are_masked(self) -> None:
        key = "grad_" + "ab" * 24
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            logs.log(
                "warn",
                f"PUT https://s3/x?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA/1 with Bearer {key} "
                "and gradwt_abcdefghijklmnopqrstuvwxyz0123 and hf_abcdefghijklmnopqrstuvwxyz",
            )
        text = out.getvalue()
        for secret in ("deadbeef", "AKIA/1", key, "gradwt_abcdefghij", "hf_abcdefghijkl"):
            self.assertNotIn(secret, text)
        # Metric and table names are not credentials.
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            logs.log("info", "grad_job_oldest_queued_age_seconds grad_schema_migrations")
        self.assertIn("grad_job_oldest_queued_age_seconds grad_schema_migrations", out.getvalue())

    def test_install_routes_library_logging_and_warnings(self) -> None:
        root = logging.getLogger()
        saved = (list(root.handlers), root.level)
        self.addCleanup(lambda: (root.handlers.clear(), root.handlers.extend(saved[0]), root.setLevel(saved[1])))
        self.addCleanup(logging.captureWarnings, False)
        logs.install()
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            logging.getLogger("some_library.loading").warning("weights %s not used", "lm_head")
            with warnings.catch_warnings():
                warnings.simplefilter("always")
                warnings.warn("deprecated knob")
        lines = _lines(out)
        library = next(line for line in lines if line["msg"] == "weights lm_head not used")
        self.assertEqual(library["level"], "warn")
        self.assertEqual(library["logger"], "some_library.loading")
        self.assertTrue(any("deprecated knob" in line["msg"] for line in lines))


if __name__ == "__main__":
    unittest.main()
