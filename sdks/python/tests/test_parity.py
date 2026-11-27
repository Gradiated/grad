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
        "filter_dataset_ids": lambda: client.datasets.filter("support-logs", ids=["rec_a", "rec_c"]),
        "deploy": lambda: client.deploy(artifact, name="support", fallback="test/tiny-qwen3", explore_rate=0.1, idempotency_key="parity-deploy-key"),
    }


class ParityTests(unittest.TestCase):
    def test_requests_match_the_shared_fixture(self) -> None:
        client, sender, _ = make_client(handler=lambda _sent: json_reply({}))
        table = calls(client)
        self.assertEqual(sorted(table), sorted(c["case"] for c in PARITY["requests"]))
        for case in PARITY["requests"]:
            with self.subTest(case=case["case"]):
                table[case["case"]]()
                sent = sender.sent[-1]
                self.assertEqual((sent.method, sent.path), (case["method"], case["path"]))
                self.assertEqual(sent.json, case["body"])
                key = sent.header("Idempotency-Key")
                if case["idempotency_key"] is None:
                    self.assertRegex(key or "", r"^[0-9a-f-]{36}$")
                else:
                    self.assertEqual(key, case["idempotency_key"])

    def test_typed_responses(self) -> None:
        responses, want = PARITY["responses"], PARITY["expect"]
        run = grad.Run.from_api(responses["run"])
        ev = grad.Eval.from_api(responses["eval"])
        plan = grad.EvalPlan.from_api(responses["eval_plan"])
        scoring = grad.Eval.from_api(responses["scoring"])
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
        }
        self.assertEqual(got, want)
        self.assertIsInstance(run.eval_report, grad.EvalReport)
        self.assertIsInstance(run.eval_report.pareto_summary, grad.RouterParetoSummary)
        self.assertEqual(run.eval_report.metric, 0.41)


if __name__ == "__main__":
    unittest.main()
