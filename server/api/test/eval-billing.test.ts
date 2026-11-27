import { afterEach, describe, expect, it } from "vitest";

import { PlanEvalRequestSchema } from "../src/contracts.js";
import { WORKSPACE_A } from "./fixtures/app.js";
import {
  makeEvalHarness,
  qaRecords,
  seedDataset,
  type EvalHarness,
  createEval,
} from "./fixtures/evals.js";

/** Every call reports 100k prompt tokens: $0.04 on qwen/qwen3-8b ($0.40/M). */
const EXPENSIVE = () => ({
  content: "answer",
  usage: { prompt_tokens: 100_000, completion_tokens: 0 },
});

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

  it("checks the balance before an eval or dataset.score() starts (r8 P1-4)", async () => {
    const asked: Array<[string, number]> = [];
    h = await makeEvalHarness({
      billing: {
        checkCanStartRun: async (workspaceId, estimatedCostUsd) => {
          asked.push([workspaceId, estimatedCostUsd]);
          return { allowed: false, reason: "Balance exhausted." };
        },
      },
    });
    const { t } = h;
    await seedDataset(t, "qa", qaRecords(3));
    const ev = await t.json("/v1/evals", {
      body: { models: ["qwen/qwen3-8b"], dataset: "qa" },
    });
    expect([ev.status, ev.body.code, ev.body.detail]).toEqual([
      403,
      "billing_denied",
      "Balance exhausted.",
    ]);
    const scored = await t.json("/v1/datasets/qa/score", {
      body: {
        rubric: [{ name: "j", kind: "judge", model: "qwen/qwen3-32b" }],
      },
    });
    expect([scored.status, scored.body.code]).toEqual([403, "billing_denied"]);
    expect(asked).toHaveLength(2);
    expect(asked[0]?.[0]).toBe(WORKSPACE_A);
    expect(asked[0]?.[1]).toBeGreaterThan(0);
    expect(await t.deps.store.evals.list(WORKSPACE_A, { limit: 10 })).toEqual({
      data: [],
      next_cursor: null,
    });
  });

  it("plans an estimate and bills a finished eval once for what ran", async () => {
    h = await makeEvalHarness();
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(3));
    fake.setModel("qwen/qwen3-8b", EXPENSIVE);
    const evals = t.services.evals;

    const plan = await evals.plan(WORKSPACE_A, request({}));
    expect(plan.estimated_cost_usd).toBeGreaterThan(0);

    const created = await createEval(evals, WORKSPACE_A, request({}));
    await h.worker.drain();
    const done = await evals.get(WORKSPACE_A, created.id);
    expect(done.status).toBe("completed");
    expect(done.total_cost_usd).toBeCloseTo(0.12, 6);

    // The attempt closed under the flush threshold: one ledger row.
    expect(await t.deps.store.usage.listByRef(created.id)).toEqual([
      expect.objectContaining({
        kind: "eval",
        ref_id: created.id,
        attempt: 1,
        tokens: 300_000,
        cost_usd: 0.12,
        idempotency_key: `eval-usage:${created.id}:1:300000`,
        tokens_from: 0,
        tokens_through: 300_000,
        price_version: t.deps.catalog.priceVersion,
      }),
    ]);
    const listed = await t.json<{ data: Array<{ ref_id: string }> }>(
      "/v1/usage",
    );
    expect(listed.body.data.map((u) => u.ref_id)).toEqual([created.id]);
  });

  it("bills outputs still in flight when the eval was cancelled (r8 P2-7)", async () => {
    h = await makeEvalHarness();
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(3));
    fake.setModel("qwen/qwen3-8b", () => ({ ...EXPENSIVE(), delayMs: 200 }));
    const evals = t.services.evals;
    const created = await createEval(evals, WORKSPACE_A, request({}));
    const running = h.worker.drain();
    // Cancel while all three calls are in flight; they land after it.
    for (let i = 0; i < 100 && fake.requests.length < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await evals.cancel(WORKSPACE_A, created.id);
    await running;
    const billed = (await t.deps.store.usage.listByRef(created.id)).reduce(
      (sum, u) => sum + u.tokens,
      0,
    );
    const spent = await t.deps.store.evals.attemptUsage(created.id, 1);
    expect(spent.tokens).toBe(300_000);
    expect(billed).toBe(spent.tokens);
  });

  it("bills after local scores and skips failed and cancelled evals that ran nothing", async () => {
    h = await makeEvalHarness();
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(1));
    fake.setModel("qwen/qwen3-8b", EXPENSIVE);
    const evals = t.services.evals;

    const local = await createEval(
      evals,
      WORKSPACE_A,
      request({ rubric: [{ name: "fn", kind: "code", runtime: "local" }] }),
    );
    await h.worker.drain();
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

    const cancelled = await createEval(evals, WORKSPACE_A, request({}));
    await evals.cancel(WORKSPACE_A, cancelled.id);

    fake.failNext(100, 400);
    const failed = await createEval(evals, WORKSPACE_A, request({}));
    await h.worker.drain();
    expect((await evals.get(WORKSPACE_A, failed.id)).status).toBe("failed");

    // Nothing ran for the cancelled and failed evals, so only the scored one bills.
    const store = t.deps.store;
    expect(
      (await store.usage.listByRef(local.id)).map((u) => u.attempt),
    ).toEqual([1]);
    expect(await store.usage.listByRef(cancelled.id)).toEqual([]);
    expect(await store.usage.listByRef(failed.id)).toEqual([]);
  });
});
