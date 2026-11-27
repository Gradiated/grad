"""Shared parity fixture (tests/fixtures/wire/sdk-parity.json), replayed by every SDK and the CLI.

Each case builds the documented call idiomatically and must send exactly the fixture's
request; the typed response fields must read back the fixture's values.
"""

from __future__ import annotations

import datetime
import unittest
from collections.abc import Callable
from typing import Any

from _fakes import fixture, json_reply, make_client

import grad
from grad import Context, Judge, validators
from grad.recipes import (
    CartridgeRecipe,
    DecisionModelRecipe,
    DistillRecipe,
    DPORecipe,
    EmbeddingRecipe,
    OffPolicy,
    OnPolicy,
    RewardModelRecipe,
    RouterRecipe,
    SFTRecipe,
)
from grad.specs import adapters, losses, optim, pooling, splits

PARITY = fixture("sdk-parity.json")
JUDGE = Judge(model="judge/m", prompt="Is the answer correct?", name="quality")


def calls(client: grad.Grad) -> dict[str, Callable[[], Any]]:
    artifact = grad.Artifact.from_api({"id": "art_1", "name": "support-sft", "version": "2026-11-27-1"}, client)
    secret = grad.SecretRef.from_api({"name": "langfuse-prod"}, client)
    source = grad.Source.from_api(PARITY["responses"]["source"], client)
    sft = SFTRecipe(
        model="test/tiny-qwen3",
        adapter=adapters.LoRA(rank=16, alpha=16),
        merge_on_export=True,
        lr=0.0002,
        lr_scale=0.5,
        optimizer=optim.AdamW(betas=(0.8, 0.9), weight_decay=0.1, grad_clip=0.5),
        batch_size=4,
        epochs=2,
        schedule="cosine",
        warmup=0.05,
        train_on="all_assistant",
        thinking="off",
        preserve_thinking=True,
        reduction="per_token",
        select="last",
        checkpoint_ttl_days=7,
        eval_every=2,
        split=splits.BySession(eval_fraction=0.2, seed=7),
    )
    router = RouterRecipe(
        model="test/tiny-qwen3",
        models=["cheap/m", "strong/m"],
        rubric=JUDGE,
        max_quality_drop=0.05,
        pricing={"cheap/m": 0.001, "strong/m": 0.01},
        fallback="strong/m",
    )
    cartridge = CartridgeRecipe(
        model="test/tiny-qwen3",
        context=Context.from_text("The capital of Testland is Tinytown."),
        num_tokens=16,
        teacher="test/tiny-qwen3-teacher",
        loss=losses.TopKKLDistill(top_k=7),
        max_new_tokens=5,
    )
    distill = DistillRecipe(
        model="test/tiny-qwen3",
        teacher="test/tiny-qwen3-teacher",
        rollout=OnPolicy(max_new_tokens=64),
        loss=losses.TopKKLDistill(top_k=16),
        context=Context.from_text("Refunds take 30 days."),
    )
    off_policy = DistillRecipe(teacher=artifact, rollout=OffPolicy(max_new_tokens=128), loss=losses.CrossEntropy())
    reward = RewardModelRecipe(model="test/tiny-qwen3", adapter=adapters.FrozenHead(), rubric="resolved")
    return {
        "plan_sft_every_param": lambda: client.runs.plan("support", name="sft-params", recipe=sft, max_cost_usd=5),
        "create_dpo_from_artifact": lambda: client.runs.create("prefs", name="dpo-continued", recipe=DPORecipe(model=artifact, beta=0.3), idempotency_key="parity-run-key"),
        "plan_router_judge_rubric": lambda: client.runs.plan("support-logs", name="router-params", recipe=router),
        "plan_cartridge": lambda: client.runs.plan("docs", name="cartridge-params", recipe=cartridge),
        "plan_embedding": lambda: client.runs.plan("pairs", name="embedding-params", recipe=EmbeddingRecipe(model="test/tiny-bert", pool=pooling.CLS(), temp=0.1)),
        "plan_decision": lambda: client.runs.plan("decisions", name="decision", recipe=DecisionModelRecipe()),
        "plan_distill": lambda: client.runs.plan("support-prompts", name="distill-params", recipe=distill),
        "plan_distill_off_policy": lambda: client.runs.plan("support-prompts", name="distill-off", recipe=off_policy),
        "plan_reward": lambda: client.runs.plan("sql-preferences", name="sql-verifier", recipe=reward),
        "create_eval": lambda: client.evals.create(
            name="parity-eval",
            models=["test/tiny-qwen3", artifact],
            dataset="support",
            rubric=[JUDGE, validators.NonEmpty()],
            baseline="test/tiny-qwen3",
            samples=3,
            temperature=0.7,
            max_tokens=256,
            limit=10,
            pass_threshold=0.5,
            dataset_version=1,
            idempotency_key="parity-eval-key",
        ),
        "score_dataset": lambda: client.datasets.score(
            "support-logs", JUDGE, version=1, name="support-logs-quality", limit=100, idempotency_key="parity-score-key"
        ),
        "filter_dataset_fields": lambda: client.datasets.filter(
            "support-logs", scores={"quality": ">=0.8"}, metadata={"env": "prod"}, created_after=datetime.date(2026, 11, 1), version=2, name="support-good"
        ),
        "plan_sft_checkpoint_evals_loggers": lambda: client.runs.plan(
            "support",
            name="sft-tracked",
            recipe=SFTRecipe(
                model="test/tiny-qwen3",
                evals=["gsm8k-200", grad.EvalSpec("support-holdout", rubric=grad.Scorer("starts_select", fn=validators.Regex("^SELECT")), limit=50, name="sql")],
                loggers=[grad.loggers.WandB("support", secret="wandb-key"), grad.loggers.MLflow("https://mlflow.internal", experiment="sft")],
            ),
        ),
        "import_benchmark": lambda: client.datasets.from_benchmark("gsm8k", limit=200, name="gsm8k-test-200", wait=False),
        "filter_dataset_ids": lambda: client.datasets.filter("support-logs", ids=["rec_a", "rec_c"]),
        "deploy": lambda: client.deploy(artifact, name="support", fallback="test/tiny-qwen3", explore_rate=0.1, idempotency_key="parity-deploy-key"),
        "set_secret": lambda: client.secrets.set("langfuse-prod", "pk-lf-1:sk-lf-2"),
        "set_secret_hosts": lambda: client.secrets.set(
            "langfuse-self", "pk-lf-1:sk-lf-2", allowed_hosts=["langfuse.internal:3000"]
        ),
        "add_source": lambda: client.sources.create(
            "support-prod",
            grad.sources.Langfuse(host="https://cloud.langfuse.com", secret=secret),
            schedule="*/15 * * * *",
            idempotency_key="parity-source-key",
        ),
        "add_source_gradiated": lambda: client.sources.create(
            "support-prod", grad.sources.Gradiated(models=("acme/support",)), schedule="0 * * * *"
        ),
        "sync_source_full": lambda: source.sync(full=True),
        "list_usage": lambda: client.usage.list(limit=10),
        "list_run_events": lambda: list(client.runs.events(PARITY["responses"]["run_events"]["run_id"])),
    }


class ParityTests(unittest.TestCase):
    def test_requests_match_the_shared_fixture(self) -> None:
        client, sender, _ = make_client(handler=lambda _sent: json_reply({}))
        table = calls(client)
        self.assertEqual(sorted(table), sorted(c["case"] for c in PARITY["requests"]))
        for case in PARITY["requests"]:
            with self.subTest(case=case["case"]):
                table[case["case"]]()
                # The last request to the case's endpoint (a helper may read the result back).
                sent = next(s for s in reversed(sender.sent) if (s.method, s.path) == (case["method"], case["path"]))
                self.assertEqual((sent.method, sent.path), (case["method"], case["path"]))
                self.assertEqual(sent.json, case["body"])
                key = sent.header("Idempotency-Key")
                if case["method"] == "GET":
                    self.assertEqual({k: v[0] for k, v in sent.query.items()}, case["query"])
                    self.assertIsNone(key)
                elif case["idempotency_key"] is None:
                    self.assertRegex(key or "", r"^[0-9a-f-]{36}$")
                else:
                    self.assertEqual(key, case["idempotency_key"])

    def test_typed_responses(self) -> None:
        responses, want = PARITY["responses"], PARITY["expect"]
        run = grad.Run.from_api(responses["run"])
        ev = grad.Eval.from_api(responses["eval"])
        plan = grad.EvalPlan.from_api(responses["eval_plan"])
        scoring = grad.Eval.from_api(responses["scoring"])
        source = grad.Source.from_api(responses["source"])
        secret = grad.SecretRef.from_api(responses["secret"])
        usage = grad.UsageRecord.from_api(responses["usage_page"]["data"][0])
        events: list[Any] = [grad._models.run_event_from_api(e) for e in responses["run_events"]["data"]]
        assert run.last_interruption is not None
        assert source.last_sync is not None
        assert run.eval_report is not None and run.eval_report.pareto_summary is not None and run.latest_metric is not None
        got = {
            "run.eval_report.metric_name": run.eval_report.metric_name,
            "run.eval_report.selected_step": run.eval_report.selected_step,
            "run.eval_report.eval_loss": run.eval_report.eval_loss,
            "run.eval_report.fallback_model": run.eval_report.fallback_model,
            "run.eval_report.pareto_summary.quality_drop": run.eval_report.pareto_summary.quality_drop,
            "run.eval_report.pareto_summary.quality_drop_ci95": run.eval_report.pareto_summary.quality_drop_ci95,
            "run.latest_metric.eval_metrics.routed_quality": (run.latest_metric.eval_metrics or {})["routed_quality"],
            "eval.total_cost_usd": ev.total_cost_usd,
            "eval.summary[0].cost_per_1k_tasks_usd": ev.summary[0].cost_per_1k_tasks_usd,
            "eval_plan.estimated_cost_usd": plan.estimated_cost_usd,
            "scoring.mode": scoring.mode,
            "scoring.scored_dataset_version": scoring.scored_dataset_version,
            "source.id": source.id,
            "source.provider.kind": source.provider.kind,
            "source.provider.secret": source.provider.secret,
            "source.schedule": source.schedule,
            "source.last_sync.status": source.last_sync.status,
            "source.last_sync.dataset_version": source.last_sync.dataset_version,
            "source.status": source.status,
            "source.consecutive_failures": source.consecutive_failures,
            "source.last_error": source.last_error,
            "secret.name": secret.name,
            "secret.allowed_hosts[0]": secret.allowed_hosts[0],
            "usage[0].kind": usage.kind,
            "usage[0].tokens_through": usage.tokens_through,
            "usage[0].cost_usd": usage.cost_usd,
            "run.phase": run.phase,
            "run.last_interruption.reason": run.last_interruption.reason,
            "run.last_interruption.resume_step": run.last_interruption.resume_step,
            "run_events.data[2].phase": events[2].phase,
            "run_events.data[2].workers_online": events[2].workers_online,
            "run_events.data[4].gpu.name": events[4].gpu["name"],
            "run_events.data[7].metric.step": events[7].metric.step,
            "run_events.data[11].checkpoint_id": events[11].checkpoint_id,
            "run_events.data[12].event": events[12].event,
            "run_events.data[12].reason": events[12].reason,
            "run_events.data[14].resume_step": events[14].resume_step,
            "run_events.data[24].status": events[24].status,
            "run_events.data[24].run.last_interruption.reason": events[24].run.last_interruption.reason,
        }
        self.assertEqual(got, want)
        self.assertIsInstance(run.eval_report, grad.EvalReport)
        self.assertIsInstance(run.eval_report.pareto_summary, grad.RouterParetoSummary)
        self.assertEqual(run.eval_report.metric, 0.41)
        self.assertIsInstance(run.last_interruption, grad.RunInterruption)
        kinds = [type(e).__name__ for e in events]
        self.assertEqual(
            sorted(set(kinds)),
            ["AttemptEvent", "CheckpointEvent", "CompletedEvent", "LogEvent", "MetricEvent", "PhaseEvent", "WarningEvent"],
        )
        self.assertIsInstance(events[24].run, grad.Run)


if __name__ == "__main__":
    unittest.main()
