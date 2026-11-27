import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createStaticWorkerAuth } from "../src/adapters.js";
import { createCloudAuth } from "../src/cloud/auth.js";
import { createAuthView, type AuthView } from "../src/cloud/auth-view.js";
import { createJwtVerifier } from "../src/cloud/jwt.js";
import { PlanEvalRequestSchema } from "../src/contracts.js";
import { ApiError } from "../src/errors.js";
import { TEST_JUDGE, WORKSPACE_A } from "./fixtures/app.js";
import {
  createEval,
  fakeInference,
  makeEvalHarness,
  qaRecords,
  seedDataset,
  startEvalWorker,
  type EvalHarness,
} from "./fixtures/evals.js";
import { ManualClock } from "./fixtures/clock.js";
import {
  startFakeCloudApi,
  type FakeCloudApi,
} from "./fixtures/fake-cloud-api.js";
import { judgeResponder } from "./fixtures/fake-openai.js";
import { postgresUrl } from "./fixtures/postgres.js";

const WS = "8f0e7c52-2d7e-4c39-9a51-0a5b3c1d2e3f";

const failure = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => (e instanceof ApiError ? `${e.status} ${e.code}` : e),
  );

/**
 * Chaos round 2, Cloud dependencies: each test takes one dependency down (or
 * makes it slow) and checks what breaks and how it recovers.
 */
describe("chaos: the inference gateway down during an eval", () => {
  let h: EvalHarness | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it("an outage longer than the per-call retries stores no error outputs or zero scores: calls wait and resume", async () => {
    h = await makeEvalHarness();
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(4));
    fake.setModel("qwen/qwen3-8b", () => ({ content: "answer" }));
    fake.setModel(TEST_JUDGE, judgeResponder(0.9));
    const created = await createEval(
      t.services.evals,
      WORKSPACE_A,
      PlanEvalRequestSchema.parse({
        models: ["qwen/qwen3-8b"],
        dataset: "qa",
        rubric: [{ name: "quality", kind: "judge", model: TEST_JUDGE }],
      }),
    );

    // The gateway answers 503 (capacity_unavailable) to the next 9 calls:
    // more than one call's own retries (2 attempts here, 6 on Cloud).
    fake.failNext(9, 503);
    const worker = startEvalWorker(t, fakeInference(fake), {
      workerId: "outage",
      concurrency: 1,
      outageMaxMs: 60_000,
    });
    expect(await worker.drain()).toBe(1);
    await worker.close();

    const done = await t.services.evals.get(WORKSPACE_A, created.id);
    expect([done.status, done.error]).toEqual(["completed", null]);
    const outputs = await t.deps.store.evals.listOutputs(
      created.id,
      {},
      { limit: 100 },
    );
    expect(outputs.data).toHaveLength(4);
    expect(outputs.data.map((o) => o.error)).toEqual([null, null, null, null]);
    expect(outputs.data.map((o) => o.scores.quality)).toEqual([
      0.9, 0.9, 0.9, 0.9,
    ]);
  });

  const judged = (t: EvalHarness["t"]) =>
    createEval(
      t.services.evals,
      WORKSPACE_A,
      PlanEvalRequestSchema.parse({
        models: ["qwen/qwen3-8b"],
        dataset: "qa",
        rubric: [{ name: "quality", kind: "judge", model: TEST_JUDGE }],
      }),
    );

  it("an outage past outageMaxMs hands the attempt back; the next one resumes and finishes clean", async () => {
    h = await makeEvalHarness();
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(4));
    fake.setModel("qwen/qwen3-8b", () => ({ content: "answer" }));
    fake.setModel(TEST_JUDGE, judgeResponder(0.9));
    const created = await judged(t);

    // One call's retries fail and the worker gives up at once: attempt 1 is
    // abandoned, attempt 2 runs after the gateway is back.
    fake.failNext(2, 503);
    const worker = startEvalWorker(t, fakeInference(fake), {
      concurrency: 1,
    });
    expect(await worker.drain()).toBe(2);
    await worker.close();

    const job = await t.deps.store.jobs.getById(created.id);
    expect(job).toMatchObject({ status: "completed", attempt: 2 });
    const outputs = await t.deps.store.evals.listOutputs(
      created.id,
      {},
      { limit: 100 },
    );
    expect(outputs.data.map((o) => o.error)).toEqual([null, null, null, null]);
  });

  it("a gateway that stays down fails the eval after MAX_ATTEMPTS with the outage as its error, storing nothing", async () => {
    h = await makeEvalHarness({ maxAttempts: 2 });
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(4));
    const created = await judged(t);

    fake.failNext(1_000, 503);
    await h.worker.drain();

    const done = await t.services.evals.get(WORKSPACE_A, created.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/inference unavailable/);
    const outputs = await t.deps.store.evals.listOutputs(
      created.id,
      {},
      { limit: 100 },
    );
    expect(outputs.data).toHaveLength(0);
  });
});

describe("chaos: the product database (auth view) and the JWKS down", () => {
  let cloud: FakeCloudApi;
  let clock: ManualClock;
  let real: AuthView;
  /** down: every lookup fails like a dead connection; slowMs: each takes this long. */
  const fault = { down: false, slowMs: 0, lookups: 0 };
  const view: AuthView = {
    find: async (digest) => {
      fault.lookups += 1;
      if (fault.slowMs) await new Promise((r) => setTimeout(r, fault.slowMs));
      if (fault.down) throw new Error("Connection terminated unexpectedly");
      return real.find(digest);
    },
    close: async () => undefined,
  };

  beforeAll(async () => {
    clock = new ManualClock(new Date());
    cloud = await startFakeCloudApi({ databaseUrl: postgresUrl(), clock });
    real = createAuthView(cloud.authDatabaseUrl as string);
  });
  afterAll(async () => {
    await real.close();
    await cloud.close();
  });
  afterEach(() => {
    Object.assign(fault, { down: false, slowMs: 0, lookups: 0 });
    cloud.setLatency(0);
  });

  const auth = () =>
    createCloudAuth({
      view,
      jwt: createJwtVerifier({
        jwksUrl: cloud.jwksUrl,
        issuer: cloud.issuer,
        audience: "training",
        clock,
      }),
      workers: createStaticWorkerAuth([]),
      clock,
    });

  it("a view outage serves each key's last answer for 5 min, then fails closed; recovery is the next lookup", async () => {
    const a = auth();
    await cloud.addKey("grad_chaos_ok", { workspace_id: WS, role: "member" });
    await cloud.addKey("grad_chaos_suspended", {
      workspace_id: WS,
      status: "suspended",
    });
    await cloud.addKey("grad_chaos_expiring", {
      workspace_id: WS,
      expires_at: new Date(clock.now().getTime() + 60_000),
    });
    expect(await a.authenticate("grad_chaos_ok")).toMatchObject({
      workspaceId: WS,
    });
    expect(await failure(a.authenticate("grad_chaos_suspended"))).toBe(
      "403 workspace_suspended",
    );
    expect(await a.authenticate("grad_chaos_expiring")).not.toBeNull();
    expect(await a.authenticate("grad_chaos_unknown")).toBeNull();

    // A failover: the fresh-answer TTL (5 s) passes with the view down.
    fault.down = true;
    clock.advanceSeconds(30);
    expect(await a.authenticate("grad_chaos_ok")).toMatchObject({
      workspaceId: WS,
    });
    expect(await failure(a.authenticate("grad_chaos_suspended"))).toBe(
      "403 workspace_suspended",
    );
    expect(await a.authenticate("grad_chaos_unknown")).toBeNull();
    // Never past the key's own expiry.
    clock.advanceSeconds(31);
    expect(await a.authenticate("grad_chaos_expiring")).toBeNull();
    // A key never seen: nothing to fall back on.
    expect(await failure(a.authenticate("grad_chaos_new"))).toBe(
      "503 auth_unavailable",
    );

    // Past 5 min down: fail closed.
    clock.advanceSeconds(300);
    expect(await failure(a.authenticate("grad_chaos_ok"))).toBe(
      "503 auth_unavailable",
    );

    // Back: a revocation made meanwhile applies on the next lookup.
    await cloud.removeKey("grad_chaos_ok");
    fault.down = false;
    expect(await a.authenticate("grad_chaos_ok")).toBeNull();
  });

  it("console JWTs keep working while the JWKS is down, and a slow JWKS never holds a request", async () => {
    const a = auth();
    const token = cloud.consoleToken(WS);
    expect(await a.authenticate(token)).toMatchObject({ workspaceId: WS });

    // Due for its 10-minute refresh while the JWKS hangs: requests are
    // answered from the cached keys without waiting for it.
    cloud.setLatency(3_000);
    cloud.failNext(1, 503, "/api/auth/jwks");
    clock.advanceSeconds(700);
    const fresh = cloud.consoleToken(WS);
    const started = Date.now();
    expect(await a.authenticate(fresh)).toMatchObject({ workspaceId: WS });
    expect(Date.now() - started).toBeLessThan(1_000);
    cloud.setLatency(0);
  });

  it("a key rotated in just after a refresh verifies on its first use", async () => {
    const a = auth();
    expect(await a.authenticate(cloud.consoleToken(WS))).not.toBeNull();
    // Within the 30 s unknown-kid throttle of that fetch.
    clock.advanceSeconds(10);
    cloud.rotateSigningKey();
    expect(await a.authenticate(cloud.consoleToken(WS))).toMatchObject({
      workspaceId: WS,
    });
  });
});
