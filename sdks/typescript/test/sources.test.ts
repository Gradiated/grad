import { describe, expect, it } from "vitest";

import { ConflictError, GradUsageError, ImportJob, SecretRef, Source, sources, ValidationError } from "../src/index.js";
import { FakeServer, json, makeGrad, wire } from "./helpers.js";

const parity = wire<{ responses: { source: Record<string, unknown>; secret: Record<string, unknown> } }>("sdk-parity.json");
const SOURCE = parity.responses.source;
const SECRET = parity.responses.secret;
const DATASET = { id: "ds_1", workspace_id: "ws", name: "support-prod", version: 2, record_count: 10, metadata: {}, created_at: "x", updated_at: "x" };
const JOB = { id: "imp_7c1d", workspace_id: "ws", dataset: "support-prod", status: "completed", source: { kind: "provider" }, connector: "auto", attempt: 1, imported_count: 3, dropped_count: 0, detected_scores: [], drop_reasons: [], dataset_version: 3, error: null, created_at: "x", updated_at: "x" };
const problem = (status: number, code: string) => json({ type: "about:blank", title: "t", status, detail: "d", code, request_id: "req_1" }, status);

describe("secrets", () => {
  it("sets, gets, lists and deletes without ever reading a value back", async () => {
    const server = new FakeServer()
      .on("POST", "/v1/secrets", json(SECRET))
      .on("GET", "/v1/secrets/langfuse-prod", json(SECRET))
      .on("GET", "/v1/secrets", json({ data: [SECRET], next_cursor: null }))
      .on("DELETE", "/v1/secrets/langfuse-prod", new Response(null, { status: 204 }));
    const { grad } = makeGrad(server);

    const ref = await grad.secrets.set("langfuse-prod", "pk:sk");
    expect(ref).toBeInstanceOf(SecretRef);
    expect(String(ref)).toBe("langfuse-prod");
    expect(JSON.parse(server.calls[0]?.body ?? "{}")).toEqual({ name: "langfuse-prod", value: "pk:sk" });
    expect((await grad.secrets.get("langfuse-prod")).name).toBe("langfuse-prod");
    expect((await grad.secrets.list().all()).map((s) => s.name)).toEqual(["langfuse-prod"]);
    await grad.secrets.delete(ref);
    expect(server.calls.at(-1)?.method).toBe("DELETE");
    await expect(grad.secrets.set("x", "")).rejects.toBeInstanceOf(GradUsageError);
    await expect(grad.secrets.delete("")).rejects.toBeInstanceOf(GradUsageError);
  });

  it("maps typed errors", async () => {
    const server = new FakeServer()
      .on("POST", "/v1/secrets", problem(501, "secrets_unavailable"))
      .on("DELETE", "/v1/secrets/used", problem(409, "secret_in_use"));
    const { grad } = makeGrad(server, { maxRetries: 0 });
    await expect(grad.secrets.set("x", "y")).rejects.toMatchObject({ status: 501, code: "secrets_unavailable" });
    await expect(grad.secrets.delete("used")).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("sources", () => {
  it("builds every provider body", () => {
    const ref = new SecretRef({ name: "bt" } as never);
    expect(sources.braintrust({ host: "https://api.braintrust.dev", secret: ref, project: "support-bot" })).toEqual({
      kind: "braintrust",
      host: "https://api.braintrust.dev",
      secret: "bt",
      project: "support-bot",
    });
    expect(sources.langsmith({ secret: "ls" })).toEqual({ kind: "langsmith", secret: "ls" });
    expect(sources.posthog({ secret: "ph", project: "123", filters: { event: "$ai_generation" } }).filters).toEqual({ event: "$ai_generation" });
    expect(sources.phoenix({ host: "http://phoenix:6006" })).toEqual({ kind: "phoenix", host: "http://phoenix:6006" });
    expect(sources.langfuse()).toEqual({ kind: "langfuse" });
    expect(sources.gradiated({ models: ["a/m"], tasks: ["t"], versions: ["v1"], filters: { trainable_only: true } })).toEqual({
      kind: "gradiated",
      filters: { trainable_only: true, models: ["a/m"], tasks: ["t"], versions: ["v1"] },
    });
    expect(sources.gradiated()).toEqual({ kind: "gradiated" });
    expect(() => sources.langfuse({ secret: { name: "" } })).toThrow(GradUsageError);
  });

  it("adds a source through the dataset, syncs, waits, lists and removes it", async () => {
    const server = new FakeServer()
      .on("GET", "/v1/datasets/support-prod", json(DATASET))
      .on("GET", "/v1/secrets/langfuse-prod", json(SECRET))
      .on("POST", "/v1/datasets/support-prod/sources", json(SOURCE, 201))
      .on("POST", "/v1/sources/src_01J9X/sync", json({ ...JOB, status: "queued" }, 202))
      .on("GET", "/v1/imports/imp_7c1d", json(JOB))
      .on("GET", "/v1/sources/src_01J9X", json(SOURCE))
      .on("GET", "/v1/sources", json({ data: [SOURCE], next_cursor: null }))
      .on("DELETE", "/v1/sources/src_01J9X", new Response(null, { status: 204 }));
    const { grad } = makeGrad(server);

    const dataset = await grad.datasets.get("support-prod");
    const source = await dataset.addSource({
      provider: sources.langfuse({ host: "https://cloud.langfuse.com", secret: await grad.secrets.get("langfuse-prod") }),
      schedule: "*/15 * * * *",
    });
    expect(source).toBeInstanceOf(Source);
    expect(source.provider.kind).toBe("langfuse");
    expect(source.lastSync?.datasetVersion).toBe(3);
    expect(JSON.parse(server.calls.at(-1)?.body ?? "{}")).toEqual({
      provider: { kind: "langfuse", host: "https://cloud.langfuse.com", secret: "langfuse-prod" },
      schedule: "*/15 * * * *",
    });

    const job = await source.sync();
    expect(job).toBeInstanceOf(ImportJob);
    expect(JSON.parse(server.calls.at(-1)?.body ?? "{}")).toEqual({ full: false });
    const done = await source.sync({ full: true }).wait();
    expect(done.status).toBe("completed");

    await source.refresh();
    expect((await grad.sources.get("src_01J9X")).id).toBe("src_01J9X");
    expect((await grad.sources.list({ dataset: dataset }).all()).length).toBe(1);
    expect(server.calls.at(-1)?.url.searchParams.get("dataset")).toBe("support-prod");
    expect(JSON.stringify(source)).toContain("src_01J9X");
    await source.delete();
    await grad.sources.delete("src_01J9X");
    await grad.sources.remove("src_01J9X"); // deprecated alias
    expect(server.calls.at(-1)?.method).toBe("DELETE");
  });

  it("sends sampling and caps, shows the effective filters, and updates a source", async () => {
    const server = new FakeServer()
      .on("POST", "/v1/datasets/support-prod/sources", json(SOURCE, 201))
      .on("PATCH", "/v1/sources/src_01J9X", json({ ...SOURCE, sample_rate: 0.5, schedule: null }))
      .on("PATCH", "/v1/sources/bad", problem(422, "source_filter_unsupported"));
    const { grad } = makeGrad(server, { maxRetries: 0 });
    const source = await grad.sources.create("support-prod", {
      provider: sources.langfuse({ secret: "lf", filters: { tags: ["prod"] } }),
      sampleRate: 0.1,
      maxRecordsPerSync: 500,
    });
    expect(JSON.parse(server.calls.at(-1)?.body ?? "{}")).toEqual({
      provider: { kind: "langfuse", secret: "lf", filters: { tags: ["prod"] } },
      sample_rate: 0.1,
      max_records_per_sync: 500,
    });
    expect([source.filters, source.sampleRate, source.maxRecordsPerDay, source.recordsToday]).toEqual([{ environment: ["production"] }, 0.1, 100000, 4200]);
    expect(await source.update({ schedule: null, maxRecordsPerDay: null })).toBe(source);
    expect(JSON.parse(server.calls.at(-1)?.body ?? "{}")).toEqual({ schedule: null, max_records_per_day: null });
    expect([source.sampleRate, source.schedule]).toEqual([0.5, null]);
    expect(server.calls.at(-1)?.headers.get("idempotency-key")).toBeNull();
    await expect(grad.sources.update("bad", { filters: { tag: ["prod"] } })).rejects.toMatchObject({ code: "source_filter_unsupported" });
  });

  it("maps unsupported and Cloud-only providers to typed errors", async () => {
    const server = new FakeServer()
      .on("POST", "/v1/datasets/d/sources", problem(422, "source_provider_unsupported"))
      .on("POST", "/v1/datasets/c/sources", problem(501, "source_unavailable"));
    const { grad } = makeGrad(server, { maxRetries: 0 });
    await expect(grad.sources.create("d", { provider: { kind: "helicone" } })).rejects.toBeInstanceOf(ValidationError);
    await expect(grad.sources.create("c", { provider: sources.gradiated() })).rejects.toMatchObject({ status: 501, code: "source_unavailable" });
  });

  it("sends only the secret's name for a gated Hugging Face import", async () => {
    const server = new FakeServer()
      .on("POST", "/v1/datasets", json(DATASET, 201))
      .on("POST", "/v1/datasets/gated/imports", json({ ...JOB, dataset: "gated" }, 202))
      .on("GET", "/v1/imports/imp_7c1d", json(JOB))
      .on("GET", "/v1/datasets/gated", json({ ...DATASET, name: "gated" }));
    const { grad } = makeGrad(server);
    await grad.datasets.fromHf("org/gated", { name: "gated", prompt: "q", secret: new SecretRef({ name: "hf-token" } as never) });
    const post = server.calls.find((c) => c.url.pathname === "/v1/datasets/gated/imports");
    expect(JSON.parse(post?.body ?? "{}").source.secret).toBe("hf-token");
  });
});

describe("usage", () => {
  it("pages billed usage records", async () => {
    const page = wire<{ responses: { usage_page: { data: unknown[] } } }>("sdk-parity.json").responses.usage_page;
    const server = new FakeServer().on("GET", "/v1/usage", json({ ...page, next_cursor: "c1" }), json({ data: [], next_cursor: null }));
    const { grad } = makeGrad(server);
    const records = await grad.usage.list({ limit: 5 }).all();
    expect(records.map((r) => [r.kind, r.tokensThrough, r.costUsd, r.refName])).toEqual([["training", 84, 0.000084, "support-sft"]]);
    expect(server.calls.at(-1)?.url.searchParams.get("cursor")).toBe("c1");
  });

  it("filters every page and takes Date bounds", async () => {
    const page = wire<{ responses: { usage_page: { data: unknown[] } } }>("sdk-parity.json").responses.usage_page;
    const server = new FakeServer().on("GET", "/v1/usage", json({ ...page, next_cursor: "c1" }), json({ data: [], next_cursor: null }));
    const { grad } = makeGrad(server);
    await grad.usage.list({ from: new Date(Date.UTC(2026, 10, 2, 12, 30)), evalId: "eval_1", kind: "eval" }).all();
    const queries = server.calls.map((c) => Object.fromEntries(c.url.searchParams));
    const want = { from: "2026-11-02T12:30:00.000Z", eval_id: "eval_1", kind: "eval" };
    expect(queries).toEqual([want, { ...want, cursor: "c1" }]);
  });

  it("returns a typed summary", async () => {
    const body = wire<{ responses: { usage_summary: unknown } }>("sdk-parity.json").responses.usage_summary;
    const server = new FakeServer().on("GET", "/v1/usage/summary", json(body));
    const { grad } = makeGrad(server);
    const summary = await grad.usage.summary({ to: new Date(Date.UTC(2026, 11, 1)), groupBy: "recipe" });
    expect(Object.fromEntries(server.calls[0]!.url.searchParams)).toEqual({ to: "2026-12-01T00:00:00.000Z", group_by: "recipe" });
    expect([summary.costUsd, summary.byKind[0]?.kind, summary.topRuns[0]?.name, summary.groupBy]).toEqual([0.0046, "teacher", "support-sft", "model"]);
  });
});
