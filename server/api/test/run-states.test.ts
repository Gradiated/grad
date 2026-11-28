import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RUN_STATUSES, type RunStatus } from "../src/contracts.js";
import { makeTestApp, type TestApp } from "./fixtures/app.js";
import { createSftRun, FakeWorker } from "./fixtures/worker.js";

/**
 * The run state machine's public transitions, status by status: what cancel
 * and resume do from each status, with no worker holding the run and with
 * one. The worker-driven transitions (complete, interrupt, lease expiry)
 * are covered in runs-lifecycle.test.ts.
 */
describe("run state transitions", () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await makeTestApp({ settings: { maxAttempts: 3 } });
  });

  afterEach(async () => {
    await t.close();
  });

  /** A run forced into `status`, released (no worker) or held by one. */
  const runIn = async (status: RunStatus, held = false) => {
    const run = await createSftRun(t, {
      name: `r-${status}-${held}`,
      maxCostUsd: 5,
    });
    if (held) {
      const job = await new FakeWorker(t).claim();
      expect(job?.id).toBe(run.id);
    }
    await t.deps.store.runs.update(run.id, {
      status,
      finished_at:
        status === "queued" || status === "running"
          ? null
          : t.clock.now().toISOString(),
    });

    return run.id;
  };

  const post = (id: string, action: "cancel" | "resume") =>
    t.json(`/v1/runs/${id}/${action}`, { method: "POST" });

  // status -> [cancel answer, the status after it]
  const CANCEL: Record<RunStatus, [number, RunStatus | string]> = {
    queued: [200, "cancelled"],
    running: [200, "cancelled"],
    cancelled: [200, "cancelled"],
    completed: [409, "run_not_cancellable"],
    failed: [409, "run_not_cancellable"],
    stopped_budget: [409, "run_not_cancellable"],
    stopped_balance: [409, "run_not_cancellable"],
  };

  // status -> [resume answer, the status after it]; a stopped_budget run
  // resumes only with a higher cap (runs-lifecycle covers raising it).
  const RESUME: Record<RunStatus, [number, RunStatus | string]> = {
    queued: [200, "queued"],
    running: [200, "running"],
    cancelled: [200, "queued"],
    failed: [200, "queued"],
    stopped_balance: [200, "queued"],
    stopped_budget: [409, "budget_exhausted"],
    completed: [409, "run_not_resumable"],
  };

  it("covers every status", () => {
    expect(Object.keys(CANCEL).sort()).toEqual([...RUN_STATUSES].sort());
    expect(Object.keys(RESUME).sort()).toEqual([...RUN_STATUSES].sort());
  });

  it.each([...RUN_STATUSES])("cancel from %s", async (status) => {
    const id = await runIn(status);
    const res = await post(id, "cancel");
    const [code, outcome] = CANCEL[status];

    expect(res.status).toBe(code);
    expect(code === 200 ? res.body.status : res.body.code).toBe(outcome);
    if (code === 200) expect(res.body.finished_at).not.toBeNull();
  });

  it.each([...RUN_STATUSES])("resume from %s", async (status) => {
    const id = await runIn(status);
    const res = await post(id, "resume");
    const [code, outcome] = RESUME[status];

    expect(res.status).toBe(code);
    expect(code === 200 ? res.body.status : res.body.code).toBe(outcome);
    if (code === 200 && outcome === "queued") {
      expect(res.body).toMatchObject({ error: null, finished_at: null });
    }
  });

  it("a run a worker still holds is cancelled for the worker to settle, and resumes only once it let go", async () => {
    const id = await runIn("running", true);

    const cancelled = await post(id, "cancel");
    expect(cancelled.body).toMatchObject({
      status: "cancelled",
      finished_at: null,
    });
    const early = await post(id, "resume");
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ code: "run_not_resumable" });
    expect(String(early.body.detail)).toContain("still stopping");

    // The worker hears it at its next heartbeat and closes the attempt.
    const worker = new FakeWorker(t);
    const job = { id, attempt: 1 } as Parameters<typeof worker.heartbeat>[0];
    const beat = await worker.heartbeat(job);
    expect(beat.body).toMatchObject({
      should_stop: true,
      stop_reason: "cancelled",
    });
    const done = await worker.call(`/v1/trainer-jobs/${id}/complete`, {
      ...worker.ref(job),
      status: "abandoned",
      tokens_processed: 0,
    });
    expect(done.status).toBe(200);
    expect((await t.json(`/v1/runs/${id}`)).body).toMatchObject({
      status: "cancelled",
    });

    const resumed = await post(id, "resume");
    expect(resumed.body).toMatchObject({ status: "queued" });
  });
});
