import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestApp, type TestApp } from "./fixtures/app.js";
import { createSftRun, FakeWorker } from "./fixtures/worker.js";

interface Ev {
  type: string;
  run_id: string;
  seq: number;
  attempt: number;
  timestamp: string;
  [key: string]: unknown;
}

interface RunView {
  status: string;
  attempt: number;
  phase: string | null;
  phase_since: string | null;
  workers_online: number | null;
  autoscaling: boolean | null;
  last_interruption: {
    attempt: number;
    reason: string;
    step: number;
    resume_step: number | null;
    message: string;
  } | null;
  cost_usd: number;
  tokens_processed: number;
  error: string | null;
}

const H100 = { name: "NVIDIA H100 80GB HBM3", memory_gb: 79.6 };

describe("run lifecycle events", () => {
  let t: TestApp;
  let worker: FakeWorker;

  beforeEach(async () => {
    t = await makeTestApp({
      settings: {
        maxAttempts: 3,
        maxPreemptions: 20,
        ssePollMs: 5,
        waitingForComputeSeconds: 30,
      },
    });
    worker = new FakeWorker(t);
  });

  afterEach(async () => {
    await t.close();
  });

  const events = async (id: string, cursor?: string) =>
    (
      await t.json<{
        data: Ev[];
        next_cursor: string | null;
        tail_cursor: string;
      }>(`/v1/runs/${id}/events${cursor ? `?cursor=${cursor}` : ""}`)
    ).body;
  const getRun = async (id: string) =>
    (await t.json<RunView>(`/v1/runs/${id}`)).body;
  const reportPhase = (
    job: { id: string; attempt: number },
    phase: string,
    step = 0,
  ) =>
    worker.call(`/v1/trainer-jobs/${job.id}/events`, {
      worker_id: worker.workerId,
      attempt: job.attempt,
      type: "phase",
      phase,
      step,
    });

  it("walks a run through queued, waiting_for_compute, starting and worker phases", async () => {
    const run = await createSftRun(t);
    const queued = await getRun(run.id);
    expect(queued).toMatchObject({
      phase: "queued",
      workers_online: 0,
      autoscaling: false,
      last_interruption: null,
    });

    // Nobody claims it within the threshold: waiting_for_compute, once.
    t.clock.advanceSeconds(10);
    expect((await t.services.maintenance.tick()).waitingForCompute).toBe(0);
    t.clock.advanceSeconds(25);
    expect((await t.services.maintenance.tick()).waitingForCompute).toBe(1);
    expect((await t.services.maintenance.tick()).waitingForCompute).toBe(0);
    expect((await getRun(run.id)).phase).toBe("waiting_for_compute");

    const job = (await worker.claim({ gpu: H100 }))!;
    const running = await getRun(run.id);
    expect(running).toMatchObject({
      phase: "starting",
      workers_online: null,
      autoscaling: null,
    });

    for (const phase of ["loading_model", "training"]) {
      expect((await reportPhase(job, phase)).status).toBe(204);
    }
    expect((await reportPhase(job, "training")).status).toBe(204); // replay
    await worker.progress(job, 1, 100);
    await reportPhase(job, "evaluating", 1);
    await reportPhase(job, "checkpointing", 1);
    await worker.checkpoint(job, 1, "ckpt-1");
    await worker.call(`/v1/trainer-jobs/${job.id}/events`, {
      ...worker.ref(job),
      type: "warning",
      seq: 0,
      message: "wandb is not installed; skipping that logger",
    });
    await worker.call(`/v1/trainer-jobs/${job.id}/events`, {
      ...worker.ref(job),
      type: "log",
      seq: 1,
      message: "checkpoint step 1 uploaded",
      step: 1,
    });
    expect(
      (await reportPhase(job, "queued")).status,
      "the server owns queued/waiting/starting",
    ).toBe(422);
    await reportPhase(job, "training", 1);
    await reportPhase(job, "uploading", 1);
    await reportPhase(job, "completing", 1);
    await worker.complete(
      job,
      {
        status: "completed",
        tokens_processed: 100,
        eval_report: {
          metric_name: "eval_loss",
          selected_step: 1,
          best_step: 1,
          final_step: 1,
          train_records: 16,
          eval_records: 4,
          warnings: ["Only 4 held-out records; eval metrics are noisy."],
        },
      },
      "artifact",
    );

    const page = await events(run.id);
    expect(page.next_cursor).toBeNull();
    const seqs = page.data.map((e) => e.seq);
    expect(seqs.slice(0, -1)).toEqual(
      [...seqs.slice(0, -1)].sort((a, b) => a - b),
    );
    expect(page.data.every((e) => e.run_id === run.id)).toBe(true);
    const summary = page.data.map((e) =>
      e.type === "phase"
        ? `phase:${String(e.phase)}`
        : e.type === "attempt"
          ? `attempt:${String(e.event)}`
          : e.type,
    );
    expect(summary).toEqual([
      "phase:queued",
      "warning",
      "phase:waiting_for_compute",
      "attempt:started",
      "phase:starting",
      "phase:loading_model",
      "phase:training",
      "metric",
      "phase:evaluating",
      "phase:checkpointing",
      "checkpoint",
      "warning",
      "log",
      "phase:training",
      "phase:uploading",
      "phase:completing",
      "warning",
      "completed",
    ]);
    const byType = (type: string) => page.data.filter((e) => e.type === type);
    expect(byType("phase")[1]).toMatchObject({
      workers_online: 0,
      autoscaling: false,
      attempt: 1,
    });
    expect(byType("phase")[2]).toMatchObject({ phase: "starting", gpu: H100 });
    expect(JSON.stringify(page.data)).not.toContain(worker.workerId);
    expect(byType("metric")[0]).toMatchObject({ step: 1, metric: { step: 1 } });
    expect(byType("checkpoint")[0]).toMatchObject({
      step: 1,
      eval_score: 0.5,
    });
    expect(byType("completed")[0]).toMatchObject({
      status: "completed",
      seq: seqs.at(-2),
      run: { status: "completed", phase: "completing" },
    });

    // SSE: event name = type, id = seq; Last-Event-ID resumes after it.
    const firstMetric = page.data.findIndex((e) => e.type === "metric");
    const middle = page.data[firstMetric - 1]!.seq;
    const res = await t.request(`/v1/runs/${run.id}/events`, {
      headers: { Accept: "text/event-stream", "Last-Event-ID": String(middle) },
    });
    const frames = (await res.text())
      .split("\n\n")
      .filter((f) => f.includes("event:"));
    expect(frames).toHaveLength(page.data.length - firstMetric);
    expect(frames[0]).toContain("event: metric");
    expect(frames[0]).toContain(`id: ${page.data[firstMetric]!.seq}`);
    expect(frames.at(-1)).toContain("event: completed");
    expect(frames.at(-1)).not.toContain("id:");

    // Paging and tailing.
    const first = await t.json<{ data: Ev[]; next_cursor: string | null }>(
      `/v1/runs/${run.id}/events?limit=3`,
    );
    expect(first.body.data).toHaveLength(3);
    const rest = await events(run.id, first.body.next_cursor!);
    expect(rest.data[0]!.seq).toBeGreaterThan(first.body.data[2]!.seq);
    expect((await t.json(`/v1/runs/${run.id}/events?cursor=bad`)).status).toBe(
      422,
    );
  });

  it("survives 12 reclaimed GPUs in a row, resuming from each emergency checkpoint, and bills each step once", async () => {
    const run = await createSftRun(t, { records: 40 });
    for (let i = 0; i < 12; i += 1) {
      const job = (await worker.claim())!;
      expect(job.attempt).toBe(i + 1);
      expect(job.resume?.step ?? 0).toBe(i);
      await worker.progress(job, i + 1, 10);
      await worker.checkpoint(job, i + 1, `emergency-${i + 1}`);
      const done = await worker.complete(job, {
        status: "abandoned",
        reason: "compute_reclaimed",
        tokens_processed: 10,
      });
      expect(done.body.run).toMatchObject({ status: "queued" });
    }
    const queued = await getRun(run.id);
    expect(queued.last_interruption).toMatchObject({
      attempt: 12,
      reason: "compute_reclaimed",
      step: 12,
      resume_step: 12,
      message:
        "attempt 12 interrupted at step 12: the GPU was reclaimed; resuming from step 12 on a new worker",
    });
    expect(queued.phase).toBe("queued");

    const job = (await worker.claim())!;
    expect(job.resume?.step).toBe(12);
    await worker.progress(job, 13, 10);
    await worker.complete(
      job,
      { status: "completed", tokens_processed: 10 },
      "artifact",
    );
    const final = await getRun(run.id);
    expect(final.status).toBe("completed");
    expect(final.tokens_processed).toBe(130);

    const attempts = (await events(run.id)).data.filter(
      (e) => e.type === "attempt",
    );
    expect(attempts.filter((e) => e.event === "interrupted")).toHaveLength(12);
    expect(attempts.filter((e) => e.event === "started")).toHaveLength(13);
    expect(attempts.at(-1)).toMatchObject({
      event: "started",
      attempt: 13,
      resume_step: 12,
      message: "attempt 13 started, resuming from step 12",
    });
  });

  it("gives up once reclaims reach their own cap", async () => {
    await t.close();
    t = await makeTestApp({
      settings: { maxAttempts: 3, maxPreemptions: 2 },
    });
    worker = new FakeWorker(t);
    const run = await createSftRun(t);
    for (let i = 0; i < 2; i += 1) {
      const job = (await worker.claim())!;
      await worker.complete(job, {
        status: "abandoned",
        reason: "compute_reclaimed",
      });
    }
    const failed = await getRun(run.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("its GPU was reclaimed 2 time(s) (limit 2)");
    const last = (await events(run.id)).data.filter(
      (e) => e.type === "attempt",
    );
    expect(last.at(-1)).toMatchObject({
      event: "gave_up",
      reason: "compute_reclaimed",
    });
  });

  it("counts worker errors, OOMs and lost leases toward max_attempts", async () => {
    const run = await createSftRun(t);
    let job = (await worker.claim())!;
    await worker.progress(job, 2, 10);
    await worker.checkpoint(job, 2, "c2");
    await worker.complete(job, { status: "abandoned", reason: "oom" });
    expect((await getRun(run.id)).last_interruption).toMatchObject({
      reason: "oom",
      step: 2,
      resume_step: 2,
    });

    job = (await worker.claim())!;
    await worker.complete(job, { status: "abandoned" });
    expect((await getRun(run.id)).last_interruption?.reason).toBe(
      "worker_error",
    );

    job = (await worker.claim())!;
    t.clock.advanceSeconds(200);
    await t.services.maintenance.tick();
    const failed = await getRun(run.id);
    expect(failed.status).toBe("failed");
    expect(failed.last_interruption).toMatchObject({
      attempt: 3,
      reason: "lease_lost",
    });
    const attempts = (await events(run.id)).data.filter(
      (e) => e.type === "attempt",
    );
    expect(attempts.at(-1)).toMatchObject({
      event: "gave_up",
      reason: "lease_lost",
      message:
        "giving up after attempt 3: the worker was lost; no attempts left",
    });
  });

  it("queues a resumed run again and says autoscaling while waiting", async () => {
    await t.close();
    t = await makeTestApp({
      settings: {
        maxAttempts: 1,
        workerAutoscaling: true,
      },
    });
    worker = new FakeWorker(t);
    const run = await createSftRun(t);
    const job = (await worker.claim())!;
    await worker.complete(job, { status: "failed", error: "boom" });
    const resumed = await t.json<RunView>(`/v1/runs/${run.id}/resume`, {
      body: {},
    });
    expect(resumed.body).toMatchObject({
      status: "queued",
      phase: "queued",
      autoscaling: true,
      workers_online: 0,
    });
    const phases = (await events(run.id)).data.filter(
      (e) => e.type === "phase" && e.phase === "queued",
    );
    expect(phases.map((e) => e.attempt)).toEqual([1, 2]);
  });
});
