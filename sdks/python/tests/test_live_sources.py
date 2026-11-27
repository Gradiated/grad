"""Live source syncs against the shared harness: a real grad-server, a real trainer worker and the
fake Langfuse (tests/fixtures/fake-langfuse.ts) or the fake Cloud API (the ``gradiated`` source).

Covers: add a source, sync, re-sync with no duplicates, incremental syncs and late scores, a
failed sync resuming from the stored watermark, ``--full`` rebuilds, provider metadata in
records, and the secret never reaching logs, API responses or the dataset.
"""

from __future__ import annotations

import json
import os
import unittest
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, ClassVar
from unittest import mock

from _stack import Stack, live_skip_reason

import grad
from grad import Grad, sources


def _post(url: str, body: Any) -> Any:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read() or b"null")


def _ago(minutes: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _trace(i: int, minutes_ago: float, *, version: str = "v41") -> dict[str, Any]:
    return {
        "id": f"trace-{i}",
        "timestamp": _ago(minutes_ago),
        "name": "answer",
        "input": [{"role": "user", "content": f"Where is invoice #{i}?"}],
        "output": {"role": "assistant", "content": f"Invoice #{i} is under Billing."},
        "sessionId": f"sess-{i}",
        "userId": "user-7",
        "version": version,
        "release": "support-bot@2026-11-27",
        "tags": ["prod"],
        "metadata": {"model": "your-org/support-sft"},
    }


def _score(i: int, trace: int, value: float, minutes_ago: float) -> dict[str, Any]:
    return {"id": f"score-{i}", "traceId": f"trace-{trace}", "name": "resolved", "value": value, "timestamp": _ago(minutes_ago)}


class _SourcesLive(unittest.TestCase):
    cloud: ClassVar[bool] = False
    stack: ClassVar[Stack]
    env: ClassVar[Any]

    @classmethod
    def setUpClass(cls) -> None:
        reason = live_skip_reason("reference")
        if reason:
            raise unittest.SkipTest(reason)
        cls.stack = Stack(cloud=cls.cloud, worker="reference")
        cls.env = mock.patch.dict(os.environ, {"GRADIATED_API_KEY": cls.stack.api_key, "GRADIATED_BASE_URL": cls.stack.base_url})
        cls.env.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.env.stop()
        cls.stack.close()


class LangfuseSyncLiveTests(_SourcesLive):
    def control(self, route: str, body: Any) -> Any:
        return _post(f"{self.stack.info['langfuse_url']}/_control/{route}", body)

    def records(self, client: Grad, name: str) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for record in client.datasets.records(name):
            self.assertNotIn(record["id"], out, "a trace appears once in a dataset version")
            out[record["id"]] = record
        return out

    def test_sync_lifecycle(self) -> None:
        client = Grad()
        key = str(self.stack.info["langfuse_secret"])
        # A self-hosted provider's secret names the host it may be sent to.
        secret = client.secrets.set(
            "langfuse-prod", key, allowed_hosts=[str(self.stack.info["langfuse_url"])]
        )
        self.assertEqual(secret.name, "langfuse-prod")
        self.assertNotIn(key, json.dumps([s.raw for s in client.secrets.list()]))

        self.control("traces", [_trace(1, 90), _trace(2, 80), _trace(3, 70)])
        self.control("scores", [_score(1, 1, 1.0, 60)])

        dataset = client.datasets.create("support-prod")
        source = dataset.add_source(
            provider=sources.Langfuse(host=self.stack.info["langfuse_url"], secret=client.secrets.get("langfuse-prod")),
        )
        self.assertEqual((source.kind, source.provider.secret), ("langfuse", "langfuse-prod"))

        # First sync: every trace, its score and the provider metadata.
        first = source.sync().wait(timeout=120)
        self.assertEqual(first.status, "completed")
        records = self.records(client, "support-prod")
        self.assertEqual(sorted(records), ["trace-1", "trace-2", "trace-3"])
        self.assertEqual(records["trace-1"]["scores"], {"resolved": 1.0})
        meta = records["trace-2"]["metadata"]
        self.assertEqual((meta["model"], meta["version"], meta["release"], meta["tags"]), ("your-org/support-sft", "v41", "support-bot@2026-11-27", ["prod"]))
        self.assertEqual(records["trace-2"]["session_id"], "sess-2")
        v1 = client.datasets.get("support-prod").version

        # Re-sync of the same window: nothing new, no duplicates.
        again = client.sources.sync(source.id).wait(timeout=120)
        self.assertEqual(again.status, "completed")
        self.assertEqual(sorted(self.records(client, "support-prod")), ["trace-1", "trace-2", "trace-3"])

        # Incremental: a new trace and a late score on a trace synced earlier.
        self.control("traces", [_trace(4, 0, version="v42")])
        self.control("scores", [_score(2, 2, 1.0, 0)])
        source.sync().wait(timeout=120)
        records = self.records(client, "support-prod")
        self.assertEqual(sorted(records), ["trace-1", "trace-2", "trace-3", "trace-4"])
        self.assertEqual(records["trace-2"]["scores"], {"resolved": 1.0}, "a late score lands on its trace")
        self.assertEqual(records["trace-4"]["metadata"]["version"], "v42")
        v2 = client.datasets.get("support-prod").version
        self.assertGreater(v2, v1)
        # Runs pin versions: the old one still reads without the late score.
        old = {r["id"]: r for r in client.datasets.records("support-prod", version=v1)}
        self.assertNotIn("scores", old["trace-2"])
        # ...so what the next run trains on changes (the docs' "choose what to train on" slice).
        good = [r["id"] for r in client.datasets.records("support-prod") if (r.get("scores") or {}).get("resolved", 0) >= 1.0]
        self.assertEqual(sorted(good), ["trace-1", "trace-2"])

        # A failure mid-sync keeps the watermark: the next sync picks up the missed traces.
        self.control("traces", [_trace(5, 0)])
        self.control("fail", {"path": "/api/public/v3/scores", "status": 401, "count": 1})
        failed = source.sync()
        with self.assertRaises(grad.ImportFailedError):
            failed.wait(timeout=120)
        self.assertEqual(source.refresh().last_sync.status, "failed")
        self.assertNotIn("trace-5", self.records(client, "support-prod"))
        source.sync().wait(timeout=120)
        self.assertIn("trace-5", self.records(client, "support-prod"))

        # --full rebuilds from what the provider holds now.
        self.control("reset", {})
        self.control("traces", [_trace(1, 90), _trace(3, 70)])
        rebuilt = source.sync(full=True).wait(timeout=120)
        self.assertEqual(rebuilt.status, "completed")
        self.assertEqual(sorted(self.records(client, "support-prod")), ["trace-1", "trace-3"])
        self.assertEqual(source.refresh().last_sync.full, True)

        # The key never leaves the secret store: not in responses, records or logs.
        public, private = key.split(":")
        seen = json.dumps([source.raw, [s.raw for s in client.sources.list()], [j.raw for j in client.imports.list()], list(client.datasets.records("support-prod"))])
        log = self.stack.log_path.read_text(errors="replace")
        for text in (seen, log):
            self.assertNotIn(private, text)
            self.assertNotIn(public, text)
        requests = urllib.request.urlopen(f"{self.stack.info['langfuse_url']}/_control/requests", timeout=10)
        self.assertTrue(all(r["authorized"] for r in json.loads(requests.read()) if r["path"] != "/api/public/v3/scores"))

        # The secret can't be deleted while the source uses it.
        with self.assertRaises(grad.ConflictError):
            client.secrets.delete("langfuse-prod")
        source.remove()
        client.secrets.delete("langfuse-prod")

    def test_filters_sampling_caps_and_update(self) -> None:
        client = Grad()
        url = str(self.stack.info["langfuse_url"])
        client.secrets.set("langfuse-filtered", str(self.stack.info["langfuse_secret"]), allowed_hosts=[url])
        self.addCleanup(self.control, "reset", {})
        self.control("traces", [_trace(11, 90), _trace(12, 80, version="v42"), _trace(13, 70, version="v42"), _trace(14, 60, version="v42")])
        with self.assertRaises(grad.ValidationError) as bad:
            client.sources.create("filtered", sources.Langfuse(host=url, secret="langfuse-filtered", filters={"tag": "prod"}))
        self.assertEqual(bad.exception.code, "source_filter_unsupported")

        source = client.datasets.create("filtered").add_source(
            provider=sources.Langfuse(host=url, secret="langfuse-filtered", filters={"version": "v42", "tags": ["prod"]}),
            max_records_per_sync=2,
        )
        self.assertEqual(source.filters, {"version": ["v42"], "tags": ["prod"]})
        job = source.sync().wait(timeout=120)
        records = self.records(client, "filtered")
        self.assertEqual(len(records), 2)
        self.assertTrue(set(records) <= {"trace-12", "trace-13", "trace-14"})
        self.assertIn("over the record cap: 1 traces", job.drop_reasons)
        self.assertEqual(source.refresh().records_today, 2)

        source.update(filters={"version": "v41"}, max_records_per_sync=None, sample_rate=1)
        self.assertEqual((source.filters, source.max_records_per_sync), ({"version": ["v41"]}, None))
        self.assertEqual(source.sync(full=True).wait(timeout=120).status, "completed")
        self.assertEqual(sorted(self.records(client, "filtered")), ["trace-11"])
        source.remove()
        client.secrets.delete("langfuse-filtered")

    def test_typed_errors(self) -> None:
        client = Grad()
        with self.assertRaises(grad.ValidationError) as unsupported:
            client.sources.create("errors", {"kind": "helicone", "secret": "x"})
        self.assertEqual(unsupported.exception.code, "source_provider_unsupported")
        with self.assertRaises(grad.FeatureUnavailableError) as cloud_only:
            client.sources.create("errors", sources.Gradiated())
        self.assertEqual(cloud_only.exception.code, "source_unavailable")
        with self.assertRaises(grad.ValidationError) as missing:
            client.sources.create("errors", sources.Langfuse(secret="no-such-secret"))
        self.assertEqual(missing.exception.code, "secret_not_found")
        client.secrets.set("bt", "key")
        with self.assertRaises(grad.ValidationError) as project:
            client.sources.create("errors", sources.Braintrust(secret="bt"))
        self.assertEqual(project.exception.code, "source_project_required")
        with self.assertRaises(grad.ValidationError) as cron:
            client.sources.create("errors", sources.Braintrust(secret="bt", project="p"), schedule="every hour")
        self.assertEqual(cron.exception.code, "invalid_schedule")
        scheduled = client.sources.create("errors", sources.Braintrust(secret="bt", project="p"), schedule="*/15 * * * *")
        self.assertIsNotNone(scheduled.next_sync_at)


class GradiatedSyncLiveTests(_SourcesLive):
    cloud = True

    def test_gradiated_source_reads_gateway_traces_and_feedback(self) -> None:
        ws = self.stack.info["workspace_id"]
        trace = {"type": "trace", "trace_id": "gw-1", "messages": [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}], "metadata": {"model": "acme/support", "version": "v1"}}
        other = {**trace, "trace_id": "gw-2", "metadata": {"model": "acme/other"}}
        score = {"type": "score", "trace_id": "gw-1", "name": "thumbs", "value": 1.0, "updated_at": _ago(1), "score_id": "s1"}
        _post(f"{self.stack.info['cloud_url']}/_control/gateway-records", {"workspace_id": ws, "records": [trace, other, score]})

        client = Grad()
        source = client.datasets.create("gateway").add_source(provider=sources.Gradiated(models=("acme/support",)))
        self.assertEqual(source.sync().wait(timeout=120).status, "completed")
        records = {r["id"]: r for r in client.datasets.records("gateway")}
        self.assertEqual(sorted(records), ["gw-1"])
        self.assertEqual(records["gw-1"]["scores"], {"thumbs": 1.0})
        self.assertEqual(records["gw-1"]["metadata"]["version"], "v1")

        # Late feedback: the Cloud cursor is the watermark, so only the new row is read.
        late = {**score, "value": 0.0, "updated_at": _ago(0), "score_id": "s2"}
        _post(f"{self.stack.info['cloud_url']}/_control/gateway-records", {"workspace_id": ws, "records": [late]})
        source.sync().wait(timeout=120)
        self.assertEqual({r["id"]: r for r in client.datasets.records("gateway")}["gw-1"]["scores"], {"thumbs": 0.0})


if __name__ == "__main__":
    unittest.main()
