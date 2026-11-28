import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TracesAdapter } from "../src/adapters.js";
import { SOURCE_FILTER_KEYS } from "../src/contracts.js";
import { createSecretsCipher } from "../src/secrets.js";
import {
  MAX_BACKOFF_SECONDS,
  nextScheduledSync,
  PAUSE_AFTER_FAILURES,
} from "../src/services/sources.js";
import { ADMIN_KEY, makeTestApp, type TestApp } from "./fixtures/app.js";
import {
  createSftRun,
  FakeWorker,
  type ClaimedJob,
} from "./fixtures/worker.js";

describe("source filter keys", () => {
  it("match the trainer's providers (tests/fixtures/wire/source-filter-keys.json)", () => {
    const wire = JSON.parse(
      readFileSync(
        new URL(
          "../../../tests/fixtures/wire/source-filter-keys.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as { providers: Record<string, string[]> };
    expect(SOURCE_FILTER_KEYS).toEqual(wire.providers);
  });
});

describe("nextScheduledSync", () => {
  const at = new Date("2026-11-27T10:07:00Z");
  const after = (schedule: string, failures: number) =>
    nextScheduledSync(schedule, at, failures);

  it("doubles the interval per consecutive failure, capped at an hour", () => {
    expect(after("*/15 * * * *", 0)).toBe("2026-11-27T10:15:00.000Z");
    expect(after("*/15 * * * *", 1)).toBe("2026-11-27T10:37:00.000Z");
    expect(after("*/15 * * * *", 2)).toBe("2026-11-27T11:07:00.000Z");
    expect(after("*/15 * * * *", 9)).toBe("2026-11-27T11:07:00.000Z");
    expect(after("* * * * *", 1)).toBe("2026-11-27T10:09:00.000Z");
    expect(after("* * * * *", 3)).toBe("2026-11-27T10:15:00.000Z");
    expect(MAX_BACKOFF_SECONDS).toBe(3600);
  });

  it("never fires sooner than the schedule itself, and not without one", () => {
    expect(after("0 9 * * *", 5)).toBe("2026-11-28T09:00:00.000Z");
    expect(nextScheduledSync(null, at, 3)).toBeNull();
    expect(nextScheduledSync("not a cron", at, 0)).toBeNull();
  });
});

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
    expect(
      await t.services.secrets.reveal("ws_a", "langfuse-prod", {
        url: "https://cloud.langfuse.com",
        use: "test",
      }),
    ).toBe("pk:other");

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
      const posted = await worker.records(job, seq, ids.map(record));
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

  it("binds every secret to its allowed hosts: no exfiltration through a source, import or logger (r8 P1-2)", async () => {
    // The admin stores an HF token for imports (default hosts).
    const hf = await t.json<{ allowed_hosts: string[] }>("/v1/secrets", {
      body: { name: "hf-token", value: "hf_REAL_TOKEN_VALUE" },
    });
    expect(hf.body.allowed_hosts).toContain("huggingface.co");
    expect(hf.body.allowed_hosts).not.toContain("attacker.example");

    // A key that may only write sources can't use secrets at all...
    const member = await t.mintKey("ws_a", ["sources:write"]);
    const exfil = {
      provider: {
        kind: "langfuse",
        host: "https://attacker.example",
        secret: "hf-token",
      },
    };
    const denied = await t.json("/v1/datasets/exfil/sources", {
      token: member,
      body: exfil,
    });
    expect([denied.status, denied.body.code]).toEqual([403, "forbidden"]);
    // ...and with secrets:read, the secret still only goes where it's allowed.
    const reader = await t.mintKey("ws_a", ["sources:write", "secrets:read"]);
    const refused = await t.json("/v1/datasets/exfil/sources", {
      token: reader,
      body: exfil,
    });
    expect([refused.status, refused.body.code]).toEqual([
      422,
      "secret_host_not_allowed",
    ]);
    const datasetWriter = await t.mintKey("ws_a", ["datasets:write"]);
    const hfImport = await t.json("/v1/datasets/d/imports", {
      token: datasetWriter,
      body: { source: { kind: "hf", repo: "org/data", secret: "hf-token" } },
    });
    expect(hfImport.status).toBe(403);

    // A self-hosted provider's secret names its host; other hosts and
    // invalid entries are refused.
    const bad = await t.json("/v1/secrets", {
      body: { name: "x", value: "y", allowed_hosts: ["not a host!"] },
    });
    expect([bad.status, bad.body.code]).toEqual([422, "secret_host_invalid"]);
    const own = await t.json<{ allowed_hosts: string[] }>("/v1/secrets", {
      body: {
        name: "lf-self",
        value: "pk:sk",
        allowed_hosts: [
          "https://Langfuse.internal:3000/",
          "langfuse.internal:3000",
        ],
      },
    });
    expect(own.body.allowed_hosts).toEqual(["langfuse.internal:3000"]);
    const selfHosted = {
      kind: "langfuse",
      host: "https://langfuse.internal:3000",
      secret: "lf-self",
    };
    const created = await addSource({ provider: selfHosted });
    expect(created.status).toBe(201);
    expect(
      (await addSource({ provider: { ...selfHosted, host: null } })).body.code,
    ).toBe("secret_host_not_allowed");
    const hfWithLf = await t.json("/v1/datasets/d/imports", {
      body: { source: { kind: "hf", repo: "org/data", secret: "lf-self" } },
    });
    expect(hfWithLf.body.code).toBe("secret_host_not_allowed");

    // Re-setting a secret to other hosts stops a source that was allowed: the
    // claim re-checks, fails the sync, and never hands out the value.
    await t.json("/v1/secrets", {
      body: {
        name: "lf-self",
        value: "pk:sk",
        allowed_hosts: ["elsewhere.example"],
      },
    });
    await t.json(`/v1/sources/${created.body.id}/sync`, { body: {} });
    expect(await worker.claim({ kinds: ["import"] })).toBeNull();
    const source = await t.json<{
      last_sync: { status: string; error: string };
    }>(`/v1/sources/${created.body.id}`);
    expect(source.body.last_sync.status).toBe("failed");
    expect(source.body.last_sync.error).toContain("may only be sent to");
    expect(JSON.stringify(source.body)).not.toContain("pk:sk");
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
      sample_rate: 1,
      max_records: null,
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

    // Within a minute of the last start: that sync again, with Retry-After.
    t.clock.advanceSeconds(20);
    const soon = await t.json<{ id: string }>(`/v1/sources/${source.id}/sync`, {
      body: {},
    });
    expect(soon.status).toBe(202);
    expect(soon.body.id).toBe(job.id);
    expect(Number(soon.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(soon.headers.get("retry-after"))).toBeLessThanOrEqual(40);
    expect(sync.headers.get("retry-after")).toBeNull();

    // The next sync starts from the stored watermark.
    t.clock.advanceSeconds(61);
    await t.json(`/v1/sources/${source.id}/sync`, { body: {} });
    const second = await claimImport();
    expect(second.import?.source.watermark).toEqual({
      traces: "2026-11-27T10:00:00Z",
      scores: "2026-11-27T10:00:00Z",
    });

    // Score updates fold into their records on read; the old version is unchanged.
    const scored = await worker.records(second, 0, [
      {
        id: "t1",
        source: "langfuse",
        scores: { resolved: 1 },
        metadata: { score_update: true },
      },
    ]);
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
    t.clock.advanceSeconds(61);
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
    t.clock.advanceSeconds(61);
    await t.json(`/v1/sources/${source.id}/sync`, { body: { full: true } });
    const full = await claimImport();
    expect(full.import?.source).toMatchObject({ full: true, watermark: null });
    await finish(full, ["t1"], {
      traces: "2026-11-27T11:00:00Z",
      scores: "2026-11-27T11:00:00Z",
    });
    t.clock.advanceSeconds(61);
    await t.json(`/v1/sources/${source.id}/sync`, { body: {} });
    const quiet = await claimImport();
    expect(quiet.import?.source.watermark).toEqual({
      traces: "2026-11-27T11:00:00Z",
      scores: "2026-11-27T11:00:00Z",
    });
    // A sync that finds nothing new adds no empty version.
    const before = (
      await t.json<{ version: number }>("/v1/datasets/support-prod")
    ).body.version;
    const nothing = await finish(quiet, [], null);
    expect(nothing.body.import).toMatchObject({
      imported_count: 0,
      dataset_version: before,
    });
    expect(
      (await t.json<{ version: number }>("/v1/datasets/support-prod")).body
        .version,
    ).toBe(before);
  });

  it("counts merged records: score updates add none, a full sync restarts the count", async () => {
    const source = (await addSource()).body;
    const syncWith = async (
      records: Array<Record<string, unknown>>,
      full = false,
    ) => {
      t.clock.advanceSeconds(61);
      await t.json(`/v1/sources/${source.id}/sync`, { body: { full } });
      const job = await claimImport();
      await worker.records(job, 0, records);
      const done = await worker.complete(job, {
        status: "completed",
        import_summary: { watermark: null },
      });
      return done.body.import as unknown as { imported_count: number };
    };
    const dataset = async () =>
      (await t.json<{ record_count: number }>("/v1/datasets/support-prod")).body
        .record_count;
    const total = async () =>
      (
        await t.json<{ total: number }>(
          "/v1/datasets/support-prod/records?limit=1",
        )
      ).body.total;
    const update = (id: string) => ({
      id,
      scores: { thumbs: 1 },
      metadata: { score_update: true },
    });

    await syncWith(["t1", "t2", "t3"].map(record));
    expect(await dataset()).toBe(3);
    // Late scores for old traces plus one new trace: one more record.
    const late = await syncWith([update("t1"), update("t2"), record("t4")]);
    expect(late.imported_count).toBe(1);
    expect(await dataset()).toBe(4);
    expect(await total()).toBe(4);
    // A trace updated after the watermark comes back whole: no new record.
    await syncWith([record("t3"), record("t6")]);
    expect(await dataset()).toBe(5);
    expect(await total()).toBe(5);
    // A full resync: the reset marker, then what the provider holds now.
    await syncWith(
      [
        { id: "grad:reset", metadata: { dataset_reset: true } },
        record("t2"),
        record("t5"),
        update("t5"),
      ],
      true,
    );
    expect(await dataset()).toBe(2);
    expect(await total()).toBe(2);
  });

  it("validates filters per provider and stores the effective ones (r8-sources)", async () => {
    const bad = async (provider: Record<string, unknown>) =>
      (await addSource({ provider })).body;
    expect(
      await bad({ ...LANGFUSE, filters: { tag: ["prod"] } }),
    ).toMatchObject({
      status: 422,
      code: "source_filter_unsupported",
    });
    // LangSmith's own filter expression is not a Langfuse filter.
    expect(
      (await bad({ ...LANGFUSE, filters: { filter: 'has(tags, "x")' } }))
        .detail,
    ).toContain("Its filters: tags, environment");
    expect(
      await bad({ ...LANGFUSE, filters: { min_score: "high" } }),
    ).toMatchObject({ code: "source_filter_invalid" });
    expect(
      await bad({
        ...LANGFUSE,
        filters: { from: "2026-11-27T00:00:00Z", to: "2026-11-26T00:00:00Z" },
      }),
    ).toMatchObject({ code: "source_filter_invalid" });
    expect(
      (await addSource({ provider: LANGFUSE, sample_rate: 0 })).body.code,
    ).toBe("validation_error");

    const created = await addSource({
      provider: {
        ...LANGFUSE,
        filters: {
          tags: "prod",
          environment: ["production"],
          version: 3,
          metadata: { tier: "gold" },
          min_score: { resolved: 0.5 },
        },
      },
      sample_rate: 0.25,
      max_records_per_day: 1000,
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      provider: {
        filters: {
          tags: ["prod"],
          environment: ["production"],
          version: ["3"],
          metadata: { tier: "gold" },
          min_score: { resolved: 0.5 },
        },
      },
      sample_rate: 0.25,
      max_records_per_sync: null,
      max_records_per_day: 1000,
      records_today: 0,
    });
  });

  it("updates filters, sampling, caps and the schedule from the next sync (r8-sources)", async () => {
    const source = (await addSource()).body;
    const patch = (body: Record<string, unknown>, id = source.id) =>
      t.json<Record<string, any>>(`/v1/sources/${id}`, {
        method: "PATCH",
        body,
      });
    expect((await patch({ filters: { nope: 1 } })).body.code).toBe(
      "source_filter_unsupported",
    );
    expect((await patch({}, "src_missing")).status).toBe(404);
    const updated = await patch({
      filters: { model: "acme/support" },
      sample_rate: 0.5,
      max_records_per_sync: 10,
      schedule: "*/5 * * * *",
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      provider: { filters: { model: ["acme/support"] } },
      sample_rate: 0.5,
      max_records_per_sync: 10,
      schedule: "*/5 * * * *",
    });
    expect(updated.body.next_sync_at).not.toBeNull();
    // Left-out fields keep their value; null clears a cap or the schedule.
    const cleared = await patch({ max_records_per_sync: null, schedule: null });
    expect(cleared.body).toMatchObject({
      provider: { filters: { model: ["acme/support"] } },
      sample_rate: 0.5,
      max_records_per_sync: null,
      schedule: null,
      next_sync_at: null,
    });
    expect((await patch({ filters: {} })).body.provider.filters).toEqual({});
  });

  it("hands the worker its filters, sample rate and record budget; the day's count caps it (r8-sources)", async () => {
    const source = (
      await addSource({
        provider: { ...LANGFUSE, filters: { tags: ["prod"] } },
        sample_rate: 0.5,
        max_records_per_sync: 100,
        max_records_per_day: 150,
      })
    ).body;
    const syncOnce = async (traces: number) => {
      t.clock.advanceSeconds(61);
      await t.json(`/v1/sources/${source.id}/sync`, { body: {} });
      const job = await claimImport();
      await worker.complete(job, {
        status: "completed",
        import_summary: { watermark: null, traces },
      });
      return job.import?.source as Record<string, unknown>;
    };
    expect(await syncOnce(100)).toMatchObject({
      filters: { tags: ["prod"] },
      sample_rate: 0.5,
      max_records: 100,
    });
    expect((await syncOnce(30)).max_records).toBe(50);
    expect((await syncOnce(0)).max_records).toBe(20);
    expect(
      (await t.json<Record<string, any>>(`/v1/sources/${source.id}`)).body
        .records_today,
    ).toBe(130);
    // A new UTC day starts the count again.
    t.clock.advanceSeconds(24 * 3600);
    expect(
      (await t.json<Record<string, any>>(`/v1/sources/${source.id}`)).body
        .records_today,
    ).toBe(0);
    expect((await syncOnce(5)).max_records).toBe(100);
  });

  it("keeps a score-filtered trace only once its merged scores pass (r8-sources)", async () => {
    const source = (await addSource()).body;
    const rule = { min_score: { resolved: 0.5 } };
    const ruled = (id: string) => {
      const r = record(id);
      return { ...r, metadata: { ...r.metadata, score_filter: rule } };
    };
    const syncWith = async (records: Array<Record<string, unknown>>) => {
      t.clock.advanceSeconds(61);
      await t.json(`/v1/sources/${source.id}/sync`, { body: {} });
      const job = await claimImport();
      await worker.records(job, 0, records);
      await worker.complete(job, {
        status: "completed",
        import_summary: { watermark: null },
      });
    };
    const page = async () =>
      (
        await t.json<{ total: number; data: Array<Record<string, any>> }>(
          "/v1/datasets/support-prod/records?limit=10",
        )
      ).body;
    const update = (id: string, resolved: number) => ({
      id,
      scores: { resolved },
      metadata: { score_update: true },
    });

    await syncWith([ruled("t1"), ruled("t2"), record("t3")]);
    expect((await page()).data.map((r) => r.id)).toEqual(["t3"]);
    await syncWith([update("t1", 1), update("t2", 0.2)]);
    const after = await page();
    expect(after.total).toBe(2);
    expect(after.data.map((r) => r.id)).toEqual(["t1", "t3"]);
    expect(after.data[0]?.metadata).toEqual({ model: "acme/support" });
  });

  const syncNow = async (id: string, full = false) => {
    t.clock.advanceSeconds(61);
    return t.json<{ id: string; source: Record<string, unknown> }>(
      `/v1/sources/${id}/sync`,
      { body: { full } },
    );
  };
  const getSource = async (id: string) =>
    (await t.json<Record<string, any>>(`/v1/sources/${id}`)).body;
  const failNext = async (error = "langfuse: 401 auth failed for ***") => {
    const job = await claimImport();
    expect(
      (await worker.complete(job, { status: "failed", error })).status,
    ).toBe(200);
    return job;
  };

  it("queues a full sync asked for during an incremental one when that one ends", async () => {
    const source = (await addSource()).body;
    const incremental = await syncNow(source.id);
    const asked = await t.json<{ id: string }>(
      `/v1/sources/${source.id}/sync`,
      { body: { full: true } },
    );
    // The running sync comes back; the full one is remembered, not lost.
    expect(asked.body.id).toBe(incremental.body.id);
    expect(asked.headers.get("retry-after")).toBeNull();
    expect((await getSource(source.id)).pending_full).toBe(true);

    const job = await claimImport();
    expect(job.import?.source.full).toBe(false);
    await finish(job, ["t1"], { traces: "2026-11-27T10:00:00Z" });
    // Queued at once (no minute wait): full, from no watermark.
    const after = await getSource(source.id);
    expect(after.pending_full).toBe(false);
    expect(after.last_sync).toMatchObject({ status: "queued", full: true });
    const full = await claimImport();
    expect(full.import?.source).toMatchObject({ full: true, watermark: null });

    // The same when the incremental one fails.
    await finish(full, ["t1"], { traces: "2026-11-27T11:00:00Z" });
    await syncNow(source.id);
    await t.json(`/v1/sources/${source.id}/sync`, { body: { full: true } });
    await failNext();
    expect((await claimImport()).import?.source.full).toBe(true);
  });

  it("records a failed sync, backs the schedule off, and clears it all on success", async () => {
    const source = (
      await addSource({ provider: LANGFUSE, schedule: "*/15 * * * *" })
    ).body;
    expect(await getSource(source.id)).toMatchObject({
      status: "active",
      last_error: null,
      last_error_at: null,
      consecutive_failures: 0,
      paused_reason: null,
    });

    await syncNow(source.id);
    await failNext();
    let s = await getSource(source.id);
    expect(s).toMatchObject({
      status: "active",
      consecutive_failures: 1,
      last_error: "langfuse: 401 auth failed for ***",
      last_error_at: t.clock.now().toISOString(),
    });
    expect(s.next_sync_at).toBe(
      nextScheduledSync("*/15 * * * *", t.clock.now(), 1),
    );
    expect(Date.parse(s.next_sync_at) - t.clock.now().getTime()).toBe(
      30 * 60_000,
    );

    await syncNow(source.id);
    await failNext();
    s = await getSource(source.id);
    expect(s.consecutive_failures).toBe(2);
    expect(Date.parse(s.next_sync_at) - t.clock.now().getTime()).toBe(
      60 * 60_000,
    );

    await syncNow(source.id);
    await finish(await claimImport(), ["t1"], { traces: "x" });
    s = await getSource(source.id);
    expect(s).toMatchObject({
      status: "active",
      consecutive_failures: 0,
      last_error: null,
      last_error_at: null,
    });
    expect(s.next_sync_at).toBe(
      nextScheduledSync("*/15 * * * *", t.clock.now(), 0),
    );
  });

  it("pauses after 10 failures in a row; a manual sync or a new secret value resumes it", async () => {
    const source = (
      await addSource({ provider: LANGFUSE, schedule: "* * * * *" })
    ).body;
    for (let i = 0; i < PAUSE_AFTER_FAILURES; i += 1) {
      await syncNow(source.id);
      await failNext(`langfuse: 401 (try ${i + 1})`);
    }
    let s = await getSource(source.id);
    expect(s).toMatchObject({
      status: "paused",
      consecutive_failures: 10,
      last_error: "langfuse: 401 (try 10)",
      next_sync_at: null,
    });
    expect(s.paused_reason).toContain("10 syncs in a row failed");
    // Paused: the schedule no longer fires.
    t.clock.advanceSeconds(7200);
    expect(await t.services.sources.tick(t.clock.now())).toBe(0);

    // A manual sync resumes it (and runs).
    const resumed = await syncNow(source.id);
    expect(resumed.status).toBe(202);
    s = await getSource(source.id);
    expect(s).toMatchObject({ status: "active", consecutive_failures: 0 });
    expect(s.last_error).toBe("langfuse: 401 (try 10)");
    expect(s.next_sync_at).not.toBeNull();
    for (let i = 0; i < PAUSE_AFTER_FAILURES; i += 1) {
      if (i > 0) await syncNow(source.id);
      await failNext();
    }
    expect((await getSource(source.id)).status).toBe("paused");

    // So does a new value for its secret (the usual fix).
    await t.json("/v1/secrets", {
      body: { name: "langfuse-prod", value: "pk-lf-new:sk-lf-new" },
    });
    s = await getSource(source.id);
    expect(s).toMatchObject({
      status: "active",
      consecutive_failures: 0,
      paused_reason: null,
    });
    t.clock.advanceSeconds(120);
    expect(await t.services.sources.tick(t.clock.now())).toBe(1);
    expect((await getSource(source.id)).last_sync.status).toBe("queued");
  });

  it("a failing source never delays another source's sync or a training job", async () => {
    const failing = (
      await addSource({ provider: LANGFUSE, schedule: "* * * * *" })
    ).body;
    const healthy = (
      await t.json<{ id: string }>("/v1/datasets/other/sources", {
        body: { provider: LANGFUSE, schedule: "* * * * *" },
      })
    ).body;
    await createSftRun(t);

    for (let i = 0; i < 3; i += 1) {
      t.clock.advanceSeconds(3600);
      expect(await t.services.sources.tick(t.clock.now())).toBe(2);
      // The failing source's sync is queued and fails; the run and the other
      // source's sync are claimed regardless.
      if (i === 0) {
        const trainer = new FakeWorker(t, "trainer-1");
        expect((await trainer.claim({ kinds: ["train"] }))?.kind).toBe("train");
      }
      for (const n of [1, 2]) {
        const w = new FakeWorker(t, `importer-${i}-${n}`);
        const job = await w.claim({ kinds: ["import"] });
        if (!job) throw new Error("expected an import job");
        if (job.import?.source.source_id === failing.id) {
          await w.complete(job, { status: "failed", error: "401" });
          continue;
        }
        await w.records(job, 0, [record(`h${i}`)]);
        await w.complete(job, {
          status: "completed",
          import_summary: { watermark: { traces: `w${i}` } },
        });
      }
    }
    expect(await getSource(failing.id)).toMatchObject({
      consecutive_failures: 3,
      status: "active",
    });
    expect(await getSource(healthy.id)).toMatchObject({
      consecutive_failures: 0,
      last_error: null,
      last_sync: { status: "completed", dataset_version: 3 },
    });
  });

  it("lets operators lower the interval (live tests sync back to back)", async () => {
    await t.close();
    t = await makeTestApp({
      secrets: createSecretsCipher({ key: randomBytes(32).toString("base64") }),
      settings: {
        maxAttempts: 3,
        sourceSyncIntervalSeconds: 0,
      },
    });
    worker = new FakeWorker(t);
    await t.json("/v1/secrets", {
      body: { name: "langfuse-prod", value: KEY },
    });
    const source = (await addSource()).body;
    const first = await t.json<{ id: string }>(
      `/v1/sources/${source.id}/sync`,
      { body: {} },
    );
    await finish(await claimImport(), [], null);
    const second = await t.json<{ id: string }>(
      `/v1/sources/${source.id}/sync`,
      { body: {} },
    );
    expect(second.body.id).not.toBe(first.body.id);
    expect(second.headers.get("retry-after")).toBeNull();
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

  it("commits a scheduled sync's version at most every version_interval; manual syncs and removal commit (r8-sources)", async () => {
    const source = (
      await addSource({
        provider: LANGFUSE,
        schedule: "* * * * *",
        version_interval: 600,
      })
    ).body as { id: string; version_interval: number };
    expect(source.version_interval).toBe(600);
    const scheduledSync = async (ids: string[]) => {
      t.clock.advanceSeconds(61);
      expect(await t.services.sources.tick(t.clock.now())).toBe(1);
      const job = await claimImport();
      if (ids.length > 0) await worker.records(job, 0, ids.map(record));
      const done = await worker.complete(job, {
        status: "completed",
        import_summary: { watermark: null },
      });
      return (done.body.import as { dataset_version: number | null })
        .dataset_version;
    };
    const ids = async () =>
      (
        await t.json<{ data: Array<{ id: string }> }>(
          "/v1/datasets/support-prod/records?limit=100",
        )
      ).body.data.map((r) => r.id);
    const state = async () =>
      (await t.json<Record<string, any>>(`/v1/sources/${source.id}`)).body;

    // The first sync commits; the next ones wait while the interval runs.
    expect(await scheduledSync(["t1"])).toBe(1);
    expect(await scheduledSync(["t2", "t3"])).toBeNull();
    expect(await scheduledSync(["t4"])).toBeNull();
    expect(await scheduledSync([])).toBeNull();
    expect(await ids()).toEqual(["t1"]);
    expect(await state()).toMatchObject({ pending_records: 3 });
    // Past the interval, a sync commits everything waiting, in order.
    t.clock.advanceSeconds(600);
    expect(await scheduledSync(["t5"])).toBe(2);
    expect(await ids()).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(await state()).toMatchObject({ pending_records: 0 });

    // A manual sync commits at once, with what waits.
    expect(await scheduledSync(["t6"])).toBeNull();
    t.clock.advanceSeconds(61);
    await t.json(`/v1/sources/${source.id}/sync`, { body: {} });
    const manual = await claimImport();
    await worker.records(manual, 0, [record("t7")]);
    await worker.complete(manual, { status: "completed" });
    expect(await ids()).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7"]);

    // Removing a source commits what its scheduled syncs fetched.
    expect(await scheduledSync(["t8"])).toBeNull();
    expect(
      (await t.json(`/v1/sources/${source.id}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect((await ids()).at(-1)).toBe("t8");

    // version_interval 0: every scheduled sync commits.
    const every = (
      await addSource({
        provider: LANGFUSE,
        schedule: "* * * * *",
        version_interval: 0,
      })
    ).body as { id: string };
    const before = (
      await t.json<{ version: number }>("/v1/datasets/support-prod")
    ).body.version;
    expect(await scheduledSync(["u1"])).toBe(before + 1);
    expect(await scheduledSync(["u2"])).toBe(before + 2);
    const patched = await t.json<{ version_interval: number }>(
      `/v1/sources/${every.id}`,
      { method: "PATCH", body: { version_interval: 3600 } },
    );
    expect(patched.body.version_interval).toBe(3600);
  });

  it("commits waiting records at once past SOURCE_VERSION_MAX_RECORDS (r8-sources)", async () => {
    await t.close();
    t = await makeTestApp({
      secrets: createSecretsCipher({ key: randomBytes(32).toString("base64") }),
      settings: {
        maxAttempts: 3,
        sourceVersionMaxRecords: 3,
      },
    });
    worker = new FakeWorker(t);
    await t.json("/v1/secrets", {
      body: { name: "langfuse-prod", value: KEY },
    });
    await addSource({ provider: LANGFUSE, schedule: "* * * * *" });
    const versions: Array<number | null> = [];
    for (const batch of [["a"], ["b"], ["c"], ["d"]]) {
      t.clock.advanceSeconds(61);
      await t.services.sources.tick(t.clock.now());
      const job = await claimImport();
      await worker.records(job, 0, batch.map(record));
      const done = await worker.complete(job, { status: "completed" });
      versions.push(
        (done.body.import as { dataset_version: number | null })
          .dataset_version,
      );
    }
    // b and c wait; d brings the waiting records to 3 and commits all three.
    expect(versions).toEqual([1, null, null, 2]);
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
