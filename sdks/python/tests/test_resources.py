"""Every public resource method of ``Grad`` against the fake transport and the shared wire fixtures."""

from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any

from _fakes import Reply, fixture, fixture_reply, json_reply, make_client, problem, refused

import grad
from grad import Judge, Rubric, Scorer, validators
from grad.recipes import SFTRecipe

RUN_Q = fixture("python-run-queued.json")
RUN_C = fixture("python-run-completed.json")
RUN_ID = RUN_Q["id"]
DATASET = fixture("python-dataset.json")


def with_status(run: dict[str, Any], status: str, **extra: Any) -> dict[str, Any]:
    out = copy.deepcopy(run)
    out.update(status=status, **extra)
    return out


class ModelsAndKeysTests(unittest.TestCase):
    def test_models(self) -> None:
        client, _, _ = make_client({"GET /v1/models": json_reply(fixture("python-models.json"))})
        models = client.models.list()
        self.assertTrue(any(m.id == "test/tiny-qwen3" for m in models))
        tiny = client.models.get("test/tiny-qwen3")
        self.assertEqual(str(tiny), "test/tiny-qwen3")
        self.assertIn("sft", tiny.calibrated_lrs)
        with self.assertRaises(grad.NotFoundError) as ctx:
            client.models.get("nope/model")
        self.assertEqual(ctx.exception.code, "model_not_found")

    def test_keys(self) -> None:
        created = fixture("python-keys-created.json")
        client, sender, _ = make_client(
            {
                "POST /v1/keys": json_reply(created, 201),
                "GET /v1/keys": json_reply({"data": [created["key"]], "next_cursor": None}),
                f"DELETE /v1/keys/{created['key']['id']}": json_reply({**created["key"], "revoked_at": "2026-11-27T00:00:00Z"}),
            }
        )
        key = client.keys.create(name="ci", scopes=["runs:read"])
        self.assertEqual(key.key.scopes, ["runs:read"])  # type: ignore[union-attr]
        self.assertTrue(key.secret)
        self.assertNotIn(key.secret, repr(key))
        self.assertEqual(sender.sent[0].json, {"name": "ci", "scopes": ["runs:read"]})
        self.assertEqual([k.name for k in client.keys.list()], ["ci"])
        self.assertIsNotNone(client.keys.revoke(created["key"]["id"]).revoked_at)
        with self.assertRaises(ValueError):
            client.keys.create(name="Bad Name", scopes=["admin"])


class DatasetTests(unittest.TestCase):
    def test_push_returns_a_dataset_usable_as_dataset_arg(self) -> None:
        client, sender, _ = make_client({"POST /v1/datasets/support/records": json_reply(DATASET), "POST /v1/runs/plan": json_reply(fixture("python-plan.json"))})
        ds = client.datasets.push("support", [{"messages": [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]}, grad.Trajectory.from_messages([{"role": "user", "content": "x"}])], metadata={"src": "test"})
        self.assertIsInstance(ds, grad.Dataset)
        self.assertEqual((ds.name, ds.version, ds.record_count), ("support", 1, 2))
        self.assertEqual(str(ds), "support")
        self.assertEqual(ds["record_count"], 2)
        self.assertEqual(ds.get("missing", 7), 7)
        self.assertEqual(ds.to_dict(), DATASET)
        body = sender.sent[0].json
        self.assertEqual(body["metadata"], {"src": "test"})
        self.assertEqual(len(body["records"]), 2)
        plan = client.runs.plan(dataset=ds, name="support-sft", recipe=SFTRecipe(model="test/tiny-qwen3"))
        self.assertEqual(sender.sent[1].json["dataset"], "support")
        self.assertIsInstance(plan, grad.Plan)

    def test_push_chunks_and_renumbers_validation_errors(self) -> None:
        client, sender, _ = make_client(
            {
                "POST /v1/datasets/big/records": [
                    json_reply({**DATASET, "name": "big", "version": 1}),
                    problem(422, "validation_error", "records.1.messages.0.role: Invalid option"),
                ]
            }
        )
        records = ({"messages": [{"role": "user", "content": str(i)}]} for i in range(5))
        with self.assertRaises(grad.ValidationError) as ctx:
            client.datasets.push("big", records, chunk_size=3)
        self.assertIn("records.4.messages.0.role", ctx.exception.detail)
        self.assertIn("records 3–4", ctx.exception.detail)
        self.assertEqual(ctx.exception.errors[0].path, "records.4.messages.0.role")
        self.assertEqual([len(s.json["records"]) for s in sender.sent], [3, 2])
        self.assertNotIn("metadata", sender.sent[1].json)

    def test_push_byte_budget_splits_chunks(self) -> None:
        from grad._helpers import chunk_records

        chunks = list(chunk_records(({"prompt": "x" * 100} for _ in range(10)), max_records=100, max_bytes=300))
        self.assertTrue(all(len(c) <= 3 for _, c in chunks))
        self.assertEqual(sum(len(c) for _, c in chunks), 10)
        with self.assertRaises(ValueError):
            list(chunk_records([], max_records=0))

    def test_push_input_errors(self) -> None:
        client, _, _ = make_client({})
        with self.assertRaises(ValueError):
            client.datasets.push("empty", [])
        with self.assertRaises(TypeError):
            client.datasets.push("x", "not-a-file")
        with self.assertRaises(TypeError):
            client.datasets.push("x", {"messages": []})  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            client.datasets.push("Bad Name", [{"prompt": "x"}])
        with self.assertRaises(TypeError):
            client.datasets.push("x", [object()])

    def test_push_file_goes_through_upload_and_import(self) -> None:
        ticket = fixture("python-upload-ticket.json")
        job = fixture("python-import-queued.json")
        done = {**job, "status": "completed", "imported_count": 1, "dataset_version": 1, "error": None, "dataset": "from-file"}
        client, sender, clock = make_client(
            {
                "POST /v1/uploads": json_reply(ticket, 201),
                f"PUT {ticket['url'].split('?')[0]}": json_reply({"upload_id": ticket["upload_id"]}),
                "POST /v1/datasets/from-file/imports": json_reply({**job, "dataset": "from-file"}, 202),
                f"GET /v1/imports/{job['id']}": [json_reply({**job, "status": "running"}), refused(), json_reply(done)],
                "GET /v1/datasets/from-file": json_reply({**DATASET, "name": "from-file", "record_count": 1}),
            },
            max_retries=0,
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "train.jsonl"
            path.write_text('{"messages":[{"role":"user","content":"q"},{"role":"assistant","content":"a"}]}\n')
            ds = client.datasets.push("from-file", str(path))
        self.assertEqual(ds.record_count, 1)
        upload = sender.sent[0].json
        self.assertEqual(upload["purpose"], "dataset_import")
        self.assertEqual(upload["filename"], "train.jsonl")
        self.assertEqual(len(upload["sha256"]), 64)
        put = sender.sent[1]
        self.assertIsNone(put.header("Authorization"))
        self.assertEqual(put.header("Content-Type"), "application/octet-stream")
        self.assertEqual(sender.sent[2].json["source"], {"kind": "upload", "upload_id": ticket["upload_id"], "format": "jsonl"})
        self.assertEqual(sender.sent[2].json["connector"], "auto")
        self.assertTrue(clock.sleeps)

    def test_import_file_failure_and_timeout(self) -> None:
        ticket = fixture("python-upload-ticket.json")
        job = fixture("python-import-queued.json")
        failed = fixture("python-imports-page.json")["data"][0]
        routes = {
            "POST /v1/uploads": json_reply(ticket, 201),
            f"PUT {ticket['url'].split('?')[0]}": json_reply({}),
            "POST /v1/datasets/d/imports": json_reply(job, 202),
            f"GET /v1/imports/{job['id']}": json_reply(failed),
        }
        client, sender, _ = make_client(routes)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "t.parquet"
            path.write_bytes(b"PAR1")
            job_obj = client.datasets.get_import = None  # noqa: F841 - attribute absent by design
            imp = grad.Dataset.from_api({**DATASET, "name": "d"}, client).import_file(path, connector="langfuse")
            self.assertEqual(sender.sent[2].json["source"]["format"], "parquet")
            self.assertEqual(sender.sent[2].json["connector"], "langfuse")
            with self.assertRaises(grad.ImportFailedError) as ctx:
                imp.wait()
            self.assertIn("offline mode", str(ctx.exception))
            self.assertEqual(ctx.exception.job.status, "failed")
            client, _, clock = make_client({**routes, f"GET /v1/imports/{job['id']}": json_reply(job)})
            imp = client.datasets.import_file("d", path)
            with self.assertRaises(grad.WaitTimeoutError) as tctx:
                imp.wait(timeout=3)
            self.assertIn("trainer worker", str(tctx.exception))
            with self.assertRaises(ValueError):
                client.datasets.import_file("d", path, connector="nope")
            with self.assertRaises(ValueError):
                client.datasets.import_file("d", path, format="csv")
            empty = Path(tmp) / "empty.jsonl"
            empty.write_text("")
            with self.assertRaises(ValueError):
                client.datasets.import_file("d", empty)
            with self.assertRaises(FileNotFoundError):
                client.datasets.import_file("d", Path(tmp) / "missing.jsonl")

    def test_from_hf(self) -> None:
        job = fixture("python-import-queued.json")
        done = {**job, "status": "completed", "imported_count": 2000}
        client, sender, _ = make_client(
            {
                "POST /v1/datasets/openai-gsm8k-main/imports": json_reply(job, 202),
                f"GET /v1/imports/{job['id']}": json_reply(done),
                "GET /v1/datasets/openai-gsm8k-main": json_reply({**DATASET, "name": "openai-gsm8k-main", "record_count": 2000}),
                "POST /v1/datasets/ultrachat/imports": json_reply(job, 202),
                "GET /v1/datasets/ultrachat": json_reply({**DATASET, "name": "ultrachat"}),
            }
        )
        tasks = client.datasets.from_hf("openai/gsm8k", subset="main", split="train", prompt="question", answer="answer", limit=2000)
        self.assertEqual(tasks.count(), 2000)
        self.assertEqual(
            sender.sent[0].json,
            {"source": {"kind": "hf", "repo": "openai/gsm8k", "split": "train", "config": "main", "columns": {"prompt": "question", "answer": "answer"}, "limit": 2000}, "connector": "auto"},
        )
        client.datasets.from_hf("HuggingFaceH4/ultrachat_200k", split="train_sft", columns={"messages": "messages"}, revision="abc", name="ultrachat", wait=False)
        self.assertEqual(sender.sent[-2].json["source"]["revision"], "abc")
        with self.assertRaises(ValueError):
            client.datasets.from_hf("a/b", config="x", subset="y")
        with self.assertRaises(ValueError):
            client.datasets.from_hf("a/b", columns={"bogus": "c"})
        with self.assertRaises(ValueError):
            client.datasets.from_hf("a/b", columns={"prompt": "x"}, prompt="y")
        from grad._helpers import hf_dataset_name

        self.assertEqual(hf_dataset_name("HuggingFaceH4/ultrachat_200k", "train_sft", None), "huggingfaceh4-ultrachat_200k-train_sft")
        self.assertEqual(len(hf_dataset_name("a" * 100 + "/b", "train", None)), 64)

    def test_get_list_count_records_render_create(self) -> None:
        page = fixture("python-dataset-records-page.json")
        page2 = {**page, "next_cursor": None, "data": [{"prompt": "second"}]}
        client, sender, _ = make_client(
            {
                "GET /v1/datasets/support": json_reply(DATASET),
                "GET /v1/datasets": [json_reply({"data": [DATASET], "next_cursor": "c2"}), json_reply({"data": [{**DATASET, "name": "other"}], "next_cursor": None})],
                "GET /v1/datasets/support/records": [json_reply({**page, "next_cursor": "n1"}), json_reply(page2)],
                "POST /v1/datasets/support/render": json_reply(fixture("python-render.json")),
                "POST /v1/datasets": [json_reply(DATASET, 201), problem(409, "dataset_exists")],
            }
        )
        ds = client.datasets.get("support")
        self.assertEqual(ds.count(), 2)
        self.assertEqual(client.datasets.count(ds), 2)
        pager = client.datasets.list(limit=1)
        self.assertTrue(pager.has_more)
        self.assertEqual([d.name for d in pager], ["support", "other"])
        self.assertIn("Page(", repr(pager))
        self.assertEqual(sender.sent[-1].query["cursor"], ["c2"])
        records = list(ds.records(limit=1))
        self.assertEqual(len(records), 2)
        preview = ds.render(model="test/tiny-qwen3", train_on="last", thinking="off", preserve_thinking=False, limit=1)
        self.assertEqual(sender.sent[-1].json, {"model": "test/tiny-qwen3", "train_on": "last", "thinking": "off", "preserve_thinking": False, "limit": 1})
        text = str(preview)
        self.assertIn("[[", text)
        self.assertIn("tokens trained", text)
        self.assertEqual(client.datasets.create("support", metadata={"a": 1}).name, "support")
        with self.assertRaises(grad.ConflictError):
            client.datasets.create("support")
        ds.push = ds.push  # bound method exists
        with self.assertRaises(TypeError):
            client.datasets.get(123)

    def test_dataset_push_method_updates_in_place(self) -> None:
        client, _, _ = make_client({"POST /v1/datasets/support/records": json_reply({**DATASET, "version": 2, "record_count": 3})})
        ds = grad.Dataset.from_api(DATASET, client)
        self.assertIs(ds.push([{"prompt": "x"}]), ds)
        self.assertEqual((ds.version, ds.record_count), (2, 3))


class RunTests(unittest.TestCase):
    def test_plan_readout(self) -> None:
        client, sender, _ = make_client({"POST /v1/runs/plan": json_reply(fixture("python-plan.json"))})
        plan = client.runs.plan(dataset="support", name="support-sft", recipe=SFTRecipe(model="test/tiny-qwen3"), max_cost_usd=5)
        self.assertEqual(sender.sent[0].json, {"dataset": "support", "name": "support-sft", "recipe": {"kind": "sft", "model": "test/tiny-qwen3"}, "max_cost_usd": 5})
        text = str(plan)
        for needle in ("Dataset     support v1", "BySession(0.1", "LoRA(rank=32, alpha=32)", "qwen3@3 (pinned)", "AdamW(lr=0.001", "Estimate", "cap max_cost_usd=5", "Warnings    2", "! The eval split is empty"):
            self.assertIn(needle, text)
        self.assertIs(plan.resolved_recipe, plan.resolved_config)
        self.assertEqual(plan.resolved_config.adapter.rank, 32)
        self.assertEqual(plan.resolved_config["model"], "test/tiny-qwen3")
        with self.assertRaises(AttributeError) as ctx:
            plan.resolved_config.nope  # noqa: B018
        self.assertIn("fields:", str(ctx.exception))
        self.assertIn("Plan(", repr(plan))

    def test_plan_readout_variants(self) -> None:
        data = fixture("python-plan.json")
        data = copy.deepcopy(data)
        data["resolved_config"]["adapter"] = {"kind": "prefix_kv", "num_tokens": 512}
        data["resolved_config"]["thinking"] = True
        data["resolved_config"]["recipe_params"] = {"context_text": "x" * 50, "teacher": "t"}
        data["estimated_tokens"] = 38_000_000
        data["estimated_cost_usd"] = 15.2
        plan = grad.Plan.from_api(data)
        text = str(plan)
        self.assertIn("PrefixKV(num_tokens=512)", text)
        self.assertIn("thinking=on", text)
        self.assertIn("context_text=<50 chars>", text)
        self.assertIn("~38.0M tokens (~$15.20", text)
        for adapter, expected in (({"kind": "encoder_full"}, "full encoder"), ({"kind": "lora", "rank": 8, "alpha": 32, "merge_on_export": True}, "merge_on_export"), (None, "—"), ({"kind": "frozen_head"}, "frozen_head")):
            data["resolved_config"]["adapter"] = adapter
            self.assertIn(expected, str(grad.Plan.from_api(data)))

    def test_run_arguments(self) -> None:
        client, sender, _ = make_client({"POST /v1/runs": json_reply(RUN_Q, 202)})
        run = client.runs.create(dataset=grad.Dataset.from_api(DATASET), name="support-sft", recipe={"kind": "sft"}, split=grad.splits.ByGroup(0.2))
        self.assertEqual(sender.sent[0].json["split"], {"strategy": "by_group", "eval_fraction": 0.2})
        self.assertIsInstance(run, grad.Run)
        self.assertFalse(run.done)
        self.assertIsNone(run.artifact)
        for bad in ({"max_cost_usd": 0}, {"max_cost_usd": True}, {"max_cost_usd": float("inf")}):
            with self.assertRaises(ValueError):
                client.runs.create("support", name="a", recipe={"kind": "sft"}, **bad)  # type: ignore[arg-type]
        with self.assertRaises(TypeError):
            client.runs.create(name="a", recipe={"kind": "sft"})
        with self.assertRaises(TypeError):
            client.runs.create("support", name="a", recipe=None)
        with self.assertRaises(TypeError):
            client.runs.create([{"prompt": "x"}], name="a", recipe={"kind": "sft"})
        with self.assertRaises(ValueError):
            client.runs.create("support", name="Bad Name", recipe={"kind": "sft"})
        with self.assertRaises(grad.NotAvailableInV0Error):
            client.runs.create("support", name="a", recipe=grad.GRPORecipe())
        self.assertEqual(len(sender.sent), 1)
        self.assertEqual(client.runs.create({"name": "support"}, name="b", recipe={"kind": "sft"}).id, RUN_ID)

    def test_wait_polls_with_backoff_and_tolerates_transient_errors(self) -> None:
        running = with_status(RUN_Q, "running")
        client, sender, clock = make_client({f"GET /v1/runs/{RUN_ID}": [json_reply(RUN_Q), json_reply(running), problem(502, "bad"), refused(), json_reply(running), json_reply(RUN_C)]}, max_retries=0)
        statuses: list[str] = []
        run = client.runs.create  # silence unused
        run = client.runs.wait(RUN_ID, on_status=lambda r: statuses.append(r.status))
        self.assertEqual(run.status, "completed")
        self.assertEqual(statuses, ["queued", "running", "completed"])
        self.assertEqual(clock.sleeps, [0.5, 0.75, 1.125, 1.6875, 2.53125])
        self.assertEqual(len(sender.sent), 6)
        self.assertEqual(run.artifact_id, RUN_C["artifact_id"])
        self.assertEqual(run.eval_report.metric_name, "eval_loss")  # type: ignore[union-attr]
        self.assertEqual(run.latest_metric.step, 1)  # type: ignore[union-attr]
        self.assertTrue(run.succeeded)

    def test_eval_report_and_metric_points_are_typed(self) -> None:
        report = {
            "metric_name": "eval_loss",
            "selected_step": 3,
            "best_step": 3,
            "final_step": 4,
            "train_records": 90,
            "eval_records": 10,
            "warnings": [],
            "eval_loss": 0.41,
            "candidates": ["a", "b"],
            "fallback_model": "b",
            "pareto_summary": {"target_max_drop": 0.02, "quality_drop": 0.008, "quality_drop_ci95": [-0.004, 0.019], "temperature": 1.3},
            "heads": {"intent": {"type": "choice", "accuracy": 0.9}},
            "future_field": 1,
        }
        metric = {"seq": 1, "attempt": 1, "step": 4, "loss": 0.5, "tokens": 1, "cost_usd": 0.0, "timestamp": "now", "eval_metrics": {"eval_loss": 0.41}}
        body = {**RUN_C, "eval_report": report, "latest_metric": metric}
        client, _, _ = make_client({f"GET /v1/runs/{RUN_ID}": json_reply(body)})
        run = client.runs.get(RUN_ID)
        ev = run.eval_report
        assert isinstance(ev, grad.EvalReport)
        self.assertEqual((ev.selected_step, ev.eval_loss, ev.metric, ev.candidates), (3, 0.41, 0.41, ["a", "b"]))
        assert isinstance(ev.pareto_summary, grad.RouterParetoSummary)
        self.assertEqual(ev.pareto_summary.quality_drop_ci95, [-0.004, 0.019])
        self.assertIsNone(ev.pareto_summary.offload_rate)
        self.assertEqual(ev.heads.intent.accuracy, 0.9)  # type: ignore[union-attr]
        self.assertEqual((ev["future_field"], ev.future_field), (1, 1))
        self.assertIsNone(ev.preference_accuracy)
        self.assertIn("pareto_summary=RouterParetoSummary(quality_drop=0.008", repr(ev))
        self.assertEqual(run.latest_metric.eval_metrics, {"eval_loss": 0.41})  # type: ignore[union-attr]
        self.assertIsNone(grad.EvalReport.from_api({"metric_name": "x"}).metric)

    def test_wait_backoff_caps_at_five_seconds(self) -> None:
        client, _, clock = make_client({f"GET /v1/runs/{RUN_ID}": [*[json_reply(RUN_Q)] * 12, json_reply(RUN_C)]})
        client.runs.wait(RUN_ID)
        self.assertEqual(max(clock.sleeps), 5.0)

    def test_wait_timeout_and_failure(self) -> None:
        client, _, _ = make_client({f"GET /v1/runs/{RUN_ID}": json_reply(RUN_Q)})
        with self.assertRaises(grad.WaitTimeoutError) as ctx:
            client.runs.wait(RUN_ID, timeout=10)
        self.assertIsInstance(ctx.exception, TimeoutError)
        self.assertEqual(ctx.exception.resource.status, "queued")
        self.assertIn("keeps running", str(ctx.exception))
        failed = with_status(RUN_Q, "failed", error="DPORunner requires preference pairs")
        client, _, _ = make_client({f"GET /v1/runs/{RUN_ID}": json_reply(failed)})
        with self.assertRaises(grad.RunFailedError) as fctx:
            client.runs.wait(RUN_ID)
        self.assertEqual(fctx.exception.error, "DPORunner requires preference pairs")
        self.assertEqual(fctx.exception.run.status, "failed")
        self.assertEqual(client.runs.wait(RUN_ID, raise_on_failure=False).status, "failed")
        for status in ("cancelled", "stopped_budget"):
            client, _, _ = make_client({f"GET /v1/runs/{RUN_ID}": json_reply(with_status(RUN_Q, status))})
            self.assertEqual(client.runs.wait(RUN_ID).status, status)
        client, _, _ = make_client({f"GET /v1/runs/{RUN_ID}": problem(404, "run_not_found")})
        with self.assertRaises(grad.NotFoundError):
            client.runs.wait(RUN_ID)

    def test_run_wait_updates_in_place_and_chains(self) -> None:
        client, _, _ = make_client({"POST /v1/runs": json_reply(RUN_Q, 202), f"GET /v1/runs/{RUN_ID}": json_reply(RUN_C)})
        run = client.runs.create("support", name="support-sft", recipe=SFTRecipe())
        same = run.wait()
        self.assertIs(same, run)
        self.assertEqual(run.status, "completed")
        self.assertIs(run.refresh(), run)

    def test_wait_with_on_metric_streams_sse(self) -> None:
        stream = fixture("python-metrics-stream.sse")
        client, sender, _ = make_client({f"GET /v1/runs/{RUN_ID}/metrics": Reply(200, stream, {"content-type": "text/event-stream"})})
        seen: list[grad.MetricPoint] = []
        run = client.runs.wait(RUN_ID, on_metric=seen.append)
        self.assertEqual([m.step for m in seen], [1])
        self.assertEqual(run.status, "completed")
        self.assertEqual(sender.sent[0].header("Accept"), "text/event-stream")
        self.assertGreater(seen[0].loss or 0, 0)
        self.assertIsNone(seen[0].eval_metrics)
        self.assertEqual(seen[0].epoch, 0)  # raw fallback for fields newer than the SDK

    def test_sse_reconnects_with_last_event_id_and_dedupes(self) -> None:
        def metric(seq: int, step: int) -> str:
            return f"event: metric\nid: {seq}\ndata: {json.dumps({'seq': seq, 'attempt': 1, 'step': step, 'loss': 0.5, 'tokens': 1, 'cost_usd': 0.0, 'timestamp': 'now'})}\n\n"

        status = f"event: status\ndata: {json.dumps(RUN_C)}\n\n"
        first = Reply(200, headers={"content-type": "text/event-stream"}, chunks=[(": hi\n\nretry: 200\n\n" + metric(1, 1) + metric(2, 2)).encode()], error=ConnectionResetError("drop"))
        second = Reply(200, (metric(2, 2) + metric(3, 3) + status), {"content-type": "text/event-stream"})
        client, sender, clock = make_client({f"GET /v1/runs/{RUN_ID}/metrics": [first, problem(503, "busy"), second]}, max_retries=0)
        steps = [m.step for m in client.runs.metrics(RUN_ID, follow=True)]
        self.assertEqual(steps, [1, 2, 3])
        self.assertEqual([s.header("Last-Event-ID") for s in sender.sent], [None, "2", "2"])
        self.assertTrue(all(0 < s <= 10 for s in clock.sleeps))

    def test_sse_stream_ending_without_status_reconnects(self) -> None:
        empty = Reply(200, ": ping\n\n", {"content-type": "text/event-stream"})
        done = Reply(200, f"event: status\ndata: {json.dumps(RUN_C)}\n\n", {"content-type": "text/event-stream"})
        client, sender, _ = make_client({f"GET /v1/runs/{RUN_ID}/metrics": [empty, done]})
        self.assertEqual(list(client.runs.metrics(RUN_ID, follow=True, after_step=0)), [])
        self.assertEqual(len(sender.sent), 2)

    def test_sse_gives_up_after_repeated_failures(self) -> None:
        client, _, _ = make_client({f"GET /v1/runs/{RUN_ID}/metrics": refused()}, max_retries=0)
        with self.assertRaises(grad.APIConnectionError):
            list(client.runs.metrics(RUN_ID, follow=True))
        bad = Reply(200, ": ping\n\n", {"content-type": "text/event-stream"})
        client, _, _ = make_client({f"GET /v1/runs/{RUN_ID}/metrics": bad})
        with self.assertRaises(grad.APIConnectionError) as ctx:
            list(client.runs.metrics(RUN_ID, follow=True))
        self.assertIn("Lost the metrics stream", str(ctx.exception))

    def test_sse_falls_back_to_polling_when_a_proxy_strips_the_stream(self) -> None:
        page = fixture("python-metrics-page.json")
        client, sender, _ = make_client(
            {
                f"GET /v1/runs/{RUN_ID}/metrics": [
                    json_reply({"data": [], "next_cursor": None, "status": "running", "run_id": RUN_ID}),
                    json_reply({**page, "status": "running"}),
                    refused(),
                    json_reply({**page, "data": [], "status": "completed"}),
                ],
                f"GET /v1/runs/{RUN_ID}": json_reply(RUN_C),
            },
            max_retries=0,
        )
        seen: list[int] = []
        run = client.runs.wait(RUN_ID, on_metric=lambda m: seen.append(m.step))
        self.assertEqual(seen, [1])
        self.assertEqual(run.status, "completed")
        cursors = [s.query.get("cursor") for s in sender.sent if s.path.endswith("/metrics")]
        self.assertIn([page["tail_cursor"]], cursors, "polling tails with tail_cursor")

    def test_wait_timeout_while_streaming(self) -> None:
        client, _, clock = make_client({f"GET /v1/runs/{RUN_ID}/metrics": Reply(200, ": ping\n\n", {"content-type": "text/event-stream"}), f"GET /v1/runs/{RUN_ID}": json_reply(RUN_Q)})
        with self.assertRaises(grad.WaitTimeoutError):
            client.runs.wait(RUN_ID, timeout=5, on_metric=lambda m: None)
        self.assertGreaterEqual(clock.now, 1005)

    def test_metrics_pages(self) -> None:
        page = fixture("python-metrics-page.json")
        client, sender, _ = make_client({f"GET /v1/runs/{RUN_ID}/metrics": [json_reply({**page, "next_cursor": "c2"}), json_reply(page)]})
        run = grad.Run.from_api(RUN_C, client)
        points = list(run.metrics())
        self.assertEqual([p.step for p in points], [1, 1])
        self.assertEqual(len(sender.sent), 2, "next_cursor is null on the last page")
        self.assertEqual(sender.sent[1].query["cursor"], ["c2"])
        self.assertIn("MetricPoint(", repr(points[0]))

    def test_cancel_resume_checkpoints_promote(self) -> None:
        ckpts = fixture("python-checkpoints-page.json")
        art = fixture("python-artifact.json")
        client, sender, _ = make_client(
            {
                f"POST /v1/runs/{RUN_ID}/cancel": json_reply(with_status(RUN_Q, "cancelled")),
                f"POST /v1/runs/{RUN_ID}/resume": json_reply(with_status(RUN_Q, "queued")),
                f"GET /v1/runs/{RUN_ID}/checkpoints": json_reply(ckpts),
                f"POST /v1/checkpoints/{ckpts['data'][0]['id']}/promote": json_reply(art, 201),
            }
        )
        run = grad.Run.from_api(RUN_Q, client)
        self.assertEqual(run.cancel().status, "cancelled")
        self.assertEqual(run.resume(max_cost_usd=40).status, "queued")
        self.assertEqual(sender.sent[1].json, {"max_cost_usd": 40})
        self.assertEqual(client.runs.resume(RUN_ID).status, "queued")
        self.assertEqual(sender.sent[2].json, {})
        checkpoints = run.checkpoints()
        self.assertEqual(checkpoints[0].step, 1)
        promoted = checkpoints[-1].promote(name="fast-diff-merge")
        self.assertEqual(sender.sent[-1].json, {"name": "fast-diff-merge"})
        self.assertIsInstance(promoted, grad.Artifact)
        client.checkpoints.promote(ckpts["data"][0]["id"])
        self.assertEqual(sender.sent[-1].json, {})

    def test_run_artifact_deploy_and_list(self) -> None:
        art = fixture("python-artifact.json")
        client, sender, _ = make_client(
            {
                f"GET /v1/artifacts/{RUN_C['artifact_id']}": json_reply(art),
                "POST /v1/deployments": fixture_reply("python-problem-501-deploy.json"),
                "GET /v1/runs": json_reply(fixture("python-runs-page.json")),
            }
        )
        run = grad.Run.from_api(RUN_C, client)
        artifact = run.artifact
        assert artifact is not None
        self.assertEqual(artifact.ref, f"{art['name']}@{art['version']}")
        with self.assertRaises(grad.DeployUnavailableError):
            run.deploy(fallback="qwen/qwen3-32b")
        self.assertEqual(sender.sent[-1].json, {"artifact": RUN_C["artifact_id"], "fallback": "qwen/qwen3-32b"})
        self.assertEqual([r.id for r in client.runs.list(limit=1)], [RUN_ID])
        no_art = grad.Run.from_api(RUN_Q, client)
        with self.assertRaises(RuntimeError) as ctx:
            no_art.deploy()
        self.assertIn("wait()", str(ctx.exception))
        with self.assertRaises(RuntimeError):
            no_art.download("x")
        with self.assertRaises(AttributeError):
            run.url  # noqa: B018


class ServingTests(unittest.TestCase):
    DEPLOYMENT = {
        "id": "dep_1",
        "workspace_id": "ws",
        "name": "support-router",
        "model_id": "ws/support-router",
        "active_artifact_id": "support-router@2026-11-27-2",
        "previous_artifact_id": "support-router@2026-11-27-1",
        "fallback_model": "qwen/qwen3-32b",
        "explore_rate": 0.05,
        "status": "active",
        "created_at": "t",
        "updated_at": "t",
    }
    ROUTE = {"inference_id": "inf_1", "deployment": "support-router", "artifact_id": "support-router@2026-11-27-2", "model": "qwen/qwen3-8b", "is_exploration": False, "confidence": 0.91, "scores": {"qwen/qwen3-8b": 0.9}}

    def test_deploy_route_feedback_rollback(self) -> None:
        fb = fixture("python-feedback-response.json")
        client, sender, _ = make_client(
            {
                "POST /v1/deployments": json_reply(self.DEPLOYMENT),
                "POST /v1/route": json_reply(self.ROUTE),
                "POST /v1/feedback": json_reply(fb),
                "POST /v1/deployments/support-router/rollback": json_reply({**self.DEPLOYMENT, "active_artifact_id": "support-router@2026-11-27-1"}),
                "GET /v1/deployments/support-router": json_reply({"deployment": self.DEPLOYMENT, "feedback_count": 1, "average_score": 1.0}),
                "GET /v1/deployments": json_reply({"data": [self.DEPLOYMENT], "next_cursor": None}),
            }
        )
        art = grad.Artifact.from_api(fixture("python-artifact.json"), client)
        dep = art.deploy(name="support-router", fallback="qwen/qwen3-32b", explore_rate=0.05)
        self.assertEqual(sender.sent[0].json, {"artifact": art.ref, "name": "support-router", "fallback": "qwen/qwen3-32b", "explore_rate": 0.05})
        decision = client.route("support-router", messages=[{"role": "user", "content": "Where is invoice #9941?"}], tools=[{"type": "function"}], session_id="s1")
        self.assertEqual(decision.model, "qwen/qwen3-8b")
        self.assertEqual(sender.sent[1].json["tools"], [{"type": "function"}])
        result = decision.record_feedback(score=1.0, metrics={"latency_ms": 120})
        event = sender.sent[2].json["events"][0]
        self.assertEqual(event["inference_id"], "inf_1")
        self.assertEqual(event["deployment_name"], "support-router")
        self.assertTrue(event["idempotency_key"].startswith("sdk:"))
        self.assertEqual(result.accepted, 1)
        decision.record_feedback(score=1.0, metrics={"latency_ms": 120})
        self.assertEqual(sender.sent[3].json["events"][0]["idempotency_key"], event["idempotency_key"], "same outcome -> same key (deduplicated)")
        decision.record_feedback(score=0.0, idempotency_key="custom")
        self.assertEqual(sender.sent[4].json["events"][0]["idempotency_key"], "custom")
        self.assertEqual(dep.rollback().active_artifact_id, "support-router@2026-11-27-1")
        status = dep.status_summary()
        self.assertEqual((status.feedback_count, status.average_score), (1, 1.0))
        self.assertIsInstance(status.deployment, grad.Deployment)
        self.assertEqual([d.name for d in client.deployments.list()], ["support-router"])
        client.route(dep, messages=[{"role": "user", "content": "x"}])
        with self.assertRaises(ValueError):
            client.route("support-router", messages=[])
        with self.assertRaises(TypeError):
            client.route(5, messages=[{"role": "user", "content": "x"}])
        run = grad.Run.from_api(RUN_C, client)
        client.deploy(run)
        self.assertEqual(sender.sent[-1].json, {"artifact": RUN_C["artifact_id"]})
        with self.assertRaises(RuntimeError):
            client.deploy(grad.Run.from_api(RUN_Q, client))

    def test_feedback_validation_and_batch(self) -> None:
        client, sender, _ = make_client({"POST /v1/feedback": json_reply(fixture("python-feedback-response.json"))})
        client.feedback.record(inference_id="inf", idempotency_key="query-inf", score=True, expected_output={"content": "fix"})
        self.assertEqual(sender.sent[0].json["events"][0], {"inference_id": "inf", "score": 1.0, "expected_output": {"content": "fix"}, "idempotency_key": "query-inf"})
        client.feedback.record(inference_id="inf", score=1.0, expected_output=None)
        self.assertNotIn("expected_output", sender.sent[1].json["events"][0])
        with self.assertRaises(ValueError):
            client.feedback.record(score=1.0)
        with self.assertRaises(ValueError):
            client.feedback.record(session_id="s", score=1.5)
        res = client.feedback.record_many([{"session_id": "s1", "score": 0.5}, {"deployment_name": "d", "metrics": {"m": 1}}])
        self.assertEqual(len(sender.sent[-1].json["events"]), 2)
        self.assertEqual(res.records[0].idempotency_key, "k1")

    def test_embeddings(self) -> None:
        body = {"model": "docs-embedder", "data": [{"index": 1, "embedding": [0.0, 1.0]}, {"index": 0, "embedding": [1.0, 0.0]}], "usage": {"prompt_tokens": 2, "total_tokens": 2}}
        client, sender, _ = make_client({"POST /v1/embeddings": json_reply(body)})
        emb = client.embeddings.create(model="docs-embedder", input=("a", "b"))
        self.assertEqual(emb.embeddings, [[1.0, 0.0], [0.0, 1.0]])
        self.assertEqual(sender.sent[0].json["input"], ["a", "b"])
        client.embeddings.create(model="docs-embedder", input="one")
        self.assertEqual(sender.sent[1].json["input"], "one")

    def test_artifacts_list(self) -> None:
        client, sender, _ = make_client({"GET /v1/artifacts": json_reply(fixture("python-artifacts-page.json"))})
        arts = list(client.artifacts.list(name="support-sft"))
        self.assertEqual(sender.sent[0].query["name"], ["support-sft"])
        self.assertTrue(arts)
        self.assertEqual(str(arts[0]), arts[0].ref)

class EvalTests(unittest.TestCase):
    def rubric(self) -> Rubric:
        return Rubric([validators.NonEmpty(), Scorer("short", fn=lambda t: 1.0 if len(t.text) < 200 else 0.0)])

    def test_plan_body_and_readout(self) -> None:
        client, sender, _ = make_client({"POST /v1/evals/plan": json_reply(fixture("python-eval-plan.json"))})
        art = grad.Artifact.from_api(fixture("python-artifact.json"))
        plan = client.evals.plan(models=["test/tiny-qwen3", art], dataset="support", rubric=self.rubric(), samples=4, temperature=0.7, baseline="test/tiny-qwen3", pass_threshold=0.5, max_tokens=256, limit=10, name="sql-eval", dataset_version=1)
        body = sender.sent[0].json
        self.assertEqual(body["models"], ["test/tiny-qwen3", art.ref])
        self.assertEqual(body["rubric"][1], {"name": "short", "kind": "code", "runtime": "local", "weight": 1.0})
        self.assertEqual((body["samples"], body["temperature"], body["baseline"]), (4, 0.7, "test/tiny-qwen3"))
        text = str(plan)
        self.assertIn("short", text)
        self.assertIn("run in this process", text)

    def test_eval_inputs(self) -> None:
        client, sender, _ = make_client({"POST /v1/evals/plan": json_reply(fixture("python-eval-plan.json"))})
        client.evals.plan(models="test/tiny-qwen3", dataset="support", rubric=[{"name": "x", "kind": "validator", "validator": "json"}])
        body = sender.sent[0].json
        self.assertEqual(body, {"models": ["test/tiny-qwen3"], "dataset": "support", "rubric": [{"name": "x", "kind": "validator", "validator": "json"}]})
        with self.assertRaises(ValueError):
            client.evals.plan(models=[], dataset="d")
        with self.assertRaises(TypeError):
            client.evals.plan(models=["m"], dataset="d", max_cost_usd=1)  # type: ignore[call-arg]

    def test_create_dry_runs_local_scorers_first(self) -> None:
        def broken(traj: grad.Trajectory) -> float:
            return traj.metadata["missing"]  # type: ignore[no-any-return]

        client, sender, _ = make_client({"GET /v1/datasets/support/records": json_reply(fixture("python-dataset-records-page.json"))})
        with self.assertRaises(grad.ScorerError) as ctx:
            client.evals.create(models=["m"], dataset="support", rubric=Rubric([Scorer("broken", fn=broken)]))
        self.assertIn("dry run", str(ctx.exception))
        self.assertEqual(sender.paths(), ["GET /v1/datasets/support/records"])

    def test_full_local_scorer_flow(self) -> None:
        queued = fixture("python-eval-queued.json")
        awaiting = fixture("python-eval-awaiting.json")
        completed = fixture("python-eval-completed.json")
        outputs = fixture("python-eval-outputs-page.json")
        eid = queued["id"]
        client, sender, clock = make_client(
            {
                "GET /v1/datasets/support/records": json_reply(fixture("python-dataset-records-page.json")),
                "POST /v1/evals": json_reply(queued, 202),
                f"GET /v1/evals/{eid}": [json_reply(queued), json_reply(awaiting), json_reply(awaiting), json_reply(completed)],
                f"GET /v1/evals/{eid}/outputs": [json_reply(outputs), json_reply({"data": [], "next_cursor": None})],
                f"POST /v1/evals/{eid}/scores": json_reply(fixture("python-eval-scores-response.json")),
                f"GET /v1/evals/{eid}/failures": json_reply(fixture("python-eval-failures-nonempty.json")),
                "POST /v1/datasets/sql-hard-cases/records": json_reply({**DATASET, "name": "sql-hard-cases"}),
                f"GET /v1/evals/{eid}/results": json_reply(fixture("python-eval-results-page.json")),
            }
        )
        ev = client.evals.create(name="support-eval", models=["test/tiny-qwen3"], dataset="support", rubric=self.rubric()).wait()
        self.assertEqual(ev.status, "completed")
        posted = [s for s in sender.sent if s.path.endswith("/scores")]
        self.assertEqual(len(posted), 1)
        scores = posted[0].json["scores"]
        self.assertEqual({s["output_id"] for s in scores}, {o["id"] for o in outputs["data"]})
        self.assertTrue(all(s["scorer"] == "short" and s["score"] == 1.0 for s in scores))
        outputs_q = [s for s in sender.sent if s.path.endswith("/outputs")][0]
        self.assertEqual(outputs_q.query["missing_scorer"], ["short"])
        table = ev.summary_table()
        self.assertIn("overall (95% CI)", table)
        self.assertIn("test/tiny-qwen3", table)
        self.assertIn("pass@1", table)
        self.assertEqual(str(ev), table)
        with self.assertRaises(grad.NotAvailableInV0Error):
            ev.summary_table(by="check")
        failures = ev.failures(model="test/tiny-qwen3", threshold=1.0)
        self.assertEqual(len(failures), 2)
        self.assertIsInstance(failures[0], grad.EvalResult)
        self.assertEqual([f.score for f in failures], [0.4, 0.4])
        hard = failures.to_dataset("sql-hard-cases", metadata={"round": 2})
        self.assertEqual(hard.name, "sql-hard-cases")
        pushed = sender.sent[-1].json
        self.assertEqual(pushed["metadata"], {"mined_from_eval": eid, "round": 2})
        self.assertEqual(len(pushed["records"]), 2)
        with self.assertRaises(ValueError):
            grad.EvalFailures(eid, [], client).to_dataset("empty")
        results = list(ev.results())
        self.assertTrue(results)
        self.assertIn("EvalFailures", repr(failures))
        self.assertLessEqual(max(clock.sleeps), 5)

    def test_awaiting_scores_without_rubric_is_a_clear_error(self) -> None:
        awaiting = fixture("python-eval-awaiting.json")
        client, _, _ = make_client({f"GET /v1/evals/{awaiting['id']}": json_reply(awaiting)})
        with self.assertRaises(grad.GradError) as ctx:
            client.evals.get(awaiting["id"]).wait()
        self.assertIn("wait(rubric=", str(ctx.exception))
        with self.assertRaises(grad.GradError) as ctx:
            client.evals.wait(awaiting["id"], rubric=Rubric([validators.JSON()]))
        self.assertIn("does not define them", str(ctx.exception))

    def test_scores_not_accepted_and_scorer_errors(self) -> None:
        awaiting = fixture("python-eval-awaiting.json")
        outputs = fixture("python-eval-outputs-page.json")
        eid = awaiting["id"]
        client, _, _ = make_client({f"GET /v1/evals/{eid}": json_reply(awaiting), f"GET /v1/evals/{eid}/outputs": json_reply(outputs), f"POST /v1/evals/{eid}/scores": json_reply({})})
        with self.assertRaises(grad.GradAPIError) as ctx:
            client.evals.score_pending(eid, self.rubric())
        self.assertEqual(ctx.exception.code, "scores_not_accepted")
        client, _, _ = make_client({f"GET /v1/evals/{eid}": json_reply(awaiting), f"GET /v1/evals/{eid}/outputs": json_reply(outputs)})
        with self.assertRaises(grad.ScorerError) as sctx:
            client.evals.score_pending(eid, Rubric([Scorer("short", fn=lambda t: 2.0)]))
        self.assertIn("output", str(sctx.exception))
        completed = fixture("python-eval-completed.json")
        client, _, _ = make_client({f"GET /v1/evals/{eid}": json_reply(completed)})
        self.assertEqual(client.evals.score_pending(eid, self.rubric()), 0)

    def test_eval_failed_cancelled_timeout_list(self) -> None:
        completed = fixture("python-eval-completed.json")
        eid = completed["id"]
        failed = {**completed, "status": "failed", "error": "inference endpoint returned 503"}
        client, _, _ = make_client({f"GET /v1/evals/{eid}": json_reply(failed)})
        with self.assertRaises(grad.EvalFailedError) as ctx:
            client.evals.wait(eid)
        self.assertIn("503", str(ctx.exception))
        self.assertEqual(ctx.exception.eval.status, "failed")
        self.assertEqual(client.evals.wait(eid, raise_on_failure=False).status, "failed")
        capped = {**completed, "status": "stopped_budget", "max_cost_usd": 0.1}
        client, _, _ = make_client({f"GET /v1/evals/{eid}": json_reply(capped)})
        self.assertEqual(client.evals.wait(eid).status, "stopped_budget")
        queued = fixture("python-eval-queued.json")
        client, _, _ = make_client(
            {
                f"GET /v1/evals/{eid}": [problem(503, "busy"), json_reply(queued)],
                f"POST /v1/evals/{eid}/cancel": json_reply({**completed, "status": "cancelled"}),
                "GET /v1/evals": json_reply({"data": [completed], "next_cursor": None}),
                f"GET /v1/evals/{eid}/outputs": json_reply(fixture("python-eval-outputs-page.json")),
            },
            max_retries=0,
        )
        with self.assertRaises(grad.WaitTimeoutError):
            client.evals.wait(eid, timeout=2)
        ev = grad.Eval.from_api(queued, client)
        self.assertEqual(ev.cancel().status, "cancelled")
        self.assertTrue(ev.done)
        self.assertEqual([e.id for e in client.evals.list()], [eid])
        outs = list(ev.outputs(model="test/tiny-qwen3"))
        traj = outs[0].trajectory()
        self.assertEqual(traj.messages[-1]["role"], "assistant")
        self.assertEqual(traj.text, outs[0].output)
        self.assertIn("(no summary yet", grad.Eval.from_api(queued).summary_table())

    def test_summary_table_with_baseline(self) -> None:
        completed = copy.deepcopy(fixture("python-eval-completed.json"))
        base = completed["summary"][0]
        completed["summary"] = [base, {**base, "model": "sql@latest", "vs_baseline": {"delta": 0.276, "ci_low": 0.24, "ci_high": 0.311}, "pass_at_k": {"1": 0.9, "4": 0.97}, "cost_per_1k_tasks_usd": None}]
        table = grad.Eval.from_api(completed).summary_table()
        self.assertIn("+27.6 (+24.0–+31.1)", table)
        self.assertIn("pass@4", table)


class ObjectTests(unittest.TestCase):
    def test_equality_repr_and_unbound(self) -> None:
        a = grad.Run.from_api(RUN_Q)
        b = grad.Run.from_api(RUN_Q)
        self.assertEqual(a, b)
        self.assertNotEqual(a, grad.Run.from_api(RUN_C))
        self.assertIn(RUN_ID, repr(a))
        with self.assertRaises(RuntimeError):
            a.refresh()
        with self.assertRaises(AttributeError):
            a._private  # noqa: B018
        self.assertEqual(grad.AttrDict({"a": {"b": 1}}).a.b, 1)
        with self.assertRaises(AttributeError):
            grad.AttrDict({}).__missing_dunder__  # noqa: B018
        created = grad.CreatedApiKey.from_api({"key": None, "secret": "grad_abcdefghijkl"})
        self.assertIn("grad_abc", repr(created))

    def test_page_next_page(self) -> None:
        page = grad.Page([1], None)
        self.assertIsNone(page.next_page())
        self.assertFalse(page.has_more)
        self.assertEqual(list(page.iter_pages()), [page])


if __name__ == "__main__":
    unittest.main()
