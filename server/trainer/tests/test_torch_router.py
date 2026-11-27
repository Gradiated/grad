"""Router recipe on a tiny real Qwen3 backbone, plus its routing math (torch)."""

from __future__ import annotations

import json
import math

from helpers import QWEN_ID, TorchCase, run_recipe

from grad_trainer.errors import RecipeConfigError, RecipeDataError


def observations(n: int = 60) -> list[dict]:
    """One record per (prompt, model) response; the cheap model fails 'hard' prompts."""
    out = []
    for i in range(n):
        hard = i % 2 == 0
        prompt = [{"role": "user", "content": ("hard SQL join query " if hard else "say hello ") + str(i)}]
        out.append({"messages": prompt + [{"role": "assistant", "content": "x"}], "metadata": {"model": "cheap/m"}, "scores": {"ok": 0.0 if hard else 1.0}, "metrics": {"cost_usd": 0.001}})
        out.append({"messages": prompt + [{"role": "assistant", "content": "y"}], "metadata": {"model": "strong/m"}, "scores": {"ok": 1.0}, "metrics": {"cost_usd": 0.01}})
    return out


CONFIG = {
    "model": QWEN_ID,
    "batch_size": 8,
    "epochs": 4,
    "lr": 1e-2,
    "warmup": 0.0,
    "adapter": {"kind": "lora", "rank": 4, "alpha": 8},
    "split": {"eval_fraction": 0.4, "seed": 5},
    "recipe_params": {"max_quality_drop": 0.05, "rubric": "ok"},
}


class RoutingMathTests(TorchCase):
    def test_policy_and_threshold_selection(self) -> None:
        from grad_trainer.recipes.router import NEVER, choose_threshold, evaluate_policy, route

        rows = [
            ({"cheap": 0.9}, {"cheap": 1.0, "strong": 1.0}),
            ({"cheap": 0.6}, {"cheap": 0.0, "strong": 1.0}),
            ({"cheap": 0.2}, {"cheap": 0.0, "strong": 1.0}),
        ]
        costs = {"cheap": 1.0, "strong": 10.0}
        self.assertEqual(route({"cheap": 0.9}, ["cheap"], "strong", 0.5), "cheap")
        self.assertEqual(route({"cheap": 0.4}, ["cheap"], "strong", 0.5), "strong")
        result = evaluate_policy(rows, ["cheap"], "strong", 0.5, costs)
        self.assertAlmostEqual(result["quality_drop"], 1 / 3)
        self.assertAlmostEqual(result["offload_rate"], 2 / 3)
        self.assertAlmostEqual(result["cost_savings_pct"], 1 - (1 + 1 + 10) / 3 / 10)
        self.assertEqual(choose_threshold(rows, ["cheap"], "strong", 0.0, costs), 0.9)
        self.assertEqual(choose_threshold(rows, ["cheap"], "strong", 0.5, costs), 0.6)
        self.assertEqual(choose_threshold(rows, ["cheap"], "strong", 0.0, None), 0.9)
        # Infeasible: offloading anything breaks the target, so never offload.
        bad = [({"cheap": 0.99}, {"cheap": 0.0, "strong": 1.0})] * 10
        self.assertEqual(choose_threshold(bad, ["cheap"], "strong", 0.01, costs), NEVER)
        self.assertEqual(choose_threshold([], ["cheap"], "strong", 0.01, costs), NEVER)
        self.assertEqual(evaluate_policy(bad, ["cheap"], "strong", NEVER, costs)["quality_drop"], 0.0)

    def test_groups_join_observations(self) -> None:
        from grad_trainer.recipes.router import collect_groups

        groups, candidates, unscored = collect_groups(observations(4) + [{"messages": [{"role": "user", "content": "z"}]}], None, "ok")
        self.assertEqual(candidates, ["cheap/m", "strong/m"])
        self.assertEqual((len(groups), unscored), (4, 1))
        self.assertEqual(groups[0]["scores"], {"cheap/m": 0.0, "strong/m": 1.0})
        self.assertEqual(groups[0]["costs"], {"cheap/m": 0.001, "strong/m": 0.01})
        direct, cands, _ = collect_groups([{"prompt": "p", "scores": {"A/x": 0.5, "B/y": 1.0}}], ["a/x", "b/y"], None)
        self.assertEqual(direct[0]["scores"], {"a/x": 0.5, "b/y": 1.0})
        with self.assertRaisesRegex(RecipeConfigError, "rubric"):
            collect_groups([{"prompt": "p", "metadata": {"model": "m"}, "scores": {"a": 1, "b": 0}}], None, None)
        with self.assertRaisesRegex(RecipeDataError, r"\[0, 1\]"):
            collect_groups([{"prompt": "p", "scores": {"a/x": 3.0}}], None, None)


class RouterTrainingTests(TorchCase):
    def test_trains_router_with_documented_report(self) -> None:
        import torch
        from safetensors.torch import load_file

        out = run_recipe("router", CONFIG, observations(), self.tmpdir())
        self.assertEqual((out.status, out.artifact_format), ("completed", "router_bundle"))
        report = out.eval_report
        summary = report["pareto_summary"]
        for key in ("target_max_drop", "routed_quality", "quality_drop", "quality_drop_ci95", "offload_rate", "cost_savings_pct", "ece"):
            self.assertIn(key, summary)
        self.assertEqual(report["fallback_model"], "strong/m")
        self.assertEqual(summary["target_max_drop"], 0.05)
        self.assertGreater(report["eval_examples"], 0)
        lo, hi = summary["quality_drop_ci95"]
        self.assertLessEqual(lo, summary["quality_drop"])
        self.assertGreaterEqual(hi, summary["quality_drop"])
        self.assertTrue(0.0 <= summary["ece"] <= 1.0)
        self.assertAlmostEqual(report["fallback_quality"], 1.0)

        files = {p.name for p in out.artifact_dir.iterdir()}
        self.assertEqual(files, {"adapter_config.json", "adapter_model.safetensors", "router_config.json", "router_head.safetensors"})
        head = load_file(str(out.artifact_dir / "router_head.safetensors"))
        self.assertEqual(tuple(head["weight"].shape), (2, 32))
        self.assertTrue(torch.isfinite(head["weight"]).all())
        config = json.loads((out.artifact_dir / "router_config.json").read_text())
        self.assertEqual(config["candidates"], ["cheap/m", "strong/m"])
        self.assertEqual(config["route_order"], ["cheap/m"])
        self.assertTrue(config["calibrated"])
        self.assertEqual(config["threshold"], summary["threshold"])
        self.assertGreater(config["temperature"], 0)

    def test_missing_scores_fail_instead_of_guessing(self) -> None:
        unscored = [{"messages": [{"role": "user", "content": f"q{i}"}, {"role": "assistant", "content": "a"}]} for i in range(10)]
        with self.assertRaisesRegex(RecipeDataError, "per-model scores"):
            run_recipe("router", CONFIG, unscored, self.tmpdir())
        one_model = [r for r in observations(10) if r["metadata"]["model"] == "cheap/m"]
        with self.assertRaisesRegex(RecipeDataError, "at least two"):
            run_recipe("router", CONFIG, one_model, self.tmpdir())
        judge = {**CONFIG, "recipe_params": {"rubric": {"kind": "judge", "model": "x"}}}
        with self.assertRaisesRegex(RecipeConfigError, "inference service"):
            run_recipe("router", judge, observations(4), self.tmpdir())
        with self.assertRaisesRegex(RecipeConfigError, "fallback"):
            run_recipe("router", {**CONFIG, "recipe_params": {"rubric": "ok", "fallback": "nope/m"}}, observations(4), self.tmpdir())

    def test_no_report_fold_gives_null_summary_and_no_prices(self) -> None:
        records = [{k: v for k, v in r.items() if k != "metrics"} for r in observations(20)]
        params = {"rubric": "ok", "pricing": None}
        out = run_recipe(
            "router",
            {**CONFIG, "epochs": 1, "adapter": {"kind": "frozen_head"}, "split": {"eval_fraction": 0.0}, "recipe_params": params},
            records,
            self.tmpdir(),
        )
        summary = out.eval_report["pareto_summary"]
        self.assertIsNone(summary["quality_drop"])
        self.assertIsNone(summary["quality_drop_ci95"])
        self.assertFalse(out.eval_report["routes_any_traffic"])
        self.assertTrue(any("pareto_summary is null" in w for w in out.eval_report["warnings"]))
        self.assertTrue(any("cost_savings_pct is null" in w for w in out.eval_report["warnings"]))
        self.assertNotIn("adapter_config.json", {p.name for p in out.artifact_dir.iterdir()})
        priced = run_recipe(
            "router",
            {**CONFIG, "epochs": 1, "recipe_params": {"rubric": "ok", "pricing": {"cheap/m": 1, "strong/m": 5}}},
            records,
            self.tmpdir(),
        )
        self.assertEqual(json.loads((priced.artifact_dir / "router_config.json").read_text())["pricing"], {"cheap/m": 1.0, "strong/m": 5.0})
        self.assertFalse(math.isnan(priced.eval_report["pareto_summary"]["offload_rate"]))
