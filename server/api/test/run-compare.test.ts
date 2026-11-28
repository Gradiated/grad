import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestApp, type TestApp } from "./fixtures/app.js";
import { createSftRun } from "./fixtures/worker.js";

type Curve = {
  data: Array<{
    seq: number;
    step: number;
    attempt: number;
    loss: number;
    eval_loss?: number | null;
  }>;
  next_cursor: string | null;
  tail_cursor: string;
};

// The console's run comparison reads each run's whole curve in one thinned
// page (max_points) and the runs list's tabs read per-status counts.
describe("run comparison: thinned metric curves and status counts", () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  const metric = (runId: string, attempt: number, step: number, extra = {}) =>
    t.deps.store.jobs.appendEvent({
      jobId: runId,
      attempt,
      type: "metric",
      step,
      payload: {
        step,
        loss: 1 / (step + 1),
        tokens: step,
        cost_usd: 0,
        timestamp: t.clock.now().toISOString(),
        ...extra,
      },
    });

  it("thins a long curve, keeps the newest point and every eval point it can, and drops replayed steps", async () => {
    const run = await createSftRun(t);
    // Attempt 1 reaches step 120, attempt 2 resumes from step 100: steps
    // 100..120 of attempt 1 are replaced. An eval every 25 steps.
    for (let step = 1; step <= 120; step++)
      await metric(run.id, 1, step, step % 25 === 0 ? { eval_loss: step } : {});
    for (let step = 100; step <= 300; step++)
      await metric(run.id, 2, step, step % 25 === 0 ? { eval_loss: step } : {});

    const full = await t.json<Curve>(
      `/v1/runs/${run.id}/metrics?max_points=5000`,
    );
    expect(full.status).toBe(200);
    expect(full.body.next_cursor).toBeNull();
    const steps = full.body.data.map((m) => m.step);
    expect(steps).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
    expect(
      full.body.data.filter((m) => m.step >= 100).every((m) => m.attempt === 2),
    ).toBe(true);

    const thin = await t.json<Curve>(
      `/v1/runs/${run.id}/metrics?max_points=20`,
    );
    const train = thin.body.data.filter((m) => m.eval_loss === undefined);
    const evals = thin.body.data.filter((m) => m.eval_loss !== undefined);
    expect(train.length).toBeLessThanOrEqual(20);
    expect(train.length).toBeGreaterThanOrEqual(15);
    // All 12 eval points fit in the budget, and the newest point is always kept.
    expect(evals.map((m) => m.step)).toEqual(
      Array.from({ length: 12 }, (_, i) => (i + 1) * 25),
    );
    expect(thin.body.data.at(-1)?.step).toBe(300);
    const seqs = thin.body.data.map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(thin.body.tail_cursor).toBe(full.body.tail_cursor);

    // The tail cursor polls only what was written later.
    await metric(run.id, 2, 301);
    const later = await t.json<Curve>(
      `/v1/runs/${run.id}/metrics?max_points=20&cursor=${thin.body.tail_cursor}`,
    );
    expect(later.body.data.map((m) => m.step)).toEqual([301]);

    const bad = await t.json(`/v1/runs/${run.id}/metrics?max_points=1`);
    expect(bad.status).toBe(422);
  });

  it("counts runs per status in the workspace, narrowed by q", async () => {
    const a = await createSftRun(t, { name: "support-sft" });
    await createSftRun(t, { name: "support-dpo" });
    await createSftRun(t, { name: "billing" });
    await t.json(`/v1/runs/${a.id}/cancel`, { method: "POST" });

    type Counts = { total: number; by_status: Record<string, number> };
    const all = await t.json<Counts>("/v1/runs/counts");
    expect(all.status).toBe(200);
    expect(all.body).toEqual({
      total: 3,
      by_status: {
        queued: 2,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 1,
        stopped_budget: 0,
        stopped_balance: 0,
      },
    });

    const support = await t.json<Counts>("/v1/runs/counts?q=SUPPORT");
    expect(support.body.total).toBe(2);
    expect(support.body.by_status).toMatchObject({ queued: 1, cancelled: 1 });

    // Another workspace's runs are never counted.
    const other = await t.json<Counts>("/v1/runs/counts", {
      token: await t.mintKey("ws_b", ["admin"]),
    });
    expect(other.body.total).toBe(0);
  });
});
