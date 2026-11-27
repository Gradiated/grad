import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { S3ObjectStore } from "../src/storage/s3.js";
import { makeTestApp, type TestApp } from "./fixtures/app.js";
import { ManualClock } from "./fixtures/clock.js";
import { s3Target } from "./fixtures/minio.js";
import {
  createSftRun,
  FakeWorker,
  sftRecords,
  sha256Hex,
} from "./fixtures/worker.js";

const target = s3Target();

/**
 * The self-hosted deployment mode end to end: Postgres store + S3 (MinIO)
 * object storage with presigned uploads/downloads and no in-process state.
 */
describe.skipIf(!target)("self-hosted stack (Postgres + S3)", () => {
  let t: TestApp;
  let storage: S3ObjectStore;
  let worker: FakeWorker;

  beforeEach(async () => {
    const clock = new ManualClock(new Date());
    storage = new S3ObjectStore({
      bucket: target!.bucket,
      region: target!.region,
      endpoint: target!.endpoint,
      credentials: {
        accessKeyId: target!.accessKeyId,
        secretAccessKey: target!.secretAccessKey,
      },
    });
    t = await makeTestApp({ storage, clock });
    worker = new FakeWorker(t);
  });

  afterEach(async () => {
    await t.close();
    storage.close();
  });

  it("trains, checkpoints, resumes and publishes through presigned S3 URLs", async () => {
    const run = await createSftRun(t);
    const job = await worker.claim();
    expect(await worker.downloadDataset(job!)).toHaveLength(20);

    const ticket = await worker.call<{
      url: string;
      headers: Record<string, string>;
    }>(`/v1/trainer-jobs/${job!.id}/uploads`, {
      ...worker.ref(job!),
      kind: "checkpoint",
      sha256: sha256Hex("expected"),
      size_bytes: 8,
    });
    expect(ticket.body.url).toMatch(/^http/);
    const tampered = await fetch(ticket.body.url, {
      method: "PUT",
      headers: ticket.body.headers,
      body: "tampered",
    });
    expect(tampered.ok).toBe(false);

    await worker.checkpoint(job!, 2, "ckpt-state", { format: "peft_lora" });
    await worker.progress(job!, 2, 1000);
    const stopped = await worker.complete(
      job!,
      { status: "stopped_budget", tokens_processed: 1000 },
      "first-artifact",
    );
    expect(stopped.body.run).toMatchObject({ status: "stopped_budget" });

    await t.json(`/v1/runs/${run.id}/resume`, {
      method: "POST",
      body: { max_cost_usd: 10 },
    });
    const job2 = await worker.claim();
    expect(job2?.resume?.step).toBe(2);
    expect(job2!.resume!.download_url).toMatch(/^http/);
    expect(await (await fetch(job2!.resume!.download_url)).text()).toBe(
      "ckpt-state",
    );

    const done = await worker.complete(
      job2!,
      { status: "completed", tokens_processed: 10 },
      "final-artifact",
    );
    const artifact = done.body.artifact as { id: string; sha256: string };
    const download = await t.request(`/v1/artifacts/${artifact.id}/download`);
    expect(await download.text()).toBe("final-artifact");
    expect(artifact.sha256).toBe(sha256Hex("final-artifact"));

    const ckpts = await t.json<{ data: Array<{ id: string }> }>(
      `/v1/runs/${run.id}/checkpoints`,
    );
    const promoted = await t.json<{ id: string }>(
      `/v1/checkpoints/${ckpts.body.data[0]!.id}/promote`,
      { body: {} },
    );
    expect(
      await (
        await t.request(`/v1/artifacts/${promoted.body.id}/download`)
      ).text(),
    ).toBe("ckpt-state");

    await t.services.billing.idle();
    const outbox = await t.deps.store.billing.listByRun(run.id);
    expect(outbox.map((e) => [e.attempt, e.status])).toEqual([
      [1, "sent"],
      [2, "sent"],
    ]);
  });

  it("imports a presigned upload and refuses unverifiable uploads", async () => {
    const file = Buffer.from(
      sftRecords(2)
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    const ticket = await t.json<{
      upload_id: string;
      url: string;
      headers: Record<string, string>;
    }>("/v1/uploads", {
      body: {
        purpose: "dataset_import",
        filename: "x.jsonl",
        size_bytes: file.byteLength,
        sha256: sha256Hex(file),
      },
    });
    const early = await t.json("/v1/datasets/s3/imports", {
      body: { source: { kind: "upload", upload_id: ticket.body.upload_id } },
    });
    expect(early.status).toBe(409);

    expect(
      (
        await fetch(ticket.body.url, {
          method: "PUT",
          headers: ticket.body.headers,
          body: file,
        })
      ).ok,
    ).toBe(true);
    const imp = await t.json<{ id: string }>("/v1/datasets/s3/imports", {
      body: { source: { kind: "upload", upload_id: ticket.body.upload_id } },
    });
    expect(imp.status).toBe(202);

    const job = await worker.claim();
    const source = job!.import!.source as { download_url: string };
    expect(
      Buffer.from(
        await (await fetch(source.download_url)).arrayBuffer(),
      ).equals(file),
    ).toBe(true);
    await worker.call(`/v1/trainer-jobs/${job!.id}/records`, {
      ...worker.ref(job!),
      seq: 0,
      records: sftRecords(2),
    });
    const done = await worker.complete(job!, { status: "completed" });
    expect(done.body.import).toMatchObject({
      status: "completed",
      imported_count: 2,
      dataset_version: 1,
    });

    // An object whose size does not match its upload record is rejected.
    const small = await t.json<{
      upload_id: string;
      url: string;
      headers: Record<string, string>;
    }>("/v1/uploads", {
      body: {
        purpose: "dataset_import",
        filename: "y",
        size_bytes: 3,
        sha256: sha256Hex("abc"),
      },
    });
    const record = await t.deps.store.uploads.get(small.body.upload_id);
    await storage.put(record!.storage_key, Buffer.from("abcd"));
    const mismatch = await t.json("/v1/datasets/s3/imports", {
      body: { source: { kind: "upload", upload_id: small.body.upload_id } },
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body).toMatchObject({ code: "upload_integrity_error" });
  });
});
