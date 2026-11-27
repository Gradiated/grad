import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BillingAdapter } from "../src/adapters.js";
import { costForTokens } from "../src/catalog.js";
import { ADMIN_KEY, makeTestApp, type TestApp } from "./fixtures/app.js";
import { evalReport } from "./fixtures/eval-report.js";
import { createSftRun, FakeWorker, sha256Hex } from "./fixtures/worker.js";

const recordingBilling = () => {
  const calls: Array<{
    runId: string;
    attempt: number;
    tokensProcessed: number;
    costUsd: number;
    idempotencyKey: string;
  }> = [];
  let failuresLeft = 0;
  const adapter: BillingAdapter = {
    checkCanStartRun: async () => ({ allowed: true }),
    recordRunUsage: async (input) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("billing temporarily down");
      }
      calls.push(input);
    },
    recordEvalUsage: async () => undefined,
  };

  return { adapter, calls, failNext: (n: number) => (failuresLeft = n) };
};

describe("run lifecycle and worker protocol", () => {
  let t: TestApp;
  let billing: ReturnType<typeof recordingBilling>;
  let worker: FakeWorker;

  beforeEach(async () => {
    billing = recordingBilling();
    t = await makeTestApp({
      billing: billing.adapter,
      settings: {
        maxAttempts: 3,
        evalConcurrency: 2,
        ssePollMs: 5,
      },
    });
    worker = new FakeWorker(t);
  });

  afterEach(async () => {
    await t.close();
  });

  const settle = async () => {
    await t.services.billing.idle();
    await t.services.billing.drain();
  };

  it("trains, checkpoints and completes with server-side cost and an immutable artifact", async () => {
    const run = await createSftRun(t);
    expect(run).not.toHaveProperty("worker_id");
    expect(run).not.toHaveProperty("lease_expires_at");
    expect(run.dataset_version).toBe(1);

    const job = await worker.claim();
    expect(job?.kind).toBe("train");
    expect(job?.attempt).toBe(1);
    expect(job?.price_per_million_tokens).toBe(1);
    expect(job?.resume).toBeNull();
    const records = await worker.downloadDataset(job!);
    expect(records).toHaveLength(20);

    const hb = await worker.heartbeat(job!);
    expect(hb.body).toMatchObject({ status: "running", should_stop: false });

    const progress = await worker.progress(job!, 1, 500_000, { cost_usd: 0 });
    expect(progress.body.cost_usd).toBeCloseTo(0.5);

    const ckpt = await worker.checkpoint(job!, 1, "ckpt-1", {
      format: "peft_lora",
    });
    expect(ckpt.status).toBe(201);
    expect(ckpt.body).not.toHaveProperty("storage_key");

    const untyped = await worker.complete(job!, {
      status: "completed",
      eval_report: { acc: 1 },
    });
    expect(untyped.status).toBe(422);
    expect(JSON.stringify(untyped.body)).toContain("eval_report.metric_name");

    const done = await worker.complete(
      job!,
      {
        status: "completed",
        tokens_processed: 1_000_000,
        manifest: { schema: "evil", run_id: "x", files: 1 },
        eval_report: evalReport({ acc: 1 }),
      },
      "artifact-bytes",
    );
    expect(done.status).toBe(200);
    expect(done.body.run).toMatchObject({
      status: "completed",
      tokens_processed: 1_000_000,
      cost_usd: 1,
    });
    const artifact = done.body.artifact as Record<string, unknown> & {
      manifest: Record<string, unknown>;
      id: string;
    };
    expect(artifact.manifest).toMatchObject({
      schema: "grad.artifact/1",
      run_id: run.id,
      files: 1,
    });
    expect(artifact.sha256).toBe(sha256Hex("artifact-bytes"));

    const download = await t.request(`/v1/artifacts/${artifact.id}/download`);
    expect(download.headers.get("x-artifact-sha256")).toBe(
      sha256Hex("artifact-bytes"),
    );
    expect(await download.text()).toBe("artifact-bytes");

    await settle();
    expect(billing.calls).toEqual([
      expect.objectContaining({
        runId: run.id,
        attempt: 1,
        tokensProcessed: 1_000_000,
        costUsd: 1,
        idempotencyKey: `run-usage:${run.id}:1`,
      }),
    ]);

    // The final and best checkpoints never expire.
    const ckpts = await t.json<{ data: Array<Record<string, unknown>> }>(
      `/v1/runs/${run.id}/checkpoints`,
    );
    expect(ckpts.body.data[0]).toMatchObject({
      final: true,
      best: true,
      expires_at: null,
    });
  });

  it("stores each worker write once: replayed progress and checkpoint retries", async () => {
    const run = await createSftRun(t);
    const job = await worker.claim();
    await worker.progress(job!, 1, 100);
    const replay = await worker.progress(job!, 1, 100);
    expect(replay.status).toBe(200);
    await worker.progress(job!, 2, 200);
    const metrics = await t.json<{ data: Array<{ step: number }> }>(
      `/v1/runs/${run.id}/metrics`,
    );
    expect(metrics.body.data.map((m) => m.step)).toEqual([1, 2]);
    // A late replay of an older step does not move the run backwards.
    await worker.progress(job!, 1, 100);
    expect((await t.json(`/v1/runs/${run.id}`)).body).toMatchObject({
      current_step: 2,
      latest_metric: { step: 2 },
    });

    const uploadId = await worker.upload(job!, "checkpoint", "ckpt-bytes");
    const body = {
      ...worker.ref(job!),
      step: 2,
      upload_id: uploadId,
      metadata: {},
    };
    const path = `/v1/trainer-jobs/${job!.id}/checkpoints`;
    const first = await worker.call<{ id: string }>(path, body);
    expect(first.status).toBe(201);
    const retry = await worker.call<{ id: string }>(path, body);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    // The retry must not delete the checkpoint's own blob.
    const resumed = await t.deps.store.checkpoints.latestForRun(
      run.id,
      t.clock.now(),
    );
    expect(await t.deps.storage.head(resumed!.storage_key)).not.toBeNull();
  });

  it("rejects workspace admins on every trainer-job route and hides worker fields", async () => {
    const run = await createSftRun(t);
    const asAdmin = new FakeWorker(t, "worker-1", ADMIN_KEY);
    await expect(asAdmin.claim()).rejects.toThrow(/403/);

    const job = await worker.claim();
    for (const path of [
      "heartbeat",
      "progress",
      "uploads",
      "checkpoints",
      "complete",
    ]) {
      const res = await t.json(`/v1/trainer-jobs/${job!.id}/${path}`, {
        body: {
          worker_id: "worker-1",
          attempt: 1,
          status: "completed",
          metric: {},
          kind: "artifact",
          sha256: "0".repeat(64),
          size_bytes: 1,
          step: 1,
          upload_id: "u",
        },
      });
      expect(res.status, path).toBe(403);
    }

    const res = await t.json(`/v1/runs/${run.id}`);
    expect(res.body).not.toHaveProperty("worker_id");
  });

  it("refuses foreign workers and stale attempts with lease_lost", async () => {
    await createSftRun(t);
    const job = await worker.claim();
    const intruder = new FakeWorker(t, "worker-2");
    const res = await intruder.progress(job!, 1, 10);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "lease_lost" });
    const stale = await worker.call(`/v1/trainer-jobs/${job!.id}/heartbeat`, {
      worker_id: "worker-1",
      attempt: 7,
    });
    expect(stale.status).toBe(409);
    const missing = await worker.call(
      "/v1/trainer-jobs/run_missing/heartbeat",
      { worker_id: "worker-1", attempt: 1 },
    );
    expect(missing.status).toBe(404);
  });

  it("bills cancelled attempts exactly once and stops the worker", async () => {
    const run = await createSftRun(t);
    const job = await worker.claim();
    await worker.progress(job!, 1, 200_000);

    const cancelled = await t.json(`/v1/runs/${run.id}/cancel`, {
      method: "POST",
    });
    expect(cancelled.body).toMatchObject({
      status: "cancelled",
      finished_at: null,
    });

    const hb = await worker.heartbeat(job!);
    expect(hb.body).toMatchObject({
      should_stop: true,
      stop_reason: "cancelled",
    });
    const progress = await worker.progress(job!, 2, 300_000);
    expect(progress.body).toMatchObject({
      should_stop: true,
      stop_reason: "cancelled",
    });

    // A worker that finished anyway cannot override the user's cancel.
    const done = await worker.complete(
      job!,
      { status: "completed", tokens_processed: 300_000 },
      "late-artifact",
    );
    expect(done.body.run).toMatchObject({
      status: "cancelled",
      artifact_id: null,
      cost_usd: 0.3,
    });
    const retried = await worker.complete(job!, {
      status: "cancelled",
      tokens_processed: 300_000,
    });
    expect(retried.status).toBe(200);

    await settle();
    expect(billing.calls).toHaveLength(1);
    expect(billing.calls[0]).toMatchObject({
      attempt: 1,
      tokensProcessed: 300_000,
      costUsd: 0.3,
    });

    const again = await t.json(`/v1/runs/${run.id}/cancel`, { method: "POST" });
    expect(again.status).toBe(200);
  });

  it("cancels queued runs immediately and refuses to cancel finished runs", async () => {
    const run = await createSftRun(t);
    const res = await t.json(`/v1/runs/${run.id}/cancel`, { method: "POST" });
    expect(res.body).toMatchObject({ status: "cancelled" });
    expect(res.body.finished_at).not.toBeNull();
    expect(await worker.claim()).toBeNull();

    const run2 = await createSftRun(t, { name: "second" });
    const job = await worker.claim();
    await worker.complete(job!, { status: "failed", error: "boom" });
    const refused = await t.json(`/v1/runs/${run2.id}/cancel`, {
      method: "POST",
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "run_not_cancellable" });
  });

  it("enforces max_cost_usd: progress stops, claim refuses, resume requires a raised cap", async () => {
    const run = await createSftRun(t, { maxCostUsd: 1 });
    const job = await worker.claim();
    expect(job?.max_cost_usd).toBe(1);

    const p1 = await worker.progress(job!, 1, 600_000);
    expect(p1.body.should_stop).toBe(false);
    const p2 = await worker.progress(job!, 2, 1_100_000);
    expect(p2.body).toMatchObject({ should_stop: true, stop_reason: "budget" });

    const done = await worker.complete(
      job!,
      { status: "stopped_budget", tokens_processed: 1_100_000 },
      "partial",
    );
    expect(done.body.run).toMatchObject({
      status: "stopped_budget",
      cost_usd: 1.1,
    });
    expect(done.body.artifact).not.toBeNull();

    const noRaise = await t.json(`/v1/runs/${run.id}/resume`, {
      method: "POST",
      body: {},
    });
    expect(noRaise.status).toBe(409);
    expect(noRaise.body).toMatchObject({ code: "budget_exhausted" });
    const tooLow = await t.json(`/v1/runs/${run.id}/resume`, {
      method: "POST",
      body: { max_cost_usd: 1.05 },
    });
    expect(tooLow.status).toBe(409);

    const resumed = await t.json(`/v1/runs/${run.id}/resume`, {
      method: "POST",
      body: { max_cost_usd: 2 },
    });
    expect(resumed.body).toMatchObject({ status: "queued", max_cost_usd: 2 });

    const job2 = await worker.claim();
    expect(job2?.attempt).toBe(2);
    expect(job2?.max_cost_usd).toBeCloseTo(0.9);
    const p3 = await worker.progress(job2!, 3, 950_000);
    expect(p3.body).toMatchObject({ should_stop: true, cost_usd: 2.05 });
    await worker.complete(
      job2!,
      { status: "stopped_budget", tokens_processed: 900_000 },
      "partial-2",
    );

    await settle();
    expect(billing.calls.map((c) => c.idempotencyKey)).toEqual([
      `run-usage:${run.id}:1`,
      `run-usage:${run.id}:2`,
    ]);
    expect(billing.calls.map((c) => c.costUsd)).toEqual([
      1.1,
      costForTokens(950_000, 1),
    ]);
    const final = await t.json<{ cost_usd: number; tokens_processed: number }>(
      `/v1/runs/${run.id}`,
    );
    expect(final.body.cost_usd).toBeCloseTo(2.05);
    expect(final.body.tokens_processed).toBe(2_050_000);
  });

  it("derives run cost from billed tokens, never from a float running total", async () => {
    const run = await createSftRun(t);
    for (let i = 0; i < 3; i += 1) {
      const job = await worker.claim();
      await worker.complete(job!, {
        status: "abandoned",
        tokens_processed: 333_333,
      });
    }
    await settle();
    const stored = await t.deps.store.runs.getById(run.id);
    expect(stored?.billed_tokens).toBe(999_999);
    expect(stored).not.toHaveProperty("billed_cost_usd");
    const final = await t.json<{ cost_usd: number; tokens_processed: number }>(
      `/v1/runs/${run.id}`,
    );
    expect(final.body).toMatchObject({
      tokens_processed: 999_999,
      cost_usd: costForTokens(999_999, 1),
    });
    expect(billing.calls.map((c) => c.tokensProcessed)).toEqual([
      333_333, 333_333, 333_333,
    ]);
  });

  it("marks a run stopped_budget at claim when a lowered cap is already spent", async () => {
    const run = await createSftRun(t, { maxCostUsd: 5 });
    const job = await worker.claim();
    await worker.complete(job!, {
      status: "failed",
      error: "oom",
      tokens_processed: 3_000_000,
    });
    await t.deps.store.runs.update(run.id, {
      status: "queued",
      max_cost_usd: 2,
      finished_at: null,
    });

    expect(await worker.claim()).toBeNull();
    const after = await t.json(`/v1/runs/${run.id}`);
    expect(after.body).toMatchObject({ status: "stopped_budget" });
  });

  it("resumes from the latest checkpoint and keeps every artifact immutable", async () => {
    const run = await createSftRun(t);
    const job = await worker.claim();
    await worker.checkpoint(job!, 5, "state-5", { format: "peft_lora" });
    const ckpts = await t.json<{ data: Array<{ id: string }> }>(
      `/v1/runs/${run.id}/checkpoints`,
    );
    const promoted = await t.json<{ id: string; sha256: string }>(
      `/v1/checkpoints/${ckpts.body.data[0]!.id}/promote`,
      { body: { name: "promoted" } },
    );
    expect(promoted.status).toBe(201);

    // Re-registering the same step with different bytes conflicts; same bytes are idempotent.
    const same = await worker.checkpoint(job!, 5, "state-5");
    expect(same.status).toBe(200);
    const different = await worker.checkpoint(job!, 5, "state-5-changed");
    expect(different.status).toBe(409);
    expect(different.body).toMatchObject({ code: "checkpoint_conflict" });

    const first = await worker.complete(
      job!,
      { status: "stopped_budget", tokens_processed: 10 },
      "artifact-v1",
    );
    const firstArtifact = first.body.artifact as { id: string };
    await t.json(`/v1/runs/${run.id}/resume`, {
      method: "POST",
      body: { max_cost_usd: 100 },
    });

    const job2 = await worker.claim();
    expect(job2?.resume).toMatchObject({
      checkpoint_id: ckpts.body.data[0]!.id,
      step: 5,
    });
    const resumeBytes = await t.request(job2!.resume!.download_url, {
      token: null,
    });
    expect(await resumeBytes.text()).toBe("state-5");
    await worker.checkpoint(job2!, 5, "attempt-2-state");
    const second = await worker.complete(
      job2!,
      { status: "completed", tokens_processed: 10 },
      "artifact-v2",
    );
    const secondArtifact = second.body.artifact as { id: string };

    expect(secondArtifact.id).not.toBe(firstArtifact.id);
    expect(
      await (
        await t.request(`/v1/artifacts/${firstArtifact.id}/download`)
      ).text(),
    ).toBe("artifact-v1");
    expect(
      await (
        await t.request(`/v1/artifacts/${secondArtifact.id}/download`)
      ).text(),
    ).toBe("artifact-v2");
    const promotedBytes = await t.request(
      `/v1/artifacts/${promoted.body.id}/download`,
    );
    expect(await promotedBytes.text()).toBe("state-5");
    expect(promotedBytes.headers.get("x-artifact-sha256")).toBe(
      sha256Hex("state-5"),
    );

    const metrics = await t.json<{ data: unknown[] }>(
      `/v1/runs/${run.id}/metrics`,
    );
    expect(metrics.status).toBe(200);
  });

  it("refuses to promote training-state checkpoints and expired ones", async () => {
    const run = await createSftRun(t);
    const job = await worker.claim();
    await worker.checkpoint(job!, 1, "state-only");
    const ckpts = await t.json<{ data: Array<{ id: string }> }>(
      `/v1/runs/${run.id}/checkpoints`,
    );
    const res = await t.json(
      `/v1/checkpoints/${ckpts.body.data[0]!.id}/promote`,
      { method: "POST" },
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "checkpoint_not_exportable" });

    t.clock.advanceDays(31);
    const gone = await t.json(
      `/v1/checkpoints/${ckpts.body.data[0]!.id}/promote`,
      { method: "POST" },
    );
    expect(gone.status).toBe(404);
  });

  it("garbage-collects expired checkpoints after 30 days but never best/final", async () => {
    const run = await createSftRun(t);
    const job = await worker.claim();
    await worker.checkpoint(job!, 1, "c1", { eval_score: 0.9 });
    await worker.checkpoint(job!, 2, "c2", { eval_score: 0.1 });
    await worker.checkpoint(job!, 3, "c3", { eval_score: 0.2 });
    await worker.complete(
      job!,
      { status: "completed", tokens_processed: 1 },
      "art",
    );

    t.clock.advanceDays(29);
    expect((await t.services.maintenance.tick()).deletedCheckpoints).toBe(0);
    t.clock.advanceDays(2);
    const report = await t.services.maintenance.tick();
    expect(report.deletedCheckpoints).toBe(1);

    const ckpts = await t.json<{
      data: Array<{ step: number; best: boolean; final: boolean }>;
    }>(`/v1/runs/${run.id}/checkpoints`);
    expect(ckpts.body.data.map((c) => [c.step, c.best, c.final])).toEqual([
      [1, true, false],
      [3, false, true],
    ]);
  });

  it("requeues expired leases with attempt+1, bills the lost attempt, and fails after max_attempts", async () => {
    const run = await createSftRun(t);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const job = await worker.claim();
      expect(job?.attempt).toBe(attempt);
      await worker.progress(job!, 1, 100_000);
      t.clock.advanceSeconds(61);
      await t.services.maintenance.tick();
    }

    const final = await t.json<{
      status: string;
      error: string;
      attempt: number;
      cost_usd: number;
    }>(`/v1/runs/${run.id}`);
    expect(final.body.status).toBe("failed");
    expect(final.body.error).toMatch(/max_attempts=3/);
    expect(final.body.cost_usd).toBeCloseTo(0.3);
    await settle();
    expect(billing.calls.map((c) => c.attempt)).toEqual([1, 2, 3]);
    expect(await worker.claim()).toBeNull();

    // A resumed run gets a fresh attempt budget.
    await t.json(`/v1/runs/${run.id}/resume`, { method: "POST", body: {} });
    expect((await worker.claim())?.attempt).toBe(4);
  });

  it("keeps a lease alive through heartbeats during long exports", async () => {
    await createSftRun(t);
    const job = await worker.claim();
    for (let i = 0; i < 5; i += 1) {
      t.clock.advanceSeconds(20);
      expect((await worker.heartbeat(job!)).status).toBe(200);
      await t.services.maintenance.tick();
    }
    const done = await worker.complete(
      job!,
      { status: "completed", tokens_processed: 5 },
      "late",
    );
    expect(done.status).toBe(200);
    expect(done.body.run).toMatchObject({ status: "completed" });
  });

  it("abandoned attempts are billed and requeued without counting as failures", async () => {
    const run = await createSftRun(t);
    const job = await worker.claim();
    const res = await worker.complete(job!, {
      status: "abandoned",
      tokens_processed: 1000,
    });
    expect(res.body.run).toMatchObject({ status: "queued" });
    const job2 = await worker.claim();
    expect(job2?.attempt).toBe(2);
    const internal = await t.deps.store.runs.getById(run.id);
    expect(internal?.failed_attempts).toBe(0);
  });

  it("completion is atomic: a failure after the artifact insert leaves no artifact and keeps the lease", async () => {
    const run = await createSftRun(t);
    const job = await worker.claim();
    const original = t.deps.store.runs.update;
    let failOnce = true;
    t.deps.store.runs.update = async (...args) => {
      if (failOnce && args[1].status === "completed") {
        failOnce = false;
        throw new Error("database went away");
      }
      return original(...args);
    };
    const uploadId = await worker.upload(job!, "artifact", "atomic");
    const failed = await worker.call(`/v1/trainer-jobs/${job!.id}/complete`, {
      ...worker.ref(job!),
      status: "completed",
      upload_id: uploadId,
      tokens_processed: 1,
    });
    expect(failed.status).toBe(500);
    expect(failed.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    const listed = await t.json<{ data: unknown[] }>("/v1/artifacts");
    expect(listed.body.data).toHaveLength(0);

    t.deps.store.runs.update = original;
    const retried = await worker.call<{ run: { status: string } }>(
      `/v1/trainer-jobs/${job!.id}/complete`,
      {
        ...worker.ref(job!),
        status: "completed",
        upload_id: uploadId,
        tokens_processed: 1,
      },
    );
    expect(retried.status).toBe(200);
    expect(retried.body.run.status).toBe("completed");
    const again = await worker.call<{ run: { id: string } }>(
      `/v1/trainer-jobs/${job!.id}/complete`,
      {
        ...worker.ref(job!),
        status: "completed",
        upload_id: uploadId,
        tokens_processed: 1,
      },
    );
    expect(again.status).toBe(200);
    expect(again.body.run.id).toBe(run.id);
    expect(
      (await t.json<{ data: unknown[] }>("/v1/artifacts")).body.data,
    ).toHaveLength(1);
  });

  it("retries billing from the outbox after an adapter failure", async () => {
    await createSftRun(t);
    billing.failNext(1);
    const job = await worker.claim();
    await worker.complete(
      job!,
      { status: "completed", tokens_processed: 10 },
      "a",
    );
    await t.services.billing.idle();
    expect(billing.calls).toHaveLength(0);

    t.clock.advanceSeconds(120);
    const report = await t.services.maintenance.tick();
    expect(report.billingSent).toBe(1);
    expect(billing.calls).toHaveLength(1);
    await t.services.maintenance.tick();
    expect(billing.calls).toHaveLength(1);
  });

  it("requires an artifact upload for completed jobs and verifies uploads", async () => {
    await createSftRun(t);
    const job = await worker.claim();
    const missing = await worker.complete(job!, { status: "completed" });
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ code: "artifact_required" } as never);

    const ticket = await worker.call<{ upload_id: string; url: string }>(
      `/v1/trainer-jobs/${job!.id}/uploads`,
      {
        ...worker.ref(job!),
        kind: "artifact",
        sha256: sha256Hex("good"),
        size_bytes: 4,
      },
    );
    const notUploaded = await worker.call(
      `/v1/trainer-jobs/${job!.id}/complete`,
      {
        ...worker.ref(job!),
        status: "completed",
        upload_id: ticket.body.upload_id,
      },
    );
    expect(notUploaded.status).toBe(409);
    expect(notUploaded.body).toMatchObject({ code: "upload_incomplete" });

    const badBytes = await t.app.request(ticket.body.url, {
      method: "PUT",
      body: "evil",
    });
    expect(badBytes.status).toBe(422);
    const badSig = await t.app.request(
      ticket.body.url.replace(/sig=[^&]+/, "sig=forged"),
      { method: "PUT", body: "good" },
    );
    expect(badSig.status).toBe(403);
    const ok = await t.app.request(ticket.body.url, {
      method: "PUT",
      body: "good",
    });
    expect(ok.status).toBe(200);
    const twice = await t.app.request(ticket.body.url, {
      method: "PUT",
      body: "good",
    });
    expect(twice.status).toBe(409);

    const wrongPurpose = await worker.call(
      `/v1/trainer-jobs/${job!.id}/checkpoints`,
      { ...worker.ref(job!), step: 1, upload_id: ticket.body.upload_id },
    );
    expect(wrongPurpose.status).toBe(422);
    expect(wrongPurpose.body).toMatchObject({ code: "unknown_upload" });

    t.clock.advanceSeconds(7 * 3600);
    await worker.heartbeat(job!);
    const expired = await worker.call(`/v1/trainer-jobs/${job!.id}/complete`, {
      ...worker.ref(job!),
      status: "completed",
      upload_id: ticket.body.upload_id,
    });
    expect(expired.status).toBe(410);
  });

  it("streams metrics over SSE with Last-Event-ID resume and paginates JSON metrics", async () => {
    const run = await createSftRun(t);
    const job = await worker.claim();
    for (let step = 1; step <= 3; step += 1)
      await worker.progress(job!, step, step * 10);

    type MetricsPage = {
      data: Array<{ seq: number; step: number; attempt: number }>;
      next_cursor: string | null;
      tail_cursor: string;
    };
    const empty = await t.json<MetricsPage>(
      `/v1/runs/${(await createSftRun(t, { name: "idle" })).id}/metrics`,
    );
    expect(empty.body).toMatchObject({ data: [], next_cursor: null });
    expect(typeof empty.body.tail_cursor).toBe("string");

    const page1 = await t.json<MetricsPage>(
      `/v1/runs/${run.id}/metrics?limit=2`,
    );
    expect(page1.body.data.map((m) => m.step)).toEqual([1, 2]);
    expect(page1.body.data[0]?.attempt).toBe(1);
    expect(page1.body.next_cursor).toBe(page1.body.tail_cursor);
    const page2 = await t.json<MetricsPage>(
      `/v1/runs/${run.id}/metrics?limit=2&cursor=${page1.body.next_cursor}`,
    );
    expect(page2.body.data.map((m) => m.step)).toEqual([3]);
    expect(page2.body.next_cursor).toBeNull();
    const page3 = await t.json<MetricsPage>(
      `/v1/runs/${run.id}/metrics?cursor=${page2.body.tail_cursor}`,
    );
    expect(page3.body.data).toEqual([]);
    expect(page3.body.next_cursor).toBeNull();
    expect(page3.body.tail_cursor).toBe(page2.body.tail_cursor);
    const filtered = await t.json<{ data: unknown[] }>(
      `/v1/runs/${run.id}/metrics?after_step=2`,
    );
    expect(filtered.body.data).toHaveLength(1);
    const badCursor = await t.json(`/v1/runs/${run.id}/metrics?cursor=nope`);
    expect(badCursor.status).toBe(422);

    const firstSeq = page1.body.data[0]!.seq;
    const finish = (async () => {
      await new Promise((r) => setTimeout(r, 30));
      await worker.progress(job!, 4, 40);
      await worker.complete(
        job!,
        { status: "completed", tokens_processed: 40 },
        "sse-art",
      );
    })();
    const res = await t.request(`/v1/runs/${run.id}/metrics`, {
      headers: {
        Accept: "text/event-stream",
        "Last-Event-ID": String(firstSeq),
      },
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    await finish;
    const events = text.split("\n\n").filter((e) => e.includes("event:"));
    const metricSteps = events
      .filter((e) => e.includes("event: metric"))
      .map(
        (e) =>
          JSON.parse(
            e
              .split("\n")
              .find((l) => l.startsWith("data: "))!
              .slice(6),
          ).step,
      );
    expect(metricSteps).toEqual([2, 3, 4]);
    const tailed = await t.json<MetricsPage>(
      `/v1/runs/${run.id}/metrics?cursor=${page3.body.tail_cursor}`,
    );
    expect(tailed.body.data.map((m) => m.step)).toEqual([4]);
    const clamped = await t.json<MetricsPage>(
      `/v1/runs/${run.id}/metrics?limit=999999`,
    );
    expect(clamped.status).toBe(200);
    expect(clamped.body.data).toHaveLength(4);
    expect(events.at(-1)).toContain("event: status");
    expect(events.at(-1)).toContain('"status":"completed"');

    const missing = await t.request("/v1/runs/run_nope/metrics", {
      headers: { Accept: "text/event-stream" },
    });
    expect(missing.status).toBe(404);
  });

  it("only claims recipes the worker supports and respects job kinds", async () => {
    await createSftRun(t);
    expect(await worker.claim({ recipes: ["dpo"] })).toBeNull();
    expect(await worker.claim({ kinds: ["import"] })).toBeNull();
    expect(
      (await worker.claim({ recipes: ["sft"], kinds: ["train"] }))?.kind,
    ).toBe("train");
  });

  it("fails a claimed run whose pinned dataset version vanished", async () => {
    const run = await createSftRun(t);
    const internal = await t.deps.store.runs.getById(run.id);
    await t.deps.store.runs.update(run.id, { status: "queued" });
    // Point the run at a version that does not exist.
    (internal as { dataset_version: number }).dataset_version = 99;
    const original = t.deps.store.runs.claimNext;
    t.deps.store.runs.claimNext = async (input) => {
      const claimed = await original(input);
      return claimed ? { ...claimed, dataset_version: 99 } : null;
    };
    expect(await worker.claim()).toBeNull();
    t.deps.store.runs.claimNext = original;
    const after = await t.json<{ status: string; error: string }>(
      `/v1/runs/${run.id}`,
    );
    expect(after.body.status).toBe("failed");
    expect(after.body.error).toMatch(/dataset version '.*@99' was not found/);
  });

  it("rejects wrong-kind calls on job ids", async () => {
    const run = await createSftRun(t);
    const job = await worker.claim();
    const records = await worker.call(`/v1/trainer-jobs/${run.id}/records`, {
      ...worker.ref(job!),
      seq: 0,
      records: [{}],
    });
    expect(records.status).toBe(409);
    const progress = await worker.call("/v1/trainer-jobs/imp_x/progress", {
      worker_id: "w",
      attempt: 1,
      metric: {
        step: 1,
        loss: 1,
        tokens: 1,
        timestamp: t.clock.now().toISOString(),
      },
    });
    expect(progress.status).toBe(409);
    const uploads = await worker.call("/v1/trainer-jobs/imp_x/uploads", {
      worker_id: "w",
      attempt: 1,
      kind: "artifact",
      sha256: "0".repeat(64),
      size_bytes: 1,
    });
    expect(uploads.status).toBe(409);
    const ckpt = await worker.call("/v1/trainer-jobs/imp_x/checkpoints", {
      worker_id: "w",
      attempt: 1,
      step: 1,
      upload_id: "x",
    });
    expect(ckpt.status).toBe(409);
    const ds = await t.request("/v1/trainer-jobs/imp_x/dataset?attempt=1", {
      token: undefined as never,
    });
    expect(ds.status).toBe(403);
  });

  it("runs maintenance on an interval until stopped", async () => {
    const run = await createSftRun(t);
    await worker.claim();
    t.clock.advanceSeconds(120);
    t.services.maintenance.start(5);
    t.services.maintenance.start(5);
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      if ((await t.deps.store.runs.getById(run.id))?.status === "queued") break;
    }
    await t.services.maintenance.stop();
    expect((await t.deps.store.runs.getById(run.id))?.status).toBe("queued");
  });
});
