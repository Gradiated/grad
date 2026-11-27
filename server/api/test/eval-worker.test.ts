import { afterEach, describe, expect, it } from "vitest";

import { createLocalApiKeyAuth, hashApiKey } from "../src/adapters.js";
import { createGradApp } from "../src/app.js";
import { PlanEvalRequestSchema } from "../src/contracts.js";
import { metrics } from "../src/telemetry/metrics.js";
import { createWorkerClient } from "../src/worker/client.js";
import { parseWorkerArgs } from "../src/worker/eval-worker.js";
import { TRAINER_KEY, WORKSPACE_A, type TestApp } from "./fixtures/app.js";
import {
  appFetch,
  createEval,
  fakeInference,
  makeEvalHarness,
  qaRecords,
  seedDataset,
  startEvalWorker,
  type EvalHarness,
} from "./fixtures/evals.js";
import { judgeResponder } from "./fixtures/fake-openai.js";

const request = (raw: Record<string, unknown>) =>
  PlanEvalRequestSchema.parse({
    models: ["qwen/qwen3-8b"],
    dataset: "qa",
    ...raw,
  });

/** Every call reports 1000 tokens, so every output costs the same. */
const PRICED = (delayMs = 0) => ({
  content: "answer",
  delayMs,
  usage: { prompt_tokens: 600, completion_tokens: 400 },
});

const until = async (what: () => Promise<boolean>, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!(await what())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** What the ledger billed and what the stored outputs cost, per attempt and in total. */
const billing = async (t: TestApp, id: string) => {
  const ledger = await t.deps.store.usage.listByRef(id);
  const outputs = await t.deps.store.evals.listOutputs(id, {}, { limit: 1000 });
  const sum = (xs: number[]) =>
    Number(xs.reduce((a, b) => a + b, 0).toFixed(8));
  const attempts = [...new Set(outputs.data.map((o) => o.attempt))].sort();

  return {
    billedTokens: ledger.reduce((a, u) => a + u.tokens, 0),
    billedCost: sum(ledger.map((u) => u.cost_usd)),
    storedTokens: outputs.data.reduce(
      (a, o) => a + o.prompt_tokens + o.completion_tokens,
      0,
    ),
    storedCost: sum(outputs.data.map((o) => o.cost_usd)),
    keys: outputs.data.map(
      (o) => `${o.model}/${o.task_index}/${o.sample_index}`,
    ),
    attempts,
    perAttempt: await Promise.all(
      attempts.map(async (a) => ({
        attempt: a,
        billed: ledger
          .filter((u) => u.attempt === a)
          .reduce((x, u) => x + u.tokens, 0),
        stored: (await t.deps.store.evals.attemptUsage(id, a)).tokens,
      })),
    ),
  };
};

describe("eval worker (grad-server worker --kinds eval)", () => {
  let h: EvalHarness | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it("resumes after the worker is killed mid-eval: no duplicate outputs, exact billing", async () => {
    h = await makeEvalHarness();
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(10));
    fake.setModel("qwen/qwen3-8b", () => PRICED(20));
    const created = await createEval(
      t.services.evals,
      WORKSPACE_A,
      request({ samples: 2 }),
    );

    // Worker A dies (SIGKILL) once a few batches are stored: from then on
    // none of its requests reach the API, so its in-flight work is lost.
    let dead = false;
    const live = appFetch(t);
    const a = startEvalWorker(t, fakeInference(fake), {
      workerId: "worker-a",
      fetch: async (input, init) => {
        if (dead) throw new TypeError("fetch failed: worker killed");
        return live(input, init);
      },
    });
    const running = a.drain();
    await until(
      async () =>
        (await t.services.evals.get(WORKSPACE_A, created.id)).progress
          .generated >= 6,
    );
    dead = true;
    // Its next claim can't reach the API either.
    await expect(running).rejects.toThrow(/worker killed/);
    await a.close();
    const stalled = await t.services.evals.get(WORKSPACE_A, created.id);
    expect(stalled.status).toBe("running");
    const storedByA = stalled.progress.generated;
    expect(storedByA).toBeLessThan(20);

    // The lease expires; worker B claims attempt 2 and skips what A stored.
    t.clock.advanceSeconds(300);
    await t.services.queue.expireLeases(t.clock.now());
    const requeued = await t.deps.store.jobs.getById(created.id);
    expect(requeued).toMatchObject({ status: "queued", failed_attempts: 1 });
    const before = fake.requests.length;
    expect(await h.worker.drain()).toBe(1);

    const done = await t.services.evals.get(WORKSPACE_A, created.id);
    expect(done.status).toBe("completed");
    expect(done.progress.generated).toBe(20);
    expect(fake.requests.length - before).toBe(20 - storedByA);

    const bill = await billing(t, created.id);
    expect(bill.keys).toHaveLength(20);
    expect(new Set(bill.keys).size).toBe(20);
    expect(bill.attempts).toEqual([1, 2]);
    expect(bill.storedTokens).toBe(20 * 1000);
    expect(bill.billedTokens).toBe(bill.storedTokens);
    expect(bill.billedCost).toBe(bill.storedCost);
    expect(done.total_cost_usd).toBeCloseTo(bill.storedCost, 8);
    for (const row of bill.perAttempt) expect(row.billed).toBe(row.stored);
  });

  it("an API restart during an eval doesn't affect it", async () => {
    h = await makeEvalHarness();
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(8));
    fake.setModel("qwen/qwen3-8b", () => PRICED(10));
    const created = await createEval(
      t.services.evals,
      WORKSPACE_A,
      request({}),
    );

    // The worker talks to "the API" through `target`: mid-eval the API goes
    // away for a few requests, then a new process (same database and
    // storage, fresh services) answers.
    const target = { app: t.app };
    let refused = 0;
    let down = false;
    const worker = startEvalWorker(t, fakeInference(fake), {
      workerId: "survivor",
      fetch: async (input, init) => {
        if (down && refused < 2) {
          refused += 1;
          throw new TypeError("fetch failed: ECONNREFUSED");
        }
        return appFetch(target)(input, init);
      },
    });
    const running = worker.drain();
    await until(
      async () =>
        (await t.services.evals.get(WORKSPACE_A, created.id)).progress
          .generated >= 2,
    );
    down = true;
    target.app = createGradApp(t.deps).app;
    expect(await running).toBe(1);
    await worker.close();

    expect(refused).toBe(2);
    const done = await t.deps.store.jobs.getById(created.id);
    expect(done).toMatchObject({
      status: "completed",
      attempt: 1,
      failed_attempts: 0,
      preemptions: 0,
    });
    const bill = await billing(t, created.id);
    expect(bill.keys).toHaveLength(8);
    expect(bill.billedTokens).toBe(8 * 1000);
    expect(bill.billedCost).toBe(bill.storedCost);
    expect(
      fake.requests.filter((r) => r.model === "qwen/qwen3-8b"),
    ).toHaveLength(8);
  });

  it("prices outputs on the server and counts model and judge calls", async () => {
    h = await makeEvalHarness();
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(3));
    fake.setModel("qwen/qwen3-8b", () => PRICED());
    fake.setModel("qwen/qwen3-32b", judgeResponder(1));
    const counter = async (c: typeof metrics.evalOutputs, result: string) =>
      (await c.get()).values.find(
        (v) => (v.labels as { result?: string }).result === result,
      )?.value ?? 0;
    const before = {
      outputs: await counter(metrics.evalOutputs, "ok"),
      judge: await counter(metrics.judgeCalls, "ok"),
    };
    const created = await createEval(
      t.services.evals,
      WORKSPACE_A,
      request({
        rubric: [{ name: "j", kind: "judge", model: "qwen/qwen3-32b" }],
      }),
    );
    await h.worker.drain();

    const done = await t.services.evals.get(WORKSPACE_A, created.id);
    expect(done.status).toBe("completed");
    expect((await counter(metrics.evalOutputs, "ok")) - before.outputs).toBe(3);
    expect((await counter(metrics.judgeCalls, "ok")) - before.judge).toBe(3);
    // Each output: 1000 model tokens plus the judge's, at plan-time prices.
    const [first] = (
      await t.deps.store.evals.listOutputs(created.id, {}, { limit: 1 })
    ).data;
    expect(first?.cost_usd).toBeGreaterThan(0.0004);
    expect(done.total_cost_usd).toBeCloseTo(3 * (first?.cost_usd ?? 0), 8);
  });

  it("counts failed model calls by reason (grad_eval_inference_errors_total)", async () => {
    h = await makeEvalHarness();
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(2));
    fake.setModel("qwen/qwen3-8b", () => ({ status: 429 }));
    const rateLimited = async () =>
      (await metrics.evalInferenceErrors.get()).values.find(
        (v) =>
          (v.labels as Record<string, unknown>).target === "model" &&
          (v.labels as Record<string, unknown>).reason === "rate_limited",
      )?.value ?? 0;
    const before = await rateLimited();
    await createEval(t.services.evals, WORKSPACE_A, request({}));
    await h.worker.drain();
    expect((await rateLimited()) - before).toBe(2);
  });

  it("guards the worker endpoints", async () => {
    h = await makeEvalHarness();
    const { t } = h;
    await seedDataset(t, "qa", qaRecords(2));
    const created = await createEval(
      t.services.evals,
      WORKSPACE_A,
      request({}),
    );
    const worker = { worker_id: "w1", attempt: 1 };
    const post = (path: string, body: unknown, token = TRAINER_KEY) =>
      t.json(`/v1/trainer-jobs/${created.id}${path}`, { body, token });

    // A train-only key never sees eval jobs.
    const gpu = trainOnlyKey(t);
    const refused = await t.json("/v1/trainer-jobs/claim", {
      body: { worker_id: "gpu", kinds: ["eval"] },
      token: gpu,
    });
    expect([refused.status, refused.body.code]).toEqual([
      403,
      "job_kind_forbidden",
    ]);

    const claim = await t.json<{ job: Record<string, any> }>(
      "/v1/trainer-jobs/claim",
      { body: { worker_id: "w1", kinds: ["eval"] }, token: TRAINER_KEY },
    );
    expect(claim.body.job).toMatchObject({
      id: created.id,
      kind: "eval",
      run: null,
      import: null,
      eval: { mode: "eval", models: ["qwen/qwen3-8b"], done: {} },
      dataset: { version: 1, record_count: 2 },
    });

    for (const [path, body] of [
      ["/events", { ...worker, type: "log", seq: 0, message: "x" }],
      [
        "/progress",
        {
          ...worker,
          metric: {
            step: 1,
            loss: 1,
            eval_metrics: {},
            tokens: 0,
            timestamp: new Date().toISOString(),
          },
        },
      ],
      ["/checkpoints", { ...worker, step: 1, upload_id: "u" }],
      [
        "/uploads",
        { ...worker, kind: "artifact", sha256: "0".repeat(64), size_bytes: 1 },
      ],
    ] as const) {
      const res = await post(path, body);
      expect([path, res.body.code]).toEqual([path, "wrong_job_kind"]);
    }
    const outputs = {
      ...worker,
      outputs: [
        {
          model: "other/model",
          task_index: 0,
          task_id: "q0",
          sample_index: 0,
          record: {},
          input: [],
          output: "x",
          scores: {},
          error: null,
          prompt_tokens: 1,
          completion_tokens: 1,
        },
      ],
    };
    const unknown = await post("/outputs", outputs);
    expect([unknown.status, unknown.body.code]).toEqual([
      422,
      "unknown_eval_output",
    ]);
    const stale = await post("/outputs", { ...outputs, attempt: 2 });
    expect([stale.status, stale.body.code]).toEqual([409, "lease_lost"]);
    const wrongAttempt = await t.request(
      `/v1/trainer-jobs/${created.id}/dataset?attempt=2`,
      { token: TRAINER_KEY },
    );
    expect(wrongAttempt.status).toBe(409);
    const budget = await post("/complete", {
      ...worker,
      status: "stopped_budget",
    });
    expect([budget.status, budget.body.code]).toEqual([
      422,
      "unsupported_completion",
    ]);

    const failed = await post("/complete", {
      ...worker,
      status: "failed",
      error: "worker bug",
    });
    expect(failed.body).toMatchObject({
      kind: "eval",
      status: "failed",
      eval: { id: created.id, status: "failed", error: "worker bug" },
    });
    // A completion replayed after its response was lost gets the result.
    const replay = await post("/complete", { ...worker, status: "failed" });
    expect(replay.body).toMatchObject({ status: "failed" });
    const later = await post("/complete", {
      ...worker,
      attempt: 3,
      status: "failed",
    });
    expect(later.status).toBe(409);

    const runOutputs = await t.json("/v1/trainer-jobs/run_x/outputs", {
      body: outputs,
      token: TRAINER_KEY,
    });
    expect(runOutputs.body.code).toBe("wrong_job_kind");
  });

  it("closes a cancelled eval whose worker died without billing it twice", async () => {
    h = await makeEvalHarness();
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(2));
    fake.setModel("qwen/qwen3-8b", () => PRICED());
    const created = await createEval(
      t.services.evals,
      WORKSPACE_A,
      request({}),
    );
    const dead = createWorkerClient({
      serverUrl: "http://grad.test",
      apiKey: TRAINER_KEY,
      workerId: "dead",
      fetch: appFetch(t),
      retryDelaysMs: [],
    });
    await dead.claim(["eval"], 30);
    await t.services.evals.cancel(WORKSPACE_A, created.id);
    // The lease stays so the worker can post what was in flight...
    const beat = await dead.heartbeat({ id: created.id, attempt: 1 });
    expect(beat).toMatchObject({ should_stop: true, stop_reason: "cancelled" });
    const late = await dead.postOutputs(
      { id: created.id, attempt: 1 },
      {
        outputs: [
          {
            model: "qwen/qwen3-8b",
            task_index: 0,
            task_id: "q0",
            sample_index: 0,
            record: {},
            input: [],
            output: "x",
            scores: {},
            error: null,
            prompt_tokens: 600,
            completion_tokens: 400,
          },
        ],
      },
    );
    expect(late).toMatchObject({ accepted: 1, should_stop: true });
    // ...but it never completes: the reaper releases the lease, no requeue.
    t.clock.advanceSeconds(60);
    expect(await t.services.queue.expireLeases(t.clock.now())).toBe(1);
    const job = await t.deps.store.jobs.getById(created.id);
    expect(job).toMatchObject({ status: "cancelled", worker_id: null });
    const bill = await billing(t, created.id);
    expect(bill.billedTokens).toBe(1000);
    expect(bill.billedCost).toBe(bill.storedCost);
    expect(await h.worker.drain()).toBe(0);
  });

  it("parses its arguments", () => {
    expect(parseWorkerArgs([])).toEqual(["eval"]);
    expect(parseWorkerArgs(["--kinds", "eval"])).toEqual(["eval"]);
    expect(parseWorkerArgs(["--kinds=eval"])).toEqual(["eval"]);
    expect(() => parseWorkerArgs(["--kinds", "train,eval"])).toThrow(
      /eval jobs only, not train/,
    );
    expect(() => parseWorkerArgs(["--kinds="])).toThrow(/not nothing/);
    expect(() => parseWorkerArgs(["--fast"])).toThrow(
      /Unknown worker argument/,
    );
  });
});

/** A TRAINER_KEYS_JSON key that may claim only train jobs. */
const trainOnlyKey = (t: TestApp): string => {
  const secret = "grad_train_only_key";
  const fallback = t.deps.auth;
  const scoped = createLocalApiKeyAuth({
    trainerKeys: [
      { label: "gpu", sha256: hashApiKey(secret), kinds: ["train"] },
    ],
    lookup: { findActiveByHash: async () => null },
  });
  t.deps.auth = {
    authenticate: (token) =>
      token === secret
        ? scoped.authenticate(token)
        : fallback.authenticate(token),
  };

  return secret;
};
