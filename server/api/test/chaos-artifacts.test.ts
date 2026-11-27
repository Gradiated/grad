import { AsyncResource } from "node:async_hooks";

import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ObjectStore } from "../src/storage/types.js";
import { artifactKey } from "../src/services/uploads.js";
import { makeTestApp, WORKSPACE_A, type TestApp } from "./fixtures/app.js";
import { fileSchemaName, postgresUrl } from "./fixtures/postgres.js";
import { testObjectStore } from "./fixtures/s3.js";
import { createSftRun, FakeWorker, sha256Hex } from "./fixtures/worker.js";

type Json = Record<string, any>;

const LORA = { adapter: { kind: "lora", rank: 8, alpha: 16 } };

/**
 * Chaos: artifact registry races and interrupted steps. `hooks.beforeDelete`
 * runs inside storage.delete, before the object goes, so a test can land a
 * concurrent writer in the window between a deleter's reference check and
 * its S3 delete. `concurrently` starts that writer outside the deleter's
 * (AsyncLocalStorage) transaction, as another request would, and gives it
 * 300 ms to finish or block.
 */
const concurrently = <T>(fn: () => Promise<T>) => {
  const detached = AsyncResource.bind(fn);

  return async (): Promise<{ pending: Promise<T> }> => {
    const pending = detached();
    pending.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));

    return { pending };
  };
};

describe("chaos: artifacts", () => {
  let t: TestApp;
  let worker: FakeWorker;
  let closeS3: () => void;
  const hooks: {
    beforeDelete?: ((key: string) => Promise<void>) | undefined;
    failDelete?: ((key: string) => boolean) | undefined;
  } = {};

  beforeEach(async () => {
    const s3 = testObjectStore();
    closeS3 = s3.close;
    const storage: ObjectStore = {
      ...s3.storage,
      delete: async (key) => {
        const hook = hooks.beforeDelete;
        hooks.beforeDelete = undefined;
        if (hook) await hook(key);
        if (hooks.failDelete?.(key)) throw new Error("S3 503 SlowDown");
        await s3.storage.delete(key);
      },
    };
    t = await makeTestApp({ storage });
    worker = new FakeWorker(t);
    hooks.beforeDelete = undefined;
    hooks.failDelete = undefined;
  });

  afterEach(async () => {
    await t.close();
    closeS3();
  });

  /** A run with a promotable checkpoint whose bundle is `bytes`. */
  const checkpoint = async (bytes: string) => {
    const run = await createSftRun(t);
    const job = (await worker.claim())!;
    await worker.checkpoint(job, 5, bytes, { format: "peft_lora" });
    const [ckpt] = (
      await t.json<{ data: Json[] }>(`/v1/runs/${run.id}/checkpoints`)
    ).body.data;

    return { run, job, ckpt: ckpt! };
  };

  const promote = (id: string, name: string) =>
    t.json<Json>(`/v1/checkpoints/${id}/promote`, { body: { name } });

  const bundleOf = async (artifactId: string) => {
    const row = await t.deps.store.artifacts.get(WORKSPACE_A, artifactId);
    return row ? t.deps.storage.head(row.storage_key) : null;
  };

  it("a delete racing a promote of the same bundle never leaves a release without its bundle", async () => {
    const { ckpt } = await checkpoint("shared-bundle");
    const a = await promote(ckpt.id, "a");
    expect(a.status).toBe(201);

    // Delete `a`; between its reference check and the S3 delete, `b` is
    // promoted from the same checkpoint (the same content-addressed key).
    let pending: Promise<{ status: number; body: Json }> | undefined;
    const start = concurrently(() => promote(ckpt.id, "b"));
    hooks.beforeDelete = async () => {
      ({ pending } = await start());
    };
    const deleted = await t.request(`/v1/artifacts/${a.body.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    let b = await pending;

    // Either b was refused (and a retry recreates its bundle) or b has its bundle.
    if (b?.status !== 201) b = await promote(ckpt.id, "b");
    expect(b.status).toBe(201);
    expect(await bundleOf(b.body.id)).not.toBeNull();
    expect(
      await (await t.request(`/v1/artifacts/${b.body.id}/download`)).text(),
    ).toBe("shared-bundle");
  });

  it("the orphan sweep racing a promote that reuses an old orphaned bundle keeps the bundle", async () => {
    const { ckpt } = await checkpoint("reused-bundle");
    // An old, unreferenced copy at the release key (a delete whose S3 call failed).
    const key = artifactKey(WORKSPACE_A, sha256Hex("reused-bundle"));
    await t.deps.storage.put(key, Buffer.from("reused-bundle"));
    t.clock.advanceDays(8);

    let pending: Promise<{ status: number; body: Json }> | undefined;
    const start = concurrently(() => promote(ckpt.id, "late"));
    hooks.beforeDelete = async (k) => {
      if (k === key) ({ pending } = await start());
    };
    await t.services.maintenance.tick();
    let promoted = await pending;
    if (promoted?.status !== 201) promoted = await promote(ckpt.id, "late");
    expect(promoted.status).toBe(201);
    expect(await bundleOf(promoted.body.id)).not.toBeNull();
  });

  it("an import publishing the bundle a delete is removing is refused, then succeeds on re-upload", async () => {
    // A trained release on bundle X.
    await createSftRun(t);
    const run = (await worker.claim())!;
    const trained = await worker.complete(
      run,
      { status: "completed", format: "peft_lora", manifest: LORA },
      "same-bytes",
    );
    const releaseA = String((trained.body.artifact as Json).id);

    // An upload import whose bundle is X too (the same content-addressed key).
    const data = Buffer.from("user-file");
    const ticket = await t.json<Json>("/v1/uploads", {
      body: {
        purpose: "artifact_import",
        filename: "lora.tar",
        sha256: sha256Hex(data),
        size_bytes: data.byteLength,
      },
    });
    await fetch(ticket.body.url, {
      method: "PUT",
      headers: ticket.body.headers,
      body: new Uint8Array(data),
    });
    const created = await t.json<Json>("/v1/artifact-imports", {
      body: {
        source: { kind: "upload", upload_id: ticket.body.upload_id },
        base_model: "test/tiny-qwen3",
        name: "imported",
      },
    });
    expect(created.status).toBe(202);
    const job = (await worker.claim({ kinds: ["import"] })) as any;
    const manifest = {
      schema: "grad.artifact/1",
      kind: "final",
      format: "peft_lora",
      format_version: 2,
      recipe_kind: "sft",
      base_model: "test/tiny-qwen3",
      provenance: job.artifact_import.provenance,
      ...LORA,
    };
    const complete = async () =>
      worker.call<Json>(`/v1/trainer-jobs/${job.id}/complete`, {
        ...worker.ref(job),
        status: "completed",
        upload_id: await worker.upload(job, "artifact", "same-bytes"),
        format: "peft_lora",
        manifest,
      });

    let pending: Promise<{ status: number; body: Json }> | undefined;
    const start = concurrently(complete);
    hooks.beforeDelete = async () => {
      ({ pending } = await start());
    };
    expect(
      (await t.request(`/v1/artifacts/${releaseA}`, { method: "DELETE" }))
        .status,
    ).toBe(204);
    let done = await pending!;
    if (done.status !== 200) {
      expect(done.body.code).toBe("upload_incomplete");
      done = await complete();
    }
    expect(done.status).toBe(200);
    expect(await bundleOf(String(done.body.artifact.id))).not.toBeNull();
  });

  it("a workspace purge interrupted by an S3 outage or a dead replica resumes and finishes", async () => {
    await createSftRun(t);
    const job = (await worker.claim())!;
    await worker.complete(
      job,
      { status: "completed", format: "peft_lora", manifest: LORA },
      "purged-bundle",
    );
    const bundle = artifactKey(WORKSPACE_A, sha256Hex("purged-bundle"));
    await t.deps.storage.put(`ws/${WORKSPACE_A}/stray/a`, Buffer.from("a"));
    await t.services.workspaces.set(WORKSPACE_A, "deleted");
    t.clock.advanceDays(8);
    const purged = async () =>
      (await t.deps.store.workspaces.get(WORKSPACE_A))?.purged_at ?? null;

    // S3 fails mid-pass: the pass records the error and retries a minute later.
    hooks.failDelete = () => true;
    expect((await t.services.maintenance.tick()).purgedWorkspaces).toBe(0);
    expect(
      (await t.deps.store.workspaces.get(WORKSPACE_A))?.last_error,
    ).toMatch(/SlowDown/);
    hooks.failDelete = undefined;
    expect((await t.services.maintenance.tick()).purgedWorkspaces).toBe(0);
    t.clock.advanceSeconds(61);

    // A replica claims the next pass and dies before finishing it: the claim
    // is a 300 s lease, after which another replica takes the purge over.
    expect(await t.deps.store.workspaces.claimPurge(t.clock.now(), 300)).toBe(
      WORKSPACE_A,
    );
    expect((await t.services.maintenance.tick()).purgedWorkspaces).toBe(0);
    t.clock.advanceSeconds(301);
    for (let i = 0; i < 4 && !(await purged()); i += 1) {
      await t.services.maintenance.tick();
    }
    expect(await purged()).not.toBeNull();
    expect(await t.deps.storage.head(bundle)).toBeNull();
    expect(await t.deps.storage.head(`ws/${WORKSPACE_A}/stray/a`)).toBeNull();
    expect((await t.json("/v1/runs")).body).toMatchObject({ data: [] });
  });

  it("an upload import killed at download, after upload and after its commit releases exactly once", async () => {
    const data = Buffer.from("killed-import");
    const ticket = await t.json<Json>("/v1/uploads", {
      body: {
        purpose: "artifact_import",
        filename: "lora.tar",
        sha256: sha256Hex(data),
        size_bytes: data.byteLength,
      },
    });
    await fetch(ticket.body.url, {
      method: "PUT",
      headers: ticket.body.headers,
      body: new Uint8Array(data),
    });
    const created = await t.json<Json>("/v1/artifact-imports", {
      body: {
        source: { kind: "upload", upload_id: ticket.body.upload_id },
        base_model: "test/tiny-qwen3",
        name: "survivor",
      },
      headers: { "Idempotency-Key": "import-once" },
    });
    // A lost response: the retry with the same key gets the same import.
    const retried = await t.json<Json>("/v1/artifact-imports", {
      body: {
        source: { kind: "upload", upload_id: ticket.body.upload_id },
        base_model: "test/tiny-qwen3",
        name: "survivor",
      },
      headers: { "Idempotency-Key": "import-once" },
    });
    expect(retried.body.id).toBe(created.body.id);
    const expire = async () => {
      t.clock.advanceSeconds(600);
      await t.services.maintenance.tick();
    };

    // Attempt 1 dies downloading: its lease expires and attempt 2 starts.
    const first = (await worker.claim({ kinds: ["import"] })) as any;
    expect(first.attempt).toBe(1);
    await expire();

    // Attempt 2 dies after uploading its bundle, before /complete.
    const second = (await worker.claim({ kinds: ["import"] })) as any;
    expect(second.attempt).toBe(2);
    expect(
      await (await fetch(second.artifact_import.source.download_url)).text(),
    ).toBe("killed-import");
    await worker.upload(second, "artifact", "bundle-of-killed-import");
    await expire();

    // Attempt 3 re-uploads the same bundle (same key) and completes; its ack
    // is lost and the retried /complete answers the same release.
    const third = (await worker.claim({ kinds: ["import"] })) as any;
    expect(third.attempt).toBe(3);
    const manifest = {
      schema: "grad.artifact/1",
      kind: "final",
      format: "peft_lora",
      format_version: 2,
      recipe_kind: "sft",
      base_model: "test/tiny-qwen3",
      provenance: third.artifact_import.provenance,
      ...LORA,
    };
    const uploadId = await worker.upload(
      third,
      "artifact",
      "bundle-of-killed-import",
    );
    const complete = () =>
      worker.call<Json>(`/v1/trainer-jobs/${third.id}/complete`, {
        ...worker.ref(third),
        status: "completed",
        upload_id: uploadId,
        format: "peft_lora",
        manifest,
      });
    const done = await complete();
    expect(done.status).toBe(200);
    const again = await complete();
    expect(again.status).toBe(200);
    expect(again.body.artifact.id).toBe(done.body.artifact.id);

    const releases = await t.json<{ data: Json[] }>(
      "/v1/artifacts?name=survivor",
    );
    expect(releases.body.data).toHaveLength(1);
    expect(
      (await t.json<Json>(`/v1/artifact-imports/${created.body.id}`)).body,
    ).toMatchObject({ status: "completed", attempt: 3 });
    expect(await bundleOf(String(done.body.artifact.id))).not.toBeNull();
  });

  it("promoting a checkpoint whose blob just expired answers 404, not 500", async () => {
    const { ckpt } = await checkpoint("expired-blob");
    const row = await t.deps.store.artifacts.getCheckpoint(
      WORKSPACE_A,
      ckpt.id,
    );
    // Retention deleted the blob between the promote's read and its copy.
    await t.deps.storage.delete(row!.storage_key);
    const res = await promote(ckpt.id, "late");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("checkpoint_not_found");
  });

  it("a pin racing a delete answers 404 or 409, never 500", async () => {
    await createSftRun(t);
    const job = (await worker.claim())!;
    const done = await worker.complete(
      job,
      { status: "completed", format: "peft_lora", manifest: LORA },
      "pin-race",
    );
    const id = String((done.body.artifact as Json).id);
    const schema = await fileSchemaName();

    // A delete holds the row (FOR UPDATE) when the pin's insert arrives.
    const client = new pg.Client({ connectionString: postgresUrl() });
    await client.connect();
    try {
      await client.query(`SET search_path TO "${schema}"`);
      await client.query("BEGIN");
      await client.query(
        "SELECT 1 FROM grad_artifacts WHERE id = $1 FOR UPDATE",
        [id],
      );
      const pin = t.json<Json>(`/v1/artifacts/${id}/pins`, {
        body: { holder: "inference:mv_1", reason: "v1" },
      });
      await new Promise((r) => setTimeout(r, 300));
      await client.query("DELETE FROM grad_artifacts WHERE id = $1", [id]);
      await client.query("COMMIT");
      const res = await pin;
      expect([404, 409]).toContain(res.status);
    } finally {
      await client.end();
    }
  });
});
