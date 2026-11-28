import { writeFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedRunConfig } from "../src/contracts.js";
import type { JobRow, Store } from "../src/store/types.js";
import { ManualClock } from "./fixtures/clock.js";
import { createTestStore } from "./fixtures/postgres.js";

/**
 * A mixed GPU fleet draining a mixed queue over simulated hours, through the
 * real claim SQL: no GPU idles while a run it fits is claimable, a run no GPU
 * fits holds nobody up, big runs get the big GPUs first, and a workspace that
 * arrives late starts at the next free GPU, not behind a long queue.
 */

interface Worker {
  id: string;
  gb: number;
  job: SimJob | null;
  busySeconds: number;
}

interface SimJob {
  ws: string;
  gb: number;
  seconds: number;
  submitAt: number;
  id?: string;
  startAt?: number;
  endAt?: number;
  worker?: string;
}

const TICK = 15;

describe("scheduling a mixed fleet (simulation over the claim SQL)", () => {
  let clock: ManualClock;
  let store: Store;
  let dispose: () => Promise<void>;
  let datasetFor: Map<string, string>;

  beforeEach(async () => {
    clock = new ManualClock();
    ({ store, dispose } = await createTestStore(clock));
    datasetFor = new Map();
  });

  afterEach(async () => {
    await dispose();
  });

  const submit = async (job: SimJob) => {
    let datasetId = datasetFor.get(job.ws);
    if (!datasetId) {
      datasetId = (
        await store.datasets.getOrCreate({
          workspaceId: job.ws,
          name: "ds",
          metadata: {},
        })
      ).id;
      datasetFor.set(job.ws, datasetId);
    }
    const run = await store.runs.create({
      workspaceId: job.ws,
      name: "run",
      datasetId,
      datasetName: "ds",
      datasetVersion: 0,
      recipeKind: "sft",
      resolvedConfig: { model: "test/tiny" } as unknown as ResolvedRunConfig,
      maxCostUsd: null,
      pricePerMillionTokens: 0.4,
      totalSteps: 10,
      maxAttempts: 3,
      minGpuMemoryGb: job.gb,
    });
    job.id = run.id;
  };

  /** Runs the fleet until every job a GPU fits is done; returns the elapsed seconds. */
  const simulate = async (fleet: Worker[], jobs: SimJob[], seed = 7) => {
    let rnd = seed;
    const shuffled = <T>(xs: T[]) =>
      xs
        .map((x) => {
          rnd = (rnd * 1103515245 + 12345) % 2 ** 31;
          return [rnd, x] as const;
        })
        .sort((a, b) => a[0] - b[0])
        .map(([, x]) => x);
    const start = clock.now().getTime();
    const byId = new Map<string, SimJob>();
    const fits = (j: SimJob) => fleet.some((w) => w.gb >= j.gb);
    let idleWhileFit = 0;

    for (let t = 0; t < 12 * 3600; t += TICK) {
      clock.set(new Date(start + t * 1000));
      for (const job of jobs) {
        if (job.submitAt === t) {
          clock.advance(1); // creates in this tick keep their order
          await submit(job);
          byId.set(job.id as string, job);
        }
      }
      for (const w of fleet) {
        if (w.job && t >= (w.job.endAt as number)) {
          await store.jobs.update(w.job.id as string, {
            status: "completed",
            worker_id: null,
            worker_key: null,
            lease_expires_at: null,
            finished_at: clock.now().toISOString(),
          });
          w.job = null;
        }
      }
      for (const w of shuffled(fleet)) {
        await store.jobs.seeWorker({
          id: w.id,
          kinds: ["train"],
          device: "gpu",
          gpuMemoryGb: w.gb,
          now: clock.now(),
        });
      }
      for (const w of shuffled(fleet)) {
        if (w.job) continue;
        const row: JobRow | null = await store.jobs.claimNext({
          workerId: w.id,
          workerKey: "k",
          leaseSeconds: 24 * 3600,
          now: clock.now(),
          kinds: ["train"],
          gpuMemoryGb: w.gb,
          maxRunning: { train: 8, import: 8, eval: 8 },
        });
        const job = row ? byId.get(row.id) : undefined;
        if (job) {
          job.startAt = t;
          job.endAt = t + job.seconds;
          job.worker = w.id;
          w.job = job;
        }
      }
      for (const w of fleet) {
        if (w.job) w.busySeconds += TICK;
        else if (
          jobs.some(
            (j) => j.id && j.startAt === undefined && j.gb <= w.gb && fits(j),
          )
        )
          idleWhileFit += 1;
      }
      if (jobs.every((j) => !fits(j) || (j.endAt ?? Infinity) <= t)) {
        return { elapsed: t, idleWhileFit };
      }
    }
    throw new Error("the queue never drained");
  };

  it("drains 26 runs on 2 x 80 GB + 4 x 24 GB with no idle GPU a queued run fits", async () => {
    const fleet: Worker[] = [
      ...["h100-1", "h100-2"].map((id) => ({ id, gb: 80 })),
      ...["l4-1", "l4-2", "l4-3", "l4-4"].map((id) => ({ id, gb: 24 })),
    ].map((w) => ({ ...w, job: null, busySeconds: 0 }));
    const small = (ws: string, submitAt = 0, seconds = 600): SimJob => ({
      ws,
      gb: 12,
      seconds,
      submitAt,
    });
    const big = (ws: string, submitAt = 0): SimJob => ({
      ws,
      gb: 46,
      seconds: 1800,
      submitAt,
    });
    const jobs: SimJob[] = [
      // One run no GPU here fits, queued first: it must hold nobody up.
      { ws: "ws_huge", gb: 120, seconds: 600, submitAt: 0 },
      ...Array.from({ length: 12 }, () => small("ws_a")),
      // A quick test run first, then the big ones: the 80 GB GPUs must take the big ones.
      small("ws_b"),
      ...Array.from({ length: 3 }, () => big("ws_b")),
      ...Array.from({ length: 2 }, () => small("ws_b")),
      ...Array.from({ length: 5 }, () => small("ws_a", 0, 1200)),
      // A workspace arriving behind 23 queued runs, and a late big run.
      small("ws_c", 300, 300),
      small("ws_c", 300, 300),
      big("ws_b", 900),
    ];
    const { elapsed, idleWhileFit } = await simulate(fleet, jobs);

    const busy = fleet.reduce((sum, w) => sum + w.busySeconds, 0);
    const work = jobs
      .filter((j) => j.gb <= 80)
      .reduce((sum, j) => sum + j.seconds, 0);
    const wait = (j: SimJob) => (j.startAt as number) - j.submitAt;
    const report = {
      elapsed_s: elapsed,
      fleet_busy_share: Number((busy / (fleet.length * elapsed)).toFixed(3)),
      work_s: work,
      lower_bound_s: Math.ceil(work / fleet.length),
      idle_worker_ticks_while_a_fitting_run_queued: idleWhileFit,
      ws_c_waits_s: jobs.filter((j) => j.ws === "ws_c").map(wait),
      big_waits_s: jobs.filter((j) => j.gb === 46).map(wait),
      big_on: jobs.filter((j) => j.gb === 46).map((j) => j.worker),
    };
    if (process.env.SIM_REPORT)
      writeFileSync(process.env.SIM_REPORT, JSON.stringify(report));

    expect(idleWhileFit).toBe(0);
    // Never claimed, and nothing waited on it.
    expect(jobs[0]?.startAt).toBeUndefined();
    // Big runs only ever ran on the 80 GB GPUs, and the first three started at once.
    expect(report.big_on.every((w) => w?.startsWith("h100"))).toBe(true);
    expect(report.big_waits_s.slice(0, 2)).toEqual([0, 0]);
    // ws_c (0 running) jumps the 20 runs queued before it: the next GPU that frees up.
    expect(Math.max(...report.ws_c_waits_s)).toBeLessThanOrEqual(600);
  });
});
