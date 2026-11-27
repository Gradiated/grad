"""Live integration tests against the shared harness stack (tests/harness/stack.ts).

They run the docs quickstart snippets nearly verbatim, with only the base URL, key and
models swapped for the harness and its tiny test models. They skip cleanly when
``server/api/node_modules`` is missing or ``GRAD_SKIP_LIVE=1``; the Cloud deploy flow
also needs ``GRAD_TRAINER_PYTHON`` (a Python with torch, transformers and peft).

Run them memory-capped, e.g. ``/root/grad-work/capped.sh env PYTHONPATH=sdks/python
python3 -m unittest discover -s sdks/python/tests -p test_live.py``.
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from typing import Any, ClassVar
from unittest import mock

from _stack import Stack, live_skip_reason

import grad
from grad import AsyncGrad, Grad, Rubric, Scorer, validators
from grad.recipes import RouterRecipe, SFTRecipe

LLM = "test/tiny-qwen3"

SQL_RECORDS = [
    {
        "messages": [
            {"role": "user", "content": "Count active users from yesterday."},
            {"role": "assistant", "content": "SELECT count(*) FROM users WHERE active_at >= current_date - 1;"},
        ]
    },
    {
        "messages": [
            {"role": "user", "content": "Total revenue by plan this month."},
            {"role": "assistant", "content": "SELECT plan, sum(amount_usd) FROM invoices WHERE created_at >= date_trunc('month', current_date) GROUP BY plan;"},
        ]
    },
]


class _LiveCase(unittest.TestCase):
    """Starts one stack per test class and points ``GRADIATED_*`` at it."""

    cloud: ClassVar[bool] = False
    worker: ClassVar[str] = "reference"
    stack: ClassVar[Stack]
    env: ClassVar[Any]

    @classmethod
    def setUpClass(cls) -> None:
        reason = live_skip_reason(cls.worker)
        if reason:
            raise unittest.SkipTest(reason)
        cls.stack = Stack(cloud=cls.cloud, worker=cls.worker)
        cls.env = mock.patch.dict(os.environ, {"GRADIATED_API_KEY": cls.stack.api_key, "GRADIATED_BASE_URL": cls.stack.base_url})
        cls.env.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.env.stop()
        cls.stack.close()

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="grad-py-live-", dir=os.environ.get("TMPDIR")))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))


class SelfHostedLiveTests(_LiveCase):
    """Self-hosted mode (DEPLOY_MODE=disabled) with the reference trainer worker."""

    def test_quickstart(self) -> None:
        # docs: training/index.mdx quickstart (model swapped for the tiny test model)
        client = Grad()  # reads GRADIATED_API_KEY
        dataset = client.datasets.push("sql-quickstart", SQL_RECORDS)
        recipe = SFTRecipe(model=LLM)

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            print(client.runs.plan(dataset=dataset, name="sql-helper", recipe=recipe))
        readout = out.getvalue()
        self.assertIn("sql-quickstart", readout)
        self.assertIn("AdamW", readout)
        self.assertIn("Estimate", readout)

        metrics: list[grad.MetricPoint] = []
        run = client.runs.create(dataset=dataset, name="sql-helper", recipe=recipe, max_cost_usd=5).wait(timeout=180, on_metric=metrics.append)
        self.assertEqual(run.status, "completed")
        self.assertTrue(metrics, "on_metric saw the streamed metrics")
        self.assertTrue(list(run.metrics()))
        self.assertTrue(run.checkpoints())
        # Self-hosted serving is disabled: deploy fails with the documented, actionable error.
        with self.assertRaises(grad.DeployUnavailableError) as ctx:
            run.deploy()
        self.assertEqual(ctx.exception.status, 501)
        self.assertIn("vLLM", str(ctx.exception))

        art = run.artifact
        self.assertIsInstance(art, grad.Artifact)
        self.assertEqual(client.artifacts.get("sql-helper@latest").ref, art.ref)
        bundle = art.download(self.tmp / "sql-helper.grad.tar.gz", format="bundle")
        self.assertGreater(bundle.stat().st_size, 0)

    def test_readme_snippets_run(self) -> None:
        # The SDK README's Python blocks, run as written with only the model swapped.
        readme = (Path(__file__).resolve().parents[1] / "README.md").read_text(encoding="utf-8")
        blocks = re.findall(r"```python\n(.*?)```", readme, flags=re.S)
        self.assertEqual(len(blocks), 2)
        cwd = os.getcwd()
        os.chdir(self.tmp)
        self.addCleanup(os.chdir, cwd)
        outputs = []
        for block in blocks:
            code = block.replace('SFTRecipe(model="qwen/qwen3-8b")', f'SFTRecipe(model="{LLM}")').replace("SFTRecipe()", f'SFTRecipe(model="{LLM}")')
            with contextlib.redirect_stdout(io.StringIO()) as out:
                exec(compile(code, "README.md", "exec"), {"__name__": "readme"})
            outputs.append(out.getvalue())
        self.assertIn("Estimate", outputs[0])
        self.assertIn("completed sql-helper@", outputs[0])
        self.assertRegex(outputs[1], r"^1 ")
        self.assertTrue((self.tmp / "sql-helper-bundle.grad.tar.gz").is_file())

    def test_import_file_render_and_records(self) -> None:
        # docs: training/index.mdx "import your traces", trajectories.mdx render
        client = Grad()
        path = self.tmp / "support_traces.jsonl"
        path.write_text("".join(json.dumps(r) + "\n" for r in SQL_RECORDS * 3))
        dataset = client.datasets.create("support-prod")
        job = dataset.import_file(path).wait(timeout=120)
        self.assertEqual(job.status, "completed")
        dataset = client.datasets.get("support-prod")
        self.assertEqual(dataset.count(), 6)
        self.assertEqual(len(list(client.datasets.records("support-prod", limit=2))), 6, "records walk every page")
        preview = dataset.render(model=LLM)
        self.assertIn("qwen3", str(preview))

    def test_eval_with_local_python_scorer(self) -> None:
        # docs: training/evaluations.mdx, with a local Python scorer (awaiting_scores flow)
        client = Grad()
        eval_ds = client.datasets.push("sql-eval-holdout", SQL_RECORDS)
        rubric = Rubric(
            [
                validators.NonEmpty(),
                Scorer("mentions_select", weight=0.5, fn=lambda t: 1.0 if "select" in t.text.lower() else 0.0),
            ]
        )
        plan = client.evals.plan(name="sql-baseline", models=[LLM], dataset=eval_ds, rubric=rubric, temperature=0.7)
        self.assertIn("mentions_select (run in this process)", str(plan))
        ev = client.evals.create(name="sql-baseline", models=[LLM], dataset=eval_ds, rubric=rubric, temperature=0.7).wait(timeout=180)
        self.assertEqual(ev.status, "completed")
        table = ev.summary_table()
        self.assertIn(LLM, table)
        self.assertIn("overall (95% CI)", table)
        # The fake model echoes the prompt, so "mentions_select" fails everywhere: mine the failures.
        failures = ev.failures(model=LLM, threshold=1.0)
        self.assertEqual(len(failures), len(SQL_RECORDS))
        hard = failures.to_dataset("sql-hard-cases")
        self.assertEqual(client.datasets.get(hard.name).record_count, len(SQL_RECORDS))

    def test_errors_keys_and_pagination(self) -> None:
        client = Grad()
        with self.assertRaises(grad.NotFoundError) as ctx:
            client.runs.get("run_does_not_exist")
        self.assertEqual(ctx.exception.status, 404)
        self.assertTrue(ctx.exception.request_id)
        with self.assertRaises(grad.AuthenticationError):
            Grad(api_key="grad_wrong_key").datasets.list().to_list()
        with self.assertRaises(grad.ValidationError) as vctx:
            client.datasets.push("bad-records", [{"messages": [{"role": "nobody", "content": "x"}]}])
        self.assertEqual(vctx.exception.status, 422)

        for i in range(3):
            client.datasets.push(f"page-{i}", SQL_RECORDS[:1])
        page = client.datasets.list(limit=1)
        self.assertEqual(len(page.data), 1)
        names = [d.name for d in page]
        self.assertTrue({"page-0", "page-1", "page-2"} <= set(names))
        self.assertEqual(len(names), len(set(names)), "no page repeats")

        created = client.keys.create(name="ci", scopes=["datasets:read"])
        self.assertTrue(created.secret.startswith("grad_"))
        self.assertIn(created.key.id, [k.id for k in client.keys.list()])
        scoped = Grad(api_key=created.secret)
        self.assertTrue(list(scoped.datasets.list()))
        with self.assertRaises(grad.PermissionDeniedError):
            scoped.datasets.push("nope", SQL_RECORDS)
        client.keys.revoke(created.key.id)
        with self.assertRaises(grad.AuthenticationError):
            scoped.datasets.list().to_list()

    def test_async_parity(self) -> None:
        async def main() -> None:
            async with AsyncGrad() as client:
                ds = await client.datasets.push("async-sql", SQL_RECORDS)
                self.assertEqual(ds.record_count, 2)
                names = [d.name async for d in client.datasets.list(limit=1)]
                self.assertIn("async-sql", names)
                plan = await client.runs.plan(dataset=ds, name="async-sft", recipe=SFTRecipe(model=LLM))
                self.assertIn("async-sql", str(plan))
                run = await (await client.runs.create(dataset=ds, name="async-sft", recipe=SFTRecipe(model=LLM), max_cost_usd=5)).wait(timeout=180)
                self.assertEqual(run.status, "completed")
                self.assertTrue([m async for m in client.runs.metrics(run.id)])
                with self.assertRaises(grad.DeployUnavailableError):
                    await run.deploy()

        asyncio.run(main())

    def test_serve_environment(self) -> None:
        # docs: training/environments.mdx, with a user-supplied policy (no model fabricated)
        from grad.environments import Action, Environment, Observation, Task, serve_environment

        class Echo(Environment[dict]):
            def setup(self, task: Task, rollout_id: str) -> dict:
                return {}

            def step(self, handle: dict, action: Action) -> Observation:
                return Observation(done=True)

            def evaluate(self, handle: dict, trajectory: Any) -> dict[str, float]:
                return {"answered": 1.0 if trajectory.text else 0.0}

        def policy(messages: list[dict[str, Any]], **_: Any) -> str:
            return f"you said: {messages[-1]['content']}"

        client = Grad()
        task = client.environments.dispatch("support-app", {"prompt": "hello"}, model_id=LLM, timeout_s=60)
        served = serve_environment(Echo, name="support-app", policy=policy, client=client, max_tasks=1, handle_signals=False, wait_ms=500)
        self.assertEqual(served, 1)
        result = client.environments.get_task(task["id"])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["result"]["score"], 1.0)


class CloudReferenceLiveTests(_LiveCase):
    """Cloud mode (fake Cloud API) with the reference worker: auth, billing-backed runs and feedback."""

    cloud = True
    worker = "reference"

    def test_cloud_run_feedback_and_undeployable_reference_artifact(self) -> None:
        client = Grad()
        dataset = client.datasets.push("sql-quickstart", SQL_RECORDS)
        run = client.runs.create(dataset=dataset, name="sql-helper", recipe=SFTRecipe(model=LLM), max_cost_usd=5).wait(timeout=180)
        self.assertEqual(run.status, "completed")
        self.assertGreaterEqual(run.cost_usd or 0.0, 0.0)
        # Reference-backend artifacts are test doubles and can never be deployed.
        with self.assertRaises(grad.GradAPIError) as ctx:
            run.deploy()
        self.assertIn(ctx.exception.status, {409, 422})
        # docs: training/index.mdx feedback snippet, keyed by session (no inference id here)
        res = client.feedback.record(session_id="s-1", idempotency_key="query-s-1", score=1.0)
        self.assertEqual(res.accepted, 1)
        self.assertEqual(client.feedback.record(session_id="s-1", idempotency_key="query-s-1", score=1.0).deduplicated, 1)
        with self.assertRaises(grad.AuthenticationError):
            Grad(api_key="grad_not_a_cloud_token").runs.list().to_list()


class CloudTorchLiveTests(_LiveCase):
    """Cloud mode (fake Cloud API) with the torch worker: deploy -> route -> feedback -> rollback."""

    cloud = True
    worker = "torch"

    def test_router_deploy_route_feedback_rollback(self) -> None:
        client = Grad()
        traces = []
        for i in range(60):
            hard = i % 2 == 0
            prompt = f"{'hard SQL join query' if hard else 'say hello'} {i}"
            traces.append({"session_id": f"s{i}", "messages": [{"role": "user", "content": prompt}], "scores": {"cheap/m": 0.0 if hard else 1.0, "strong/m": 1.0}})
        path = self.tmp / "support_traces.jsonl"
        path.write_text("".join(json.dumps(t) + "\n" for t in traces))

        # docs: training/index.mdx router quickstart (backbone and candidates swapped for test models)
        dataset = client.datasets.create("support-prod")
        dataset.import_file(path).wait(timeout=180)
        recipe = RouterRecipe(model=LLM, models=["cheap/m", "strong/m"], batch_size=8)
        self.assertIn("router", str(client.runs.plan(dataset=dataset, name="support-router", recipe=recipe)))
        run = client.runs.create(dataset=dataset, name="support-router", recipe=recipe).wait(timeout=600)
        self.assertEqual(run.status, "completed")

        adapter = run.artifact.download(self.tmp / "support-router")
        self.assertTrue((adapter / "adapter_config.json").is_file())
        self.assertTrue((adapter / "adapter_model.safetensors").is_file())

        dep = run.deploy()
        first = dep.active_artifact_id
        messages = [{"role": "user", "content": "Where is invoice #9941?"}]
        # docs: training/index.mdx "route and record feedback"
        decision = client.route("support-router", messages=messages)
        # The fake Cloud API picks from manifest.router_config.candidates and otherwise falls back to
        # the deployment's model id (the trainer does not put router_config in the manifest yet).
        self.assertIn(decision.model, {"cheap/m", "strong/m", dep.model_id})
        self.assertTrue(decision.inference_id)
        result = decision.record_feedback(score=1.0, metrics={"latency_ms": 12.0, "output_tokens": 3})
        self.assertEqual(result.accepted, 1)
        again = decision.record_feedback(score=1.0, metrics={"latency_ms": 12.0, "output_tokens": 3})
        self.assertEqual((again.accepted, again.deduplicated), (0, 1), "same outcome is deduplicated, never double-counted")

        # A second version (a promoted checkpoint), then roll back to the first.
        ckpt = run.checkpoints()[0]
        promoted = ckpt.promote(name="support-router")
        dep2 = promoted.deploy(name="support-router")
        self.assertNotEqual(dep2.active_artifact_id, first)
        rolled = dep2.rollback()
        self.assertEqual(rolled.active_artifact_id, first)
        status = rolled.status_summary()
        self.assertGreaterEqual(status.feedback_count, 1)


if __name__ == "__main__":
    unittest.main()
