import { afterEach, describe, expect, it } from "vitest";

import { BALANCE_STOPPED } from "../src/services/runs.js";
import { makeTestApp, WORKSPACE_A, type TestApp } from "./fixtures/app.js";
import { ManualClock } from "./fixtures/clock.js";
import {
  cloudBillingDeps,
  startTestCloud,
  usageCommitted,
} from "./fixtures/cloud.js";
import type { FakeCloudApi } from "./fixtures/fake-cloud-api.js";
import { createSftRun, FakeWorker } from "./fixtures/worker.js";

/** Usage rows of one run, oldest first. */
const ledger = async (t: TestApp, runId: string) =>
  t.deps.store.usage.listByRef(runId);

/** The rows tile the run's tokens per attempt and sum to what it used. */
const expectTiled = (
  rows: Awaited<ReturnType<typeof ledger>>,
  perAttempt: Record<number, number>,
) => {
  const ends = new Map<number, number>();
  for (const row of rows) {
    expect(row.tokens_from).toBe(ends.get(row.attempt) ?? 0);
    expect(row.tokens).toBe(row.tokens_through - row.tokens_from);
    expect(row.idempotency_key).toBe(
      `run-usage:${row.ref_id}:${row.attempt}:${row.tokens_through}`,
    );
    ends.set(row.attempt, row.tokens_through);
  }
  expect(Object.fromEntries(ends)).toEqual(perAttempt);
};

describe("usage ledger: incremental billing while a run trains", () => {
  let t: TestApp | undefined;
  let cloud: FakeCloudApi | undefined;

  afterEach(async () => {
    await t?.close();
    await cloud?.close();
    t = undefined;
    cloud = undefined;
  });

  const app = async (settings: Record<string, number> = {}) =>
    makeTestApp({
      settings: {
        maxAttempts: 3,
        usageFlushTokens: 1000,
        usageFlushSeconds: 300,
        ...settings,
      },
    });

  it("bills every N tokens or minutes, at checkpoints and at the end; replays add nothing", async () => {
    t = await app();
    const worker = new FakeWorker(t);
    const run = await createSftRun(t);
    const job = (await worker.claim())!;

    await worker.progress(job, 1, 400); // under both thresholds
    expect(await ledger(t, run.id)).toEqual([]);
    await worker.progress(job, 2, 1200); // past 1000 tokens
    await worker.progress(job, 2, 1200); // the same report, replayed
    expect((await ledger(t, run.id)).map((r) => r.tokens)).toEqual([1200]);

    t.clock.advanceSeconds(301);
    await worker.progress(job, 3, 1500); // past 5 minutes
    await worker.checkpoint(job, 3, "ckpt");
    await worker.progress(job, 4, 1800);
    await worker.checkpoint(job, 4, "ckpt-4"); // a checkpoint always bills
    await worker.complete(
      job,
      { status: "completed", tokens_processed: 2100 },
      "artifact",
    );

    const rows = await ledger(t, run.id);
    expect(rows.map((r) => r.tokens_through)).toEqual([1200, 1500, 1800, 2100]);
    expectTiled(rows, { 1: 2100 });
    const final = await t.json<{ tokens_processed: number; cost_usd: number }>(
      `/v1/runs/${run.id}`,
    );
    expect(final.body.tokens_processed).toBe(2100);
    expect(rows.reduce((sum, r) => sum + r.cost_usd, 0)).toBeCloseTo(
      final.body.cost_usd,
      6,
    );

    const listed = await t.json<{
      data: Array<{ tokens_through: number }>;
      next_cursor: string | null;
    }>("/v1/usage?limit=3");
    expect(listed.body.data.map((u) => u.tokens_through)).toEqual([
      2100, 1800, 1500,
    ]);
    expect(listed.body.next_cursor).not.toBeNull();
  });

  it("never bills past max_cost_usd: the step that crosses the cap is billed only up to it", async () => {
    t = await app();
    const worker = new FakeWorker(t);
    // test/tiny-qwen3 costs $1 per million tokens: the cap is 2,000 tokens.
    const run = await createSftRun(t, { maxCostUsd: 0.002 });
    const job = (await worker.claim())!;
    await worker.progress(job, 1, 1500);
    expect((await worker.progress(job, 2, 2500)).body).toMatchObject({
      should_stop: true,
      stop_reason: "budget",
    });
    const done = await worker.complete(
      job,
      { status: "stopped_budget", tokens_processed: 2600 },
      "partial",
    );
    expect(done.body.run).toMatchObject({
      status: "stopped_budget",
      tokens_processed: 2600,
    });
    const rows = await ledger(t, run.id);
    expectTiled(rows, { 1: 2000 });
    expect(rows.reduce((total, r) => total + r.cost_usd, 0)).toBeCloseTo(
      0.002,
      9,
    );

    // A resume under a higher cap bills the new attempt up to the run's cap, no further.
    await t.json(`/v1/runs/${run.id}/resume`, {
      body: { max_cost_usd: 0.003 },
    });
    const again = (await worker.claim())!;
    await worker.complete(
      again,
      { status: "stopped_budget", tokens_processed: 1000 },
      "partial-2",
    );
    expectTiled(await ledger(t, run.id), { 1: 2000, 2: 400 });
  });

  it("a cancel bills exactly what ran, with no rows after it", async () => {
    t = await app();
    const worker = new FakeWorker(t);
    const run = await createSftRun(t);
    const job = (await worker.claim())!;
    await worker.progress(job, 1, 1500);
    await worker.progress(job, 2, 1700);
    await t.json(`/v1/runs/${run.id}/cancel`, { body: {} });
    // The worker learns of the cancel and reports what it really used.
    expect((await worker.heartbeat(job)).body).toMatchObject({
      should_stop: true,
      stop_reason: "cancelled",
    });
    await worker.complete(job, { status: "cancelled", tokens_processed: 1750 });
    const afterCancel = await ledger(t, run.id);
    expectTiled(afterCancel, { 1: 1750 });

    // A late report of the closed attempt is fenced off and bills nothing.
    expect((await worker.progress(job, 3, 5000)).status).toBe(409);
    expect(await ledger(t, run.id)).toEqual(afterCancel);
    expect(
      (await t.json<{ tokens_processed: number }>(`/v1/runs/${run.id}`)).body
        .tokens_processed,
    ).toBe(1750);
  });

  it("a worker that dies is billed up to its last progress report, then the next attempt bills afresh", async () => {
    t = await app();
    const worker = new FakeWorker(t);
    const run = await createSftRun(t);
    const job = (await worker.claim())!;
    await worker.progress(job, 1, 600);
    t.clock.advanceSeconds(90);
    await t.services.maintenance.tick();
    const next = (await new FakeWorker(t, "worker-2").claim())!;
    expect(next.attempt).toBe(2);
    await new FakeWorker(t, "worker-2").complete(
      next,
      { status: "completed", tokens_processed: 1100 },
      "a",
    );
    expectTiled(await ledger(t, run.id), { 1: 600, 2: 1100 });
  });

  it("pushes the ledger to Cloud billing as usage events, once per row", async () => {
    cloud = await startTestCloud();
    const clock = new ManualClock();
    t = await makeTestApp({
      clock,
      ...(await cloudBillingDeps(cloud, clock)),
      settings: { maxAttempts: 3, usageFlushTokens: 1000 },
    });
    const worker = new FakeWorker(t);
    const run = await createSftRun(t);
    const job = (await worker.claim())!;
    await worker.progress(job, 1, 1500);
    await usageCommitted();
    expect((await t.services.maintenance.tick()).exportedUsage).toBe(1);
    await worker.complete(
      job,
      { status: "completed", tokens_processed: 2000 },
      "a",
    );
    await usageCommitted();
    expect((await t.services.maintenance.tick()).exportedUsage).toBe(1);
    expect((await t.services.maintenance.tick()).exportedUsage).toBe(0);
    expect(cloud.usageEvents).toEqual([
      expect.objectContaining({
        event_id: `training:run-usage:${run.id}:1:1500`,
        workspace_id: WORKSPACE_A,
        product: "training",
        sku: "train:test/tiny-qwen3",
        quantity: 1500,
        amount_nano_usd: 1_500_000,
        price_version: "pv_1",
        subject_id: run.id,
        tags: { attempt: "1", recipe_kind: "sft" },
      }),
      expect.objectContaining({
        event_id: `training:run-usage:${run.id}:1:2000`,
        quantity: 500,
        amount_nano_usd: 500_000,
      }),
    ]);

    // A fresh replica resumes from the shared cursor instead of re-sending.
    const restarted = await makeTestApp({
      store: t.deps.store,
      clock,
      ...(await cloudBillingDeps(cloud, clock)),
    });
    expect((await restarted.services.maintenance.tick()).exportedUsage).toBe(0);
    expect(cloud.callsTo("/api/internal/v1/billing/usage-events")).toHaveLength(
      2,
    );
    await restarted.close();
  });

  it("stops a run whose workspace ran out of balance, and resumes it after a top-up", async () => {
    cloud = await startTestCloud();
    const clock = new ManualClock();
    t = await makeTestApp({ clock, ...(await cloudBillingDeps(cloud, clock)) });
    const worker = new FakeWorker(t);
    const run = await createSftRun(t, { maxCostUsd: 50 });
    const job = (await worker.claim())!;
    await worker.progress(job, 1, 1000);
    expect((await worker.heartbeat(job)).body).toMatchObject({
      should_stop: false,
    });

    cloud.balances.set(WORKSPACE_A, -1);
    // The balance answer is reused for 30 s per workspace.
    t.clock.advanceSeconds(31);
    expect((await worker.heartbeat(job)).body).toMatchObject({
      should_stop: true,
      stop_reason: "insufficient_balance",
    });
    const stopped = await worker.complete(
      job,
      {
        status: "stopped_budget",
        stop_reason: "insufficient_balance",
        tokens_processed: 1200,
      },
      "partial",
    );
    expect(stopped.body.run).toMatchObject({
      status: "stopped_balance",
      error: BALANCE_STOPPED,
      tokens_processed: 1200,
    });
    expectTiled(await ledger(t, run.id), { 1: 1200 });

    // A billing outage never stops a run; a top-up lets it resume as is.
    cloud.balances.set(WORKSPACE_A, 100_000_000_000);
    const resumed = await t.json(`/v1/runs/${run.id}/resume`, { body: {} });
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ status: "queued", error: null });
    const again = (await worker.claim())!;
    t.clock.advanceSeconds(31);
    cloud.failNext(1, 503, "/api/internal/v1/billing/check");
    expect((await worker.heartbeat(again)).body).toMatchObject({
      should_stop: false,
    });
  });
});
