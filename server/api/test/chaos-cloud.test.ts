import { afterEach, describe, expect, it } from "vitest";

import { PlanEvalRequestSchema } from "../src/contracts.js";
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
import { judgeResponder } from "./fixtures/fake-openai.js";

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
