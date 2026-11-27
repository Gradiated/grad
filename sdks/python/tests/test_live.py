"""Live integration tests against the shared harness stack (tests/harness/stack.ts).

They run the docs quickstart snippets nearly verbatim, with only the base URL, key and
models swapped for the harness and its tiny test models. They skip cleanly when
``server/api/node_modules`` is missing or ``GRAD_SKIP_LIVE=1``; the Cloud torch-worker tests
also needs ``GRAD_TRAINER_PYTHON`` (a Python with torch, transformers and peft).

Run them memory-capped, e.g. ``/root/grad-work/capped.sh env PYTHONPATH=sdks/python
python3 -m unittest discover -s sdks/python/tests -p test_live.py``.
"""

from __future__ import annotations

import base64
import contextlib
import io
import json
import os
import signal
import re
import tempfile
import unittest
import urllib.request
from pathlib import Path
from typing import Any, ClassVar
from unittest import mock

from _stack import Stack, live_skip_reason

import grad
from grad import Grad, Rubric, Scorer, validators
from grad.recipes import DistillRecipe, OffPolicy, OnPolicy, RewardModelRecipe, SFTRecipe

LLM = "test/tiny-qwen3"
TEACHER = "test/tiny-qwen3-teacher"

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

    #: Hard per-test limit: a live test that waits forever (wait() defaults to 24 h) must fail, not hang CI.
    test_timeout_s: ClassVar[int] = int(os.environ.get("GRAD_LIVE_TEST_TIMEOUT_S", "300"))

    def setUp(self) -> None:
        if hasattr(signal, "SIGALRM"):

            def _timeout(_signum: int, _frame: Any) -> None:
                raise TimeoutError(f"{self.id()} exceeded {self.test_timeout_s}s")

            previous = signal.signal(signal.SIGALRM, _timeout)
            signal.alarm(self.test_timeout_s)
            self.addCleanup(signal.signal, signal.SIGALRM, previous)
            self.addCleanup(signal.alarm, 0)
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
        code = blocks[0].replace('SFTRecipe(model="qwen/qwen3-8b")', f'SFTRecipe(model="{LLM}")')
        with contextlib.redirect_stdout(io.StringIO()) as out:
            exec(compile(code, "README.md", "exec"), {"__name__": "readme"})
        self.assertIn("Estimate", out.getvalue())
        self.assertIn("completed sql-helper@", out.getvalue())
        # The continued-training block needs a PEFT artifact (the torch worker): it is
        # exercised by CloudTorchLiveTests.test_continued_training_and_caller_idempotency_key.
        compile(blocks[1], "README.md", "exec")
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

    def test_dataset_score_and_filter(self) -> None:
        # docs: training/trajectories.mdx "Score and filter datasets"
        client = Grad()
        dataset = client.datasets.push("sql-logs", SQL_RECORDS)
        rubric = Rubric(
            [
                validators.Regex(r"^SELECT"),
                Scorer("short", fn=lambda t: 1.0 if len(t.text) < 70 else 0.0),
            ]
        )
        scored = dataset.score(rubric).wait(timeout=180)
        self.assertEqual(scored.version, dataset.version + 1)
        self.assertEqual(scored.record_count, len(SQL_RECORDS))
        scores = [r.get("scores") for r in scored.records()]
        self.assertEqual([s["short"] for s in scores], [1.0, 0.0])
        self.assertTrue(all(len(s) == 2 for s in scores))
        passing = scored.filter(scores={"short": ">=0.8"})
        self.assertEqual(passing.count(), 1)
        self.assertEqual(scored.filter(scores={"short": ">=0.8"}).id, passing.id)
        long_prompts = scored.filter(lambda t: "revenue" in t.input.messages[0]["content"])
        self.assertEqual([r["id"] for r in long_prompts.records()], [list(scored.records())[1]["id"]])
        # Everything is scored now: a second pass skips every record and adds no version.
        again = client.datasets.score(scored, rubric).wait(timeout=60)
        self.assertEqual(again.version, scored.version)

    def test_benchmark_import_is_pinned(self) -> None:
        # docs: training/evaluations.mdx "Check for regressions with standard benchmarks" (queued only:
        # the harness worker has no network, so the import itself is not awaited)
        client = Grad()
        gsm8k = client.datasets.from_benchmark("gsm8k", limit=5, wait=False)
        self.assertEqual(gsm8k.name, "gsm8k-5")
        job = next(j for j in client.imports.list() if j.dataset == "gsm8k-5")
        self.assertEqual(job.source["benchmark"], "gsm8k")
        self.assertRegex(job.source["revision"], r"^[0-9a-f]{40}$")
        self.assertEqual((job.source["repo"], job.source["split"], job.source["limit"]), ("openai/gsm8k", "test", 5))

    def test_checkpoint_evals_and_tracker_loggers(self) -> None:
        # docs: training/recipes.mdx "Evaluate during training" and "Experiment tracking".
        # The real server resolves each logger's workspace secret on claim; the real worker
        # streams the run's metrics to a fake MLflow and a fake W&B over their HTTP APIs.
        import http.server
        import threading

        seen: list[tuple[str, str, Any, str | None]] = []  # (tracker, path, body, Authorization)

        def tracker(name: str, reply: Any) -> str:
            class Handler(http.server.BaseHTTPRequestHandler):
                def log_message(self, *_a: Any) -> None:
                    return

                def _reply(self) -> None:
                    n = int(self.headers.get("Content-Length") or 0)
                    body = json.loads(self.rfile.read(n)) if n else None
                    seen.append((name, self.path, body, self.headers.get("Authorization")))
                    payload, status = reply(self.path, body)
                    raw = json.dumps(payload).encode()
                    self.send_response(status)
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)

                do_GET = do_POST = _reply

            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            self.addCleanup(server.server_close)
            self.addCleanup(server.shutdown)
            return f"127.0.0.1:{server.server_address[1]}"

        def mlflow(path: str, _body: Any) -> tuple[Any, int]:
            if "get-by-name" in path:
                return {"error_code": "RESOURCE_DOES_NOT_EXIST"}, 404
            if path.endswith("experiments/create"):
                return {"experiment_id": "1"}, 200
            if path.endswith("runs/create"):
                return {"run": {"info": {"run_id": "r1"}}}, 200
            return {}, 200

        def wandb(path: str, body: Any) -> tuple[Any, int]:
            if path == "/graphql" and "viewer" in body["query"]:
                return {"data": {"viewer": {"entity": "team-ml"}}}, 200
            if path == "/graphql":
                return {"data": {"upsertBucket": {"bucket": {"id": "b1", "name": body["variables"]["name"]}}}}, 200
            return {}, 200

        mlflow_host, wandb_host = tracker("mlflow", mlflow), tracker("wandb", wandb)
        client = Grad()
        client.secrets.set("wandb-key", "wandb-live-0123456789", allowed_hosts=[wandb_host])
        client.secrets.set("mlflow-token", "mlflow-live-0123456789", allowed_hosts=[mlflow_host])
        dataset = client.datasets.push("sql-sft-tracked", SQL_RECORDS * 10)
        holdout = client.datasets.push("sql-holdout-tracked", SQL_RECORDS)
        recipe = SFTRecipe(
            model=LLM,
            evals=[grad.EvalSpec(holdout, rubric=validators.Regex("SELECT"))],
            loggers=[
                grad.loggers.MLflow(f"http://{mlflow_host}", experiment="sql", secret=client.secrets.get("mlflow-token")),
                grad.loggers.WandB("sql-helper", secret=client.secrets.get("wandb-key"), host=f"http://{wandb_host}", run_name="tracked"),
            ],
        )
        run = client.runs.create(dataset=dataset, name="sql-tracked", recipe=recipe).wait(timeout=240)
        self.assertEqual(run.status, "completed", run.error)
        self.assertEqual(run.resolved_config["checkpoint_evals"][0]["dataset"], "sql-holdout-tracked")
        # The secret names are in the run's config; their values never are.
        self.assertEqual([lg.get("secret") for lg in run.resolved_config["loggers"]], ["mlflow-token", "wandb-key"])
        self.assertNotIn("live-0123456789", json.dumps(run.resolved_config))
        # The reference worker's checkpoints can't be served, so each checkpoint eval is recorded as failed.
        self.assertTrue(run.checkpoint_evals)
        self.assertTrue(all(e["status"] == "failed" and "can't serve" in e["error"] for e in run.checkpoint_evals))

        mlflow_calls = [(p, b, a) for t, p, b, a in seen if t == "mlflow"]
        self.assertEqual({a for _, _, a in mlflow_calls}, {"Bearer mlflow-live-0123456789"})
        self.assertIn(("/api/2.0/mlflow/experiments/create", {"name": "sql"}), [(p, b) for p, b, _ in mlflow_calls])
        steps = [m["step"] for p, b, _ in mlflow_calls if p.endswith("log-batch") for m in (b or {}).get("metrics", [])]
        self.assertTrue(steps, seen)
        self.assertEqual(next(b for p, b, _ in mlflow_calls if p.endswith("runs/update"))["status"], "FINISHED")

        wandb_calls = [(p, b, a) for t, p, b, a in seen if t == "wandb"]
        basic = "Basic " + base64.b64encode(b"api:wandb-live-0123456789").decode()
        self.assertEqual({a for _, _, a in wandb_calls}, {basic})
        upsert = next(b for p, b, _ in wandb_calls if p == "/graphql" and "upsertBucket" in b["query"])
        self.assertEqual((upsert["variables"]["project"], upsert["variables"]["entity"], upsert["variables"]["displayName"]), ("sql-helper", "team-ml", "tracked"))
        stream = [b for p, b, _ in wandb_calls if p.startswith(f"/files/team-ml/sql-helper/{upsert['variables']['name']}/file_stream")]
        rows = [json.loads(line) for b in stream for line in (b.get("files") or {}).get("wandb-history.jsonl", {}).get("content", [])]
        self.assertEqual(sorted(r["_step"] for r in rows), sorted(set(steps)))
        self.assertTrue(all("loss" in r for r in rows), rows)
        self.assertEqual(stream[-1], {"complete": True, "exitcode": 0})

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

    def test_post_retry_replays_after_a_dropped_response(self) -> None:
        # The fault proxy lets the server commit the first POST, then answers 503; the
        # retry carries the same Idempotency-Key, so the server replays the 201 instead
        # of failing with dataset_exists.
        fault_url = str(self.stack.info["fault_url"])
        with Grad(base_url=fault_url) as flaky:
            created = flaky.datasets.create("idempotent-create")
        self.assertEqual(created.name, "idempotent-create")
        with urllib.request.urlopen(f"{fault_url}/__fault/stats") as resp:
            stats = json.loads(resp.read())
        self.assertGreaterEqual(stats["dropped"], 1)
        self.assertGreaterEqual(stats["replayed"], 1)
        with self.assertRaises(grad.ConflictError):
            Grad().datasets.create("idempotent-create")  # a new logical call gets a new key


class CloudReferenceLiveTests(_LiveCase):
    """Cloud mode (fake Cloud API) with the reference worker: auth and billing-backed runs."""

    cloud = True
    worker = "reference"

    def test_cloud_run_and_deploy_served_by_cloud(self) -> None:
        client = Grad()
        dataset = client.datasets.push("sql-quickstart", SQL_RECORDS)
        run = client.runs.create(dataset=dataset, name="sql-helper", recipe=SFTRecipe(model=LLM), max_cost_usd=5).wait(timeout=180)
        self.assertEqual(run.status, "completed")
        self.assertGreaterEqual(run.cost_usd or 0.0, 0.0)
        # Deploys go to Gradiated Cloud's product API; grad-server itself answers 501.
        with self.assertRaises(grad.DeployUnavailableError) as ctx:
            run.deploy()
        self.assertEqual(ctx.exception.status, 501)
        with self.assertRaises(grad.AuthenticationError):
            Grad(api_key="grad_not_a_cloud_token").runs.list().to_list()


class CloudTorchLiveTests(_LiveCase):
    """Cloud mode (fake Cloud API) with the torch worker: continued training and caller idempotency keys."""

    cloud = True
    worker = "torch"

    def test_continued_training_and_caller_idempotency_key(self) -> None:
        # docs: recipes/dpo.mdx "start from an SFT artifact"; api-reference Idempotency-Key
        client = Grad()
        ds = client.datasets.push("sql-sft", SQL_RECORDS)
        sft = client.runs.create(dataset=ds, name="sql-helper", recipe=SFTRecipe(model=LLM), idempotency_key="live-sft-1").wait(timeout=600)
        self.assertEqual(sft.status, "completed")
        again = client.runs.create(dataset=ds, name="sql-helper", recipe=SFTRecipe(model=LLM), idempotency_key="live-sft-1")
        self.assertEqual(again.id, sft.id, "the same key replays the first create instead of starting a run")
        plan = client.runs.plan(dataset=ds, name="sql-helper-2", recipe=SFTRecipe(model=sft.artifact))
        self.assertEqual(plan.resolved_config["base_artifact"]["id"], sft.artifact.id)

    def test_distill_and_reward_model(self) -> None:
        # docs: recipes/distillation.mdx and recipes/reward-models.mdx (tiny student/teacher)
        client = Grad()
        prompts = client.datasets.push("support-prompts", [{"messages": [{"role": "user", "content": f"How do I rotate API key {i}?"}]} for i in range(12)])
        recipe = DistillRecipe(model=LLM, teacher=TEACHER, rollout=OnPolicy(max_new_tokens=4), batch_size=4, thinking="off")
        plan = client.runs.plan(dataset=prompts, name="support-distilled", recipe=recipe)
        assert plan.teacher is not None
        self.assertEqual(plan.teacher["model"], TEACHER)
        self.assertGreater(plan.estimated_cost_usd, plan.teacher["estimated_cost_usd"])
        run = client.runs.create(dataset=prompts, name="support-distilled", recipe=recipe).wait(timeout=600)
        self.assertEqual((run.status, run.artifact.format), ("completed", "peft_lora"))
        assert run.eval_report is not None
        self.assertEqual(run.eval_report.metric_name, "eval_kl")
        self.assertIsNotNone(run.eval_report.eval_kl)

        # Off-policy: the teacher answers through the inference endpoint first (a labeling eval).
        off = DistillRecipe(model=LLM, teacher=TEACHER, rollout=OffPolicy(max_new_tokens=16), batch_size=4)
        self.assertIsNotNone(client.runs.plan(dataset=prompts, name="support-off", recipe=off).labeling)
        off_run = client.runs.create(dataset=prompts, name="support-off", recipe=off).wait(timeout=600)
        self.assertEqual(off_run.status, "completed")
        self.assertIsNotNone(off_run.resolved_config["label_eval_id"])

        pairs = client.datasets.push("sql-preferences", [{"prompt": f"Count users {i}", "chosen": "SELECT count(*) FROM users;", "rejected": "no idea"} for i in range(16)])
        verifier = client.runs.create(dataset=pairs, name="sql-verifier", recipe=RewardModelRecipe(model=LLM, batch_size=4)).wait(timeout=600)
        self.assertEqual((verifier.status, verifier.artifact.format), ("completed", "reward_bundle"))
        assert verifier.eval_report is not None
        self.assertEqual(verifier.eval_report.metric_name, "preference_accuracy")
        self.assertIsNotNone(verifier.eval_report.preference_accuracy)
        bundle = verifier.artifact.download(self.tmp / "sql-verifier")
        self.assertTrue((bundle / "reward_config.json").is_file())
        self.assertTrue((bundle / "reward_head.safetensors").is_file())


if __name__ == "__main__":
    unittest.main()
