import { describe, expect, it } from "vitest";

import { PlanEvalRequestSchema, type DatasetRecord } from "../src/contracts.js";
import {
  bootstrapMeanCI,
  computePassAtK,
  planEval,
  runDeterministicEval,
} from "../src/evals.js";

const sampleDataset: DatasetRecord[] = [
  {
    id: "t1",
    messages: [
      { role: "user", content: "Return JSON" },
      { role: "assistant", content: '{"ok": true}' },
    ],
  },
  {
    id: "t2",
    messages: [
      { role: "user", content: "Return JSON" },
      { role: "assistant", content: "not json" },
    ],
  },
  {
    id: "t3",
    messages: [
      { role: "user", content: "Return JSON" },
      { role: "assistant", content: '{"items": [1, 2]}' },
    ],
  },
];

describe("evals planning and statistics", () => {
  it("enforces exactly one task source and explicit Judge model", () => {
    expect(() =>
      planEval(
        PlanEvalRequestSchema.parse({
          models: ["qwen/qwen3-8b"],
        }),
      ),
    ).toThrow(/exactly one task source/);

    expect(() =>
      planEval(
        PlanEvalRequestSchema.parse({
          models: ["qwen/qwen3-8b"],
          dataset: "support",
          benchmarks: [{ name: "ifeval", limit: 10 }],
        }),
      ),
    ).toThrow(/only one task source/);

    expect(() =>
      PlanEvalRequestSchema.parse({
        models: ["qwen/qwen3-8b"],
        dataset: "support",
        rubric: [{ name: "helpfulness", kind: "judge", prompt: "grade" }],
      }),
    ).toThrow(/explicit 'model'/);
  });

  it("estimates calls, judge calls, and cost via planEval", () => {
    const plan = planEval(
      PlanEvalRequestSchema.parse({
        models: ["qwen/qwen3-8b", "support@latest"],
        dataset: "support",
        samples: 3,
        rubric: [
          {
            name: "accuracy",
            kind: "judge",
            model: "qwen/qwen3-32b",
            prompt: "Is the answer accurate?",
          },
        ],
      }),
      sampleDataset,
    );

    expect(plan.task_source_kind).toBe("dataset");
    expect(plan.estimated_tasks).toBe(3);
    expect(plan.estimated_model_calls).toBe(18);
    expect(plan.estimated_judge_calls).toBe(18);
    expect(plan.judge_models).toEqual(["qwen/qwen3-32b"]);
    expect(plan.estimated_cost_usd).toBeGreaterThanOrEqual(0);
  });

  it("computes deterministic bootstrap 95% CI, pass@k, and paired vs_baseline diff", () => {
    const ci = bootstrapMeanCI([0.2, 0.8, 0.9, 1.0, 0.7], 42);
    expect(ci.ci_low).toBeLessThanOrEqual(ci.mean);
    expect(ci.mean).toBeLessThanOrEqual(ci.ci_high);

    expect(computePassAtK([false, false, true, false], 1)).toBe(0.25);
    expect(computePassAtK([false, false, true, false], 4)).toBe(1);

    const outcome = runDeterministicEval(
      PlanEvalRequestSchema.parse({
        name: "json-eval",
        models: ["qwen/qwen3-8b", "json-sft@latest"],
        baseline: "qwen/qwen3-8b",
        dataset: "support",
        samples: 2,
        pass_threshold: 0.8,
        rubric: [
          {
            name: "valid_json",
            kind: "validator",
            validator: "json",
            weight: 1,
          },
          {
            name: "judge_quality",
            kind: "judge",
            model: "qwen/qwen3-32b",
            prompt: "check quality",
            weight: 1,
          },
        ],
      }),
      sampleDataset,
    );

    expect(outcome.judge_models).toEqual(["qwen/qwen3-32b"]);
    expect(outcome.summary).toHaveLength(2);
    const baselineSummary = outcome.summary.find(
      (s) => s.model === "qwen/qwen3-8b",
    );
    const candidateSummary = outcome.summary.find(
      (s) => s.model === "json-sft@latest",
    );
    expect(baselineSummary?.vs_baseline).toBeNull();
    expect(candidateSummary?.vs_baseline).not.toBeNull();
    expect(candidateSummary?.pass_at_k).toHaveProperty("pass@1");
    expect(candidateSummary?.pass_at_k).toHaveProperty("pass@2");
  });
});
