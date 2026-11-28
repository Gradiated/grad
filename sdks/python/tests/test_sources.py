"""Secrets and observability sources: request shapes, typed results, and errors."""

from __future__ import annotations

import datetime
import unittest

from _fakes import fixture, json_reply, make_client

import grad
from grad import sources

PARITY = fixture("sdk-parity.json")
SOURCE = PARITY["responses"]["source"]
SECRET = PARITY["responses"]["secret"]
DATASET = {"id": "ds_1", "workspace_id": "ws", "name": "support-prod", "version": 2, "record_count": 10, "metadata": {}}
JOB = {"id": "imp_7c1d", "dataset": "support-prod", "status": "queued", "source": {"kind": "provider", "source_id": "src_01J9X", "full": False}}
PROBLEM = {"type": "https://gradiated.com/problems/x", "title": "t", "status": 0, "detail": "d", "code": "x", "request_id": "req_1"}


def problem(status: int, code: str, detail: str = "nope") -> dict[str, object]:
    return {**PROBLEM, "status": status, "code": code, "detail": detail}


class SecretsTests(unittest.TestCase):
    def test_set_get_list_delete(self) -> None:
        client, sender, _ = make_client(
            {
                "POST /v1/secrets": json_reply(SECRET),
                "GET /v1/secrets/langfuse-prod": json_reply(SECRET),
                "GET /v1/secrets": json_reply({"data": [SECRET], "next_cursor": None}),
                "DELETE /v1/secrets/langfuse-prod": json_reply(None, 204),
            }
        )
        ref = client.secrets.set("langfuse-prod", "pk:sk")
        self.assertIsInstance(ref, grad.SecretRef)
        self.assertEqual((ref.name, str(ref)), ("langfuse-prod", "langfuse-prod"))
        self.assertNotIn("value", ref.raw)
        self.assertEqual(client.secrets.get("langfuse-prod").name, "langfuse-prod")
        self.assertEqual([s.name for s in client.secrets.list()], ["langfuse-prod"])
        client.secrets.delete(ref)
        self.assertEqual(sender.sent[-1].method, "DELETE")
        with self.assertRaises(ValueError):
            client.secrets.set("Bad Name", "v")
        with self.assertRaises(ValueError):
            client.secrets.set("ok", "")
        with self.assertRaises(TypeError):
            client.secrets.set("ok", "v", allowed_hosts="langfuse.internal")  # type: ignore[arg-type]

    def test_typed_errors(self) -> None:
        client, _, _ = make_client(
            {
                "POST /v1/secrets": json_reply(problem(501, "secrets_unavailable", "set GRAD_SECRETS_KEY"), 501),
                "DELETE /v1/secrets/used": json_reply(problem(409, "secret_in_use"), 409),
                "GET /v1/secrets/missing": json_reply(problem(404, "secret_not_found"), 404),
            }
        )
        with self.assertRaises(grad.FeatureUnavailableError) as raised:
            client.secrets.set("x", "y")
        self.assertEqual(raised.exception.code, "secrets_unavailable")
        with self.assertRaises(grad.ConflictError):
            client.secrets.delete("used")
        with self.assertRaises(grad.NotFoundError):
            client.secrets.get("missing")


class SourcesTests(unittest.TestCase):
    def test_providers_serialise_secret_refs_and_filters(self) -> None:
        ref = grad.SecretRef.from_api(SECRET)
        self.assertEqual(
            sources.Braintrust(host="https://api.braintrust.dev", secret=ref, project="support-bot").to_api(),
            {"kind": "braintrust", "host": "https://api.braintrust.dev", "secret": "langfuse-prod", "project": "support-bot"},
        )
        self.assertEqual(sources.LangSmith(secret="ls").to_api(), {"kind": "langsmith", "secret": "ls"})
        self.assertEqual(sources.PostHog(secret="ph", filters={"event": "$ai_generation"}).to_api()["filters"], {"event": "$ai_generation"})
        self.assertEqual(sources.Phoenix(host="http://phoenix:6006").to_api(), {"kind": "phoenix", "host": "http://phoenix:6006"})
        self.assertEqual(
            sources.Gradiated(models=("a/m",), tasks=("support",), versions=("v1",), filters={"trainable_only": True}).to_api(),
            {"kind": "gradiated", "filters": {"trainable_only": True, "models": ["a/m"], "tasks": ["support"], "versions": ["v1"]}},
        )
        self.assertEqual(sources.Gradiated().to_api(), {"kind": "gradiated"})
        with self.assertRaises(TypeError):
            sources.Langfuse(secret=42).to_api()

    def test_add_source_sync_and_remove_through_the_dataset(self) -> None:
        client, sender, _ = make_client(
            {
                "GET /v1/datasets/support-prod": json_reply(DATASET),
                "GET /v1/secrets/langfuse-prod": json_reply(SECRET),
                "POST /v1/datasets/support-prod/sources": json_reply(SOURCE, 201),
                "POST /v1/sources/src_01J9X/sync": json_reply(JOB, 202),
                "GET /v1/sources/src_01J9X": json_reply(SOURCE),
                "GET /v1/sources": json_reply({"data": [SOURCE], "next_cursor": None}),
                "DELETE /v1/sources/src_01J9X": json_reply(None, 204),
            }
        )
        dataset = client.datasets.get("support-prod")
        source = dataset.add_source(
            provider=sources.Langfuse(host="https://cloud.langfuse.com", secret=client.secrets.get("langfuse-prod")),
            schedule="*/15 * * * *",
        )
        self.assertIsInstance(source, grad.Source)
        self.assertEqual((source.kind, source.provider.host, source.dataset), ("langfuse", "https://cloud.langfuse.com", "support-prod"))
        self.assertEqual(
            sender.sent[-1].json,
            {"provider": {"kind": "langfuse", "host": "https://cloud.langfuse.com", "secret": "langfuse-prod"}, "schedule": "*/15 * * * *"},
        )

        job = source.sync()
        self.assertIsInstance(job, grad.ImportJob)
        self.assertEqual(sender.sent[-1].json, {"full": False})
        self.assertEqual(client.sources.sync("src_01J9X", full=True).id, "imp_7c1d")
        self.assertEqual(sender.sent[-1].json, {"full": True})

        self.assertIs(source.refresh(), source)
        self.assertEqual([s.id for s in dataset.sources()], ["src_01J9X"])
        self.assertEqual(sender.sent[-1].query.get("dataset"), ["support-prod"])
        self.assertEqual(len(client.sources.list().to_list()), 1)
        source.delete()
        self.assertEqual((sender.sent[-1].method, sender.sent[-1].path), ("DELETE", "/v1/sources/src_01J9X"))
        client.sources.delete("src_01J9X")
        with self.assertWarns(DeprecationWarning):
            client.sources.remove("src_01J9X")
        with self.assertWarns(DeprecationWarning):
            source.remove()

    def test_filters_sampling_caps_and_update(self) -> None:
        client, sender, _ = make_client(
            {
                "POST /v1/datasets/support-prod/sources": json_reply(SOURCE, 201),
                "PATCH /v1/sources/src_01J9X": json_reply({**SOURCE, "sample_rate": 0.5}),
                "PATCH /v1/sources/bad": json_reply(problem(422, "source_filter_unsupported", "no filter 'tag'"), 422),
            }
        )
        source = client.sources.create("support-prod", sources.Langfuse(secret="lf", filters={"tags": ["prod"]}), sample_rate=0.1, max_records_per_sync=500)
        self.assertEqual(sender.sent[-1].json, {"provider": {"kind": "langfuse", "secret": "lf", "filters": {"tags": ["prod"]}}, "sample_rate": 0.1, "max_records_per_sync": 500})
        self.assertEqual((source.filters, source.sample_rate, source.max_records_per_day, source.records_today), ({"environment": ["production"]}, 0.1, 100000, 4200))
        self.assertIn("filters={'environment': ['production']}", repr(source))
        self.assertIs(source.update(max_records_per_day=None, schedule="*/5 * * * *"), source)
        self.assertEqual(sender.sent[-1].json, {"schedule": "*/5 * * * *", "max_records_per_day": None})
        self.assertEqual(source.sample_rate, 0.5)
        client.sources.update("src_01J9X", filters={})
        self.assertEqual(sender.sent[-1].json, {"filters": {}})
        self.assertIsNone(sender.sent[-1].header("Idempotency-Key"))
        with self.assertRaises(grad.ValidationError) as raised:
            client.sources.update("bad", filters={"tag": ["prod"]})
        self.assertEqual(raised.exception.code, "source_filter_unsupported")
        self.assertEqual(repr(sources.UNSET), "UNSET")

    def test_mapping_provider_and_typed_errors(self) -> None:
        client, sender, _ = make_client(
            {
                "POST /v1/datasets/d/sources": json_reply(problem(422, "source_provider_unsupported", "grad can't sync from 'helicone'"), 422),
                "POST /v1/datasets/c/sources": json_reply(problem(501, "source_unavailable", "Cloud only"), 501),
            }
        )
        with self.assertRaises(grad.ValidationError) as raised:
            client.sources.create("d", {"kind": "helicone", "secret": grad.SecretRef.from_api(SECRET)})
        self.assertEqual(raised.exception.code, "source_provider_unsupported")
        self.assertEqual(sender.sent[-1].json, {"provider": {"kind": "helicone", "secret": "langfuse-prod"}})
        with self.assertRaises(grad.FeatureUnavailableError):
            client.sources.create("c", sources.Gradiated())
        with self.assertRaises(TypeError):
            client.sources.create("d", "langfuse")

    def test_from_hf_sends_the_secret_name_only(self) -> None:
        job = {**JOB, "source": {"kind": "hf"}, "status": "queued"}
        client, sender, _ = make_client(
            {
                "POST /v1/datasets/gated/imports": json_reply(job, 202),
                "GET /v1/datasets/gated": json_reply({**DATASET, "name": "gated"}),
            }
        )
        client.datasets.from_hf("org/gated", prompt="q", name="gated", secret=grad.SecretRef.from_api({"name": "hf-token"}), wait=False)
        self.assertEqual(sender.sent[0].json["source"]["secret"], "hf-token")
        client.datasets.from_hf("org/gated", prompt="q", name="gated", secret="hf-token", wait=False)
        self.assertEqual(sender.sent[-2].json["source"]["secret"], "hf-token")


class UsageTests(unittest.TestCase):
    def test_lists_usage_pages(self) -> None:
        page = PARITY["responses"]["usage_page"]
        client, sender, _ = make_client(
            {"GET /v1/usage": [json_reply({**page, "next_cursor": "c1"}), json_reply({"data": [], "next_cursor": None})]}
        )
        records = client.usage.list(limit=5).to_list()
        self.assertEqual([(r.kind, r.tokens, r.cost_usd) for r in records], [("training", 84, 0.000084)])
        self.assertIsInstance(records[0], grad.UsageRecord)
        self.assertEqual(sender.sent[-1].query, {"limit": ["5"], "cursor": ["c1"]})

    def test_filters_follow_every_page_and_take_native_times(self) -> None:
        page = PARITY["responses"]["usage_page"]
        client, sender, _ = make_client(
            {"GET /v1/usage": [json_reply({**page, "next_cursor": "c1"}), json_reply({"data": [], "next_cursor": None})]}
        )
        ev = grad.Eval.from_api({"id": "eval_1"})
        noon = datetime.datetime(2026, 11, 2, 12, 30)  # naive: UTC
        client.usage.list(from_=noon, eval_id=ev, kind="eval").to_list()
        want = {"from": ["2026-11-02T12:30:00+00:00"], "eval_id": ["eval_1"], "kind": ["eval"]}
        self.assertEqual(sender.sent[0].query, want)
        self.assertEqual(sender.sent[1].query, {**want, "cursor": ["c1"]})

    def test_summary_is_typed_and_prints_a_report(self) -> None:
        body = PARITY["responses"]["usage_summary"]
        client, sender, _ = make_client({"GET /v1/usage/summary": [json_reply(body), json_reply({**body, "records": 0, "by_kind": [], "top_runs": [], "top_evals": [], "group_by": None, "groups": []})]})
        summary = client.usage.summary(group_by="model")
        self.assertEqual(sender.sent[0].query, {"group_by": ["model"]})
        self.assertIsInstance(summary, grad.UsageSummary)
        self.assertEqual((summary.from_, summary["from"]), ("2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"))
        self.assertIsInstance(summary.top_runs[0], grad.UsageTotal)
        text = str(summary)
        self.assertIn("Usage from 2026-11-01 00:00 to 2026-12-01 00:00 UTC: $0.0046", text)
        self.assertIn("support-sft  run_015437ae0c01e09a573e4811  training", text)
        self.assertIn("By model", text)
        self.assertIn("qwen/qwen3-32b", text)
        self.assertIn("(nothing billed in this period)", str(client.usage.summary(from_=datetime.date(2026, 1, 1))))
        self.assertEqual(sender.sent[1].query, {"from": ["2026-01-01"]})
        self.assertIn("UsageSummary(from_=", repr(summary))


if __name__ == "__main__":
    unittest.main()
