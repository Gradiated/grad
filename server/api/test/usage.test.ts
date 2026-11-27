import { afterEach, describe, expect, it } from "vitest";

import { createCloudBillingAdapter } from "../src/adapters-cloud.js";
import { BALANCE_STOPPED } from "../src/services/runs.js";
import { makeTestApp, WORKSPACE_A, type TestApp } from "./fixtures/app.js";
import {
  startFakeCloudApi,
  type FakeCloudApi,
} from "./fixtures/fake-cloud-api.js";
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
        evalConcurrency: 2,
        usageExportLagSeconds: 0,
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

  it("exports the ledger to Gradiated Cloud from its cursor, once per row", async () => {
    cloud = await startFakeCloudApi();
    t = await makeTestApp({
      billing: createCloudBillingAdapter({
        internalApiBaseUrl: cloud.url,
        serviceToken: cloud.serviceToken,
      }),
      settings: {
        maxAttempts: 3,
        evalConcurrency: 2,
        usageExportLagSeconds: 0,
        usageFlushTokens: 1000,
      },
    });
    const worker = new FakeWorker(t);
    const run = await createSftRun(t);
    const job = (await worker.claim())!;
    await worker.progress(job, 1, 1500);
    expect((await t.services.maintenance.tick()).exportedUsage).toBe(1);
    await worker.complete(
      job,
      { status: "completed", tokens_processed: 2000 },
      "a",
    );
    expect((await t.services.maintenance.tick()).exportedUsage).toBe(1);
    expect((await t.services.maintenance.tick()).exportedUsage).toBe(0);
    expect(
      cloud.usage.map((u) => [u.ref_id, u.attempt, u.tokens_processed]),
    ).toEqual([
      [run.id, 1, 1500],
      [run.id, 1, 500],
    ]);

    // A fresh replica resumes from Cloud's cursor instead of re-sending.
    const restarted = await makeTestApp({
      store: t.deps.store,
      billing: createCloudBillingAdapter({
        internalApiBaseUrl: cloud.url,
        serviceToken: cloud.serviceToken,
      }),
      settings: {
        maxAttempts: 3,
        evalConcurrency: 2,
        usageExportLagSeconds: 0,
      },
    });
    expect((await restarted.services.maintenance.tick()).exportedUsage).toBe(0);
    expect(cloud.callsTo("/api/internal/v1/billing/usage")).toHaveLength(2);
  });

  it("stops a run whose workspace ran out of balance, and resumes it after a top-up", async () => {
    cloud = await startFakeCloudApi();
    const billing = createCloudBillingAdapter({
      internalApiBaseUrl: cloud.url,
      serviceToken: cloud.serviceToken,
    });
    t = await makeTestApp({ billing });
    const worker = new FakeWorker(t);
    const run = await createSftRun(t, { maxCostUsd: 50 });
    const job = (await worker.claim())!;
    await worker.progress(job, 1, 1000);
    expect((await worker.heartbeat(job)).body).toMatchObject({
      should_stop: false,
    });

    cloud.balances.set(WORKSPACE_A, -1);
    expect((await worker.heartbeat(job)).body).toMatchObject({
      should_stop: true,
      stop_reason: "insufficient_balance",
    });
    const stopped = await worker.complete(
      job,
      { status: "stopped_budget", tokens_processed: 1200 },
      "partial",
    );
    expect(stopped.body.run).toMatchObject({
      status: "stopped_budget",
      error: BALANCE_STOPPED,
      tokens_processed: 1200,
    });
    expectTiled(await ledger(t, run.id), { 1: 1200 });

    // A billing outage never stops a run; a top-up lets it resume as is.
    cloud.balances.set(WORKSPACE_A, 100);
    const resumed = await t.json(`/v1/runs/${run.id}/resume`, { body: {} });
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ status: "queued", error: null });
    const again = (await worker.claim())!;
    cloud.failNext(1, 503, "/api/internal/v1/billing/check");
    expect((await worker.heartbeat(again)).body).toMatchObject({
      should_stop: false,
    });
  });
});
