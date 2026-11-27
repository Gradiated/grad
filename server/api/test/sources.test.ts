import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TracesAdapter } from "../src/adapters.js";
import { createSecretsCipher } from "../src/secrets.js";
import { ADMIN_KEY, makeTestApp, type TestApp } from "./fixtures/app.js";
import { FakeWorker, type ClaimedJob } from "./fixtures/worker.js";

const KEY = "pk-lf-test:sk-lf-very-secret";
const LANGFUSE = {
  kind: "langfuse",
  host: "https://cloud.langfuse.com",
  secret: "langfuse-prod",
};

const record = (id: string) => ({
  id,
  messages: [
    { role: "user", content: `q ${id}` },
    { role: "assistant", content: `a ${id}` },
  ],
  metadata: { model: "acme/support" },
});

describe("workspace secrets", () => {
  let t: TestApp;

  afterEach(async () => t.close());

  it("answers 501 secrets_unavailable without GRAD_SECRETS_KEY", async () => {
    t = await makeTestApp();
    const res = await t.json("/v1/secrets", {
      body: { name: "x", value: "y" },
    });
    expect(res.status).toBe(501);
    expect(res.body.code).toBe("secrets_unavailable");
    expect((await t.json("/v1/secrets")).body).toEqual({
      data: [],
      next_cursor: null,
    });
  });

  it("stores values sealed, never returns them, and scopes them to a workspace", async () => {
    t = await makeTestApp({
      secrets: createSecretsCipher({ key: randomBytes(32).toString("base64") }),
    });

    const set = await t.json("/v1/secrets", {
      body: { name: "langfuse-prod", value: KEY },
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({
      name: "langfuse-prod",
      workspace_id: "ws_a",
    });
    expect(JSON.stringify(set.body)).not.toContain("sk-lf");

    const replaced = await t.json("/v1/secrets", {
      body: { name: "langfuse-prod", value: "pk:other" },
      headers: { "Idempotency-Key": "k1" },
    });
    expect(replaced.status).toBe(200);
    expect(await t.services.sources.revealSecret("ws_a", "langfuse-prod")).toBe(
      "pk:other",
    );

    const listed = await t.json<{ data: Array<Record<string, unknown>> }>(
      "/v1/secrets",
    );
    expect(listed.body.data.map((s) => s.name)).toEqual(["langfuse-prod"]);
    expect(JSON.stringify(listed.body)).not.toContain("pk:other");
    expect((await t.json("/v1/secrets/langfuse-prod")).body.name).toBe(
      "langfuse-prod",
    );

    const other = await t.mintKey("ws_b", ["admin"]);
    expect(
      (await t.json("/v1/secrets/langfuse-prod", { token: other })).status,
    ).toBe(404);
    const reader = await t.mintKey("ws_a", ["datasets:write"]);
    expect((await t.json("/v1/secrets", { token: reader })).status).toBe(403);
    expect(
      (
        await t.json("/v1/secrets", {
          token: reader,
          body: { name: "a", value: "b" },
        })
      ).status,
    ).toBe(403);

    expect(
      (await t.json("/v1/secrets", { body: { name: "Bad Name", value: "v" } }))
        .status,
    ).toBe(422);
    expect(
      (await t.json("/v1/secrets/langfuse-prod", { method: "DELETE" })).status,
    ).toBe(204);
    expect(
      (await t.json("/v1/secrets/langfuse-prod", { method: "DELETE" })).status,
    ).toBe(404);
  });
});

describe("sources", () => {
  let t: TestApp;
  let worker: FakeWorker;
  let pulls: Array<Parameters<TracesAdapter["pull"]>[0]>;

  const setup = async (traces: TracesAdapter | null = null) => {
    pulls = [];
    t = await makeTestApp({
      secrets: createSecretsCipher({ key: randomBytes(32).toString("base64") }),
      traces,
    });
    worker = new FakeWorker(t);
    await t.json("/v1/secrets", {
      body: { name: "langfuse-prod", value: KEY },
    });
  };

  beforeEach(async () => setup());
  afterEach(async () => t.close());

  const addSource = async (
    body: Record<string, unknown> = { provider: LANGFUSE },
  ) =>
    t.json<Record<string, unknown> & { id: string }>(
      "/v1/datasets/support-prod/sources",
      { body },
    );

  const claimImport = async (): Promise<ClaimedJob> => {
    const job = await worker.claim({ kinds: ["import"] });
    if (!job) throw new Error("expected an import job");
    return job;
  };

  const finish = async (
    job: ClaimedJob,
    ids: string[],
    watermark: Record<string, unknown> | null,
    seq = 0,
  ) => {
    if (ids.length > 0) {
      const posted = await worker.call(`/v1/trainer-jobs/${job.id}/records`, {
        ...worker.ref(job),
        seq,
        records: ids.map(record),
      });
      expect(posted.status).toBe(200);
    }
    return worker.complete(job, {
      status: "completed",
      import_summary: { watermark },
    });
  };

  it("validates providers, secrets, projects and schedules with typed errors", async () => {
    const codes = async (body: Record<string, unknown>) => {
      const res = await addSource(body);
      return [res.status, res.body.code];
    };

    expect(
      await codes({ provider: { kind: "helicone", secret: "langfuse-prod" } }),
    ).toEqual([422, "source_provider_unsupported"]);
    expect(await codes({ provider: { kind: "gradiated" } })).toEqual([
      501,
      "source_unavailable",
    ]);
    expect(
      await codes({ provider: { kind: "langfuse", secret: "missing" } }),
    ).toEqual([422, "secret_not_found"]);
    expect(await codes({ provider: { kind: "langfuse" } })).toEqual([
      422,
      "source_secret_required",
    ]);
    expect(
      await codes({
        provider: { kind: "braintrust", secret: "langfuse-prod" },
      }),
    ).toEqual([422, "source_project_required"]);
    expect(
      await codes({ provider: { kind: "posthog", secret: "langfuse-prod" } }),
    ).toEqual([422, "source_project_required"]);
    expect(await codes({ provider: { kind: "phoenix" } })).toEqual([
      422,
      "source_host_required",
    ]);
    expect(await codes({ provider: { ...LANGFUSE, host: "ftp://x" } })).toEqual(
      [422, "source_host_invalid"],
    );
    expect(await codes({ provider: LANGFUSE, schedule: "every hour" })).toEqual(
      [422, "invalid_schedule"],
    );

    const phoenix = await addSource({
      provider: { kind: "phoenix", host: "http://phoenix.internal:6006" },
    });
    expect(phoenix.status).toBe(201);
    expect(phoenix.body.provider).toEqual({
      kind: "phoenix",
      host: "http://phoenix.internal:6006",
      secret: null,
      project: null,
      filters: {},
    });
  });

  it("creates once per Idempotency-Key and lists by dataset", async () => {
    const headers = { "Idempotency-Key": "src-key" };
    const body = { provider: LANGFUSE, schedule: "*/15 * * * *" };
    const a = await t.json<{ id: string; next_sync_at: string }>(
      "/v1/datasets/support-prod/sources",
      { body, headers },
    );
    const b = await t.json<{ id: string }>(
      "/v1/datasets/support-prod/sources",
      { body, headers },
    );
    expect(a.status).toBe(201);
    expect(b.headers.get("Idempotent-Replayed")).toBe("true");
    expect(b.body.id).toBe(a.body.id);
    expect(Date.parse(a.body.next_sync_at)).toBeGreaterThan(
      t.clock.now().getTime(),
    );

    await t.json("/v1/datasets/other/sources", {
      body: { provider: LANGFUSE },
    });
    const mine = await t.json<{ data: Array<{ id: string }> }>(
      "/v1/sources?dataset=support-prod",
    );
    expect(mine.body.data.map((s) => s.id)).toEqual([a.body.id]);
    expect(
      (await t.json<{ data: unknown[] }>("/v1/sources")).body.data,
    ).toHaveLength(2);
    expect(
      (await t.json<{ data: unknown[] }>("/v1/sources?dataset=nope")).body.data,
    ).toHaveLength(0);

    // The secret can't go while a source reads it.
    const del = await t.json("/v1/secrets/langfuse-prod", { method: "DELETE" });
    expect([del.status, del.body.code]).toEqual([409, "secret_in_use"]);
  });

  it("syncs as an import job: secret at claim only, one sync at a time, watermark on completion", async () => {
    const source = (await addSource()).body;

    const sync = await t.json<{
      id: string;
      status: string;
      source: Record<string, unknown>;
    }>(`/v1/sources/${source.id}/sync`, { body: {} });
    expect(sync.status).toBe(202);
    expect(sync.body.source).toEqual({
      kind: "provider",
      source_id: source.id,
      provider: "langfuse",
      full: false,
    });
    const again = await t.json<{ id: string }>(
      `/v1/sources/${source.id}/sync`,
      { method: "POST" },
    );
    expect(again.body.id).toBe(sync.body.id);

    // A train-only claim never sees it; an import claim gets the plaintext key.
    expect(await worker.claim({ kinds: ["train"] })).toBeNull();
    const job = await claimImport();
    expect(job.import?.source).toEqual({
      kind: "provider",
      source_id: source.id,
      provider: "langfuse",
      host: "https://cloud.langfuse.com",
      secret: KEY,
      project: null,
      filters: {},
      watermark: null,
      full: false,
    });

    const done = await finish(job, ["t1", "t2"], {
      traces: "2026-11-27T10:00:00Z",
      scores: "2026-11-27T10:00:00Z",
    });
    expect(done.status).toBe(200);
    const after = await t.json<Record<string, any>>(`/v1/sources/${source.id}`);
    expect(after.body.last_sync).toMatchObject({
      import_id: job.id,
      status: "completed",
      full: false,
      dataset_version: 1,
    });
    expect(after.body.last_synced_at).not.toBeNull();
    expect(JSON.stringify(after.body)).not.toContain("sk-lf");

    // The next sync starts from the stored watermark.
    await t.json(`/v1/sources/${source.id}/sync`, { body: {} });
    const second = await claimImport();
    expect(second.import?.source.watermark).toEqual({
      traces: "2026-11-27T10:00:00Z",
      scores: "2026-11-27T10:00:00Z",
    });

    // Score updates fold into their records on read; the old version is unchanged.
    const scored = await worker.call(`/v1/trainer-jobs/${second.id}/records`, {
      ...worker.ref(second),
      seq: 0,
      records: [
        {
          id: "t1",
          source: "langfuse",
          scores: { resolved: 1 },
          metadata: { score_update: true },
        },
      ],
    });
    expect(scored.status).toBe(200);
    await worker.complete(second, {
      status: "completed",
      import_summary: { watermark: null },
    });
    const page = await t.json<{
      total: number;
      data: Array<Record<string, unknown>>;
    }>("/v1/datasets/support-prod/records?limit=1");
    expect(page.body.total).toBe(2);
    expect(page.body.data).toEqual([
      { ...record("t1"), scores: { resolved: 1 } },
    ]);
    const v1 = await t.json<{ data: Array<Record<string, unknown>> }>(
      "/v1/datasets/support-prod/records?version=1",
    );
    expect(v1.body.data.map((r) => r.scores)).toEqual([undefined, undefined]);
    // A null watermark keeps the stored one.
    await t.json(`/v1/sources/${source.id}/sync`, { body: {} });
    const third = await claimImport();
    expect(third.import?.source.watermark).toEqual({
      traces: "2026-11-27T10:00:00Z",
      scores: "2026-11-27T10:00:00Z",
    });

    // A failed sync keeps it, so the retry replays the same window.
    await worker.complete(third, { status: "failed", error: "boom" });
    expect(
      (await t.json<Record<string, any>>(`/v1/sources/${source.id}`)).body
        .last_sync.status,
    ).toBe("failed");
    await t.json(`/v1/sources/${source.id}/sync`, { body: { full: true } });
    const full = await claimImport();
    expect(full.import?.source).toMatchObject({ full: true, watermark: null });
    await finish(full, ["t1"], {
      traces: "2026-11-27T11:00:00Z",
      scores: "2026-11-27T11:00:00Z",
    });
    await t.json(`/v1/sources/${source.id}/sync`, { body: {} });
    expect((await claimImport()).import?.source.watermark).toEqual({
      traces: "2026-11-27T11:00:00Z",
      scores: "2026-11-27T11:00:00Z",
    });
  });

  it("fails a queued sync whose source was removed", async () => {
    const source = (await addSource()).body;
    const sync = await t.json<{ id: string }>(`/v1/sources/${source.id}/sync`, {
      body: {},
    });
    expect(
      (await t.json(`/v1/sources/${source.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect((await t.json(`/v1/sources/${source.id}`)).status).toBe(404);

    expect(await worker.claim({ kinds: ["import"] })).toBeNull();
    const failed = await t.json<{ status: string; error: string }>(
      `/v1/imports/${sync.body.id}`,
    );
    expect(failed.body.status).toBe("failed");
    expect(failed.body.error).toContain("was removed");
  });

  it("ticks due schedules on every replica with SKIP LOCKED, at most one sync per source", async () => {
    const source = (
      await addSource({ provider: LANGFUSE, schedule: "*/15 * * * *" })
    ).body as { id: string; next_sync_at: string };
    expect(await t.services.sources.tick(t.clock.now())).toBe(0);

    t.clock.set(new Date(Date.parse(source.next_sync_at) + 1000));
    const ticks = await Promise.all([
      t.services.sources.tick(t.clock.now()),
      t.services.sources.tick(t.clock.now()),
    ]);
    expect(ticks.sort()).toEqual([0, 1]);
    const imports = await t.json<{ data: Array<{ id: string }> }>(
      "/v1/imports",
    );
    expect(imports.body.data).toHaveLength(1);

    // Due again while that sync is queued: no second job, the schedule moves on.
    const moved = (
      await t.json<{ next_sync_at: string }>(`/v1/sources/${source.id}`)
    ).body.next_sync_at;
    expect(Date.parse(moved)).toBeGreaterThan(Date.parse(source.next_sync_at));
    t.clock.set(new Date(Date.parse(moved) + 1000));
    expect(await t.services.sources.tick(t.clock.now())).toBe(1);
    expect(
      (await t.json<{ data: unknown[] }>("/v1/imports")).body.data,
    ).toHaveLength(1);
  });

  it("serves gradiated pages for the job's own workspace through source-page", async () => {
    await t.close();
    await setup({
      pull: async (input) => {
        pulls.push(input);
        return {
          records: [{ type: "trace", trace_id: "gw-1" }],
          cursor: "c1",
          has_more: false,
        };
      },
    });
    const source = (
      await addSource({
        provider: { kind: "gradiated", filters: { models: ["acme/support"] } },
      })
    ).body;
    await t.json(`/v1/sources/${source.id}/sync`, { body: {} });
    const job = await claimImport();
    expect(job.import?.source).toMatchObject({
      provider: "gradiated",
      secret: null,
      host: null,
    });

    const page = await worker.call(`/v1/trainer-jobs/${job.id}/source-page`, {
      ...worker.ref(job),
      cursor: null,
      workspace_id: "ws_b",
    });
    expect(page.body).toEqual({
      records: [{ type: "trace", trace_id: "gw-1" }],
      cursor: "c1",
      has_more: false,
    });
    expect(pulls).toEqual([
      {
        workspaceId: "ws_a",
        filter: { models: ["acme/support"] },
        cursor: null,
        limit: 500,
      },
    ]);

    const stale = await worker.call(`/v1/trainer-jobs/${job.id}/source-page`, {
      ...worker.ref(job),
      attempt: job.attempt + 1,
      cursor: "c1",
    });
    expect(stale.status).toBe(409);
    expect(
      (
        await t.json(`/v1/trainer-jobs/${job.id}/source-page`, {
          token: ADMIN_KEY,
          body: { ...worker.ref(job) },
        })
      ).status,
    ).toBe(403);
  });

  it("answers source-page with 501 on self-hosted servers", async () => {
    const res = await t.json("/v1/trainer-jobs/imp_x/source-page", {
      body: { worker_id: "w", attempt: 1 },
    });
    expect(res.status).toBe(403);
    const direct = await worker.call("/v1/trainer-jobs/imp_x/source-page", {
      worker_id: "worker-1",
      attempt: 1,
    });
    expect([direct.status, direct.body.code]).toEqual([
      501,
      "source_unavailable",
    ]);
  });
});
