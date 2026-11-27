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

describe("eval billing", () => {
  let h: EvalHarness | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it("plans an estimate and bills a finished eval once for what ran", async () => {
    const billing = recordingBilling();
    h = await makeEvalHarness({ billing: billing.adapter });
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(3));
    fake.setModel("qwen/qwen3-8b", EXPENSIVE);
    const evals = t.services.evals;

    const plan = await evals.plan(WORKSPACE_A, request({}));
    expect(plan.estimated_cost_usd).toBeGreaterThan(0);

    const created = await evals.create(WORKSPACE_A, request({}));
    await evals.drain();
    const done = await evals.get(WORKSPACE_A, created.id);
    expect(done.status).toBe("completed");
    expect(done.total_cost_usd).toBeCloseTo(0.12, 6);

    await t.services.billing.idle();
    await t.services.billing.drain();
    expect(billing.evals).toEqual([
      {
        workspaceId: WORKSPACE_A,
        evalId: created.id,
        tokensProcessed: 300_000,
        costUsd: 0.12,
        idempotencyKey: `eval-usage:${created.id}`,
      },
    ]);
  });

  it("bills after local scores and skips failed and cancelled evals that ran nothing", async () => {
    const billing = recordingBilling();
    h = await makeEvalHarness({ billing: billing.adapter });
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(1));
    fake.setModel("qwen/qwen3-8b", EXPENSIVE);
    const evals = t.services.evals;

    const local = await evals.create(
      WORKSPACE_A,
      request({ rubric: [{ name: "fn", kind: "code", runtime: "local" }] }),
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
    expect(posted.status).toBe("completed");

    const cancelled = await evals.create(WORKSPACE_A, request({}));
    await evals.cancel(WORKSPACE_A, cancelled.id);

    fake.failNext(100, 400);
    const failed = await evals.create(WORKSPACE_A, request({}));
    await evals.drain();
    expect((await evals.get(WORKSPACE_A, failed.id)).status).toBe("failed");

    await t.services.billing.idle();
    await t.services.billing.drain();
    // Nothing ran for the cancelled and failed evals, so only the scored one bills.
    expect(billing.evals.map((e) => e.evalId)).toEqual([local.id]);
  });
});
