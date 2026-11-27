"""Provider-specific quirks the shared contract does not cover."""

from __future__ import annotations

import ipaddress
import os
import json
import unittest
from datetime import timedelta
from typing import Any
from unittest import mock

from fixtures.provider_server import FakeProviderServer
from fixtures.providers import BraintrustFixture, LangfuseFixture, LangSmithFixture, PhoenixFixture, PostHogFixture
from fixtures.providers.base import NOW, iso

from grad_trainer.errors import SourceAPIChangedError, SourceAuthError, SourceUnavailableError
from grad_trainer.import_runner import detect_source, normalize_traces, parse_row
from grad_trainer.providers import PROVIDERS, SourceSpec, SyncEngine, build_provider
from grad_trainer.providers.braintrust import BraintrustProvider
from grad_trainer.providers.gradiated import GradiatedProvider
from grad_trainer.providers.http import EgressPolicy, _PinnedHTTPSConnection
from grad_trainer.providers.langfuse import LangfuseProvider
from grad_trainer.providers.langsmith import LangSmithProvider
from grad_trainer.providers.phoenix import PhoenixProvider
from grad_trainer.providers.posthog import PostHogProvider
from grad_trainer.records import merge_records

LOOPBACK = EgressPolicy(allow=(ipaddress.ip_network("127.0.0.0/8"),))


class Served(unittest.TestCase):
    def serve(self, fixture: Any, *, traces: int = 2) -> tuple[Any, FakeProviderServer]:
        server = FakeProviderServer(fixture).__enter__()
        self.addCleanup(server.__exit__)
        for i in range(traces):
            fixture.add_trace(i, NOW - timedelta(hours=1) + timedelta(minutes=i))
        return fixture, server

    def provider(self, fixture: Any, server: FakeProviderServer, **source: Any) -> Any:
        spec = {"provider": fixture.name, "host": server.url, "secret": fixture.secret, "project": fixture.project, **source}
        return build_provider(spec, policy=LOOPBACK, sleep=lambda _s: None)

    def sync(self, provider: Any, watermark: Any = None, now: Any = NOW) -> tuple[list[dict], Any]:
        batches: list[list[dict]] = []
        result = SyncEngine(provider, emit_batch=batches.append, now=lambda: now).run(watermark)
        return [r for b in batches for r in b], result


class LangfuseQuirks(Served):
    def test_secret_must_be_a_key_pair(self) -> None:
        with self.assertRaisesRegex(SourceAuthError, "PUBLIC_KEY:SECRET_KEY"):
            LangfuseProvider(SourceSpec(secret="sk-lf-only")).http  # noqa: B018

    def test_edited_score_with_an_old_timestamp_lands_through_the_rescan_window(self) -> None:
        fx, server = self.serve(LangfuseFixture())
        fx.add_score("tr-0", "resolved", 1.0, NOW - timedelta(minutes=35))
        first, wm = self.sync(self.provider(fx, server))
        fx.scores[0].update(value=0.0, updatedAt=iso(NOW + timedelta(minutes=5)))  # edited later, same timestamp
        # The re-scan window (GRAD_SOURCES_RESCAN_SECONDS, 1 h) still reaches its timestamp.
        second, _ = self.sync(self.provider(fx, server), wm.watermark, now=NOW + timedelta(minutes=20))
        merged = {r["id"]: r for r in merge_records(first + second)}
        self.assertEqual(merged["tr-0"]["scores"], {"resolved": 0.0})

    def test_feedback_is_re_read_over_a_bounded_window(self) -> None:
        from grad_trainer.providers.base import RESCAN_WINDOW

        self.assertEqual(RESCAN_WINDOW, timedelta(hours=1))
        fx, server = self.serve(LangfuseFixture())
        self.sync(self.provider(fx, server), {"traces": iso(NOW - timedelta(days=3)), "scores": iso(NOW - timedelta(days=3))})
        since = [r.arg("fromTimestamp") for r in server.requests if r.path == "/api/public/v3/scores"]
        self.assertEqual(since, [iso(NOW - timedelta(days=3))], "an older watermark is used as is")
        server.requests.clear()
        # A recent watermark: one window back, not the 7 days it used to be.
        later = NOW + timedelta(minutes=5)
        self.sync(self.provider(fx, server), {"traces": iso(NOW), "scores": iso(NOW)}, now=later)
        since = [r.arg("fromTimestamp") for r in server.requests if r.path == "/api/public/v3/scores"]
        self.assertEqual(since, [iso(later - RESCAN_WINDOW)])
        # Re-scanned under 15 min ago (GRAD_SOURCES_RESCAN_EVERY_SECONDS): scores from the watermark.
        server.requests.clear()
        _, result = self.sync(self.provider(fx, server), {"traces": iso(NOW), "scores": iso(NOW), "rescanned": iso(NOW)}, now=later)
        since = [r.arg("fromTimestamp") for r in server.requests if r.path == "/api/public/v3/scores"]
        self.assertEqual((since, result.watermark["rescanned"]), ([iso(NOW)], iso(NOW)))

    def test_requests_per_minute_can_be_raised_for_a_bigger_plan(self) -> None:
        fx, server = self.serve(LangfuseFixture())
        self.assertEqual(self.provider(fx, server).http.requests_per_minute, 30)
        with mock.patch.dict(os.environ, {"GRAD_SOURCES_LANGFUSE_REQUESTS_PER_MINUTE": "1000"}):
            self.assertEqual(self.provider(fx, server).http.requests_per_minute, 1000)

    def test_score_types(self) -> None:
        p = LangfuseProvider()
        obs = {"subject": {"kind": "observation", "id": "o1", "traceId": "t1"}, "updatedAt": "2026-11-27T10:00:00Z"}
        self.assertEqual(p.to_score_update({**obs, "name": "ok", "dataType": "BOOLEAN", "value": True}).scores, {"ok": 1.0})
        fix = p.to_score_update({**obs, "name": "fix", "dataType": "CORRECTION", "value": "Billing > Invoices"})
        self.assertEqual((fix.trace_id, fix.expected_output, fix.scores), ("t1", "Billing > Invoices", {}))
        self.assertIsNone(p.to_score_update({**obs, "name": "c", "dataType": "CATEGORICAL", "value": "good"}))
        self.assertIsNone(p.to_score_update({"subject": {"kind": "session", "id": "s"}, "name": "n", "value": 1}))
        self.assertEqual(p.to_score_update({"traceId": "t2", "name": "q", "value": 0.5}).trace_id, "t2")  # v1 export

    def test_v1_trace_export_rows_still_import(self) -> None:
        row = {"id": "lf1", "timestamp": "2026-11-01T00:00:00Z", "sessionId": "s", "input": [{"role": "user", "content": "q"}], "output": "a",
               "scores": [{"name": "quality", "value": 0.9}], "release": "r1", "version": "v9", "tags": ["x"], "metadata": {"model": "m"}}  # fmt: skip
        self.assertEqual(detect_source(row), "langfuse")
        rec = normalize_traces([row])[0]
        self.assertEqual((rec["id"], rec["scores"], rec["metadata"]["release"], rec["metadata"]["model"]), ("lf1", {"quality": 0.9}, "r1", "m"))


class LangSmithQuirks(Served):
    def test_project_lookup(self) -> None:
        fx, server = self.serve(LangSmithFixture())
        with self.assertRaisesRegex(SourceUnavailableError, "no tracing project named 'other'"):
            self.sync(self.provider(fx, server, project="other"))
        server.requests.clear()
        self.sync(self.provider(fx, server, project="6f1c1a52-3f0e-4a4e-9b55-3d1d7c4e2a10"))
        self.assertNotIn("/api/v1/sessions", server.paths())

    def test_feedback_offset_paging_and_corrections(self) -> None:
        fx, server = self.serve(LangSmithFixture())
        for n in range(3):
            fx.add_score("tr-0", f"k{n}", 1.0, NOW - timedelta(minutes=30 - n))
        fx.scores[1]["correction"] = {"outputs": {"answer": "fixed"}}
        provider = self.provider(fx, server)
        provider.page_size = 2
        records, _ = self.sync(provider)
        merged = {r["id"]: r for r in merge_records(records)}
        self.assertEqual(merged["tr-0"]["scores"], {"k0": 1.0, "k1": 1.0, "k2": 1.0})
        # The correction's fixed outputs, unwrapped as the logged outputs are: SFT trains on it.
        self.assertEqual(merged["tr-0"]["expected_output"], "fixed")
        offsets = [r.arg("offset") for r in server.requests if r.path == "/api/v1/feedback"]
        self.assertEqual(offsets, ["0", "2"])

    def test_named_outputs_and_structured_corrections(self) -> None:
        from grad_trainer.providers.langsmith import _correction

        provider = build_provider({"provider": "langsmith", "secret": "k"})
        record = provider.to_record({"id": "r1", "inputs": {"question": "q"}, "outputs": {"answer": "a"}})
        self.assertEqual(record["messages"][-1], {"role": "assistant", "content": "a"})
        two = [{"role": "assistant", "content": "x"}, {"role": "assistant", "content": "y"}]
        self.assertEqual(_correction({"outputs": {"messages": two}}), two)
        self.assertEqual(_correction({"outputs": {"answer": "a", "sources": ["s"]}}), '{"answer": "a", "sources": ["s"]}')
        self.assertIsNone(_correction({}))

    def test_thread_comes_from_metadata_not_the_project_session(self) -> None:
        run = {"id": "r1", "session_id": "project-uuid", "inputs": {"q": 1}, "outputs": {"generations": [[{"text": "a"}]]},
               "extra": {"metadata": {"thread_id": "th-1", "ls_model_name": "gpt-x"}}, "feedback_stats": {"correctness": {"avg": 1.0}}}  # fmt: skip
        rec = LangSmithProvider().to_record(run)
        self.assertEqual((rec["session_id"], rec["metadata"]["model"], rec["scores"]), ("th-1", "gpt-x", {"correctness": 1.0}))
        self.assertIsNone(LangSmithProvider().to_score_update({"key": "k", "score": 1}))


    def test_own_filter_expression_is_anded_with_the_rest(self) -> None:
        fx, server = self.serve(LangSmithFixture(), traces=4)
        records, _ = self.sync(self.provider(fx, server, filters={"filter": 'has(tags, "beta")', "name": ["answer"]}))
        self.assertEqual(sorted(r["id"] for r in records), ["tr-1", "tr-3"])
        body = next(r.body for r in server.requests if r.path == "/api/v2/runs/query")
        self.assertEqual(body["filter"], 'and(in(name, ["answer"]), has(tags, "beta"))')


class BraintrustQuirks(Served):
    def test_filters_are_quoted_sql(self) -> None:
        fx, server = self.serve(BraintrustFixture())
        self.sync(self.provider(fx, server, filters={"tags": ["it's"], "metadata": {"tier": "a'b", "bad key": "x"}}))
        sql = next(r.body["query"] for r in server.requests if r.path == "/btql")
        self.assertIn("tags IN ('it''s')", sql)
        self.assertIn("metadata.tier = 'a''b'", sql)
        self.assertNotIn("bad key", sql, "a key that isn't an identifier is applied after fetching only")

    def test_project_is_required_and_resolved_by_name(self) -> None:
        fx, server = self.serve(BraintrustFixture())
        with self.assertRaisesRegex(SourceUnavailableError, "needs a project"):
            self.sync(self.provider(fx, server, project=None))
        with self.assertRaisesRegex(SourceUnavailableError, "no project named 'nope'"):
            self.sync(self.provider(fx, server, project="nope"))
        server.requests.clear()
        self.sync(self.provider(fx, server, project="1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d"))
        self.assertNotIn("/v1/project", server.paths())

    def test_watermark_must_be_an_xact_id(self) -> None:
        fx, server = self.serve(BraintrustFixture())
        with self.assertRaises(SourceAPIChangedError):
            self.sync(self.provider(fx, server), {"traces": "1' OR 1=1 --"})

    def test_expected_from_feedback_becomes_expected_output(self) -> None:
        rec = BraintrustProvider().to_record({"id": "b1", "input": "q", "output": "a", "expected": "right", "metadata": {"session_id": "s"}})
        self.assertEqual((rec["expected_output"], rec["session_id"]), ("right", "s"))


class PostHogQuirks(Served):
    def test_project_must_be_numeric(self) -> None:
        fx, server = self.serve(PostHogFixture())
        for project, message in ((None, "needs a project"), ("@current", "numeric project id")):
            with self.assertRaisesRegex(SourceUnavailableError, message):
                self.sync(self.provider(fx, server, project=project))

    def test_survey_responses(self) -> None:
        p = PostHogProvider()
        base = {"created_at": "2026-11-27T10:00:00Z", "properties": {"$ai_trace_id": "t", "$survey_id": "srv"}}
        score = lambda **props: p.to_score_update({**base, "properties": {**base["properties"], **props}}).scores  # noqa: E731
        # posthog-js lists the questions: the first is the LLM feedback survey's thumbs question.
        questions = [{"id": "q-thumbs", "question": "Was this helpful?"}, {"id": "q-why", "question": "What went wrong?"}]
        self.assertEqual(score(**{"$survey_questions": questions, "$survey_response": 2, "$survey_response_q-thumbs": 2, "$survey_response_q-why": "hedgehogs"}), {"thumbs": 0.0})
        self.assertEqual(score(**{"$survey_questions": json.dumps(questions), "$survey_response_q-thumbs": "1"}), {"thumbs": 1.0})
        # A manual capture (docs: user-feedback/manual-event-capture): the only numeric answer.
        self.assertEqual(score(**{"$survey_response_0193": 1, "$survey_response_0194": "great"}), {"thumbs": 1.0})
        self.assertEqual(score(**{"$survey_response": 2}), {"thumbs": 0.0})
        # A 2 on a rating scale is not a thumbs down: other answers keep their value by question id.
        rating = [{"id": "q-thumbs"}, {"id": "q-stars"}]
        self.assertEqual(score(**{"$survey_questions": rating, "$survey_response_q-thumbs": 1, "$survey_response_q-stars": 2}), {"thumbs": 1.0, "q-stars": 2.0})
        self.assertEqual(score(**{"$survey_response_a": 2, "$survey_response_b": 4}), {"a": 2.0, "b": 4.0})
        self.assertEqual(score(**{"$survey_questions": rating, "$survey_response_q-thumbs": 4}), {"q-thumbs": 4.0})
        self.assertEqual(score(**{"$survey_response": 0.5}), {"srv": 0.5})
        self.assertIsNone(p.to_score_update({"properties": {"$survey_response_x": 1}}))
        self.assertIsNone(p.to_score_update({**base, "properties": {"$ai_trace_id": "t", "$survey_response_x": "meh"}}))

    def test_a_trace_is_its_latest_generation(self) -> None:
        fx, server = self.serve(PostHogFixture(), traces=1)
        fx.traces.append({**fx.traces[0], "uuid": "evt-later", "timestamp": iso(NOW - timedelta(minutes=30)),
                          "properties": {**fx.traces[0]["properties"], "$ai_output_choices": [{"role": "assistant", "content": "final"}]}})  # fmt: skip
        records, _ = self.sync(self.provider(fx, server))
        merged = merge_records(records)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["messages"][-1]["content"], "final")

    def test_filters_are_quoted_hogql(self) -> None:
        fx, server = self.serve(PostHogFixture())
        self.sync(self.provider(fx, server, filters={"model": ["m-'1"], "to": "2026-11-27T11:30:00Z"}))
        sql = next(r.body["query"]["query"] for r in server.requests if "$ai_generation" in r.body["query"]["query"])
        self.assertIn("properties.$ai_model IN ('m-\\'1')", sql)
        self.assertIn("timestamp < '2026-11-27 11:30:00.000000'", sql)

    def test_unexpected_response_shape_is_typed(self) -> None:
        fx, server = self.serve(PostHogFixture())
        fx.respond = lambda req: (200, {"error": "nope"}, {})
        with self.assertRaisesRegex(SourceAPIChangedError, "results"):
            self.sync(self.provider(fx, server))


class PhoenixQuirks(Served):
    def test_label_only_annotations_and_fallback_io(self) -> None:
        p = PhoenixProvider()
        self.assertIsNone(p.to_score_update({"span_id": "s", "name": "n", "result": {"label": "good", "score": None}}))
        span = {"context": {"span_id": "s1"}, "attributes": {"input": {"value": "q?"}, "output": {"value": '{"content": "a"}'}, "metadata": "not json"}}
        rec = p.to_record(span)
        self.assertEqual([m["content"] for m in rec["messages"]], ["q?", "a"])
        self.assertEqual(p.auth_headers(""), {})

    def test_single_value_filters_become_attribute_pairs(self) -> None:
        fx, server = self.serve(PhoenixFixture(), traces=3)
        records, _ = self.sync(self.provider(fx, server, filters={"user_id": "user-7", "session_id": ["sess-1", "sess-2"]}))
        self.assertEqual(sorted(r["id"] for r in records), ["tr-1", "tr-2"])
        spans = next(r for r in server.requests if r.path.endswith("/spans"))
        self.assertEqual(spans.query["attribute"], ['user.id:"user-7"'], "two sessions can't be one AND-ed pair")

    def test_needs_a_host(self) -> None:
        with self.assertRaisesRegex(SourceUnavailableError, "needs a host"):
            PhoenixProvider().fetch_traces(None, None)

    def test_annotations_are_paged_per_span_page(self) -> None:
        fx, server = self.serve(PhoenixFixture())
        for n in range(3):
            fx.add_score("tr-1", f"a{n}", 0.5, NOW - timedelta(minutes=30))
        with mock.patch("grad_trainer.providers.phoenix.ANNOTATIONS_LIMIT", 2):
            records, _ = self.sync(self.provider(fx, server))
        merged = {r["id"]: r for r in merge_records(records)}
        self.assertEqual(merged["tr-1"]["scores"], {"a0": 0.5, "a1": 0.5, "a2": 0.5})


class GradiatedQuirks(unittest.TestCase):
    def test_self_hosted_has_no_gradiated_source(self) -> None:
        with self.assertRaisesRegex(SourceUnavailableError, "only available on Gradiated Cloud"):
            SyncEngine(GradiatedProvider(), emit_batch=lambda b: None).run(None)

    def test_gateway_export_rows_import_and_score_rows_are_skipped(self) -> None:
        row = {"id": "prx1", "trace_id": "tr_1", "model": "qwen/qwen3-8b", "request": {"messages": [{"role": "user", "content": "ping"}], "tools": [{"type": "function"}]},
               "response": {"choices": [{"message": {"role": "assistant", "content": "pong"}}]}, "scores": {"thumbs": 1}}  # fmt: skip
        self.assertEqual(detect_source(row), "gradiated")
        rec = normalize_traces([row])[0]
        self.assertEqual((rec["id"], rec["metadata"]["model"], rec["tools"], rec["scores"]), ("tr_1", "qwen/qwen3-8b", [{"type": "function"}], {"thumbs": 1.0}))
        self.assertEqual(parse_row({"type": "score", "trace_id": "t"}, "gradiated"), (None, "gradiated:no_messages"))
        self.assertIsNone(GradiatedProvider().to_score_update({"name": "x", "value": 1}))


class RegistryAndTlsTests(unittest.TestCase):
    def test_unknown_provider(self) -> None:
        with self.assertRaisesRegex(SourceUnavailableError, "Unknown source provider 'helicone'"):
            build_provider({"provider": "helicone"})
        self.assertEqual(list(PROVIDERS)[-1], "phoenix")

    def test_https_connects_to_the_vetted_ip_with_sni(self) -> None:
        conn = _PinnedHTTPSConnection("api.example.com", 443, "93.184.216.34", 5)
        with mock.patch("socket.create_connection") as connect, mock.patch.object(conn._context, "wrap_socket") as wrap:
            conn.connect()
        connect.assert_called_once_with(("93.184.216.34", 443), 5)
        self.assertEqual(wrap.call_args.kwargs["server_hostname"], "api.example.com")


if __name__ == "__main__":
    unittest.main()
