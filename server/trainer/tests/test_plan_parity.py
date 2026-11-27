"""runs.plan against what the trainer bills: tokens within 25%, optimizer steps exactly (torch).

Each case is planned by server/api/src/planner.ts (through tsx, against the dev-model catalog
of ``grad local up --dev-models``), then trained on its resolved config with the tiny dev
models. The run's ``tokens_processed`` is what it bills; ``total_steps`` is what it reports.
"""

from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

from helpers import QWEN_ID, TorchCase, run_recipe

REPO = Path(__file__).resolve().parents[3]
TSX = REPO / "server" / "api" / "node_modules" / ".bin" / "tsx"
SCRIPT = Path(__file__).resolve().parent / "fixtures" / "plan_parity.mts"

TRACES = [json.loads(line) for line in (REPO / "examples" / "support_traces.jsonl").read_text().splitlines()]
CHAT = [{**r, "id": f"r{i}"} for i, r in enumerate(TRACES)]
PAIRS = [
    {
        "id": f"p{i}",
        "prompt": r["messages"][1]["content"],
        "chosen": r["messages"][2]["content"],
        "rejected": "Please contact support about this; we can't help with it here.",
    }
    for i, r in enumerate(TRACES)
]


def case(name: str, recipe: dict, records: list[dict]) -> dict:
    return {"request": {"name": name, "dataset": "fixture", "recipe": {"model": QWEN_ID, **recipe}}, "records": records}


# About 40 records at the default batch size (the trial's s-sft, s-dpo and s-router), and
# larger, multi-epoch runs.
CASES = [
    case("s-sft", {"kind": "sft"}, CHAT[:40]),
    case("sft-epochs", {"kind": "sft", "epochs": 3, "batch_size": 16}, CHAT),
    case("s-dpo", {"kind": "dpo"}, PAIRS[:40]),
    case("dpo-epochs", {"kind": "dpo", "epochs": 2, "batch_size": 16}, PAIRS),
    case("s-router", {"kind": "router", "rubric": "resolved"}, CHAT),
    case("reward", {"kind": "reward"}, PAIRS[:40]),
]


@unittest.skipUnless(TSX.exists(), "server/api node_modules not installed")
class PlanParityTests(TorchCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        result = subprocess.run(
            [str(TSX), str(SCRIPT), str(REPO)],
            input=json.dumps({"cases": CASES}),
            cwd=REPO / "server" / "api",
            capture_output=True,
            text=True,
            timeout=120,
            check=True,
        )
        cls.plans = json.loads(result.stdout)

    def test_plan_matches_billed_tokens_and_steps(self) -> None:
        for c, plan in zip(CASES, self.plans):
            name, kind = c["request"]["name"], c["request"]["recipe"]["kind"]
            with self.subTest(name):
                out = run_recipe(kind, plan["resolved_config"], c["records"], self.tmpdir())
                self.assertEqual(out.status, "completed")
                self.assertEqual(out.manifest["total_steps"], plan["estimated_steps"])
                ratio = out.tokens_processed / plan["estimated_tokens"]
                self.assertTrue(0.75 <= ratio <= 1.25, f"{name}: billed {out.tokens_processed}, planned {plan['estimated_tokens']}")
                self.assertAlmostEqual(
                    plan["estimated_cost_usd"], plan["cost_breakdown"]["train_usd"] + plan["cost_breakdown"]["eval_usd"], places=3
                )

    def test_small_datasets_get_several_steps_per_epoch(self) -> None:
        small = {p["resolved_config"]["name"]: p for p in self.plans}
        for name in ("s-sft", "s-dpo"):
            plan = small[name]
            self.assertLess(plan["resolved_config"]["batch_size"], 128)
            self.assertGreaterEqual(plan["estimated_steps"], 4)
            self.assertIn("steps per epoch", plan["warnings"][-1])


if __name__ == "__main__":
    unittest.main()
