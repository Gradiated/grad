import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCloudBilling } from "../src/cloud/billing.js";
import { createCloudPrices, pricedCatalog } from "../src/cloud/prices.js";
import { createModelCatalog } from "../src/catalog.js";
import { ApiError } from "../src/errors.js";
import { amountNanoUsd, MAX_UNNAMED_REFUSALS } from "../src/services/usage.js";
import { metrics } from "../src/telemetry/metrics.js";
import {
  makeTestApp,
  TEST_JUDGE,
  TEST_JUDGES_JSON,
  TINY_MODELS_JSON,
  WORKSPACE_A,
  type TestApp,
} from "./fixtures/app.js";
import { ManualClock } from "./fixtures/clock.js";
import {
  cloudBillingDeps,
  startTestCloud,
  TEST_PRICES,
  usageCommitted,
} from "./fixtures/cloud.js";
import type { FakeCloudApi } from "./fixtures/fake-cloud-api.js";
import { fileSchemaName, postgresUrl, sql } from "./fixtures/postgres.js";
import { createSftRun, FakeWorker } from "./fixtures/worker.js";

const lag = async (): Promise<number> =>
  (await metrics.usageExportLag.get()).values[0]?.value ?? 0;

const priceAge = async (): Promise<number | undefined> =>
  (await metrics.priceListAge.get()).values[0]?.value;

const checks = async (op: string, result: string): Promise<number> =>
  (await metrics.billingChecks.get()).values
    .filter((v) => {
      const l = v.labels as Record<string, unknown>;
      return l.op === op && l.result === result;
    })
    .reduce((sum, v) => sum + v.value, 0);

describe("Cloud price list", () => {
  let cloud: FakeCloudApi;
  let clock: ManualClock;

  beforeEach(async () => {
    cloud = await startTestCloud();
    clock = new ManualClock();
  });
  afterEach(() => cloud.close());

  const prices = () =>
    createCloudPrices({
      url: cloud.pricesUrl,
      token: cloud.serviceToken,
      clock,
    });

  it("polls every 5 min with If-None-Match, keeps the last good list through an outage, then goes stale", async () => {
    const p = prices();
    expect(p.current()).toBeNull();
    expect(p.fresh()).toBe(false);
    expect(await p.refresh()).toBe(true);
    expect(p.current()?.version).toBe("pv_1");
    expect(p.current()?.skus.get("train:test/tiny-qwen3")).toBe(1e9);

    // Not due yet: no request.
    expect(await p.refresh()).toBe(true);
    expect(cloud.callsTo("/api/internal/v1/billing/prices")).toHaveLength(1);
    clock.advanceSeconds(301);
    expect(await p.refresh()).toBe(true);
    const calls = cloud.callsTo("/api/internal/v1/billing/prices");
    expect(calls).toHaveLength(2);

    cloud.setPrices("pv_2", { ...TEST_PRICES, "train:test/tiny-qwen3": 3e9 });
    clock.advanceSeconds(301);
    await p.refresh();
    expect(p.current()?.version).toBe("pv_2");

    cloud.failNext(100, 503, "/api/internal/v1/billing/prices");
    clock.advanceSeconds(301);
    expect(await p.refresh()).toBe(false);
    expect(p.current()?.version).toBe("pv_2");
    expect(p.fresh()).toBe(true);
    // Backoff: the next try waits 30 s.
    expect(await p.refresh()).toBe(true);
    clock.advanceSeconds(24 * 3600);
    await p.refresh(true);
    expect(p.fresh()).toBe(false);
    expect(p.current()?.version).toBe("pv_2");
    // grad_price_list_age_seconds: since the list was last confirmed.
    expect(await priceAge()).toBe(301 + 24 * 3600);
  });

  it("rejects a malformed list and keeps the previous one", async () => {
    const p = prices();
    await p.refresh(true);
    cloud.respondOnce("/api/internal/v1/billing/prices", 200, {
      price_version: "pv_x",
      skus: [{ sku: "train:a", price_nano_usd_per_mtok: 1.5 }],
    });
    expect(await p.refresh(true)).toBe(false);
    expect(p.current()?.version).toBe("pv_1");
  });

  it("prices the catalog: trainable only with a train SKU, judges at inference SKUs", async () => {
    const p = prices();
    const catalog = pricedCatalog(
      createModelCatalog(TINY_MODELS_JSON, TEST_JUDGES_JSON),
      p,
    );
    // No list yet: lookups are retryable 503s, never "unknown model".
    expect(() => catalog.list()).toThrow(
      expect.objectContaining({ status: 503, code: "billing_unavailable" }),
    );
    expect(() => catalog.find("test/tiny-qwen3")).toThrow(ApiError);
    expect(catalog.priceFor("test/tiny-qwen3")).toBeUndefined();
    expect(catalog.priceVersion).toBe("unpriced");
    await p.refresh(true);

    expect(catalog.list().map((m) => m.id)).toEqual([
      "test/tiny-qwen3",
      "test/tiny-qwen3-teacher",
    ]);
    expect(catalog.priceFor("test/tiny-qwen3")).toBe(1);
    expect(catalog.find("qwen/qwen3-8b")).toBeUndefined();
    expect(catalog.judgePriceFor(TEST_JUDGE)).toBe(10);
    expect(catalog.judgePriceFor("unpriced/judge")).toBeUndefined();
    expect(catalog.judgeModels()).toEqual([TEST_JUDGE, "test/tiny-qwen3"]);
    expect(catalog.priceVersion).toBe("pv_1");
    expect(catalog.defaultModelFor("sft")).toBeUndefined();
    expect(catalog.charsPerToken("test/tiny-qwen3")).toBe(4);
  });
});

describe("Cloud billing: balance check, stop on balance, usage push", () => {
  let cloud: FakeCloudApi;
  let t: TestApp | undefined;

  beforeEach(async () => {
    cloud = await startTestCloud();
  });
  afterEach(async () => {
    await t?.close();
    t = undefined;
    await cloud.close();
  });

  it("checks the balance in nano-USD and says why it refuses", async () => {
    const clock = new ManualClock();
    const { billing } = await cloudBillingDeps(cloud, clock);
    const before = {
      allowed: await checks("start", "allowed"),
      refused: await checks("start", "refused"),
      error: await checks("start", "error"),
      continueError: await checks("continue", "error"),
    };
    expect(await billing.checkCanStartRun(WORKSPACE_A, 1.5)).toEqual({
      allowed: true,
    });
    expect(cloud.callsTo("/api/internal/v1/billing/check")[0]?.body).toEqual({
      workspace_id: WORKSPACE_A,
      estimated_amount_nano_usd: 1_500_000_000,
    });

    cloud.balances.set(WORKSPACE_A, 1_000_000_000);
    expect(await billing.checkCanStartRun(WORKSPACE_A, 1.5)).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/balance does not cover/),
    });
    expect(await billing.checkCanStartRun("ws_unknown", 1)).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/does not know/),
    });
    cloud.suspended.add(WORKSPACE_A);
    expect(await billing.checkCanStartRun(WORKSPACE_A, 0)).toMatchObject({
      reason: expect.stringMatching(/suspended/),
    });

    cloud.failNext(1, 500, "/api/internal/v1/billing/check");
    await expect(
      billing.checkCanStartRun(WORKSPACE_A, 1),
    ).rejects.toMatchObject({ status: 503, code: "billing_unavailable" });
    const dead = createCloudBilling({
      baseUrl: "http://127.0.0.1:9/billing",
      token: "t",
      prices: {
        current: () => null,
        fresh: () => true,
        refresh: async () => true,
      },
      clock,
      timeoutMs: 500,
    });
    await expect(dead.checkCanStartRun("ws", 1)).rejects.toBeInstanceOf(
      ApiError,
    );
    // A billing outage never stops running work.
    expect(await dead.canContinue?.("ws")).toBe(true);
    // grad_billing_checks_total by op and result.
    expect(await checks("start", "allowed")).toBe(before.allowed + 1);
    expect(await checks("start", "refused")).toBe(before.refused + 3);
    expect(await checks("start", "error")).toBe(before.error + 2);
    expect(await checks("continue", "error")).toBe(before.continueError + 1);
  });

  it("refuses new runs with 503 billing_unavailable once the price list is stale", async () => {
    const clock = new ManualClock();
    t = await makeTestApp({ clock, ...(await cloudBillingDeps(cloud, clock)) });
    await createSftRun(t);
    cloud.failNext(1000, 503, "/api/internal/v1/billing/prices");
    clock.advanceSeconds(24 * 3600 + 1);
    const res = await t.json("/v1/runs", {
      body: {
        dataset: "support",
        name: "support-sft-2",
        recipe: { kind: "sft", model: "test/tiny-qwen3", batch_size: 4 },
      },
    });
    expect(res.body).toMatchObject({ code: "billing_unavailable" });
    expect(res.status).toBe(503);
  });

  it("bills a run at the price version it was created with, after the list changes", async () => {
    const clock = new ManualClock();
    t = await makeTestApp({
      clock,
      ...(await cloudBillingDeps(cloud, clock)),
      settings: { maxAttempts: 3, usageFlushTokens: 1000 },
    });
    const run = await createSftRun(t);
    expect((await t.deps.store.runs.getById(run.id))?.price_version).toBe(
      "pv_1",
    );
    cloud.setPrices("pv_2", { ...TEST_PRICES, "train:test/tiny-qwen3": 5e9 });
    clock.advanceSeconds(301);
    await t.services.maintenance.tick();
    expect(t.deps.catalog.priceVersion).toBe("pv_2");

    const worker = new FakeWorker(t);
    const job = (await worker.claim())!;
    await worker.complete(
      job,
      { status: "completed", tokens_processed: 1234 },
      "a",
    );
    await usageCommitted();
    await t.services.maintenance.tick();
    expect(cloud.usageEvents).toEqual([
      expect.objectContaining({
        price_version: "pv_1",
        quantity: 1234,
        amount_nano_usd: amountNanoUsd(1234, 1e9),
      }),
    ]);
  });

  it("keeps rows in the ledger while ingest is down, backs off, reports lag, then drains", async () => {
    const clock = new ManualClock();
    t = await makeTestApp({
      clock,
      ...(await cloudBillingDeps(cloud, clock)),
      settings: { maxAttempts: 3, usageFlushTokens: 1000 },
    });
    await createSftRun(t);
    const worker = new FakeWorker(t);
    const job = (await worker.claim())!;
    cloud.failNext(1, 503, "/api/internal/v1/billing/usage-events");
    await worker.progress(job, 1, 1500);
    await usageCommitted();
    expect((await t.services.maintenance.tick()).exportedUsage).toBe(0);
    clock.advanceSeconds(10);
    // Backing off (15 s): no push this tick.
    expect((await t.services.maintenance.tick()).exportedUsage).toBe(0);
    expect(cloud.callsTo("/api/internal/v1/billing/usage-events")).toHaveLength(
      1,
    );
    expect((await metrics.usageExportPending.get()).values[0]?.value).toBe(1);
    expect(await lag()).toBeGreaterThanOrEqual(10);

    // Training goes on meanwhile.
    expect((await worker.heartbeat(job)).body).toMatchObject({
      should_stop: false,
    });
    clock.advanceSeconds(10);
    expect((await t.services.maintenance.tick()).exportedUsage).toBe(1);
    expect(cloud.usageEvents).toHaveLength(1);
    expect(await lag()).toBe(0);
  });

  it("a row ingest refuses for good (422, 409) is parked; the rest go on and parked rows retry by hand", async () => {
    const clock = new ManualClock();
    t = await makeTestApp({
      clock,
      ...(await cloudBillingDeps(cloud, clock)),
    });
    const record = (key: string, amountNanoUsd: number) =>
      t!.deps.store.usage.record({
        idempotencyKey: key,
        workspaceId: WORKSPACE_A,
        kind: "run",
        refId: "run_x",
        attempt: 1,
        tokensFrom: 0,
        tokensThrough: 10,
        costUsd: 0.00001,
        amountNanoUsd,
        priceVersion: "pv_1",
        sku: "train:test/tiny-qwen3",
      });
    const good = amountNanoUsd(10, 1e9);
    const parked = async () =>
      (await metrics.usageParkedRows.get()).values[0]?.value;
    await record("run-usage:run_x:1:1", good);
    // Billing ingest prices it differently: 422 price_mismatch.
    await record("run-usage:run_x:1:2", 7);
    await record("run-usage:run_x:1:3", good);
    await usageCommitted();
    expect(await t.services.usage.exportPending()).toBe(2);
    expect(cloud.usageEvents.map((e) => e.event_id)).toEqual([
      "training:run-usage:run_x:1:1",
      "training:run-usage:run_x:1:3",
    ]);
    expect(await parked()).toBe(1);
    expect(await t.deps.store.usage.exportBacklog()).toMatchObject({
      rows: 0,
      parked: 1,
    });
    const [mark] = await sql(
      "SELECT parked_code, parked_at FROM grad_usage WHERE idempotency_key = $1",
      ["run-usage:run_x:1:2"],
    );
    expect(mark?.parked_code).toBe("price_mismatch");
    expect(mark?.parked_at).toBeInstanceOf(Date);

    // No backoff: the next row goes out on the next tick; the parked one is
    // never pushed again by itself.
    await record("run-usage:run_x:1:4", good);
    await usageCommitted();
    const calls = cloud.callsTo("/api/internal/v1/billing/usage-events").length;
    expect(await t.services.usage.exportPending()).toBe(1);
    expect(
      cloud.callsTo("/api/internal/v1/billing/usage-events").slice(calls),
    ).toHaveLength(1);

    // 409 event_conflict: billing already has this event id with other
    // content. Parked the same way.
    cloud.usageEvents.push({
      ...cloud.usageEvents[0]!,
      event_id: "training:run-usage:run_x:1:5",
      quantity: 99,
    });
    await record("run-usage:run_x:1:5", good);
    await usageCommitted();
    expect(await t.services.usage.exportPending()).toBe(0);
    expect(await parked()).toBe(2);

    // Retry by hand (docs/CLOUD_MODE.md), once billing's price is fixed: the
    // re-stamped rows are ahead of the cursor again.
    cloud.usageEvents.pop();
    await sql(
      `UPDATE grad_usage SET parked_code = NULL, parked_at = NULL, txid = pg_current_xact_id()
        WHERE parked_at IS NOT NULL AND parked_code = 'event_conflict'`,
    );
    await usageCommitted();
    expect(await t.services.usage.exportPending()).toBe(1);
    expect(cloud.usageEvents.at(-1)?.event_id).toBe(
      "training:run-usage:run_x:1:5",
    );
    expect(await parked()).toBe(1);
  });

  it("a refusal that names no row of the batch is narrowed down row by row", async () => {
    const clock = new ManualClock();
    t = await makeTestApp({
      clock,
      ...(await cloudBillingDeps(cloud, clock)),
    });
    for (const [i, amount] of [amountNanoUsd(10, 1e9), 7].entries()) {
      await t.deps.store.usage.record({
        idempotencyKey: `run-usage:run_y:1:${i}`,
        workspaceId: WORKSPACE_A,
        kind: "run",
        refId: "run_y",
        attempt: 1,
        tokensFrom: 0,
        tokensThrough: 10,
        costUsd: 0.00001,
        amountNanoUsd: amount,
        priceVersion: "pv_1",
        sku: "train:test/tiny-qwen3",
      });
    }
    await usageCommitted();
    // A refusal without an event_id (a proxy, an older ingest).
    cloud.failNext(1, 422, "/api/internal/v1/billing/usage-events");
    expect(await t.services.usage.exportPending()).toBe(1);
    expect(cloud.usageEvents.map((e) => e.event_id)).toEqual([
      "training:run-usage:run_y:1:0",
    ]);
    expect((await t.deps.store.usage.exportBacklog()).parked).toBe(1);
  });

  it("unnamed one-row refusals past the cap are a contract break: it backs off and parks nothing", async () => {
    const clock = new ManualClock();
    t = await makeTestApp({
      clock,
      ...(await cloudBillingDeps(cloud, clock)),
    });
    const rows = MAX_UNNAMED_REFUSALS + 5;
    for (let i = 0; i < rows; i += 1) {
      await t.deps.store.usage.record({
        idempotencyKey: `run-usage:run_w:1:${i}`,
        workspaceId: WORKSPACE_A,
        kind: "run",
        refId: "run_w",
        attempt: 1,
        tokensFrom: 0,
        tokensThrough: 10,
        costUsd: 0.00001,
        amountNanoUsd: amountNanoUsd(10, 1e9),
        priceVersion: "pv_1",
        sku: "train:test/tiny-qwen3",
      });
    }
    await usageCommitted();
    const failures = async () =>
      (await metrics.usageExportFailures.get()).values[0]?.value ?? 0;
    const before = await failures();
    const path = "/api/internal/v1/billing/usage-events";
    const calls = cloud.callsTo(path).length;
    // Ingest refuses every request without naming a row (an envelope change).
    cloud.failNext(1000, 422, path);
    expect(await t.services.usage.exportPending()).toBe(0);
    // The batch, then MAX_UNNAMED_REFUSALS + 1 single rows; then it stops.
    expect(cloud.callsTo(path).length - calls).toBe(MAX_UNNAMED_REFUSALS + 2);
    expect(await t.deps.store.usage.exportBacklog()).toMatchObject({
      rows,
      parked: 0,
    });
    expect(await failures()).toBe(before + 1);

    // Backed off like any failed push; once ingest takes them, all go out.
    cloud.clearFaults();
    expect(await t.services.usage.exportPending()).toBe(0);
    clock.advanceSeconds(16);
    expect(await t.services.usage.exportPending()).toBe(rows);
    expect(await t.deps.store.usage.exportBacklog()).toMatchObject({
      rows: 0,
      parked: 0,
    });
  });

  it("a transient failure while parking keeps the cursor: nothing is skipped", async () => {
    const clock = new ManualClock();
    t = await makeTestApp({
      clock,
      ...(await cloudBillingDeps(cloud, clock)),
    });
    for (const [i, amount] of [7, amountNanoUsd(10, 1e9)].entries()) {
      await t.deps.store.usage.record({
        idempotencyKey: `run-usage:run_z:1:${i}`,
        workspaceId: WORKSPACE_A,
        kind: "run",
        refId: "run_z",
        attempt: 1,
        tokensFrom: 0,
        tokensThrough: 10,
        costUsd: 0.00001,
        amountNanoUsd: amount,
        priceVersion: "pv_1",
        sku: "train:test/tiny-qwen3",
      });
    }
    await usageCommitted();
    // The first push is refused (parks row 0); the retry of the rest is a 503.
    cloud.respondOnce("/api/internal/v1/billing/usage-events", 422, {
      code: "price_mismatch",
      event_id: "training:run-usage:run_z:1:0",
    });
    cloud.respondOnce("/api/internal/v1/billing/usage-events", 503, {
      detail: "down",
    });
    expect(await t.services.usage.exportPending()).toBe(0);
    expect(await t.deps.store.usage.exportBacklog()).toMatchObject({
      rows: 2,
      parked: 0,
    });
    clock.advanceSeconds(16);
    expect(await t.services.usage.exportPending()).toBe(1);
    expect(await t.deps.store.usage.exportBacklog()).toMatchObject({
      rows: 0,
      parked: 1,
    });
  });

  it("two replicas push every row exactly once (the cursor is SKIP LOCKED)", async () => {
    const clock = new ManualClock();
    t = await makeTestApp({ clock, ...(await cloudBillingDeps(cloud, clock)) });
    const other = await makeTestApp({
      clock,
      store: t.deps.store,
      ...(await cloudBillingDeps(cloud, clock)),
    });
    try {
      for (let i = 1; i <= 1200; i += 1) {
        await t.deps.store.usage.record({
          idempotencyKey: `run-usage:run_${i}:1:10`,
          workspaceId: WORKSPACE_A,
          kind: "run",
          refId: `run_${i}`,
          attempt: 1,
          tokensFrom: 0,
          tokensThrough: 10,
          costUsd: 0.00001,
          amountNanoUsd: amountNanoUsd(10, 1e9),
          priceVersion: "pv_1",
          sku: "train:test/tiny-qwen3",
        });
      }
      await usageCommitted();
      cloud.setLatency(20);
      const [a, b] = await Promise.all([
        t.services.usage.exportPending(),
        other.services.usage.exportPending(),
      ]);
      cloud.setLatency(0);
      const more =
        (await t.services.usage.exportPending()) +
        (await other.services.usage.exportPending());
      expect(a + b + more).toBe(1200);
      expect(cloud.usageEvents).toHaveLength(1200);
      expect(new Set(cloud.usageEvents.map((e) => e.event_id)).size).toBe(1200);
    } finally {
      await other.close();
    }
  });

  it("never skips a row a slow transaction commits late", async () => {
    const clock = new ManualClock();
    t = await makeTestApp({ clock, ...(await cloudBillingDeps(cloud, clock)) });
    const row = (key: string) => ({
      idempotencyKey: key,
      workspaceId: WORKSPACE_A,
      kind: "run" as const,
      refId: "run_slow",
      attempt: 1,
      tokensFrom: 0,
      tokensThrough: 10,
      costUsd: 0.00001,
      amountNanoUsd: amountNanoUsd(10, 1e9),
      priceVersion: "pv_1",
      sku: "train:test/tiny-qwen3",
    });
    const slow = new pg.Client({
      connectionString: postgresUrl(),
      options: `-c search_path=${await fileSchemaName()}`,
    });
    await slow.connect();
    try {
      await slow.query("BEGIN");
      await slow.query(
        `INSERT INTO grad_usage (idempotency_key, workspace_id, kind, ref_id, attempt,
           tokens_from, tokens_through, tokens, cost_usd, price_version, created_at,
           amount_nano_usd, sku)
         VALUES ('run-usage:run_slow:1:5', $1, 'run', 'run_slow', 1, 0, 5, 5, 0, 'pv_1',
                 now(), 5000, 'train:test/tiny-qwen3')`,
        [WORKSPACE_A],
      );
      await t.deps.store.usage.record(row("run-usage:run_fast:1:10"));
      // The open transaction holds back everything after it.
      expect(await t.services.usage.exportPending()).toBe(0);
      await slow.query("COMMIT");
      await usageCommitted();
      expect(await t.services.usage.exportPending()).toBe(2);
      expect(cloud.usageEvents.map((e) => e.event_id)).toEqual([
        "training:run-usage:run_slow:1:5",
        "training:run-usage:run_fast:1:10",
      ]);
    } finally {
      await slow.end();
    }
  });

  it("never pushes rows the gateway bills (Cloud evals)", async () => {
    const clock = new ManualClock();
    t = await makeTestApp({
      clock,
      ...(await cloudBillingDeps(cloud, clock, { gatewayBillsEvals: true })),
    });
    await t.deps.store.usage.record({
      idempotencyKey: "eval-usage:ev_1:1:10",
      workspaceId: WORKSPACE_A,
      kind: "eval",
      refId: "ev_1",
      attempt: 1,
      tokensFrom: 0,
      tokensThrough: 10,
      costUsd: 0.0001,
      priceVersion: "pv_1",
      billedBy: "gateway",
    });
    expect(await t.services.usage.exportPending()).toBe(0);
    expect(cloud.callsTo("/api/internal/v1/billing/usage-events")).toEqual([]);
    const usage = await t.json<{ data: Array<{ billed_by: string }> }>(
      "/v1/usage",
    );
    expect(usage.body.data.map((u) => u.billed_by)).toEqual(["gateway"]);
  });
});
