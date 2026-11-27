import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { jobBlobKey, stagingKey } from "../src/services/uploads.js";
import { makeTestApp, WORKSPACE_A, type TestApp } from "./fixtures/app.js";
import {
  createSftRun,
  FakeWorker,
  sftRecords,
  sha256Hex,
} from "./fixtures/worker.js";

describe("data model: one queue, artifacts, staged parts, sweeps", () => {
  let t: TestApp;
  let worker: FakeWorker;

  beforeEach(async () => {
    t = await makeTestApp();
    worker = new FakeWorker(t);
  });

  afterEach(async () => {
    await t.close();
  });

  it("answers 501 on the paths Gradiated Cloud serves, with what to do instead", async () => {
    const cases: Array<[string, string, unknown, string]> = [
      [
        "POST",
        "/v1/deployments",
        { artifact: "a@latest" },
        "deploy_unavailable",
      ],
      ["GET", "/v1/deployments", undefined, "deploy_unavailable"],
      ["GET", "/v1/deployments/router", undefined, "deploy_unavailable"],
      [
        "POST",
        "/v1/deployments/router/rollback",
        undefined,
        "deploy_unavailable",
      ],
      [
        "POST",
        "/v1/route",
        { deployment: "router", messages: [{ role: "user", content: "hi" }] },
        "inference_unavailable",
      ],
      [
        "POST",
        "/v1/embeddings",
        { model: "emb", input: "hi" },
        "inference_unavailable",
      ],
      [
        "POST",
        "/v1/feedback",
        { events: [{ idempotency_key: "k", score: 1 }] },
        "inference_unavailable",
      ],
    ];
    for (const [method, path, body, code] of cases) {
      const res = await t.json<{ code: string; detail: string }>(path, {
        method,
        ...(body !== undefined ? { body } : {}),
      });
      expect(res.status, path).toBe(501);
      expect(res.body.code, path).toBe(code);
      expect(res.body.detail, path).toMatch(/Gradiated Cloud/);
      expect(res.body.detail, path).toMatch(/vLLM/);
    }
    // The documented request shapes still validate.
    expect(
      (await t.json("/v1/deployments", { body: { artifact: "" } })).status,
    ).toBe(422);
  });

  it("promotes a checkpoint by reference, once per name, and keeps its blob past checkpoint expiry", async () => {
    const run = await createSftRun(t);
    const job = (await worker.claim())!;
    await worker.checkpoint(job, 5, "ckpt-five", { format: "peft_lora" });
    await worker.checkpoint(job, 6, "ckpt-six");
    const [ckpt] = (
      await t.json<{ data: Array<{ id: string; sha256: string }> }>(
        `/v1/runs/${run.id}/checkpoints`,
      )
    ).body.data;

    const promoted = await t.json<{
      id: string;
      sha256: string;
      checkpoint_id: string;
    }>(`/v1/checkpoints/${ckpt!.id}/promote`, { body: { name: "best" } });
    expect(promoted.status).toBe(201);
    expect(promoted.body).toMatchObject({
      sha256: sha256Hex("ckpt-five"),
      checkpoint_id: ckpt!.id,
    });
    const again = await t.json<{ id: string }>(
      `/v1/checkpoints/${ckpt!.id}/promote`,
      { body: { name: "best" } },
    );
    expect(again.body.id).toBe(promoted.body.id);
    const blob = jobBlobKey(run as never, 1, sha256Hex("ckpt-five"));
    const release = await t.deps.store.artifacts.get(
      WORKSPACE_A,
      promoted.body.id,
    );
    expect(release?.storage_key).toBe(blob);

    // Past the TTL the checkpoints expire; only the unshared blob goes.
    t.clock.advanceDays(31);
    await worker.heartbeat(job).catch(() => undefined);
    const report = await t.services.maintenance.tick();
    expect(report.deletedCheckpoints).toBe(1);
    expect(await t.deps.storage.head(blob)).not.toBeNull();
    expect(
      await t.deps.storage.head(
        jobBlobKey(run as never, 1, sha256Hex("ckpt-six")),
      ),
    ).toBeNull();
    const download = await t.request(
      `/v1/artifacts/${promoted.body.id}/download`,
    );
    expect(await download.text()).toBe("ckpt-five");
  });

  it("an import commits only its final attempt's staged parts and deletes the rest", async () => {
    const imp = await t.json<{ id: string }>("/v1/datasets/staged/imports", {
      body: { source: { kind: "hf", repo: "o/n" } },
    });
    const post = (
      job: { id: string; attempt: number },
      w: FakeWorker,
      seq: number,
      n: number,
    ) =>
      w.call(`/v1/trainer-jobs/${job.id}/records`, {
        ...w.ref(job as never),
        seq,
        records: sftRecords(n),
      });

    const first = (await worker.claim())!;
    expect((await post(first, worker, 0, 4)).status).toBe(200);
    const staleKey = `${jobBlobKey({ workspace_id: WORKSPACE_A, id: imp.body.id }, 1, "records")}/0.jsonl`;
    expect(await t.deps.storage.head(staleKey)).not.toBeNull();
    t.clock.advanceSeconds(90);
    await t.services.maintenance.tick();

    const second = new FakeWorker(t, "worker-2");
    const job = (await second.claim())!;
    expect(job.attempt).toBe(2);
    await post(job, second, 0, 2);
    await post(job, second, 1, 3);
    const done = await second.call<{
      import: { imported_count: number; dataset_version: number };
    }>(`/v1/trainer-jobs/${job.id}/complete`, {
      ...second.ref(job),
      status: "completed",
    });
    expect(done.body.import).toMatchObject({
      imported_count: 5,
      dataset_version: 1,
    });
    expect(
      (await t.json<{ record_count: number }>("/v1/datasets/staged")).body
        .record_count,
    ).toBe(5);
    expect(await t.deps.storage.head(staleKey)).toBeNull();
  });

  it("a failed import drops its staged parts", async () => {
    await t.json("/v1/datasets/dropped/imports", {
      body: { source: { kind: "hf", repo: "o/n" } },
    });
    const job = (await worker.claim())!;
    await worker.call(`/v1/trainer-jobs/${job.id}/records`, {
      ...worker.ref(job),
      seq: 0,
      records: sftRecords(2),
    });
    const failed = await worker.call<{ import: { status: string } }>(
      `/v1/trainer-jobs/${job.id}/complete`,
      { ...worker.ref(job), status: "failed", error: "bad file" },
    );
    expect(failed.body.import.status).toBe("failed");
    expect(await t.deps.store.datasets.listStaged(job.id, 1)).toEqual({
      parts: [],
      dropped: 0,
      count: 0,
    });
    expect(
      (await t.json<{ version: number }>("/v1/datasets/dropped")).body.version,
    ).toBe(0);
  });

  it("sweeps staged uploads after 7 days and job events after the retention", async () => {
    const file = Buffer.from("old upload");
    const key = stagingKey(WORKSPACE_A, sha256Hex(file));
    await t.deps.storage.put(key, file);
    const run = await createSftRun(t);
    const job = (await worker.claim())!;
    await worker.progress(job, 1, 10);

    // Object ages come from the filesystem, so age them by moving "now".
    const real = t.clock.now();
    t.clock.set(new Date(Date.now() + 8 * 86_400_000));
    const swept = await t.services.uploads.sweepStaging(t.clock.now());
    expect(swept).toBe(1);
    expect(await t.deps.storage.head(key)).toBeNull();

    t.clock.set(new Date(real.getTime() + 91 * 86_400_000));
    const report = await t.services.maintenance.tick();
    expect(report.deletedEvents).toBe(1);
    expect(
      (await t.json<{ data: unknown[] }>(`/v1/runs/${run.id}/metrics`)).body
        .data,
    ).toEqual([]);
  });
});
