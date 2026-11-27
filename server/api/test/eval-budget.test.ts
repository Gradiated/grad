import { afterEach, describe, expect, it } from "vitest";

import type { BillingAdapter } from "../src/adapters.js";
import { PlanEvalRequestSchema } from "../src/contracts.js";
import { WORKSPACE_A } from "./fixtures/app.js";
import {
  makeEvalHarness,
  qaRecords,
  seedDataset,
  type EvalHarness,
} from "./fixtures/evals.js";

/** Every call reports 100k prompt tokens: $0.04 on qwen/qwen3-8b ($0.40/M). */
const EXPENSIVE = () => ({
  content: "answer",
  usage: { prompt_tokens: 100_000, completion_tokens: 0 },
});

const recordingBilling = () => {
  const evals: Array<Parameters<BillingAdapter["recordEvalUsage"]>[0]> = [];
  const adapter: BillingAdapter = {
    checkCanStartRun: async () => ({ allowed: true }),
    recordRunUsage: async () => undefined,
    recordEvalUsage: async (input) => {
      evals.push(input);
    },
  };

  return { adapter, evals };
};

const request = (raw: Record<string, unknown>) =>
  PlanEvalRequestSchema.parse({
    models: ["qwen/qwen3-8b"],
    dataset: "qa",
    ...raw,
  });

describe("eval max_cost_usd", () => {
  let h: EvalHarness | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it("plan shows the estimate and create rejects plans over the cap", async () => {
    h = await makeEvalHarness();
    await seedDataset(h.t, "qa", qaRecords(20));
    const evals = h.t.services.evals;

    const plan = await evals.plan(
      WORKSPACE_A,
      request({ max_cost_usd: 0.000001 }),
    );
    expect(plan.estimated_cost_usd).toBeGreaterThan(0.000001);
    expect(plan.warnings.join(" ")).toMatch(/evals.create rejects it/);
    await expect(
      evals.create(WORKSPACE_A, request({ max_cost_usd: 0.000001 })),
    ).rejects.toMatchObject({ status: 422, code: "eval_budget_exceeded" });

    const ok = await evals.create(WORKSPACE_A, request({ max_cost_usd: 10 }));
    expect(ok.max_cost_usd).toBe(10);
    const unlimited = await evals.create(WORKSPACE_A, request({}));
    expect(unlimited.max_cost_usd).toBeNull();
  });

  it("stops generating at the cap with partial results and bills what ran", async () => {
    const billing = recordingBilling();
    h = await makeEvalHarness({ billing: billing.adapter });
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(20));
    fake.setModel("qwen/qwen3-8b", EXPENSIVE);
    const evals = t.services.evals;

    const created = await evals.create(
      WORKSPACE_A,
      request({ max_cost_usd: 0.1 }),
    );
    await evals.drain();
    const stopped = await evals.get(WORKSPACE_A, created.id);
    expect(stopped.status).toBe("stopped_budget");
    expect(stopped.progress.generated).toBe(2);
    expect(stopped.progress.total_outputs).toBe(20);
    expect(stopped.total_cost_usd).toBeCloseTo(0.08, 6);
    expect(stopped.total_cost_usd).toBeLessThanOrEqual(0.1);
    expect(fake.requests).toHaveLength(2);
    expect(stopped.summary[0]?.tasks).toBe(2);

    const results = await evals.listResults(WORKSPACE_A, created.id, {
      limit: 50,
    });
    expect(results.data).toHaveLength(2);

    await t.services.billing.idle();
    await t.services.billing.drain();
    expect(billing.evals).toEqual([
      {
        workspaceId: WORKSPACE_A,
        evalId: created.id,
        tokensProcessed: 200_000,
        costUsd: 0.08,
        idempotencyKey: `eval-usage:${created.id}`,
      },
    ]);
  });

  it("finishes stopped_budget after local scores and bills failed and cancelled evals", async () => {
    const billing = recordingBilling();
    h = await makeEvalHarness({ billing: billing.adapter });
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(10));
    fake.setModel("qwen/qwen3-8b", EXPENSIVE);
    const evals = t.services.evals;

    const local = await evals.create(
      WORKSPACE_A,
      request({
        max_cost_usd: 0.05,
        rubric: [{ name: "fn", kind: "code", runtime: "local" }],
      }),
    );
    await evals.drain();
    const waiting = await evals.get(WORKSPACE_A, local.id);
    expect(waiting).toMatchObject({
      status: "awaiting_scores",
      progress: { generated: 1, pending_local_scores: 1 },
    });
    const [output] = (
      await evals.listOutputs(WORKSPACE_A, local.id, {
        limit: 10,
        missingScorer: "fn",
      })
    ).data;
    const posted = await evals.postScores(WORKSPACE_A, local.id, [
      { output_id: output!.id, scorer: "fn", score: 1 },
    ]);
    expect(posted.status).toBe("stopped_budget");

    const cancelled = await evals.create(WORKSPACE_A, request({}));
    await evals.cancel(WORKSPACE_A, cancelled.id);

    fake.failNext(100, 400);
    const failed = await evals.create(WORKSPACE_A, request({}));
    await evals.drain();
    expect((await evals.get(WORKSPACE_A, failed.id)).status).toBe("failed");

    await t.services.billing.idle();
    await t.services.billing.drain();
    // Nothing ran for the cancelled and failed evals, so only the capped one bills.
    expect(billing.evals.map((e) => e.evalId)).toEqual([local.id]);
  });
});
