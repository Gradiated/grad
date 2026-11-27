"""A CI-sized run of scripts/load/sources.py (about 30 s of traffic): a fake Langfuse at 50 traces
a second with late scores, synced by hand every 5 s. Every trace and score lands once, and each
sync catches up to within a few seconds of the provider."""

from __future__ import annotations

import argparse
import importlib.util
import unittest
from pathlib import Path

from _stack import live_skip_reason

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "load" / "sources.py"


class SourcesLoadLiveTests(unittest.TestCase):
    def test_a_busy_source_keeps_up_and_loses_nothing(self) -> None:
        reason = live_skip_reason("reference")
        if reason:
            self.skipTest(reason)
        spec = importlib.util.spec_from_file_location("load_sources", SCRIPT)
        assert spec and spec.loader
        load = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(load)
        args = argparse.Namespace(
            rate=50.0, duration=30.0, score_every=10, score_delay=(3.0, 10.0), version_interval=0,
            sample_every=1.0, manual_every=5.0,
        )  # fmt: skip
        report = load.run(args)
        self.assertEqual(report["failed_syncs"], 0)
        self.assertEqual((report["records_read"], report["duplicates"]), (report["traces_generated"], 0))
        self.assertEqual(report["records_with_scores"], report["scores_generated"])
        self.assertLess(report["lag_after_sync_s"]["max"], 10)
        if report["s3_objects_added"] is not None:  # needs the aws CLI
            self.assertGreater(report["s3_objects_added"], 0)
        self.assertEqual(report["pg_rows_added"]["grad_job_events"], 0, "syncs write no job events")


if __name__ == "__main__":
    unittest.main()
