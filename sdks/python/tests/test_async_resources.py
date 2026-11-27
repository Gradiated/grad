"""Async parity: every public ``AsyncGrad`` resource method against the fake transport and wire fixtures."""

from __future__ import annotations

import asyncio
import copy
import json
import tempfile
import unittest
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from _fakes import Reply, bundle_bytes, fixture, fixture_reply, json_reply, make_async_client, problem, refused

import grad
from grad import Rubric, Scorer, validators
from grad.recipes import SFTRecipe

RUN_Q = fixture("python-run-queued.json")
RUN_C = fixture("python-run-completed.json")
RUN_ID = RUN_Q["id"]
DATASET = fixture("python-dataset.json")


def with_status(run: dict[str, Any], status: str, **extra: Any) -> dict[str, Any]:
    out = copy.deepcopy(run)
    out.update(status=status, **extra)
    return out


def arun(test: Callable[[], Awaitable[None]]) -> None:
    asyncio.run(test())


class AsyncModelsKeysTests(unittest.TestCase):
    def test_models_and_keys(self) -> None:
        created = fixture("python-keys-created.json")

        async def main() -> None:
            client, sender, _ = make_async_client(
                {
                    "GET /v1/models": json_reply(fixture("python-models.json")),
                    "POST /v1/keys": json_reply(created, 201),
                    "GET /v1/keys": json_reply({"data": [created["key"]], "next_cursor": None}),
                    f"DELETE /v1/keys/{created['key']['id']}": json_reply({**created["key"], "revoked_at": "2026-11-27T00:00:00Z"}),
                }
            )
            async with client:
                models = await client.models.list()
                self.assertTrue(any(m.id == "test/tiny-qwen3" for m in models))
                self.assertEqual((await client.models.get("test/tiny-qwen3")).id, "test/tiny-qwen3")
                with self.assertRaises(grad.NotFoundError):
                    await client.models.get("nope/model")
                key = await client.keys.create(name="ci", scopes=["runs:read"])
                self.assertTrue(key.secret)
                self.assertEqual([k.name async for k in client.keys.list()], ["ci"])
                self.assertIsNotNone((await client.keys.revoke(created["key"]["id"])).revoked_at)
            self.assertTrue(sender.closed)

        arun(main)


class AsyncDatasetTests(unittest.TestCase):
    def test_push_create_get_list_records_render(self) -> None:
        page = fixture("python-dataset-records-page.json")

        async def main() -> None:
            client, sender, _ = make_async_client(
                {
                    "POST /v1/datasets/support/records": [
                        json_reply(DATASET),
                        json_reply(DATASET),
                        problem(422, "validation_error", "records.1.messages.0.role: Invalid option"),
                        json_reply(DATASET),
                    ],
                    "GET /v1/datasets/support": json_reply(DATASET),
                    "GET /v1/datasets": [
                        json_reply({"data": [DATASET], "next_cursor": "c2"}),
                        json_reply({"data": [DATASET], "next_cursor": "c2"}),
                        json_reply({"data": [{**DATASET, "name": "other"}], "next_cursor": None}),
                    ],
                    "GET /v1/datasets/support/records": [json_reply({**page, "next_cursor": "n1"}), json_reply({**page, "next_cursor": None})],
                    "POST /v1/datasets/support/render": json_reply(fixture("python-render.json")),
                    "POST /v1/datasets": json_reply(DATASET, 201),
                }
            )
            ds = await client.datasets.push("support", [{"prompt": "a"}], metadata={"src": "t"})
            self.assertIsInstance(ds, grad.AsyncDataset)
            self.assertEqual(sender.sent[0].json["metadata"], {"src": "t"})
            with self.assertRaises(grad.ValidationError) as ctx:
                await client.datasets.push("support", ({"prompt": str(i)} for i in range(4)), chunk_size=2)
            self.assertIn("records.3", ctx.exception.detail, "renumbered to the caller's record index")
            with self.assertRaises(ValueError):
                await client.datasets.push("support", [])
            with self.assertRaises(TypeError):
                await client.datasets.push("support", {"messages": []})  # type: ignore[arg-type]
            got = await client.datasets.get("support")
            self.assertEqual(await got.count(), 2)
            self.assertEqual(await client.datasets.count("support"), 2)
            first = await client.datasets.list(limit=1)
            self.assertTrue(first.has_more)
            self.assertIn("AsyncPage(", repr(first))
            self.assertEqual([d.name async for d in client.datasets.list(limit=1)], ["support", "other"])
            self.assertEqual(len([r async for r in got.records(limit=1)]), 2 * len(page["data"]))
            preview = await got.render(model="test/tiny-qwen3", train_on="last", thinking="on", preserve_thinking=True, limit=1)
            self.assertEqual(sender.sent[-1].json, {"model": "test/tiny-qwen3", "train_on": "last", "thinking": True, "preserve_thinking": True, "limit": 1})
            self.assertIn("tokens trained", str(preview))
            self.assertEqual((await client.datasets.create("support", metadata={"a": 1})).name, "support")
            self.assertIs(await got.refresh(), got)
            self.assertIs(await got.push([{"prompt": "x"}]), got)
            for call in (lambda: got.score(), lambda: got.filter()):
                with self.assertRaises(grad.NotAvailableInV0Error):
                    await call()

        arun(main)

    def test_file_import_and_hf(self) -> None:
        ticket = fixture("python-upload-ticket.json")
        job = fixture("python-import-queued.json")
        done = {**job, "status": "completed", "imported_count": 1, "dataset": "from-file"}
        failed = fixture("python-imports-page.json")["data"][0]

        async def main() -> None:
            client, sender, clock = make_async_client(
                {
                    "POST /v1/uploads": json_reply(ticket, 201),
                    f"PUT {ticket['url'].split('?')[0]}": json_reply({}),
                    "POST /v1/datasets/from-file/imports": json_reply({**job, "dataset": "from-file"}, 202),
                    f"GET /v1/imports/{job['id']}": [json_reply({**job, "status": "running"}), refused(), json_reply(done), json_reply(failed)],
                    "GET /v1/datasets/from-file": json_reply({**DATASET, "name": "from-file", "record_count": 1}),
                    "GET /v1/imports": json_reply(fixture("python-imports-page.json")),
                    "POST /v1/datasets/openai-gsm8k-main/imports": json_reply(job, 202),
                    "GET /v1/datasets/openai-gsm8k-main": json_reply({**DATASET, "name": "openai-gsm8k-main"}),
                },
                max_retries=0,
            )
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "train.jsonl"
                path.write_text('{"prompt":"q","completion":"a"}\n')
                ds = await client.datasets.push("from-file", path)
                self.assertEqual(ds.record_count, 1)
                self.assertIsNone(sender.sent[1].header("Authorization"))
                self.assertEqual(sender.sent[2].json["source"]["format"], "jsonl")
                imp = await ds.import_file(path, connector="langfuse")
                with self.assertRaises(grad.ImportFailedError):
                    await imp.wait()
                self.assertIs(await imp.refresh(), imp)
                self.assertEqual((await client.imports.get(job["id"])).status, "failed")
                self.assertTrue([j async for j in client.imports.list()])
                with self.assertRaises(ValueError):
                    await client.datasets.import_file("d", path, connector="nope")
            self.assertTrue(clock.sleeps)
            hf = await client.datasets.from_hf("openai/gsm8k", subset="main", prompt="question", answer="answer", limit=10, wait=False)
            self.assertEqual(hf.name, "openai-gsm8k-main")
            self.assertEqual(sender.sent[-2].json["source"]["config"], "main")
            with self.assertRaises(ValueError):
                await client.datasets.from_hf("a/b", config="x", subset="y")

        arun(main)

    def test_import_wait_timeout(self) -> None:
        job = fixture("python-import-queued.json")

        async def main() -> None:
            client, _, _ = make_async_client({f"GET /v1/imports/{job['id']}": json_reply(job)})
            with self.assertRaises(grad.WaitTimeoutError):
                await client.imports.wait(job["id"], timeout=2)
            imp = grad.AsyncImportJob.from_api({**job, "status": "completed", "dataset": "support"}, client)
            self.assertEqual(imp.dataset, "support")

        arun(main)


class AsyncRunTests(unittest.TestCase):
    def test_plan_create_wait_cancel_resume_checkpoints(self) -> None:
        ckpts = fixture("python-checkpoints-page.json")
        art = fixture("python-artifact.json")

        async def main() -> None:
            client, sender, clock = make_async_client(
                {
                    "POST /v1/runs/plan": json_reply(fixture("python-plan.json")),
                    "POST /v1/runs": json_reply(RUN_Q, 202),
                    f"GET /v1/runs/{RUN_ID}": [json_reply(RUN_Q), problem(502, "bad"), json_reply(with_status(RUN_Q, "running")), json_reply(RUN_C)],
                    f"POST /v1/runs/{RUN_ID}/cancel": json_reply(with_status(RUN_Q, "cancelled")),
                    f"POST /v1/runs/{RUN_ID}/resume": json_reply(with_status(RUN_Q, "queued")),
                    f"GET /v1/runs/{RUN_ID}/checkpoints": json_reply(ckpts),
                    f"POST /v1/checkpoints/{ckpts['data'][0]['id']}/promote": json_reply(art, 201),
                    "GET /v1/runs": json_reply(fixture("python-runs-page.json")),
                    f"GET /v1/artifacts/{RUN_C['artifact_id']}": json_reply(art),
                    "POST /v1/deployments": fixture_reply("python-problem-501-deploy.json"),
                },
                max_retries=0,
            )
            plan = await client.runs.plan(dataset="support", name="support-sft", recipe=SFTRecipe(model="test/tiny-qwen3"), max_cost_usd=5)
            self.assertIn("cap max_cost_usd=5", str(plan))
            run = await client.runs.create("support", name="support-sft", recipe=SFTRecipe())
            statuses: list[str] = []

            async def on_status(r: grad.AsyncRun) -> None:
                statuses.append(r.status)

            same = await run.wait(on_status=on_status)
            self.assertIs(same, run)
            self.assertEqual(statuses, ["queued", "running", "completed"])
            self.assertLessEqual(max(clock.sleeps), 5)
            self.assertIs(await run.refresh(), run)
            self.assertEqual((await client.runs.cancel(RUN_ID)).status, "cancelled")
            self.assertEqual((await run.resume(max_cost_usd=40)).status, "queued")
            self.assertEqual(sender.sent[-1].json, {"max_cost_usd": 40})
            self.assertEqual((await run.cancel()).status, "cancelled")
            checkpoints = await run.checkpoints()
            self.assertEqual(checkpoints[0].step, 1)
            promoted = await checkpoints[0].promote(name="fast")
            self.assertIsInstance(promoted, grad.AsyncArtifact)
            await client.checkpoints.promote(ckpts["data"][0]["id"])
            self.assertEqual(sender.sent[-1].json, {})
            self.assertEqual([r.id async for r in client.runs.list(limit=1)], [RUN_ID])
            done = grad.AsyncRun.from_api(RUN_C, client)
            artifact = await done.get_artifact()
            self.assertEqual(artifact.ref, f"{art['name']}@{art['version']}")
            with self.assertRaises(grad.DeployUnavailableError):
                await done.deploy(fallback="qwen/qwen3-32b")
            with self.assertRaises(grad.DeployUnavailableError):
                await client.deploy(done)
            with self.assertRaises(RuntimeError):
                await grad.AsyncRun.from_api(RUN_Q, client).deploy()

        arun(main)

    def test_wait_failure_timeout_and_sse(self) -> None:
        stream = fixture("python-metrics-stream.sse")

        def metric(seq: int, step: int) -> str:
            return f"event: metric\nid: {seq}\ndata: {json.dumps({'seq': seq, 'attempt': 1, 'step': step, 'loss': 0.5, 'tokens': 1, 'cost_usd': 0.0, 'timestamp': 'now'})}\n\n"

        async def main() -> None:
            failed = with_status(RUN_Q, "failed", error="boom")
            client, _, _ = make_async_client({f"GET /v1/runs/{RUN_ID}": json_reply(failed)})
            with self.assertRaises(grad.RunFailedError) as ctx:
                await client.runs.wait(RUN_ID)
            self.assertEqual(ctx.exception.error, "boom")
            self.assertEqual((await client.runs.wait(RUN_ID, raise_on_failure=False)).status, "failed")
            client, _, _ = make_async_client({f"GET /v1/runs/{RUN_ID}": json_reply(RUN_Q)})
            with self.assertRaises(grad.WaitTimeoutError):
                await client.runs.wait(RUN_ID, timeout=3)

            client, sender, _ = make_async_client({f"GET /v1/runs/{RUN_ID}/metrics": Reply(200, stream, {"content-type": "text/event-stream"})})
            seen: list[int] = []
            run = await client.runs.wait(RUN_ID, on_metric=lambda m: seen.append(m.step))
            self.assertEqual((seen, run.status), ([1], "completed"))
            self.assertEqual(sender.sent[0].header("Accept"), "text/event-stream")

            status = f"event: status\ndata: {json.dumps(RUN_C)}\n\n"
            first = Reply(200, headers={"content-type": "text/event-stream"}, chunks=[("retry: 100\n\n" + metric(1, 1) + metric(2, 2)).encode()], error=ConnectionResetError("drop"))
            second = Reply(200, metric(2, 2) + metric(3, 3) + status, {"content-type": "text/event-stream"})
            client, sender, _ = make_async_client({f"GET /v1/runs/{RUN_ID}/metrics": [first, problem(503, "busy"), second]}, max_retries=0)
            steps = [m.step async for m in client.runs.metrics(RUN_ID, follow=True)]
            self.assertEqual(steps, [1, 2, 3])
            self.assertEqual([s.header("Last-Event-ID") for s in sender.sent], [None, "2", "2"])

            client, _, _ = make_async_client({f"GET /v1/runs/{RUN_ID}/metrics": refused()}, max_retries=0)
            with self.assertRaises(grad.APIConnectionError):
                [m async for m in client.runs.metrics(RUN_ID, follow=True)]
            client, _, _ = make_async_client({f"GET /v1/runs/{RUN_ID}/metrics": Reply(200, ": ping\n\n", {"content-type": "text/event-stream"})})
            with self.assertRaises(grad.APIConnectionError):
                [m async for m in client.runs.metrics(RUN_ID, follow=True)]

            client, _, clock = make_async_client(
                {f"GET /v1/runs/{RUN_ID}/metrics": Reply(200, ": ping\n\n", {"content-type": "text/event-stream"}), f"GET /v1/runs/{RUN_ID}": json_reply(RUN_Q)}
            )
            with self.assertRaises(grad.WaitTimeoutError):
                await client.runs.wait(RUN_ID, timeout=5, on_metric=lambda m: None)

        arun(main)

    def test_sse_polling_fallback_and_metric_pages(self) -> None:
        page = fixture("python-metrics-page.json")

        async def main() -> None:
            client, _, _ = make_async_client(
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
            run = await client.runs.wait(RUN_ID, on_metric=lambda m: seen.append(m.step))
            self.assertEqual((seen, run.status), ([1], "completed"))
            client, sender, _ = make_async_client({f"GET /v1/runs/{RUN_ID}/metrics": [json_reply(page), json_reply({**page, "data": []})]})
            run = grad.AsyncRun.from_api(RUN_C, client)
            self.assertEqual([p.step async for p in run.metrics()], [1])
            self.assertEqual(sender.sent[1].query["cursor"], [page["next_cursor"]])

        arun(main)


class AsyncServingTests(unittest.TestCase):
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
    ROUTE = {"inference_id": "inf_1", "deployment": "support-router", "artifact_id": "support-router@2026-11-27-2", "model": "qwen/qwen3-8b", "is_exploration": False, "confidence": 0.91, "scores": {}}

    def test_deploy_route_feedback_rollback_embeddings_artifacts_env(self) -> None:
        fb = fixture("python-feedback-response.json")
        art = fixture("python-artifact.json")

        async def main() -> None:
            client, sender, _ = make_async_client(
                {
                    "POST /v1/deployments": json_reply(self.DEPLOYMENT),
                    "POST /v1/route": json_reply(self.ROUTE),
                    "POST /v1/feedback": json_reply(fb),
                    "POST /v1/deployments/support-router/rollback": json_reply({**self.DEPLOYMENT, "active_artifact_id": "support-router@2026-11-27-1"}),
                    "GET /v1/deployments/support-router": json_reply({"deployment": self.DEPLOYMENT, "feedback_count": 1, "average_score": 1.0}),
                    "GET /v1/deployments": json_reply({"data": [self.DEPLOYMENT], "next_cursor": None}),
                    "POST /v1/embeddings": json_reply({"model": "e", "data": [{"index": 0, "embedding": [1.0]}], "usage": {"prompt_tokens": 1, "total_tokens": 1}}),
                    "GET /v1/artifacts": json_reply(fixture("python-artifacts-page.json")),
                    f"GET /v1/artifacts/{art['name']}@latest": json_reply(art),
                    f"GET /v1/artifacts/{art['name']}@{art['version']}": json_reply(art),
                    "POST /v1/env-workers/tasks": json_reply(fixture("python-env-dispatch.json"), 202),
                    "GET /v1/env-workers/tasks/envtask_1": json_reply({"id": "envtask_1", "status": "queued"}),
                }
            )
            artifact = await client.artifacts.get(f"{art['name']}@latest")
            self.assertIs(await artifact.refresh(), artifact)
            dep = await artifact.deploy(name="support-router", fallback="qwen/qwen3-32b", explore_rate=0.05)
            self.assertEqual(sender.sent[-1].json, {"artifact": artifact.ref, "name": "support-router", "fallback": "qwen/qwen3-32b", "explore_rate": 0.05})
            decision = await client.route("support-router", messages=[{"role": "user", "content": "Where is invoice #9941?"}])
            self.assertIsInstance(decision, grad.AsyncRouteDecision)
            self.assertEqual(decision.model, "qwen/qwen3-8b")
            result = await decision.record_feedback(score=1.0, metrics={"latency_ms": 1.0})
            self.assertEqual(result.accepted, 1)
            self.assertEqual(sender.sent[-1].json["events"][0]["inference_id"], "inf_1")
            await client.feedback.record(session_id="s", score=0.5, idempotency_key="k")
            await client.feedback.record_many([{"session_id": "s1", "score": 0.5}])
            self.assertEqual((await dep.rollback()).active_artifact_id, "support-router@2026-11-27-1")
            status = await dep.status_summary()
            self.assertEqual(status.feedback_count, 1)
            self.assertEqual((await client.deployments.get("support-router")).average_score, 1.0)
            self.assertEqual([d.name async for d in client.deployments.list()], ["support-router"])
            self.assertEqual((await client.deployments.rollback("support-router")).name, "support-router")
            await client.deployments.create(grad.AsyncRun.from_api(RUN_C, client))
            self.assertEqual(sender.sent[-1].json, {"artifact": RUN_C["artifact_id"]})
            emb = await client.embeddings.create(model="e", input=["a"])
            self.assertEqual(emb.embeddings, [[1.0]])
            self.assertTrue([a async for a in client.artifacts.list(name="support-sft")])
            with self.assertRaises(grad.NotAvailableInV0Error):
                await client.artifacts.merge()
            out = await client.environments.dispatch("support-app", {"prompt": "hi"}, model_id="m", system_prompt="s", timeout_s=5)
            self.assertEqual(out["status"], "queued")
            self.assertEqual((await client.environments.get_task("envtask_1"))["status"], "queued")

        arun(main)

    def test_download_verifies_and_extracts(self) -> None:
        art = fixture("python-artifact.json")
        files = {"adapter_config.json": b'{"peft_type": "LORA"}', "adapter_model.safetensors": b"\x00" * 16}
        data = bundle_bytes(files)
        import hashlib

        sha = hashlib.sha256(data).hexdigest()
        meta = {**art, "sha256": sha, "format": "peft_lora"}

        async def main() -> None:
            with tempfile.TemporaryDirectory() as tmp:
                client, _, _ = make_async_client(
                    {
                        f"GET /v1/artifacts/{art['name']}@latest": json_reply(meta),
                        f"GET /v1/artifacts/{art['name']}@{art['version']}/download": [
                            Reply(200, headers={"content-type": "application/octet-stream", "x-artifact-sha256": sha}, chunks=[data[:10], data[10:]]),
                            Reply(200, headers={"content-type": "application/octet-stream", "x-artifact-sha256": sha}, chunks=[data]),
                            Reply(200, headers={"content-type": "application/octet-stream", "x-artifact-sha256": "0" * 64}, chunks=[data]),
                        ],
                    }
                )
                out = await client.artifacts.download(f"{art['name']}@latest", Path(tmp) / "adapter")
                self.assertTrue((out / "adapter_config.json").is_file())
                bundle = await client.artifacts.download(f"{art['name']}@latest", Path(tmp) / "a.grad.tar.gz", format="bundle")
                self.assertTrue(bundle.is_file())
                with self.assertRaises(grad.ChecksumMismatchError):
                    await client.artifacts.download(f"{art['name']}@latest", Path(tmp) / "other")
                self.assertFalse((Path(tmp) / "other").exists())
                self.assertEqual([p.name for p in Path(tmp).iterdir() if p.name.startswith(".")], [], "no temp files left")

        arun(main)


class AsyncEvalTests(unittest.TestCase):
    def rubric(self) -> Rubric:
        return Rubric([validators.NonEmpty(), Scorer("short", fn=lambda t: 1.0 if len(t.text) < 200 else 0.0)])

    def test_full_local_scorer_flow(self) -> None:
        queued = fixture("python-eval-queued.json")
        awaiting = fixture("python-eval-awaiting.json")
        completed = fixture("python-eval-completed.json")
        outputs = fixture("python-eval-outputs-page.json")
        eid = queued["id"]

        async def main() -> None:
            client, sender, _ = make_async_client(
                {
                    "GET /v1/datasets/support/records": json_reply(fixture("python-dataset-records-page.json")),
                    "POST /v1/evals/plan": json_reply(fixture("python-eval-plan.json")),
                    "POST /v1/evals": json_reply(queued, 202),
                    f"GET /v1/evals/{eid}": [json_reply(queued), json_reply(awaiting), json_reply(awaiting), json_reply(completed)],
                    f"GET /v1/evals/{eid}/outputs": [json_reply(outputs), json_reply({"data": [], "next_cursor": None}), json_reply({**outputs, "next_cursor": None})],
                    f"POST /v1/evals/{eid}/scores": json_reply(fixture("python-eval-scores-response.json")),
                    f"GET /v1/evals/{eid}/failures": json_reply(fixture("python-eval-failures-nonempty.json")),
                    "POST /v1/datasets/sql-hard-cases/records": json_reply({**DATASET, "name": "sql-hard-cases"}),
                    f"GET /v1/evals/{eid}/results": json_reply(fixture("python-eval-results-page.json")),
                    "GET /v1/evals": json_reply({"data": [completed], "next_cursor": None}),
                    f"POST /v1/evals/{eid}/cancel": json_reply({**completed, "status": "cancelled"}),
                }
            )
            plan = await client.evals.plan(models=["test/tiny-qwen3"], dataset="support", rubric=self.rubric(), temperature=0.7)
            self.assertIsInstance(plan, grad.EvalPlan)
            self.assertEqual(sender.sent[-1].json["temperature"], 0.7)
            ev = await client.evals.create(name="support-eval", models=["test/tiny-qwen3"], dataset="support", rubric=self.rubric())
            done = await ev.wait()
            self.assertEqual(done.status, "completed")
            posted = [s for s in sender.sent if s.path.endswith("/scores")]
            self.assertEqual({s["output_id"] for s in posted[0].json["scores"]}, {o["id"] for o in outputs["data"]})
            self.assertIn("overall (95% CI)", done.summary_table())
            failures = await done.failures(model="test/tiny-qwen3", threshold=1.0)
            self.assertEqual(len(failures), 2)
            hard = await failures.to_dataset("sql-hard-cases")
            self.assertEqual(hard.name, "sql-hard-cases")
            self.assertTrue([r async for r in done.results()])
            self.assertTrue([o async for o in client.evals.outputs(eid, model="test/tiny-qwen3")])
            self.assertEqual([e.id async for e in client.evals.list()], [eid])
            self.assertEqual((await done.cancel()).status, "cancelled")
            self.assertIs(await done.refresh(), done)
            self.assertEqual(await client.evals.score_pending(eid, self.rubric()), 0)
            with self.assertRaises(grad.NotAvailableInV0Error):
                await client.evals.from_inspect("x")

        arun(main)

    def test_failed_timeout_and_scores_not_accepted(self) -> None:
        queued = fixture("python-eval-queued.json")
        awaiting = fixture("python-eval-awaiting.json")
        outputs = fixture("python-eval-outputs-page.json")
        eid = queued["id"]

        async def main() -> None:
            client, _, _ = make_async_client({f"GET /v1/evals/{eid}": json_reply({**queued, "status": "failed", "error": "judge down"})})
            with self.assertRaises(grad.EvalFailedError) as ctx:
                await client.evals.wait(eid)
            self.assertEqual(ctx.exception.error, "judge down")
            self.assertEqual((await client.evals.wait(eid, raise_on_failure=False)).status, "failed")
            client, _, _ = make_async_client({f"GET /v1/evals/{eid}": [refused(), json_reply(queued)]}, max_retries=0)
            with self.assertRaises(grad.WaitTimeoutError):
                await client.evals.wait(eid, timeout=2)
            client, _, _ = make_async_client(
                {
                    f"GET /v1/evals/{awaiting['id']}": json_reply(awaiting),
                    f"GET /v1/evals/{awaiting['id']}/outputs": json_reply(outputs),
                    f"POST /v1/evals/{awaiting['id']}/scores": json_reply({}),
                }
            )
            with self.assertRaises(grad.GradAPIError) as actx:
                await client.evals.wait(awaiting["id"], rubric=self.rubric())
            self.assertEqual(actx.exception.code, "scores_not_accepted")
            many = [{"output_id": f"o{i}", "scorer": "short", "score": 1.0} for i in range(1500)]
            client, sender, _ = make_async_client({f"POST /v1/evals/{eid}/scores": json_reply({"accepted": 1})})
            await client.evals.post_scores(eid, many)
            self.assertEqual([len(s.json["scores"]) for s in sender.sent], [1000, 500])

        arun(main)


if __name__ == "__main__":
    unittest.main()
