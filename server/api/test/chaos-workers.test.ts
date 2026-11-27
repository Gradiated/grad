/**
 * Chaos round 2, workers and queue: what happens when a worker's credential,
 * its authenticator or its compute goes away mid-job, and whether the fair
 * queue starves anyone under load.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedRunConfig } from "../src/contracts.js";
import { PlanEvalRequestSchema } from "../src/contracts.js";
import { ApiError } from "../src/errors.js";
import type { JobRow, Store } from "../src/store/types.js";
import { createWorkerClient, type WorkerClient } from "../src/worker/client.js";
import { createEvalWorker } from "../src/worker/eval-worker.js";
import { createRegexEvaluator } from "../src/services/evals/regex.js";
import { createKubernetesWorkerAuth } from "../src/worker-auth/kubernetes.js";
import {
  makeTestApp,
  TRAINER_KEY,
  WORKSPACE_A,
  type TestApp,
} from "./fixtures/app.js";
import { ManualClock } from "./fixtures/clock.js";
import {
  appFetch,
  createEval,
  fakeInference,
  makeEvalHarness,
  qaRecords,
  seedDataset,
  type EvalHarness,
} from "./fixtures/evals.js";
import { createTestStore } from "./fixtures/postgres.js";
import { createSftRun, FakeWorker } from "./fixtures/worker.js";

const config = { model: "test/tiny" } as unknown as ResolvedRunConfig;

describe("queue under load (store)", () => {
  let clock: ManualClock;
  let store: Store;
  let dispose: () => Promise<void>;
  const datasets = new Map<string, string>();

  beforeEach(async () => {
    clock = new ManualClock();
    ({ store, dispose } = await createTestStore(clock));
    datasets.clear();
  });

  afterEach(async () => {
    await dispose();
  });

  const queueRun = async (
    s: Store,
    ws: string,
    extra: { minGpuMemoryGb?: number; maxQueued?: number } = {},
  ) => {
    let datasetId = datasets.get(ws);
    if (!datasetId) {
      datasetId = (
        await s.datasets.getOrCreate({
          workspaceId: ws,
          name: "ds",
          metadata: {},
        })
      ).id;
      datasets.set(ws, datasetId);
    }
    clock.advanceSeconds(1);

    return s.runs.create({
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

  const claim = async (workerId: string, gpuMemoryGb: number) => {
    await store.jobs.seeWorker({
      id: workerId,
      kinds: ["train"],
      device: "gpu",
      gpuMemoryGb,
      now: clock.now(),
    });

    return store.jobs.claimNext({
      workerId,
      workerKey: "k",
      leaseSeconds: 60,
      now: clock.now(),
      kinds: ["train"],
      gpuMemoryGb,
      maxRunning: { train: 8, import: 8, eval: 8 },
    });
  };

  const finish = (job: JobRow) =>
    store.jobs.update(job.id, {
      status: "completed",
      worker_id: null,
      lease_expires_at: null,
      finished_at: clock.now().toISOString(),
    });

  it("a run only the big GPU fits is not starved by a quieter workspace's stream of small runs", async () => {
    // ws_a keeps three small runs going on 24 GB workers and waits for its
    // 70 GB run; ws_b feeds one small run at a time. Fair share alone hands
    // the 80 GB worker to ws_b (fewer running) every time.
    for (let i = 0; i < 3; i += 1) await queueRun(store, "ws_a");
    for (const w of ["s1", "s2", "s3"])
      expect(await claim(w, 24)).not.toBeNull();
    const big = await queueRun(store, "ws_a", { minGpuMemoryGb: 70 });

    let bigClaimed = false;
    for (let round = 0; round < 10 && !bigClaimed; round += 1) {
      await queueRun(store, "ws_b");
      const job = await claim("big", 80);
      expect(job).not.toBeNull();
      bigClaimed = job?.id === big.id;
      await finish(job as JobRow);
    }
    expect(bigClaimed).toBe(true);
  });

  it("homogeneous GPUs keep plain fair share: a big run doesn't jump the queue", async () => {
    const a = await queueRun(store, "ws_a");
    const b = await queueRun(store, "ws_b", { minGpuMemoryGb: 70 });
    // Every online worker fits both: oldest first.
    expect((await claim("g1", 80))?.id).toBe(a.id);
    expect((await claim("g2", 80))?.id).toBe(b.id);
  });

  it("holds queue_limit for concurrent creates on two replicas", async () => {
    const other = await createTestStore(clock);
    try {
      for (let i = 0; i < 3; i += 1) await queueRun(store, "ws_cap");
      const results = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          queueRun(i % 2 === 0 ? store : other.store, "ws_cap", {
            maxQueued: 5,
          }),
        ),
      );
      const ok = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter(
        (r) =>
          r.status === "rejected" &&
          r.reason instanceof ApiError &&
          r.reason.code === "queue_limit",
      );
      expect(ok).toHaveLength(2);
      expect(refused).toHaveLength(10);
    } finally {
      await other.dispose();
    }
  });
});

describe("preemption storms", () => {
  let t: TestApp;

  afterEach(async () => {
    await t.close();
  });

  it("an attempt that saved a checkpoint before its GPU was reclaimed does not count toward MAX_PREEMPTIONS", async () => {
    t = await makeTestApp({ settings: { maxAttempts: 3, maxPreemptions: 3 } });
    const worker = new FakeWorker(t);
    const run = await createSftRun(t, { records: 40 });
    for (let i = 1; i <= 8; i += 1) {
      const job = (await worker.claim())!;
      expect(job.resume?.step ?? 0).toBe(i - 1);
      await worker.progress(job, i, 10);
      await worker.checkpoint(job, i, `emergency-${i}`);
      const done = await worker.complete(job, {
        status: "abandoned",
        reason: "compute_reclaimed",
        tokens_processed: 10,
      });
      expect(done.body.run).toMatchObject({ status: "queued" });
    }

    // Reclaims that save nothing are a loop: they still hit the cap.
    for (let i = 0; i < 3; i += 1) {
      const job = (await worker.claim())!;
      await worker.complete(job, {
        status: "abandoned",
        reason: "compute_reclaimed",
      });
    }
    const failed = await t.json<{ status: string; error: string }>(
      `/v1/runs/${run.id}`,
    );
    expect(failed.body.status).toBe("failed");
    expect(failed.body.error).toContain("reclaimed 3 time(s) (limit 3)");
  });
});

describe("kubernetes TokenReview outages", () => {
  const exp = Math.floor(Date.UTC(2030, 0, 1) / 1000);
  const jwt = (sub: string) =>
    [
      Buffer.from('{"alg":"RS256"}').toString("base64url"),
      Buffer.from(JSON.stringify({ aud: ["grad"], sub, exp })).toString(
        "base64url",
      ),
      "sig",
    ].join(".");
  const ok = (user: string) => ({
    authenticated: true,
    audiences: ["grad"],
    user: {
      username: user,
      extra: { "authentication.kubernetes.io/pod-name": ["trainer-0"] },
    },
  });

  it("keeps a reviewed token working while the API server is down, for a bounded time", async () => {
    const clock = new ManualClock();
    let down = false;
    let reviews = 0;
    const auth = createKubernetesWorkerAuth({
      serviceAccounts: { "grad/trainer": ["train"], "grad/other": ["train"] },
      clock,
      review: async () => {
        reviews += 1;
        if (down) throw new Error("connect ECONNREFUSED");
        return ok("system:serviceaccount:grad:trainer");
      },
    });
    const token = jwt("system:serviceaccount:grad:trainer");
    expect((await auth.authenticate(token))?.identity).toBe(
      "k8s:grad/trainer/trainer-0",
    );

    down = true;
    clock.advanceSeconds(120);
    // Past the 60 s cache: the review fails, the last good one still holds.
    expect((await auth.authenticate(token))?.identity).toBe(
      "k8s:grad/trainer/trainer-0",
    );
    // A token never reviewed while the API was up gets the 503.
    await expect(
      auth.authenticate(jwt("system:serviceaccount:grad:other")),
    ).rejects.toMatchObject({ status: 503 });
    clock.advanceSeconds(16 * 60);
    await expect(auth.authenticate(token)).rejects.toMatchObject({
      status: 503,
    });

    // Back up: a fresh review, and a rejection is never served stale.
    down = false;
    expect(await auth.authenticate(token)).not.toBeNull();
    expect(reviews).toBeGreaterThan(2);
  });

  it("serves a reviewed token while reviews are saturated, and coalesces concurrent reviews of one token", async () => {
    const clock = new ManualClock();
    let release: () => void = () => undefined;
    let reviews = 0;
    const auth = createKubernetesWorkerAuth({
      serviceAccounts: { "grad/trainer": ["train"] },
      clock,
      maxInFlight: 1,
      review: async () => {
        reviews += 1;
        if (reviews > 1) await new Promise<void>((r) => (release = r));
        return ok("system:serviceaccount:grad:trainer");
      },
    });
    const token = jwt("system:serviceaccount:grad:trainer");
    expect(await auth.authenticate(token)).not.toBeNull();
    clock.advanceSeconds(61);

    // Three requests of one pod at once (heartbeat, progress, checkpoint):
    // one review, no 503.
    const same = Promise.all([0, 1, 2].map(() => auth.authenticate(token)));
    await new Promise((r) => setTimeout(r, 5));
    expect(reviews).toBe(2);
    release();
    for (const p of await same) expect(p).not.toBeNull();
  });
});
