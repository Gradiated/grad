import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedRunConfig } from "../src/contracts.js";
import { ApiError } from "../src/errors.js";
import { queueView, type QueueLimits } from "../src/services/jobs.js";
import type { JobRow, QueueSnapshot, Store } from "../src/store/types.js";
import { metrics, registry } from "../src/telemetry/metrics.js";
import { makeTestApp, type TestApp } from "./fixtures/app.js";
import { ManualClock } from "./fixtures/clock.js";
import {
  createTestStore,
  fileSchemaName,
  postgresUrl,
} from "./fixtures/postgres.js";
import { createSftRun, FakeWorker, sftRecords } from "./fixtures/worker.js";

const config = { model: "test/tiny" } as unknown as ResolvedRunConfig;
const caps = (n: number): QueueLimits["maxRunning"] => ({
  train: n,
  import: n,
  eval: n,
});

describe("fair claims (store)", () => {
  let clock: ManualClock;
  let store: Store;
  let dispose: () => Promise<void>;

  beforeEach(async () => {
    clock = new ManualClock();
    ({ store, dispose } = await createTestStore(clock));
  });

  afterEach(async () => {
    await dispose();
  });

  const datasets = new Map<string, string>();
  const queueRun = async (
    ws: string,
    extra: { minGpuMemoryGb?: number; maxQueued?: number } = {},
  ) => {
    let datasetId = datasets.get(ws);
    if (!datasetId || !(await store.datasets.getById(ws, datasetId))) {
      datasetId = (
        await store.datasets.getOrCreate({
          workspaceId: ws,
          name: "ds",
          metadata: {},
        })
      ).id;
      datasets.set(ws, datasetId);
    }
    // Distinct created_at: FIFO order inside a workspace is by age.
    clock.advanceSeconds(1);

    return store.runs.create({
      workspaceId: ws,
      name: "run",
      datasetId,
      datasetName: "ds",
      datasetVersion: 0,
      recipeKind: "sft",
      resolvedConfig: config,
      maxCostUsd: null,
      pricePerMillionTokens: 0.4,
      totalSteps: 10,
      maxAttempts: 3,
      ...extra,
    });
  };

  const claim = (
    workerId: string,
    extra: Partial<Parameters<Store["jobs"]["claimNext"]>[0]> = {},
  ) =>
    store.jobs.claimNext({
      workerId,
      workerKey: "k",
      leaseSeconds: 60,
      now: clock.now(),
      kinds: ["train"],
      maxRunning: caps(8),
      ...extra,
    });

  const finish = (job: JobRow) =>
    store.jobs.update(job.id, {
      status: "completed",
      worker_id: null,
      worker_key: null,
      lease_expires_at: null,
      finished_at: clock.now().toISOString(),
    });

  it("a workspace with 2 queued runs starts both within the first round of 4 workers, behind one with 50", async () => {
    const big = [];
    for (let i = 0; i < 50; i += 1) big.push(await queueRun("ws_big"));
    const small = [await queueRun("ws_small"), await queueRun("ws_small")];

    const round = await Promise.all(
      ["w1", "w2", "w3", "w4"].map((w) => claim(w)),
    );
    const ids = round.map((j) => j?.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids).toEqual(expect.arrayContaining(small.map((r) => r.id)));
    // The other two are the big workspace's oldest, in order.
    expect(ids.filter((id) => !small.some((r) => r.id === id)).sort()).toEqual(
      [big[0]?.id, big[1]?.id].sort(),
    );
  });

  it("orders by fewest running, then the oldest queued job", async () => {
    const a1 = await queueRun("ws_a");
    const a2 = await queueRun("ws_a");
    const b1 = await queueRun("ws_b");
    const c1 = await queueRun("ws_c");
    // Sequential claims alternate: a1 (oldest), then b1 and c1 (0 running), then a2.
    const order = [];
    for (let i = 0; i < 4; i += 1) order.push((await claim(`w${i}`))?.id);
    expect(order).toEqual([a1.id, b1.id, c1.id, a2.id]);
    expect(await claim("w9")).toBeNull();
  });

  it("caps running jobs per workspace and kind; the rest wait, other workspaces go on", async () => {
    for (let i = 0; i < 5; i += 1) await queueRun("ws_a");
    const b = await queueRun("ws_b");
    const got = [];
    for (let i = 0; i < 4; i += 1) {
      got.push(await claim(`w${i}`, { maxRunning: caps(2) }));
    }
    // ws_a first (oldest), then ws_b (fewer running), then ws_a up to its cap.
    expect(got.map((j) => j?.workspace_id ?? null)).toEqual([
      "ws_a",
      "ws_b",
      "ws_a",
      null,
    ]);
    expect(got[1]?.id).toBe(b.id);
    // A finished job frees a slot.
    await finish(got[0] as JobRow);
    expect((await claim("w5", { maxRunning: caps(2) }))?.workspace_id).toBe(
      "ws_a",
    );
  });

  it("8 parallel claimers never double-claim or pass a workspace's cap", async () => {
    for (const ws of ["ws_a", "ws_b", "ws_c"]) {
      for (let i = 0; i < 6; i += 1) await queueRun(ws);
    }
    const seen = new Set<string>();
    const running = new Map<string, JobRow[]>();
    for (let round = 0; round < 4; round += 1) {
      const claimed = (
        await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            claim(`w${round}-${i}`, { maxRunning: caps(2) }),
          ),
        )
      ).filter((j): j is JobRow => j !== null);
      for (const job of claimed) {
        expect(seen.has(job.id)).toBe(false);
        seen.add(job.id);
        running.set(job.workspace_id, [
          ...(running.get(job.workspace_id) ?? []),
          job,
        ]);
      }
      for (const [, jobs] of running)
        expect(jobs.length).toBeLessThanOrEqual(2);
      // Each round, every workspace finishes one job.
      for (const [ws, jobs] of running) {
        const [done, ...rest] = jobs;
        if (done) await finish(done);
        running.set(ws, rest);
      }
    }
    expect(seen.size).toBe(3 * 2 + 3 * 3);
  });

  it("claims only train jobs whose min_gpu_memory_gb fits the worker's GPU", async () => {
    const big = await queueRun("ws_a", { minGpuMemoryGb: 46 });
    const any = await queueRun("ws_a");
    expect((await claim("w24", { gpuMemoryGb: 24 }))?.id).toBe(any.id);
    expect(await claim("w24b", { gpuMemoryGb: 24 })).toBeNull();
    // Without a reported GPU (a CPU or older worker) nothing is filtered.
    expect((await claim("w80", { gpuMemoryGb: 80 }))?.id).toBe(big.id);
  });

  it("refuses a create past the queued cap with 429 queue_limit, under concurrency too", async () => {
    await queueRun("ws_a", { maxQueued: 3 });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => queueRun("ws_a", { maxQueued: 3 })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    const refused = results.flatMap((r) =>
      r.status === "rejected" ? [r.reason as ApiError] : [],
    );
    expect(refused).toHaveLength(4);
    expect(refused[0]).toMatchObject({ status: 429, code: "queue_limit" });
    // Another workspace is unaffected; claimed jobs no longer count.
    await queueRun("ws_b", { maxQueued: 3 });
    await claim("w1");
    await queueRun("ws_a", { maxQueued: 3 });
  });

  it("reports online workers' GPUs and the unfit gauge", async () => {
    await queueRun("ws_a", { minGpuMemoryGb: 46 });
    const now = clock.now();
    await store.jobs.seeWorker({
      id: "gpu-24",
      kinds: ["train"],
      device: "gpu",
      gpuMemoryGb: 24,
      now,
    });
    await store.jobs.seeWorker({
      id: "cpu-1",
      kinds: ["import"],
      device: "cpu",
      gpuMemoryGb: null,
      now,
    });
    const snap = await store.jobs.queueSnapshot("train", [], now);
    expect(snap.workerGpus).toEqual([24]);
    expect(
      (await store.telemetry.snapshot(now, { byWorkspace: false })).unfit,
    ).toBe(1);
    // Unseen for a minute and holding no lease: offline, then forgotten.
    clock.advanceSeconds(61);
    expect(
      (await store.jobs.queueSnapshot("train", [], clock.now())).workerGpus,
    ).toEqual([]);
    expect(await store.jobs.pruneWorkers(clock.now())).toBe(2);
  });

  it("gauges: jobs held back by a cap, and the fair-share wait", async () => {
    for (let i = 0; i < 4; i += 1) await queueRun("ws_a");
    await queueRun("ws_b");
    await claim("w1", { maxRunning: caps(1) });
    await claim("w2", { maxRunning: caps(1) });
    clock.advanceSeconds(30);
    const snap = await store.telemetry.snapshot(clock.now(), {
      byWorkspace: false,
      maxRunning: caps(1),
    });
    // ws_a: 1 running, 3 queued, all held back; ws_b's only job runs.
    expect(snap.queue).toEqual([
      { kind: "train", over_limit: 3, fair_share_wait_seconds: null },
    ]);
    const uncapped = await store.telemetry.snapshot(clock.now(), {
      byWorkspace: false,
      maxRunning: caps(8),
    });
    expect(uncapped.queue[0]?.over_limit).toBe(0);
    expect(uncapped.queue[0]?.fair_share_wait_seconds).toBeGreaterThanOrEqual(
      30,
    );
  });

  it("claims stay fast with 10k queued jobs across 100 workspaces", async () => {
    // 100 workspaces x ~100 queued train jobs, 50 running, 50k finished.
    await sql(`
      INSERT INTO grad_jobs (id, workspace_id, kind, status, max_attempts, payload, created_at, updated_at)
      SELECT 'run_bench_' || g, 'ws_' || (g % 100), 'train',
             CASE WHEN g < 50 THEN 'running' ELSE 'queued' END, 3, '{}'::jsonb,
             now() - make_interval(secs => 20000 - g), now()
      FROM generate_series(0, 10049) g`);
    await sql(`
      INSERT INTO grad_jobs (id, workspace_id, kind, status, max_attempts, payload, created_at, updated_at)
      SELECT 'run_done_' || g, 'ws_' || (g % 100), 'train', 'completed', 3, '{}'::jsonb,
             now() - interval '1 day', now()
      FROM generate_series(0, 49999) g`);
    await sql("ANALYZE grad_jobs");
    const timed = async (workerId: string) => {
      const start = performance.now();
      const job = await claim(workerId);
      expect(job).not.toBeNull();
      return performance.now() - start;
    };
    const stats = (ms: number[]) => {
      const sorted = [...ms].sort((a, b) => a - b);
      const at = (q: number) =>
        (
          sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ??
          0
        ).toFixed(1);
      return `p50 ${at(0.5)} ms, p95 ${at(0.95)} ms, max ${at(1)} ms`;
    };
    const sequential: number[] = [];
    for (let i = 0; i < 40; i += 1) sequential.push(await timed(`seq-${i}`));
    const parallel: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      parallel.push(
        ...(await Promise.all(
          Array.from({ length: 8 }, (_, i) => timed(`par-${round}-${i}`)),
        )),
      );
    }
    console.log(
      `claim latency, 10k queued / 100 workspaces: one claimer ${stats(sequential)}; 8 parallel claimers ${stats(parallel)}`,
    );
    // Generous bound for a shared CI host; the measured numbers are logged.
    expect([...sequential].sort((a, b) => a - b)[20]).toBeLessThan(250);
  });
});

/** Runs SQL in this file's schema on its own connection. */
const sql = async (text: string, params: unknown[] = []): Promise<void> => {
  const client = new pg.Client({ connectionString: postgresUrl() });
  await client.connect();
  try {
    await client.query(`SET search_path TO "${await fileSchemaName()}"`);
    await client.query(text, params);
  } finally {
    await client.end();
  }
};

describe("queueView", () => {
  const job = (id: string, ws: string, need: number | null = null) => ({
    id,
    workspace_id: ws,
    min_gpu_memory_gb: need,
  });
  const snap = (over: Partial<QueueSnapshot>): QueueSnapshot => ({
    shares: [],
    ranks: {},
    workerGpus: [],
    cpuWorkers: 0,
    ...over,
  });

  it("counts other workspaces' jobs that start first under fair share", () => {
    const s = snap({
      shares: [
        {
          workspace_id: "big",
          queued: 50,
          running: 2,
          oldest: "2026-01-01T00:00:00.000Z",
        },
        {
          workspace_id: "me",
          queued: 3,
          running: 0,
          oldest: "2026-01-02T00:00:00.000Z",
        },
        {
          workspace_id: "idle",
          queued: 1,
          running: 0,
          oldest: "2026-01-03T00:00:00.000Z",
        },
      ],
      ranks: { first: 0, third: 2 },
    });
    expect(queueView(job("first", "me"), s, 8, "run")).toEqual({
      queue_position: 0,
      queue_message: null,
    });
    // Claims go me, idle, me, then big (2 running; its older head wins the
    // tie), then "third": 2 of its own plus 1 each from idle and big.
    expect(queueView(job("third", "me"), s, 8, "run")).toEqual({
      queue_position: 4,
      queue_message: "Queued behind 4 runs",
    });
    // big's next job waits for me's first two and idle's one.
    expect(
      queueView(job("x", "big"), snap({ ...s, ranks: { x: 0 } }), 8, "run")
        .queue_position,
    ).toBe(3);
    // A capped workspace starts at most cap - running of its jobs first.
    expect(queueView(job("third", "me"), s, 3, "run").queue_position).toBe(4);
    expect(queueView(job("third", "me"), s, 2, "run").queue_position).toBe(3);
  });

  it("names a workspace cap before anything else", () => {
    const s = snap({
      shares: [{ workspace_id: "me", queued: 2, running: 8, oldest: null }],
      ranks: { r: 1 },
    });
    expect(queueView(job("r", "me"), s, 8, "run").queue_message).toBe(
      "Queued: workspace concurrency limit (8 running)",
    );
  });

  it("says when no online worker has the GPU memory", () => {
    const s = snap({ workerGpus: [24, 23.5, 24] });
    expect(queueView(job("r", "me", 46), s, 8, "run").queue_message).toBe(
      "Waiting for a GPU with ≥46 GB; online workers have 23.5 GB, 24 GB",
    );
    // A CPU (unfiltered) worker or no worker at all: no GPU message.
    expect(
      queueView(job("r", "me", 46), snap({ workerGpus: [24, null] }), 8, "run")
        .queue_message,
    ).toBeNull();
    expect(
      queueView(job("r", "me", 46), snap({}), 8, "run").queue_message,
    ).toBeNull();
  });
});

describe("fair queue over HTTP", () => {
  let t: TestApp;

  afterEach(async () => {
    await t.close();
  });

  const app = (queue: { maxRunning?: number; maxQueued?: number }) =>
    makeTestApp({
      settings: {
        maxAttempts: 3,
        waitingForComputeSeconds: 30,
        queue: {
          maxRunning: { train: queue.maxRunning ?? 8 },
          maxQueued: queue.maxQueued ?? 500,
        },
      },
    });

  const counter = async (name: string) =>
    (await registry.getSingleMetricAsString(name))
      .split("\n")
      .filter((l) => l.startsWith(name))
      .reduce((n, l) => n + Number(l.split(" ").at(-1)), 0);

  it("answers 429 queue_limit past the queued cap", async () => {
    t = await app({ maxQueued: 2 });
    await createSftRun(t, { name: "a" });
    await createSftRun(t, { name: "b" });
    const before = await counter("grad_queue_limit_rejections_total");
    const res = await t.json<{ code: string; detail: string; status: number }>(
      "/v1/runs",
      {
        body: {
          dataset: "support",
          name: "c",
          recipe: { kind: "sft", model: "test/tiny-qwen3", batch_size: 4 },
        },
      },
    );
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("queue_limit");
    expect(res.body.detail).toContain("already has 2 queued jobs");
    expect(await counter("grad_queue_limit_rejections_total")).toBe(before + 1);
    // Imports count against the same cap.
    const imp = await t.json<{ code: string }>("/v1/datasets/support/imports", {
      body: { source: { kind: "hf", repo: "o/n" } },
    });
    expect(imp.status).toBe(429);
    expect(imp.body.code).toBe("queue_limit");
  });

  it("warns when only CPU workers are online for a GPU-sized base model", async () => {
    t = await app({});
    await t.json("/v1/datasets/support/records", {
      body: { records: sftRecords(20) },
    });
    const warnings = async (model: string) =>
      (
        await t.json<{ warnings: string[] }>("/v1/runs/plan", {
          body: {
            dataset: "support",
            name: "p",
            recipe: { kind: "sft", model, batch_size: 4 },
          },
        })
      ).body.warnings.filter((w) => w.includes("CPU-only"));
    // No worker online yet: nothing to say.
    expect(await warnings("qwen/qwen3-8b")).toEqual([]);
    await new FakeWorker(t, "local-cpu-trainer").claim({
      kinds: ["train"],
      device: "cpu",
    });
    const [warning] = await warnings("qwen/qwen3-8b");
    expect(warning).toContain("qwen/qwen3-8b is sized for a GPU");
    expect(warning).toContain("grad local up --gpu");
    expect(await warnings("test/tiny-qwen3")).toEqual([]);
    // A GPU worker online: the run will land there.
    await new FakeWorker(t, "gpu-1").claim({
      kinds: ["train"],
      device: "gpu",
      gpu: { name: "NVIDIA H100", memory_gb: 80 },
    });
    expect(await warnings("qwen/qwen3-8b")).toEqual([]);
  });

  it("shows the queue position, the cap reason and the GPU reason on the run", async () => {
    t = await app({ maxRunning: 1 });
    await t.json("/v1/datasets/support/records", {
      body: { records: sftRecords(20) },
    });
    const create = async (name: string) =>
      (
        await t.json<{ id: string }>("/v1/runs", {
          body: {
            dataset: "support",
            name,
            recipe: { kind: "sft", model: "test/tiny-qwen3", batch_size: 4 },
          },
        })
      ).body;
    const first = await create("one");
    t.clock.advanceSeconds(1);
    const second = await create("two");
    const run = async (id: string) =>
      (
        await t.json<{
          queue_position: number | null;
          queue_message: string | null;
          min_gpu_memory_gb: number | null;
        }>(`/v1/runs/${id}`)
      ).body;
    expect(await run(second.id)).toMatchObject({
      queue_position: 1,
      queue_message: "Queued behind 1 run",
      min_gpu_memory_gb: null,
    });
    const events = await t.json<{ data: Array<Record<string, unknown>> }>(
      `/v1/runs/${second.id}/events`,
    );
    expect(events.body.data[0]).toMatchObject({
      type: "phase",
      phase: "queued",
      queue_position: 1,
      message: "Queued behind 1 run",
    });

    const worker = new FakeWorker(t);
    const job = await worker.claim({
      device: "gpu",
      gpu: { name: "L4", memory_gb: 24 },
    });
    expect(job?.id).toBe(first.id);
    expect(await run(second.id)).toMatchObject({
      queue_position: 0,
      queue_message: "Queued: workspace concurrency limit (1 running)",
    });
    // Capped runs don't turn waiting_for_compute: they wait on their workspace.
    t.clock.advanceSeconds(60);
    await t.services.maintenance.tick();
    expect(
      (await t.json<{ phase: string }>(`/v1/runs/${second.id}`)).body.phase,
    ).toBe("queued");
    expect(
      await new FakeWorker(t, "worker-2").claim({
        device: "gpu",
        gpu: { name: "L4", memory_gb: 24 },
      }),
    ).toBeNull();

    // A run needing more GPU memory than any online worker has says so.
    await t.deps.store.jobs.update(first.id, {
      status: "completed",
      worker_id: null,
      worker_key: null,
      lease_expires_at: null,
      finished_at: t.clock.now().toISOString(),
    });
    await sql("UPDATE grad_jobs SET min_gpu_memory_gb = 46 WHERE id = $1", [
      second.id,
    ]);
    await new FakeWorker(t, "w24").claim({
      device: "gpu",
      gpu: { name: "L4", memory_gb: 24 },
    });
    expect(await run(second.id)).toMatchObject({
      min_gpu_memory_gb: 46,
      queue_message: "Waiting for a GPU with ≥46 GB; online workers have 24 GB",
    });
    await t.services.maintenance.tick();
    expect(metrics.jobsUnfit).toBeDefined();
    expect(await counter("grad_jobs_unfit")).toBe(1);
    const h100 = await new FakeWorker(t, "w80").claim({
      device: "gpu",
      gpu: { name: "H100", memory_gb: 80 },
    });
    expect(h100?.id).toBe(second.id);
  });
});
