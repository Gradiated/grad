"""SyncEngine guards and batching, the record merge, and the import-runner seam for source jobs."""

from __future__ import annotations

import os
import unittest
from typing import Any
from unittest import mock

from fixtures.provider_server import FakeProviderServer
from fixtures.providers import GradiatedFixture, LangfuseFixture
from fixtures.providers.base import NOW, iso

from grad_trainer import import_runner
from grad_trainer.errors import PaginationLoopError, SourceUnreachableError
from grad_trainer.providers import Page, Provider, ScoreUpdate, SyncEngine
from grad_trainer.providers.langfuse import LangfuseProvider
from grad_trainer.providers.sync import pages
from grad_trainer.records import RESET_RECORD, merge_records


class Scripted(Provider):
    """A provider whose pages are given by the test."""

    name = "scripted"

    def __init__(self, trace_pages: list[Page], score_pages: list[Page] | None = None) -> None:
        super().__init__()
        self.trace_pages, self.score_pages = trace_pages, score_pages or [Page([])]

    def auth_headers(self, secret: str) -> dict[str, str]:
        return {}

    def fetch_traces(self, since: str | None, cursor: str | None) -> Page:
        return self.trace_pages[int(cursor or 0)]

    def fetch_scores(self, since: str | None, cursor: str | None) -> Page:
        return self.score_pages[int(cursor or 0)]

    def to_record(self, raw: dict[str, Any]) -> dict[str, Any] | None:
        if raw.get("boom"):
            raise ValueError("bad row")
        return {"id": raw.get("id"), "messages": [{"role": "user", "content": "q"}], "timestamp": raw.get("at")}

    def to_score_update(self, raw: dict[str, Any]) -> ScoreUpdate | None:
        return ScoreUpdate(raw["id"], raw.get("scores", {}), raw.get("expected"), raw.get("at"))


def run(provider: Provider, **kw: Any) -> tuple[list[list[dict]], Any]:
    batches: list[list[dict]] = []
    result = SyncEngine(provider, emit_batch=batches.append, now=lambda: NOW, **kw).run(None)
    return batches, result


class EngineTests(unittest.TestCase):
    def test_bad_rows_are_skipped_and_reported(self) -> None:
        batches, result = run(Scripted([Page([{"id": "a"}, {"boom": True}, {"id": None}])]))
        self.assertEqual([r["id"] for b in batches for r in b], ["a"])
        self.assertEqual(result.skipped, 2)
        self.assertEqual(result.errors, ["scripted: ValueError: bad row", "scripted: no trace id or no messages"])

    def test_rows_newer_than_the_settle_point_wait_for_the_next_sync(self) -> None:
        batches, result = run(Scripted([Page([{"id": "old", "at": iso(NOW.replace(hour=1))}, {"id": "new", "at": iso(NOW)}])]))
        self.assertEqual([r["id"] for b in batches for r in b], ["old"])
        self.assertLess(result.watermark["traces"], iso(NOW))

    def test_score_updates_for_one_trace_merge_latest_wins(self) -> None:
        scores = [
            {"id": "a", "scores": {"x": 1.0}, "at": "2026-11-27T10:00:00Z"},
            {"id": "a", "scores": {"x": 0.0, "y": 1.0}, "expected": "fixed", "at": "2026-11-27T11:00:00Z"},
            {"id": "a", "scores": {"x": 0.5}, "at": "2026-11-27T09:00:00Z"},  # older edit arrives last
            {"id": "b", "scores": {}, "at": "2026-11-27T09:00:00Z"},  # nothing to apply
        ]
        batches, _ = run(Scripted([Page([{"id": "a"}])], [Page(scores)]))
        updates = [r for b in batches for r in b if r.get("metadata", {}).get("score_update")]
        self.assertEqual(len(updates), 1)
        self.assertEqual((updates[0]["scores"], updates[0]["expected_output"]), ({"x": 0.0, "y": 1.0}, "fixed"))

    def test_batches_are_bounded(self) -> None:
        rows = [{"id": f"t{i}"} for i in range(7)]
        batches, result = run(Scripted([Page(rows)]), batch_size=3)
        self.assertEqual([len(b) for b in batches], [3, 3, 1])
        self.assertEqual(result.records, 7)

    def test_identical_rereads_are_dropped_changed_ones_reemitted(self) -> None:
        rows = [{"id": "a"}, {"id": "a"}, {"id": "b"}]
        batches, _ = run(Scripted([Page(rows[:2], "1"), Page(rows[1:])]), batch_size=1)
        self.assertEqual([r["id"] for b in batches for r in b], ["a", "b"])

    def test_pagination_guards(self) -> None:
        endless = Scripted([Page([{"id": "x"}], str(i + 1)) for i in range(10)])
        with self.assertRaisesRegex(PaginationLoopError, "more than 5 pages"):
            run(endless, max_pages=5)
        empty = [Page([], str(i + 1)) for i in range(30)]
        with self.assertRaisesRegex(PaginationLoopError, "empty pages"):
            list(pages(lambda _s, c: empty[int(c or 0)], None))
        some_empty = [Page([], "1"), Page([{"id": "y"}])]
        self.assertEqual(len(list(pages(lambda _s, c: some_empty[int(c or 0)], None))), 2)


class MergeTests(unittest.TestCase):
    def test_a_sync_has_a_wall_clock_cap(self) -> None:
        # r8 P1-6: a source that keeps answering slowly can't hold the worker past the cap,
        # and the provider's HTTP client gets the same deadline for its in-flight request.
        ticks = iter(float(t) for t in range(0, 1000, 10))
        provider = Scripted([Page([{"id": "a"}], cursor="1"), Page([{"id": "b"}], cursor="2"), Page([{"id": "c"}])])
        with self.assertRaisesRegex(SourceUnreachableError, "longer than 15s"):
            run(provider, max_seconds=15, clock=lambda: next(ticks))
        self.assertEqual(provider._http_options["deadline"], 15.0)

    def test_merge_rules(self) -> None:
        def update(rid: str, **kw: Any) -> dict:
            return ScoreUpdate(rid, **kw).to_record("x")

        parts = [
            update("b", scores={"early": 1.0}),  # before its trace
            {"id": "a", "messages": [1], "scores": {"s": 0.0}},
            {"messages": [2]},  # no id: kept as is
            {"id": "b", "messages": [3]},
            update("a", scores={"s": 1.0}, expected_output="fix"),
            {"id": "a", "messages": [4]},  # re-synced content keeps the merged feedback
            update("ghost", scores={"s": 1.0}),  # trace never synced
        ]
        merged = merge_records(parts)
        self.assertEqual(
            merged,
            [{"id": "a", "messages": [4], "scores": {"s": 1.0}, "expected_output": "fix"}, {"messages": [2]}, {"id": "b", "messages": [3], "scores": {"early": 1.0}}],
        )
        self.assertEqual(merge_records([{"id": "c", "messages": []}, {"id": "c", "messages": [1]}]), [{"id": "c", "messages": [1]}])

    def test_reset_marker_drops_everything_before_it(self) -> None:
        parts = [
            {"id": "old", "messages": [1], "scores": {"s": 0.0}},
            {"id": "a", "messages": [1], "scores": {"stale": 1.0}},
            ScoreUpdate("pending", scores={"s": 1.0}).to_record("x"),
            dict(RESET_RECORD),
            {"id": "a", "messages": [2], "scores": {"s": 1.0}},
            {"id": "pending", "messages": [3]},
        ]
        self.assertEqual(merge_records(parts), [{"id": "a", "messages": [2], "scores": {"s": 1.0}}, {"id": "pending", "messages": [3]}])


class ImportSeamTests(unittest.TestCase):
    def test_provider_source_job_returns_the_watermark(self) -> None:
        fx = LangfuseFixture()
        for i in range(3):
            fx.add_trace(i, NOW.replace(hour=9, minute=i))
        env = {"GRAD_SOURCES_EGRESS_ALLOW": "127.0.0.1/32"}
        with FakeProviderServer(fx) as server, mock.patch.dict(os.environ, env), mock.patch.object(LangfuseProvider, "requests_per_minute", None):
            batches: list[list[dict]] = []
            source = {"kind": "provider", "provider": "langfuse", "host": server.url, "secret": fx.secret, "watermark": None, "full": False}
            summary = import_runner.run(source, None, emit_batch=batches.append, workdir=None)  # type: ignore[arg-type]
        self.assertEqual(summary.records, 3)
        self.assertEqual(set(summary.watermark or {}), {"traces", "scores"})

    def test_gradiated_reads_through_the_worker_page_function(self) -> None:
        fx = GradiatedFixture()
        fx.add_trace(0, NOW)
        fx.add_score("tr-0", "thumbs", 1.0, NOW)
        batches: list[list[dict]] = []
        summary = import_runner.run({"kind": "provider", "provider": "gradiated"}, None, emit_batch=batches.append, workdir=None, source_page=fx.pull)  # type: ignore[arg-type]
        self.assertEqual(summary.watermark, {"traces": "2", "scores": "2"})
        self.assertEqual(merge_records(batches[0])[0]["scores"], {"thumbs": 1.0})

    def test_filters_sample_rate_and_budget_reach_the_engine(self) -> None:
        fx = GradiatedFixture()
        for i in range(5):
            fx.add_trace(i, NOW)
        batches: list[list[dict]] = []
        source = {"kind": "provider", "provider": "gradiated", "filters": {"tags": ["prod"], "environment": "production"}, "sample_rate": 1, "max_records": 2}
        summary = import_runner.run(source, None, emit_batch=batches.append, workdir=None, source_page=fx.pull)  # type: ignore[arg-type]
        self.assertEqual((summary.records, summary.traces), (2, 2))
        self.assertEqual(summary.errors, ["filtered out: 1 traces", "over the record cap: 2 traces"])


class FilterTests(unittest.TestCase):
    def test_values_and_matching(self) -> None:
        from grad_trainer.providers.filters import Filters

        record = {"id": "t", "session_id": "s1", "timestamp": "2026-11-27T10:00:00Z",
                  "metadata": {"tags": ["a", "b"], "model": "m", "version": 3, "flag": True}}  # fmt: skip
        self.assertTrue(Filters({"tags": ["a"], "model": ["x", "m"], "version": "3", "metadata": {"flag": True}}).matches(record))
        self.assertFalse(Filters({"tags": ["a", "c"]}).matches(record))
        self.assertFalse(Filters({"environment": "prod"}).matches(record), "a missing field doesn't match")
        self.assertFalse(Filters({"metadata": {"flag": "false"}}).matches(record))
        self.assertTrue(Filters({"from": "2026-11-27T10:00:00Z", "to": "2026-11-27T10:00:01Z"}).matches(record))
        self.assertFalse(Filters({"to": "2026-11-27T10:00:00Z"}).matches(record), "to is exclusive")
        self.assertFalse(Filters({"from": "2026-11-27T10:00:00Z"}).matches({"id": "t"}), "a time window needs a timestamp")
        self.assertFalse(Filters({"session_id": "s2"}).matches(record))
        self.assertIsNone(Filters({"has_feedback": False}).score_rule())
        self.assertEqual(Filters({"has_feedback": True, "model": "m"}).score_rule(), {"has_feedback": True})

    def test_sampling_rate_is_honoured_and_stable(self) -> None:
        from grad_trainer.providers.filters import sampled

        kept = [i for i in range(10_000) if sampled(f"trace-{i}", 0.1)]
        self.assertAlmostEqual(len(kept) / 10_000, 0.1, delta=0.01)
        self.assertEqual(kept, [i for i in range(10_000) if sampled(f"trace-{i}", 0.1)])
        self.assertTrue(set(kept) <= {i for i in range(10_000) if sampled(f"trace-{i}", 0.2)}, "a higher rate keeps a superset")
        self.assertFalse(sampled("x", 0.0))
        self.assertTrue(sampled("x", 1.0))

    def test_score_filter_rules_on_the_merged_record(self) -> None:
        from grad_trainer.records import SCORE_FILTER, passes_score_filter

        def rec(rule: dict[str, Any], **fields: Any) -> dict[str, Any]:
            return {"id": "t", "metadata": {SCORE_FILTER: rule}, **fields}

        self.assertFalse(passes_score_filter(rec({"has_feedback": True})))
        self.assertTrue(passes_score_filter(rec({"has_feedback": True}, expected_output="fix")))
        self.assertTrue(passes_score_filter(rec({"min_score": 0.5}, scores={"a": 0.5, "b": 0.9})))
        self.assertFalse(passes_score_filter(rec({"min_score": 0.5}, scores={"a": 0.4, "b": 0.9})))
        self.assertFalse(passes_score_filter(rec({"min_score": 0.5})), "a number needs at least one score")
        self.assertTrue(passes_score_filter(rec({"min_score": {"a": 0.5}}, scores={"a": 0.7, "b": 0.0})))
        self.assertFalse(passes_score_filter(rec({"min_score": {"a": 0.5}}, scores={"b": 0.9})))
        self.assertTrue(passes_score_filter({"id": "t"}))
        late = merge_records([rec({"has_feedback": True}, messages=[{"role": "user", "content": "q"}]),
                              {"id": "t", "scores": {"a": 1.0}, "metadata": {"score_update": True}}])  # fmt: skip
        self.assertEqual(late, [{"id": "t", "metadata": {}, "messages": [{"role": "user", "content": "q"}], "scores": {"a": 1.0}}])


if __name__ == "__main__":
    unittest.main()
