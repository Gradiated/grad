import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { stagingKey } from "../src/services/uploads.js";
import { makeTestApp, WORKSPACE_A, type TestApp } from "./fixtures/app.js";
import { ManualClock } from "./fixtures/clock.js";
import {
  createSftRun,
  FakeWorker,
  sftRecords,
  sha256Hex,
} from "./fixtures/worker.js";

/**
 * The self-hosted deployment mode end to end: Postgres store + S3
 * (SeaweedFS) object storage with presigned uploads/downloads and no
 * in-process state.
 */
describe("self-hosted stack (Postgres + S3)", () => {
  let t: TestApp;
  let worker: FakeWorker;

  beforeEach(async () => {
    t = await makeTestApp({ clock: new ManualClock(new Date()) });
    worker = new FakeWorker(t);
  });

  afterEach(async () => {
    await t.close();
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

    const usage = await t.deps.store.usage.listByRef(run.id);
    expect([...new Set(usage.map((u) => u.attempt))]).toEqual([1, 2]);
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
    await worker.records(job!, 0, sftRecords(2));
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
    // Other bytes stored at the upload's key (a direct put) fail the commit check.
    await t.deps.storage.put(
      stagingKey(WORKSPACE_A, small.body.upload_id),
      Buffer.from("abcd"),
    );
    const mismatch = await t.json("/v1/datasets/s3/imports", {
      body: { source: { kind: "upload", upload_id: small.body.upload_id } },
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body).toMatchObject({ code: "upload_integrity_error" });
  });

  it("hashes the object itself when the backend reports no checksum", async () => {
    const file = Buffer.from(
      sftRecords(1)
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    const sha = sha256Hex(file);
    // A store whose HEAD has no checksum, holding other bytes at the key.
    const head = t.deps.storage.head;
    t.deps.storage.head = async (key) => {
      const found = await head(key);
      return found && { ...found, sha256: null };
    };
    await t.deps.storage.put(stagingKey(WORKSPACE_A, sha), Buffer.from("x"));
    const bad = await t.json("/v1/datasets/nochecksum/imports", {
      body: { source: { kind: "upload", upload_id: sha } },
    });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: "upload_integrity_error" });

    const good = sha256Hex("y");
    await t.deps.storage.put(stagingKey(WORKSPACE_A, good), Buffer.from("y"));
    const imp = await t.json("/v1/datasets/nochecksum/imports", {
      body: { source: { kind: "upload", upload_id: good } },
    });
    expect(imp.status).toBe(202);
  });
});
