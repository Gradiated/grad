import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { artifactKey } from "../src/services/uploads.js";
import { makeTestApp, WORKSPACE_A, type TestApp } from "./fixtures/app.js";
import { sql } from "./fixtures/postgres.js";
import {
  createSftRun,
  FakeWorker,
  sha256Hex,
  type ClaimedJob,
} from "./fixtures/worker.js";

type Json = Record<string, any>;

const LORA_MANIFEST = { adapter: { kind: "lora", rank: 8, alpha: 16 } };

describe("artifact registry: layout, provenance, uploads, imports, pins", () => {
  let t: TestApp;
  let worker: FakeWorker;

  beforeEach(async () => {
    t = await makeTestApp();
    worker = new FakeWorker(t);
  });

  afterEach(async () => {
    await t.close();
  });

  /** A trained SFT artifact (its bundle is `bytes`). */
  const trained = async (bytes = "trained-bundle"): Promise<Json> => {
    await createSftRun(t);
    const job = (await worker.claim())!;
    const done = await worker.complete(
      job,
      { status: "completed", format: "peft_lora", manifest: LORA_MANIFEST },
      bytes,
    );
    expect(done.status).toBe(200);

    return done.body.artifact as Json;
  };

  /** Stages `bytes` with POST /v1/uploads, the way the SDKs do. */
  const stage = async (bytes: string, token?: string): Promise<string> => {
    const data = Buffer.from(bytes);
    const ticket = await t.json<Json>("/v1/uploads", {
      body: {
        purpose: "artifact_import",
        filename: "lora.tar",
        sha256: sha256Hex(data),
        size_bytes: data.byteLength,
      },
      ...(token ? { token } : {}),
    });
    expect(ticket.status).toBe(201);
    const put = await fetch(ticket.body.url, {
      method: "PUT",
      headers: ticket.body.headers,
      body: new Uint8Array(data),
    });
    expect(put.status).toBe(200);

    return ticket.body.upload_id as string;
  };

  const createImport = (body: Json, token?: string) =>
    t.json<Json>("/v1/artifact-imports", {
      body,
      ...(token ? { token } : {}),
    });

  /** The worker's side of an artifact import: bundle, upload, complete. */
  const publish = async (job: ClaimedJob, manifest: Json, bytes: string) => {
    const uploadId = await worker.upload(job, "artifact", bytes);

    return worker.call<Json>(`/v1/trainer-jobs/${job.id}/complete`, {
      ...worker.ref(job),
      status: "completed",
      upload_id: uploadId,
      format: manifest.format,
      manifest,
    });
  };

  it("stores a run's bundle under artifacts/<ws>/<sha256> with run provenance", async () => {
    const artifact = await trained();
    expect(artifact.provenance).toEqual({
      source: "run",
      run_id: artifact.run_id,
      uploader: null,
      uri: null,
    });
    expect(artifact.manifest.provenance).toEqual({
      source: "run",
      run_id: artifact.run_id,
    });
    const row = await t.deps.store.artifacts.get(WORKSPACE_A, artifact.id);
    expect(row?.storage_key).toBe(
      artifactKey(WORKSPACE_A, sha256Hex("trained-bundle")),
    );
    // S3 keeps the bundle's full-object SHA-256: the recorded sha256.
    expect((await t.deps.storage.head(row!.storage_key))?.sha256).toBe(
      artifact.sha256,
    );

    // A browser following the presigned link saves the bundle under its name.
    const link = await t.json<{ url: string; filename: string }>(
      `/v1/artifacts/${artifact.id}/download-url`,
    );
    const filename = `${artifact.name}-${artifact.version}.grad.tar.gz`;
    expect(link.body.filename).toBe(filename);
    const res = await fetch(link.body.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="${filename}"; filename*=UTF-8''${filename}`,
    );
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe(
      "trained-bundle",
    );
  });

  it("reads releases written before provenance as source=run", async () => {
    const artifact = await trained();
    // A pre-registry manifest: no provenance.
    const { provenance: _p, ...manifest } = artifact.manifest;
    await sql("UPDATE grad_artifacts SET manifest = $1::jsonb WHERE id = $2", [
      JSON.stringify(manifest),
      artifact.id,
    ]);
    const res = await t.json<Json>(`/v1/artifacts/${artifact.id}`);
    expect(res.body.provenance.source).toBe("run");
    expect(res.body.provenance.run_id).toBe(artifact.run_id);
  });

  it("deletes an unpinned artifact, its bundle and its run's artifact_id", async () => {
    const artifact = await trained();
    const key = artifactKey(WORKSPACE_A, sha256Hex("trained-bundle"));
    const deleted = await t.request(`/v1/artifacts/${artifact.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    expect((await t.json(`/v1/artifacts/${artifact.id}`)).status).toBe(404);
    expect(await t.deps.storage.head(key)).toBeNull();
    const run = await t.json<Json>(`/v1/runs/${artifact.run_id}`);
    expect(run.body.artifact_id).toBeNull();
    // Needs artifacts:write.
    const reader = await t.mintKey(WORKSPACE_A, ["artifacts:read"]);
    const other = await trained("second-bundle");
    expect(
      (
        await t.request(`/v1/artifacts/${other.id}`, {
          method: "DELETE",
          token: reader,
        })
      ).status,
    ).toBe(403);
  });

  it("a pinned artifact can't be deleted by users, retention, sweeps or workspace cleanup", async () => {
    const artifact = await trained();
    const key = artifactKey(WORKSPACE_A, sha256Hex("trained-bundle"));
    const pinPath = `/v1/artifacts/${artifact.id}/pins`;
    const pin = {
      holder: "inference:model-version:mv_1",
      reason: "acme/sql v3",
    };

    // artifacts:pin (or admin); artifacts:write is not enough.
    const writer = await t.mintKey(WORKSPACE_A, ["artifacts:write"]);
    expect((await t.json(pinPath, { body: pin, token: writer })).status).toBe(
      403,
    );
    const pinner = await t.mintKey(WORKSPACE_A, ["artifacts:pin"]);
    const first = await t.json<Json>(pinPath, { body: pin, token: pinner });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ artifact_id: artifact.id, ...pin });
    const again = await t.json<Json>(pinPath, {
      body: { ...pin, reason: "other" },
    });
    expect(again.status).toBe(200);
    expect(again.body.reason).toBe("acme/sql v3");
    expect(
      (await t.json(`/v1/artifacts/nope@2026-01-01-1/pins`, { body: pin }))
        .status,
    ).toBe(404);

    // User delete: 409 naming the holder.
    const refused = await t.json<Json>(`/v1/artifacts/${artifact.id}`, {
      method: "DELETE",
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("artifact_pinned");
    expect(refused.body.detail).toContain("inference:model-version:mv_1");

    // Any other path that deletes the row hits the foreign key.
    await expect(
      sql("DELETE FROM grad_artifacts WHERE workspace_id = $1", [WORKSPACE_A]),
    ).rejects.toThrow(/foreign key|grad_artifact_pins/);

    // Retention and the orphan sweep keep it: its row references the bundle.
    t.clock.set(new Date(Date.now() + 40 * 86_400_000));
    await t.services.maintenance.tick();
    await t.services.maintenance.tick();
    expect(await t.deps.storage.head(key)).not.toBeNull();
    expect((await t.json(`/v1/artifacts/${artifact.id}`)).status).toBe(200);

    // Unpinning lets it go.
    expect(
      (
        await t.request(`${pinPath}/inference:model-version:mv_1`, {
          method: "DELETE",
          token: pinner,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await t.request(`${pinPath}/inference:model-version:mv_1`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    expect(
      (await t.request(`/v1/artifacts/${artifact.id}`, { method: "DELETE" }))
        .status,
    ).toBe(204);
  });

  it("sweeps a released bundle no row references", async () => {
    const orphan = artifactKey(WORKSPACE_A, sha256Hex("lost"));
    await t.deps.storage.put(orphan, Buffer.from("lost"));
    const kept = await trained();
    t.clock.set(new Date(Date.now() + 8 * 86_400_000));
    expect((await t.services.maintenance.tick()).deletedOrphanBlobs).toBe(1);
    expect(await t.deps.storage.head(orphan)).toBeNull();
    expect((await t.request(`/v1/artifacts/${kept.id}/download`)).status).toBe(
      200,
    );
  });

  it("uploads: a staged file becomes name@version with upload provenance, usable for continued training", async () => {
    const uploader = await t.mintKey(WORKSPACE_A, ["artifacts:write"]);
    const uploadId = await stage("user-lora.tar", uploader);
    const created = await createImport(
      {
        source: { kind: "upload", upload_id: uploadId },
        base_model: "test/tiny-qwen3",
        name: "my-lora",
      },
      uploader,
    );
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({
      status: "queued",
      name: "my-lora",
      format: "peft_lora",
      base_model: "test/tiny-qwen3",
      source: { kind: "upload", upload_id: uploadId, repo: null },
      artifact_id: null,
    });
    // Artifact imports aren't dataset imports.
    expect((await t.json<Json>("/v1/imports")).body.data).toEqual([]);
    expect((await t.json(`/v1/imports/${created.body.id}`)).status).toBe(404);

    const job = (await worker.claim({ kinds: ["import"] })) as ClaimedJob & {
      artifact_import: Json;
    };
    expect(job.import).toBeNull();
    expect(job.artifact_import).toMatchObject({
      name: "my-lora",
      format: "peft_lora",
      base_model: "test/tiny-qwen3",
      provenance: { source: "upload", uploader: expect.any(String) },
      source: { kind: "upload", sha256: uploadId },
    });
    const download = await fetch(job.artifact_import.source.download_url);
    expect(await download.text()).toBe("user-lora.tar");

    // Bundles go to artifacts/, never as records parts.
    const wrong = await worker.call(`/v1/trainer-jobs/${job.id}/uploads`, {
      ...worker.ref(job),
      kind: "records",
      sha256: sha256Hex("x"),
      size_bytes: 1,
    });
    expect(wrong.status).toBe(409);

    const manifest = {
      schema: "grad.artifact/1",
      kind: "final",
      format: "peft_lora",
      format_version: 2,
      recipe_kind: "sft",
      base_model: "test/tiny-qwen3",
      provenance: job.artifact_import.provenance,
      ...LORA_MANIFEST,
    };
    const done = await publish(job, manifest, "bundled-upload");
    expect(done.status).toBe(200);
    expect(done.body.artifact_import).toMatchObject({
      status: "completed",
      artifact_id: done.body.artifact.id,
    });
    const artifact = done.body.artifact as Json;
    expect(artifact).toMatchObject({
      name: "my-lora",
      run_id: null,
      recipe_kind: "sft",
      format: "peft_lora",
      sha256: sha256Hex("bundled-upload"),
      provenance: {
        source: "upload",
        run_id: null,
        uploader: job.artifact_import.provenance.uploader,
        uri: null,
      },
    });
    expect(artifact.id).toMatch(/^my-lora@\d{4}-\d{2}-\d{2}-1$/);
    expect(
      (await t.deps.store.artifacts.get(WORKSPACE_A, artifact.id))?.storage_key,
    ).toBe(artifactKey(WORKSPACE_A, sha256Hex("bundled-upload")));
    expect(
      (await t.deps.storage.head(artifactKey(WORKSPACE_A, artifact.sha256)))
        ?.sha256,
    ).toBe(artifact.sha256);
    const polled = await t.json<Json>(
      `/v1/artifact-imports/${created.body.id}`,
    );
    expect(polled.body).toMatchObject({
      status: "completed",
      artifact_id: artifact.id,
    });
    // A retried completion answers the same.
    const retry = await worker.call<Json>(
      `/v1/trainer-jobs/${job.id}/complete`,
      { ...worker.ref(job), status: "completed" },
    );
    expect(retry.body.artifact.id).toBe(artifact.id);

    // Continued training: the same rules as a trained LoRA.
    await t.json("/v1/datasets/prefs/records", {
      body: {
        records: Array.from({ length: 12 }, (_, i) => ({
          id: `p${i}`,
          prompt: `q ${i}`,
          chosen: `good ${i}`,
          rejected: `bad ${i}`,
        })),
      },
    });
    const plan = await t.json<Json>("/v1/runs/plan", {
      body: {
        dataset: "prefs",
        name: "dpo-from-upload",
        recipe: { kind: "dpo", model: "my-lora@latest" },
      },
    });
    expect(plan.status).toBe(200);
    expect(plan.body.resolved_config).toMatchObject({
      model: "test/tiny-qwen3",
      adapter: { kind: "lora", rank: 8, alpha: 16 },
      base_artifact: { id: artifact.id, format: "peft_lora" },
    });
  });

  it("a validation failure fails the import with invalid_artifact and the worker's message", async () => {
    const uploadId = await stage("bad-lora.tar");
    const created = await createImport({
      source: { kind: "upload", upload_id: uploadId },
      base_model: "test/tiny-qwen3",
      name: "bad-lora",
    });
    const job = (await worker.claim())!;
    const failed = await worker.call<Json>(
      `/v1/trainer-jobs/${job.id}/complete`,
      {
        ...worker.ref(job),
        status: "failed",
        error_code: "invalid_artifact",
        error:
          "adapter_config.json: base_model_name_or_path is 'Qwen/Qwen3-8B', expected 'test/tiny-qwen3'",
      },
    );
    expect(failed.status).toBe(200);
    const polled = await t.json<Json>(
      `/v1/artifact-imports/${created.body.id}`,
    );
    expect(polled.body).toMatchObject({
      status: "failed",
      error_code: "invalid_artifact",
      artifact_id: null,
    });
    expect(polled.body.error).toMatch(/^adapter_config.json: /);
    expect((await t.json<Json>("/v1/artifacts")).body.data).toEqual([]);
  });

  it("HF import revisions are branch, tag or commit names (security review 2026-11-28)", async () => {
    for (const revision of [
      "../../api/whoami",
      "main/../x",
      "http://169.254.169.254/",
      "main?x=1",
      "main#x",
      "-rf",
      "main%2F..",
    ]) {
      const bad = await createImport({
        source: { kind: "hf", repo: "acme/lora", revision },
        base_model: "test/tiny-qwen3",
      });
      expect(bad.status, revision).toBe(422);
    }
    for (const revision of ["main", "v1.0", "refs/pr/1", "a".repeat(40)]) {
      const ok = await createImport({
        source: { kind: "hf", repo: "acme/lora", revision },
        base_model: "test/tiny-qwen3",
        name: `ok-${revision.replace(/[^a-z0-9]/g, "-").slice(0, 20)}`,
      });
      expect(ok.status, revision).toBe(202);
    }
  });

  it("HF imports pin the commit the worker resolved", async () => {
    const created = await createImport({
      source: { kind: "hf", repo: "acme/Support-LoRA", revision: "main" },
      base_model: "test/tiny-qwen3",
    });
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({
      name: "support-lora",
      source: { kind: "hf", repo: "acme/Support-LoRA", revision: "main" },
    });
    const job = (await worker.claim()) as ClaimedJob & {
      artifact_import: Json;
    };
    expect(job.artifact_import.source).toEqual({
      kind: "hf",
      repo: "acme/Support-LoRA",
      revision: "main",
    });
    const manifest = (uri: string) => ({
      format: "peft_lora",
      base_model: "test/tiny-qwen3",
      provenance: { source: "import", uri },
      ...LORA_MANIFEST,
    });
    const unpinned = await publish(
      job,
      manifest("hf://acme/Support-LoRA@main"),
      "hf-bundle",
    );
    expect(unpinned.status).toBe(422);
    const commit = "a".repeat(40);
    const done = await publish(
      job,
      manifest(`hf://acme/Support-LoRA@${commit}`),
      "hf-bundle",
    );
    expect(done.status).toBe(200);
    expect(done.body.artifact.provenance).toEqual({
      source: "import",
      run_id: null,
      uploader: null,
      uri: `hf://acme/Support-LoRA@${commit}`,
    });
    expect(done.body.artifact_import.source.revision).toBe(commit);
    // A manifest for another format or base is refused.
    const other = await createImport({
      source: { kind: "hf", repo: "acme/other" },
      base_model: "test/tiny-qwen3",
    });
    const next = (await worker.claim())!;
    expect(next.id).toBe(other.body.id);
    const mismatch = await publish(
      next,
      { ...manifest(`hf://acme/other@${commit}`), format: "cartridge" },
      "x",
    );
    expect(mismatch.status).toBe(409);
  });

  it("refuses unknown bases, a format the base can't take, and nameless uploads", async () => {
    const uploadId = await stage("x.tar");
    const cases: Array<[Json, string]> = [
      [
        { source: { kind: "hf", repo: "a/b" }, base_model: "nope/model" },
        "unknown_model",
      ],
      [
        {
          source: { kind: "hf", repo: "a/b" },
          base_model: "test/tiny-qwen3",
          format: "encoder_safetensors",
        },
        "format_base_mismatch",
      ],
      [
        {
          source: { kind: "upload", upload_id: uploadId },
          base_model: "test/tiny-qwen3",
        },
        "name_required",
      ],
      [
        {
          source: { kind: "upload", upload_id: sha256Hex("never uploaded") },
          base_model: "test/tiny-qwen3",
          name: "n",
        },
        "upload_incomplete",
      ],
    ];
    for (const [body, code] of cases) {
      const res = await createImport(body);
      expect(res.body.code, code).toBe(code);
    }
    // The HF token secret needs secrets:read too.
    const writer = await t.mintKey(WORKSPACE_A, ["artifacts:write"]);
    const secret = await createImport(
      {
        source: { kind: "hf", repo: "a/b", secret: "hf-token" },
        base_model: "test/tiny-qwen3",
      },
      writer,
    );
    expect(secret.status).toBe(403);
    expect((await t.json("/v1/artifact-imports/imp_nope")).status).toBe(404);
  });
});
