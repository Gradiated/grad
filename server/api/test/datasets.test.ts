import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestApp, type TestApp } from "./fixtures/app.js";
import {
  createSftRun,
  FakeWorker,
  sftRecords,
  sha256Hex,
} from "./fixtures/worker.js";

const trajectoryPair = (group: string) => [
  {
    schema: "grad.trajectory/1",
    group_id: group,
    role: "chosen",
    input: {
      messages: [{ role: "user", content: "Merge this diff." }],
      features: { tier: "pro" },
    },
    output: {
      turns: [{ role: "assistant", content: "clean merged code" }],
      token_ids: [1, 2],
    },
    scores: { tests_passed: 1 },
    metadata: { inference_id: "inf_1" },
  },
  {
    schema: "grad.trajectory/1",
    group_id: group,
    role: "rejected",
    input: { messages: [{ role: "user", content: "Merge this diff." }] },
    output: { turns: [{ role: "assistant", content: "truncated" }] },
  },
];

describe("datasets, uploads and imports", () => {
  let t: TestApp;
  let worker: FakeWorker;

  beforeEach(async () => {
    t = await makeTestApp();
    worker = new FakeWorker(t);
  });

  afterEach(async () => {
    await t.close();
  });

  it("creates datasets explicitly and refuses duplicates", async () => {
    const created = await t.json("/v1/datasets", {
      body: { name: "support-prod", metadata: { team: "a" } },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "support-prod",
      version: 0,
      record_count: 0,
      metadata: { team: "a" },
    });
    expect(created.body).not.toHaveProperty("storage_key");
    const dup = await t.json("/v1/datasets", {
      body: { name: "support-prod" },
    });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: "dataset_exists" });
    const missing = await t.json("/v1/datasets/nope");
    expect(missing.status).toBe(404);
  });

  it("versions every append and pins runs to the version at creation", async () => {
    const v1 = await t.json("/v1/datasets/support/records", {
      body: { records: sftRecords(10) },
    });
    expect(v1.body).toMatchObject({ version: 1, record_count: 10 });
    const run = await createSftRun(t, { records: 5 });
    expect(run.dataset_version).toBe(2);

    await t.json("/v1/datasets/support/records", {
      body: { records: sftRecords(7, "late"), metadata: { source: "late" } },
    });
    const ds = await t.json("/v1/datasets/support");
    expect(ds.body).toMatchObject({
      version: 3,
      record_count: 22,
      metadata: { source: "late" },
    });

    const job = await worker.claim();
    expect(job?.dataset).toMatchObject({ version: 2, record_count: 15 });
    expect(await worker.downloadDataset(job!)).toHaveLength(15);

    const pinned = await t.json<{ total: number; version: number }>(
      "/v1/datasets/support/records?version=1",
    );
    expect(pinned.body).toMatchObject({ total: 10, version: 1 });
    const bad = await t.json("/v1/datasets/support/records?version=9");
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: "dataset_version_not_found" });
  });

  it("keeps every concurrent append (no in-process locks)", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        t.json("/v1/datasets/many/records", {
          body: { records: sftRecords(3, `p${i}`) },
        }),
      ),
    );
    const ds = await t.json("/v1/datasets/many");
    expect(ds.body).toMatchObject({ version: 10, record_count: 30 });
    const all = await t.json<{ data: unknown[]; total: number }>(
      "/v1/datasets/many/records?limit=1000",
    );
    expect(all.body.data).toHaveLength(30);
  });

  it("paginates records with a cursor", async () => {
    await t.json("/v1/datasets/pages/records", {
      body: { records: sftRecords(5) },
    });
    await t.json("/v1/datasets/pages/records", {
      body: { records: sftRecords(5, "b") },
    });
    const seen: unknown[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `&cursor=${cursor}` : "";
      const page: { body: { data: unknown[]; next_cursor: string | null } } =
        await t.json(`/v1/datasets/pages/records?limit=3${query}`);
      seen.push(...page.body.data);
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(seen).toHaveLength(10);
    const bad = await t.json("/v1/datasets/pages/records?cursor=WyJ4Il0");
    expect(bad.status).toBe(422);
  });

  it("preserves grad.trajectory/1 fields and rejects unknown keys instead of dropping them", async () => {
    await t.json("/v1/datasets/prefs/records", {
      body: { records: trajectoryPair("pair_1") },
    });
    const page = await t.json<{ data: Array<Record<string, unknown>> }>(
      "/v1/datasets/prefs/records",
    );
    expect(page.body.data[0]).toMatchObject({
      schema: "grad.trajectory/1",
      group_id: "pair_1",
      role: "chosen",
      input: { features: { tier: "pro" } },
      output: { token_ids: [1, 2] },
    });

    const unknown = await t.json("/v1/datasets/prefs/records", {
      body: { records: [{ foo: "bar" }] },
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body).toMatchObject({ code: "validation_error" });
    expect(String((unknown.body as { detail: string }).detail)).toMatch(/foo/);
  });

  it("plans the documented DPO trajectory-group format and rejects shapes a recipe cannot train", async () => {
    await t.json("/v1/datasets/prefs/records", {
      body: {
        records: [
          ...trajectoryPair("g1"),
          ...trajectoryPair("g2"),
          trajectoryPair("g3")[0],
        ],
      },
    });
    const plan = await t.json<{ usable_records: number; warnings: string[] }>(
      "/v1/runs/plan",
      {
        body: {
          dataset: "prefs",
          name: "dpo",
          recipe: { kind: "dpo", model: "test/tiny-qwen3" },
        },
      },
    );
    expect(plan.status).toBe(200);
    expect(plan.body.usable_records).toBe(2);
    expect(plan.body.warnings.join(" ")).toMatch(
      /only a chosen or only a rejected/,
    );

    await t.json("/v1/datasets/queries/records", {
      body: { records: [{ query: "q", positive: "p" }] },
    });
    const sft = await t.json("/v1/runs/plan", {
      body: {
        dataset: "queries",
        name: "x",
        recipe: { kind: "sft", model: "test/tiny-qwen3" },
      },
    });
    expect(sft.status).toBe(422);
    expect(sft.body).toMatchObject({ code: "no_usable_records" });
    const created = await t.json("/v1/runs", {
      body: {
        dataset: "queries",
        name: "x",
        recipe: { kind: "sft", model: "test/tiny-qwen3" },
      },
    });
    expect(created.status).toBe(422);
  });

  it("renders chat templates for chat models only", async () => {
    await t.json("/v1/datasets/support/records", {
      body: { records: sftRecords(4) },
    });
    const res = await t.json<{ examples: unknown[]; token_counts: string }>(
      "/v1/datasets/support/render",
      { body: { model: "qwen/qwen3-8b", limit: 2 } },
    );
    expect(res.status).toBe(200);
    expect(res.body.examples).toHaveLength(2);
    expect(res.body.token_counts).toBe("estimated");
    const encoder = await t.json("/v1/datasets/support/render", {
      body: { model: "baai/bge-small-en-v1.5" },
    });
    expect(encoder.status).toBe(422);
    const conflict = await t.json("/v1/datasets/support/render", {
      body: { model: "qwen/qwen3-8b", thinking: "on" },
    });
    expect(conflict.status).toBe(422);
    expect(conflict.body).toMatchObject({ code: "render_conflict" });
  });

  it("imports an uploaded file through an import job", async () => {
    const file = Buffer.from('{"messages":[]}\n');
    const ticket = await t.json<{
      upload_id: string;
      url: string;
      headers: Record<string, string>;
    }>("/v1/uploads", {
      body: {
        purpose: "dataset_import",
        filename: "traces.jsonl",
        size_bytes: file.byteLength,
        sha256: sha256Hex(file),
      },
    });
    expect(ticket.status).toBe(201);
    expect(ticket.body.url.startsWith("/blobs/uploads/")).toBe(true);

    const early = await t.json("/v1/datasets/traces/imports", {
      body: { source: { kind: "upload", upload_id: ticket.body.upload_id } },
    });
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ code: "upload_incomplete" });

    expect(
      (
        await t.app.request(ticket.body.url, {
          method: "PUT",
          headers: ticket.body.headers,
          body: file,
        })
      ).status,
    ).toBe(200);
    const imp = await t.json<{ id: string; status: string }>(
      "/v1/datasets/traces/imports",
      {
        body: {
          source: {
            kind: "upload",
            upload_id: ticket.body.upload_id,
            format: "jsonl",
          },
          connector: "otel",
        },
      },
    );
    expect(imp.status).toBe(202);
    expect(imp.body).toMatchObject({
      status: "queued",
      dataset: "traces",
      connector: "otel",
    });
    const reuse = await t.json("/v1/datasets/other/imports", {
      body: { source: { kind: "upload", upload_id: ticket.body.upload_id } },
    });
    expect(reuse.status).toBe(409);
    // An unkeyed retry into the same dataset must not queue a second import.
    const sameDataset = await t.json("/v1/datasets/traces/imports", {
      body: { source: { kind: "upload", upload_id: ticket.body.upload_id } },
    });
    expect(sameDataset.body).toMatchObject({ code: "upload_already_used" });

    const job = await worker.claim();
    expect(job?.kind).toBe("import");
    const source = job!.import!.source as {
      kind: string;
      download_url: string;
    };
    expect(source.kind).toBe("upload");
    const downloaded = await t.request(source.download_url, { token: null });
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(file)).toBe(true);
    expect((await worker.heartbeat(job!)).body).toMatchObject({
      should_stop: false,
    });

    const records = [
      ...sftRecords(3),
      { foo: 1 },
      { messages: "nope" },
      { ...sftRecords(1)[0], scores: { csat: 1 } },
    ];
    const post = (seq: number) =>
      worker.call<{
        accepted: number;
        rejected: number;
        errors: unknown[];
      }>(`/v1/trainer-jobs/${job!.id}/records`, {
        ...worker.ref(job!),
        seq,
        records,
      });
    const batch = await post(0);
    expect(batch.body).toMatchObject({ accepted: 4, rejected: 2 });
    expect(batch.body.errors).toHaveLength(2);
    // A retry whose first response was lost is stored once (records without
    // an id get the same deterministic ids, so the part is byte-identical).
    const retry = await post(0);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ accepted: 4, rejected: 2 });
    const progress = await t.json(`/v1/imports/${imp.body.id}`);
    expect(progress.body).toMatchObject({
      imported_count: 4,
      dropped_count: 2,
    });

    const before = await t.json("/v1/datasets/traces");
    expect(before.body).toMatchObject({ version: 0 });
    const done = await worker.complete(job!, {
      status: "completed",
      import_summary: { dropped_count: 3, detected_scores: ["latency"] },
    });
    expect(done.body.import).toMatchObject({
      status: "completed",
      imported_count: 4,
      dropped_count: 5,
      detected_scores: ["csat", "latency"],
      dataset_version: 1,
    });
    const again = await worker.complete(job!, { status: "completed" });
    expect(again.status).toBe(200);

    const got = await t.json(`/v1/imports/${imp.body.id}`);
    expect(got.body).toMatchObject({ status: "completed", imported_count: 4 });
    const listed = await t.json<{ data: unknown[] }>("/v1/imports");
    expect(listed.body.data).toHaveLength(1);
    expect((await t.json("/v1/datasets/traces")).body).toMatchObject({
      version: 1,
      record_count: 4,
    });
  });

  it("queues Hugging Face imports with a column mapping and handles failure and lease expiry", async () => {
    const imp = await t.json<{ id: string; source: Record<string, unknown> }>(
      "/v1/datasets/prefs/imports",
      {
        body: {
          source: {
            kind: "hf",
            repo: "trl-lib/ultrafeedback_binarized",
            split: "train",
            columns: { chosen: "chosen", rejected: "rejected" },
            limit: 2000,
          },
        },
      },
    );
    expect(imp.status).toBe(202);
    expect(imp.body.source).toMatchObject({
      kind: "hf",
      repo: "trl-lib/ultrafeedback_binarized",
      limit: 2000,
    });
    const badRepo = await t.json("/v1/datasets/prefs/imports", {
      body: { source: { kind: "hf", repo: "../etc" } },
    });
    expect(badRepo.status).toBe(422);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const job = await worker.claim();
      expect(job?.attempt).toBe(attempt);
      await worker.call(`/v1/trainer-jobs/${job!.id}/records`, {
        ...worker.ref(job!),
        seq: 0,
        records: sftRecords(2),
      });
      t.clock.advanceSeconds(81);
      await t.services.maintenance.tick();
    }
    const failed = await t.json(`/v1/imports/${imp.body.id}`);
    expect(failed.body).toMatchObject({ status: "failed" });
    expect((await t.json("/v1/datasets/prefs")).body).toMatchObject({
      version: 0,
    });

    const second = await t.json<{ id: string }>("/v1/datasets/prefs/imports", {
      body: { source: { kind: "hf", repo: "org/name" } },
    });
    const job = await worker.claim();
    // A claim retried after a lost response returns the same job.
    expect(await worker.claim()).toMatchObject({ id: job!.id, attempt: 1 });
    const aborted = await worker.complete(job!, { status: "abandoned" });
    expect(aborted.body.import).toMatchObject({ status: "queued" });
    const job2 = await worker.claim();
    // Abandons count toward max_attempts like lease expiries.
    expect(
      (await t.deps.store.imports.getById(job2!.id))?.failed_attempts,
    ).toBe(1);
    const stale = await worker.call(`/v1/trainer-jobs/${job2!.id}/records`, {
      worker_id: worker.workerId,
      attempt: 1,
      seq: 0,
      records: sftRecords(1),
    });
    expect(stale.status).toBe(409);
    const res = await worker.complete(job2!, {
      status: "failed",
      error: "repo not found",
    });
    expect(res.body.import).toMatchObject({
      status: "failed",
      error: "repo not found",
    });
    expect((await t.json(`/v1/imports/${second.body.id}`)).body).toMatchObject({
      status: "failed",
    });
  });

  it("scopes imports and uploads to the caller's workspace", async () => {
    const other = await t.mintKey("ws_b", ["admin"]);
    const imp = await t.json<{ id: string }>("/v1/datasets/x/imports", {
      body: { source: { kind: "hf", repo: "org/name" } },
    });
    expect(
      (await t.json(`/v1/imports/${imp.body.id}`, { token: other })).status,
    ).toBe(404);

    const file = Buffer.from("x");
    const ticket = await t.json<{ upload_id: string; url: string }>(
      "/v1/uploads",
      {
        body: {
          purpose: "dataset_import",
          filename: "f",
          size_bytes: 1,
          sha256: sha256Hex(file),
        },
      },
    );
    await t.app.request(ticket.body.url, { method: "PUT", body: file });
    const stolen = await t.json("/v1/datasets/x/imports", {
      token: other,
      body: { source: { kind: "upload", upload_id: ticket.body.upload_id } },
    });
    expect(stolen.status).toBe(422);
    expect(stolen.body).toMatchObject({ code: "unknown_upload" });
  });

  it("serves signed blob downloads only with a valid signature", async () => {
    const res = await t.request("/blobs/objects?key=uploads/x&exp=1&sig=bad", {
      token: null,
    });
    expect(res.status).toBe(403);
    const path = t.deps.signer.downloadPath(
      "uploads/missing",
      new Date(t.clock.now().getTime() + 60_000),
    );
    const missing = await t.request(path, { token: null });
    expect(missing.status).toBe(404);
  });
});
