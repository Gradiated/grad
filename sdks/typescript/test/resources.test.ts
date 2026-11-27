import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApiClient,
  Artifact,
  ArtifactImportFailedError,
  ConflictError,
  Dataset,
  Grad,
  GradError,
  GradUsageError,
  ImportFailedError,
  Judge,
  NotFoundError,
  Paginator,
  parseHfUri,
  Scorer,
  Trajectory,
  ValidationError,
} from "../src/index.js";
import { BASE, FakeServer, json, makeGrad, problemFixture, wire } from "./helpers.js";

const scratch = () => mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "grad-ts-"));

describe("configuration", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  const configFile = (profiles: unknown) => {
    const dir = scratch();
    const file = path.join(dir, "gradiated", "config.json");
    mkdtempSync(path.join(dir, "x"));
    writeFileSync(path.join(dir, "config.json"), JSON.stringify({ profiles }));
    return { dir, file: path.join(dir, "config.json") };
  };

  it("defaults to https://api.gradiated.com with no key", async () => {
    delete process.env.GRADIATED_API_KEY;
    delete process.env.GRADIATED_BASE_URL;
    const grad = new Grad({ configPath: path.join(scratch(), "missing.json") });
    expect(await grad.config()).toEqual({ baseURL: "https://api.gradiated.com", apiKeySource: "none" });
  });

  it("reads GRADIATED_API_KEY and GRADIATED_BASE_URL", async () => {
    process.env.GRADIATED_API_KEY = "grad_env";
    process.env.GRADIATED_BASE_URL = "http://localhost:18787";
    const server = new FakeServer().on("GET", "/v1/base-models", json(wire("models.json")));
    const grad = new Grad({ fetch: (async (u: string, i: RequestInit) => server.fetch(u.replace("http://localhost:18787", BASE), i)) as typeof fetch });
    expect(await grad.config()).toEqual({ baseURL: "http://localhost:18787", apiKeySource: "env" });
    await grad.models.list();
    expect(server.calls[0]?.headers.get("authorization")).toBe("Bearer grad_env");
  });

  it("falls back to the grad login config file, honouring profiles; env and options win", async () => {
    delete process.env.GRADIATED_API_KEY;
    delete process.env.GRADIATED_BASE_URL;
    const { file } = configFile({ default: { base_url: "http://file:8787", api_key: "grad_file" }, staging: { base_url: "http://staging", api_key: "grad_staging" } });
    expect(await new Grad({ configPath: file }).config()).toEqual({ baseURL: "http://file:8787", apiKeySource: "config" });
    expect(await new Grad({ configPath: file, profile: "staging" }).config()).toEqual({ baseURL: "http://staging", apiKeySource: "config" });
    process.env.GRADIATED_PROFILE = "staging";
    expect((await new Grad({ configPath: file }).config()).baseURL).toBe("http://staging");
    // A profile selected by name wins over the environment variables (like every SDK and the CLI).
    process.env.GRADIATED_API_KEY = "grad_env";
    process.env.GRADIATED_BASE_URL = "http://env";
    expect(await new Grad({ configPath: file }).config()).toEqual({ baseURL: "http://staging", apiKeySource: "config" });
    expect(await new Grad({ configPath: file, apiKey: "grad_opt", baseURL: "http://opt" }).config()).toEqual({ baseURL: "http://opt", apiKeySource: "option" });
    await expect(new Grad({ configPath: file, profile: "nope" }).config()).rejects.toThrow(/Profile 'nope' not found/);
    delete process.env.GRADIATED_PROFILE;
    expect(await new Grad({ configPath: file }).config()).toEqual({ baseURL: "http://env", apiKeySource: "env" });
  });

  it("only sends a saved key to its profile's server, and fails fast without a key", async () => {
    delete process.env.GRADIATED_API_KEY;
    delete process.env.GRADIATED_PROFILE;
    const { file } = configFile({ default: { base_url: "https://cloud.example", api_key: "grad_saved" } });
    process.env.GRADIATED_BASE_URL = "https://other.example";
    const calls: string[] = [];
    const grad = new Grad({ configPath: file, fetch: (async (u: string) => { calls.push(u); return new Response("{}"); }) as typeof fetch });
    expect(await grad.config()).toEqual({ baseURL: "https://other.example", apiKeySource: "none" });
    await expect(grad.models.list()).rejects.toThrow(
      "No API key for https://other.example: run `grad login`, set GRADIATED_API_KEY, or export GRADIATED_PROFILE=local to use a `grad local up` stack. (the key saved in profile 'default' belongs to https://cloud.example, so it was not sent)",
    );
    expect(calls).toEqual([]);
    delete process.env.GRADIATED_BASE_URL;
    const none = new Grad({ configPath: path.join(scratch(), "missing.json") });
    await expect(none.models.list()).rejects.toMatchObject({ code: "missing_api_key" });
  });

  it("drops a trailing /v1 and rejects unknown options", async () => {
    expect((await new Grad({ baseURL: "http://localhost:18787/v1/", apiKey: "" }).config()).baseURL).toBe("http://localhost:18787");
    expect(() => new Grad({ baseUrl: "http://x" } as never)).toThrow(/Unknown Grad option 'baseUrl'; did you mean 'baseURL'\?/);
  });

  it("finds the config under XDG_CONFIG_HOME, then HOME", async () => {
    delete process.env.GRADIATED_API_KEY;
    delete process.env.GRADIATED_BASE_URL;
    const xdg = scratch();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.join(xdg, "gradiated"));
    writeFileSync(path.join(xdg, "gradiated", "config.json"), JSON.stringify({ profiles: { default: { base_url: "http://xdg", api_key: "k" } } }));
    process.env.XDG_CONFIG_HOME = xdg;
    expect((await new Grad().config()).baseURL).toBe("http://xdg");
    delete process.env.XDG_CONFIG_HOME;
    const home = scratch();
    mkdirSync(path.join(home, ".config", "gradiated"), { recursive: true });
    writeFileSync(path.join(home, ".config", "gradiated", "config.json"), JSON.stringify({ profiles: { default: { base_url: "http://home" } } }));
    process.env.HOME = home;
    expect(await new Grad().config()).toEqual({ baseURL: "http://home", apiKeySource: "none" });
  });

  it("rejects malformed config files and base URLs loudly", async () => {
    delete process.env.GRADIATED_API_KEY;
    delete process.env.GRADIATED_BASE_URL;
    const dir = scratch();
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    await expect(new Grad({ configPath: bad }).config()).rejects.toThrow(/not valid JSON/);
    writeFileSync(bad, JSON.stringify({ profiles: { default: "x" } }));
    await expect(new Grad({ configPath: bad }).config()).rejects.toThrow(/must be an object/);
    await expect(new Grad({ configPath: dir }).config()).rejects.toThrow(/Could not read/);
    expect(() => new Grad({ baseURL: "localhost:18787" })).toThrow(/absolute http\(s\) URL/);
  });
});

describe("dataset scoring and filters", () => {
  it("scores (running local scorers) and resolves to the scored dataset", async () => {
    const queued = wire<Record<string, unknown>>("eval-scoring-queued.json");
    const done = wire<Record<string, unknown>>("eval-scoring-completed.json");
    const awaiting = { ...queued, status: "awaiting_scores", local_scorers: ["short"] };
    const output = {
      id: "evout_1",
      eval_id: queued.id,
      task_id: "rec_a",
      model: "record",
      sample_index: 0,
      input: [{ role: "user", content: "hi" }],
      output: "hello",
      expected_output: null,
      record: { id: "rec_a" },
      scores: {},
      error: null,
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    };
    const server = new FakeServer()
      .on("POST", "/v1/datasets/support-logs/score", json(queued, 202))
      .on("GET", `/v1/evals/${String(queued.id)}`, json(awaiting), json(done))
      .on("GET", `/v1/evals/${String(queued.id)}/outputs`, json({ data: [output], next_cursor: null }))
      .on("POST", `/v1/evals/${String(queued.id)}/scores`, json({ accepted: 1, status: "completed", pending_local_scores: 0 }))
      .on("GET", "/v1/datasets/support-logs", json({ ...wire<Record<string, unknown>>("dataset.json"), name: "support-logs", version: 2 }));
    const { grad } = makeGrad(server);
    const ds = await grad.datasets.get("support-logs");
    const rubric = [new Judge({ name: "resolved", model: "qwen/qwen3-32b", prompt: "ok?" }), new Scorer("short", { fn: (out) => (out ?? "").length < 20 })];
    const job = await ds.score(rubric);
    expect([job.id, job.status]).toEqual([queued.id, "queued"]);
    const scored = await ds.score(rubric).wait({ pollIntervalMs: 1 });
    expect([scored.name, scored.version]).toEqual(["support-logs", 2]);
    expect(server.lastBody("POST", `/v1/evals/${String(queued.id)}/scores`)).toEqual({ scores: [{ output_id: "evout_1", scorer: "short", score: 1 }] });
    expect((server.lastBody("POST", "/v1/datasets/support-logs/score") as { rubric: { kind: string }[] }).rubric.map((r) => r.kind)).toEqual(["judge", "code"]);
    expect(() => grad.datasets.score("support-logs", [])).toThrow(GradUsageError);
  });

  it("filters by fields on the server or by a local function", async () => {
    const view = { ...wire<Record<string, unknown>>("dataset.json"), name: "support-logs-f-0123456789" };
    const page = {
      dataset: "support-logs",
      version: 3,
      total: 3,
      next_cursor: null,
      data: [
        { id: "a", messages: [{ role: "user", content: "short" }] },
        { id: "b", messages: Array.from({ length: 8 }, () => ({ role: "user", content: "x" })) },
        { messages: [{ role: "user", content: "no id" }] },
      ],
    };
    const server = new FakeServer()
      .on("GET", "/v1/datasets/support-logs", json({ ...wire<Record<string, unknown>>("dataset.json"), name: "support-logs", version: 3 }))
      .on("GET", "/v1/datasets/support-logs/records", json(page))
      .on("POST", "/v1/datasets/support-logs/filter", json(view, 201));
    const { grad } = makeGrad(server);
    const ds = await grad.datasets.get("support-logs");
    const short = await ds.filter((t) => (t.messages ?? []).length <= 6, { name: "short-chats" });
    expect(short.name).toBe("support-logs-f-0123456789");
    expect(server.lastBody("POST", "/v1/datasets/support-logs/filter")).toEqual({ ids: ["a"], version: 3, name: "short-chats" });
    await ds.filter({ scores: { resolved_score: ">=0.8", exact: 1 }, createdAfter: new Date("2026-11-01T00:00:00Z"), createdBefore: "2026-12-01" });
    expect(server.lastBody("POST", "/v1/datasets/support-logs/filter")).toEqual({
      scores: { resolved_score: ">=0.8", exact: 1 },
      created_after: "2026-11-01T00:00:00.000Z",
      created_before: "2026-12-01",
    });
  });
});

describe("datasets and imports", () => {
  it("creates, gets, lists (paginated), pushes in batches, renders and reads records", async () => {
    const server = new FakeServer()
      .on("POST", "/v1/datasets", json(wire("dataset-created.json"), 201))
      .on("GET", "/v1/datasets/support-prod", json(wire("dataset.json")))
      .on("GET", "/v1/datasets", json(wire("datasets-page-1.json")), json(wire("datasets-page-2.json")))
      .on("POST", "/v1/datasets/support-prod/records", json(wire("dataset.json")))
      .on("POST", "/v1/datasets/support-prod/render", json({ dataset: "support-prod", model: "m", template_revision: "t", token_counts: "estimated", examples: [] }))
      .on("GET", "/v1/datasets/support-prod/records", json(wire("dataset-records-page.json")));
    const { grad } = makeGrad(server);

    const created = await grad.datasets.create("support-prod", { metadata: { team: "support" } });
    expect(created).toBeInstanceOf(Dataset);
    expect(created.recordCount).toBe(0);
    expect(server.lastBody("POST", "/v1/datasets")).toEqual({ name: "support-prod", metadata: { team: "support" } });

    const ds = await grad.datasets.get("support-prod");
    expect(ds.recordCount).toBe(3);
    expect(await ds.count()).toBe(3);

    const firstPage = await grad.datasets.list({ limit: 1 });
    expect(firstPage.data).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();
    server.on("GET", "/v1/datasets", json(wire("datasets-page-1.json")), json(wire("datasets-page-2.json")));
    const names: string[] = [];
    for await (const d of grad.datasets.list({ limit: 1 })) names.push(d.name);
    expect(names).toHaveLength(2);
    expect(server.callsTo("GET", "/v1/datasets").at(-1)?.url.searchParams.get("cursor")).toBe(firstPage.nextCursor);

    const records = Array.from({ length: 5 }, (_, i) => ({ sessionId: `s${i}`, messages: [{ role: "user" as const, content: `q${i}` }], scores: { tests_passed: 1 } }));
    const pushed = await grad.datasets.push("support-prod", records, { batchSize: 2, metadata: { source: "unit" } });
    expect(pushed.recordCount).toBe(3);
    const pushes = server.callsTo("POST", "/v1/datasets/support-prod/records").map((c) => JSON.parse(c.body ?? "{}"));
    expect(pushes.map((p) => p.records.length)).toEqual([2, 2, 1]);
    expect(pushes[0].metadata).toEqual({ source: "unit" });
    expect(pushes[1].metadata).toBeUndefined();
    expect(pushes[0].records[0]).toEqual({ session_id: "s0", messages: [{ role: "user", content: "q0" }], scores: { tests_passed: 1 } });

    await ds.push([{ messages: [] }], { maxBatchBytes: 1 });
    await expect(grad.datasets.push("support-prod", [])).rejects.toBeInstanceOf(GradUsageError);

    const dir = scratch();
    const file = path.join(dir, "r.jsonl");
    writeFileSync(file, `${JSON.stringify({ session_id: "f1", messages: [] })}\n\n${JSON.stringify({ messages: [] })}\n`);
    await grad.datasets.push("support-prod", file);
    expect(server.lastBody<{ records: unknown[] }>("POST", "/v1/datasets/support-prod/records").records).toHaveLength(2);
    writeFileSync(file, "{bad\n");
    await expect(grad.datasets.push("support-prod", file)).rejects.toThrow(/r.jsonl:1 is not valid JSON/);
    writeFileSync(file, "[1]\n");
    await expect(grad.datasets.push("support-prod", file)).rejects.toThrow(/must be a JSON object/);

    await ds.render({ model: "qwen/qwen3-8b", trainOn: "all_assistant" });
    expect(server.lastBody("POST", "/v1/datasets/support-prod/render")).toEqual({ model: "qwen/qwen3-8b", train_on: "all_assistant" });
    await grad.datasets.render("support-prod");

    const page = await grad.datasets.records("support-prod", { version: 2, limit: 2 });
    expect(page.data[0]?.sessionId).toBeDefined();
    expect(server.callsTo("GET", "/v1/datasets/support-prod/records")[0]?.url.search).toBe("?version=2&limit=2");
    expect(JSON.parse(JSON.stringify(ds)).name).toBe("support-prod");
  });

  it("imports a file: upload ticket, PUT without the API key, import job, wait", async () => {
    const ticket = wire<{ url: string }>("upload-ticket.json");
    const ticketPath = new URL(ticket.url, BASE).pathname;
    const server = new FakeServer()
      .on("POST", "/v1/uploads", json(ticket, 201))
      .on("PUT", ticketPath, json({ upload_id: "upl" }))
      .on("POST", "/v1/datasets/support-prod/imports", json(wire("import-job-queued.json"), 202))
      .on("GET", `/v1/imports/${wire<{ id: string }>("import-job-queued.json").id}`, json({ ...wire<Record<string, unknown>>("import-job-queued.json"), status: "running" }), json(wire("import-job-completed.json")));
    server.on("GET", "/v1/datasets/support-prod", json(wire("dataset.json")));
    const { grad, clock } = makeGrad(server);
    const ds = await grad.datasets.get("support-prod");
    const dir = scratch();
    const file = path.join(dir, "traces.jsonl");
    writeFileSync(file, '{"messages":[]}\n');

    const job = await ds.importFile(file, { connector: "openai_chat", format: "jsonl" }).wait();
    expect(job.status).toBe("completed");
    expect(job.importedCount).toBe(3);
    expect(job.detectedScores).toEqual(["resolved"]);
    expect(clock.sleeps).toEqual([500]);

    const upload = server.lastBody("POST", "/v1/uploads");
    expect(upload).toMatchObject({ purpose: "dataset_import", filename: "traces.jsonl", size_bytes: 16 });
    expect((upload as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
    const put = server.callsTo("PUT", ticketPath)[0]!;
    expect(put.headers.has("authorization")).toBe(false);
    expect(put.headers.get("content-type")).toBe("application/octet-stream");
    expect(put.url.search).toContain("sig=");
    expect(put.rawBody).toBeInstanceOf(Blob);
    expect(server.lastBody("POST", "/v1/datasets/support-prod/imports")).toEqual({
      source: { kind: "upload", upload_id: ticket["upload_id" as keyof typeof ticket], format: "jsonl" },
      connector: "openai_chat",
    });

    const pending = grad.datasets.importFile("support-prod", file);
    expect((await pending).id).toBe(wire<{ id: string }>("import-job-queued.json").id);
    await expect(ds.importFile(path.join(dir, "missing.jsonl"))).rejects.toThrow(/File not found/);
  });

  it("uploads to a presigned cross-origin URL with only the ticket headers", async () => {
    const server = new FakeServer()
      .on("POST", "/v1/uploads", json({ upload_id: "upl_s3", method: "PUT", url: "https://bucket.s3.example/key?X-Amz-Signature=abc", headers: { "x-amz-checksum-sha256": "z" }, expires_at: "t" }, 201))
      .on("PUT", "/key", new Response(null, { status: 200 }))
      .on("POST", "/v1/datasets/d/imports", json(wire("import-job-queued.json"), 202));
    const { grad } = makeGrad(server);
    const file = path.join(scratch(), "t.jsonl");
    writeFileSync(file, "{}\n");
    await grad.datasets.importFile("d", file);
    const put = server.callsTo("PUT", "/key")[0]!;
    expect(put.url.origin).toBe("https://bucket.s3.example");
    expect(put.headers.has("authorization")).toBe(false);
    expect(put.headers.get("x-amz-checksum-sha256")).toBe("z");
  });

  it("raises ImportFailedError with the server's error", async () => {
    const failed = { ...wire<Record<string, unknown>>("import-job-completed.json"), id: "imp_1", status: "failed", error: "line 3: not JSON" };
    const server = new FakeServer().on("GET", "/v1/imports/imp_1", json(failed));
    const { grad } = makeGrad(server);
    const e = await grad.imports.wait("imp_1").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ImportFailedError);
    expect((e as Error).message).toContain("line 3: not JSON");
    expect((e as ImportFailedError).job.status).toBe("failed");
  });

  it("imports a built-in benchmark and waits for it", async () => {
    const queued = wire<Record<string, unknown>>("import-job-queued.json");
    const server = new FakeServer()
      .on("POST", "/v1/datasets/gsm8k-200/imports", json(queued, 202))
      .on("GET", `/v1/imports/${String(queued.id)}`, json({ ...queued, status: "completed" }))
      .on("GET", "/v1/datasets/gsm8k-200", json({ ...wire<Record<string, unknown>>("dataset.json"), name: "gsm8k-200" }))
      .on("POST", "/v1/datasets/mmlu/imports", json(queued, 202))
      .on("GET", "/v1/datasets/mmlu", json({ ...wire<Record<string, unknown>>("dataset.json"), name: "mmlu" }));
    const { grad } = makeGrad(server);
    const gsm8k = await grad.datasets.fromBenchmark("gsm8k", { limit: 200, pollIntervalMs: 1 });
    expect(gsm8k.name).toBe("gsm8k-200");
    expect(server.lastBody("POST", "/v1/datasets/gsm8k-200/imports")).toEqual({ source: { kind: "benchmark", benchmark: "gsm8k", limit: 200 }, connector: "auto" });
    await grad.datasets.fromBenchmark("mmlu", { wait: false });
    expect(server.lastBody("POST", "/v1/datasets/mmlu/imports")).toEqual({ source: { kind: "benchmark", benchmark: "mmlu" }, connector: "auto" });
  });

  it("imports from Hugging Face into a derived dataset name", async () => {
    const done = { ...wire<Record<string, unknown>>("import-job-completed.json"), dataset: "openai-gsm8k-train" };
    const server = new FakeServer()
      .on("POST", "/v1/datasets", problemFixture("conflict"))
      .on("POST", "/v1/datasets/openai-gsm8k-train/imports", json({ ...done, id: "imp_hf", status: "queued" }, 202))
      .on("GET", "/v1/imports/imp_hf", json(done))
      .on("GET", "/v1/datasets/openai-gsm8k-train", json({ ...wire<Record<string, unknown>>("dataset.json"), name: "openai-gsm8k-train" }));
    const { grad } = makeGrad(server);
    const ds = await grad.datasets.fromHf("openai/gsm8k", { subset: "main", split: "train", prompt: "question", answer: "answer", limit: 10, revision: "r1", connector: "auto" });
    expect(ds.name).toBe("openai-gsm8k-train");
    expect(server.lastBody("POST", "/v1/datasets/openai-gsm8k-train/imports")).toEqual({
      source: { kind: "hf", repo: "openai/gsm8k", split: "train", config: "main", revision: "r1", limit: 10, columns: { prompt: "question", answer: "answer" } },
      connector: "auto",
    });

    const other = new FakeServer().on("POST", "/v1/datasets", json({}, 403));
    await expect(makeGrad(other).grad.datasets.fromHf("a/b")).rejects.toThrow(/403/);

    const importer = new FakeServer()
      .on("POST", "/v1/datasets/mine/imports", json({ ...done, id: "imp_2" }, 202))
      .on("GET", "/v1/imports", json({ data: [done], next_cursor: null }))
      .on("GET", "/v1/datasets/mine", json({ ...wire<Record<string, unknown>>("dataset.json"), name: "mine" }));
    const g2 = makeGrad(importer).grad;
    const mine = await g2.datasets.get("mine");
    await mine.importHf("x/y", { columns: { messages: "conversation" } });
    expect(importer.lastBody("POST", "/v1/datasets/mine/imports")).toEqual({ source: { kind: "hf", repo: "x/y", columns: { messages: "conversation" } } });
    expect((await g2.imports.list()).data).toHaveLength(1);
    expect((await g2.imports.list({ limit: 5 }).all())[0]?.status).toBe("completed");
  });

  it("builds trajectories with empty score maps", () => {
    const t = Trajectory.fromMessages([{ role: "user", content: "hi" }], { sessionId: "pr_481", groupId: "g", id: "r1", source: "unit" });
    t.scores.tests_passed = 1;
    expect(t).toEqual({ schema: "grad.trajectory/1", messages: [{ role: "user", content: "hi" }], scores: { tests_passed: 1 }, metrics: {}, metadata: {}, id: "r1", sessionId: "pr_481", groupId: "g", source: "unit" });
  });
});

describe("artifacts", () => {
  const artifactFixture = wire<{ id: string; name: string; version: string; sha256: string }>("artifact.json");

  it("gets and lists artifacts and maps 404", async () => {
    const server = new FakeServer()
      .on("GET", `/v1/artifacts/${encodeURIComponent("support-sft@latest")}`, json(artifactFixture))
      .on("GET", "/v1/artifacts", json(wire("artifacts-page.json")))
      .on("GET", "/v1/artifacts/missing", problemFixture("not-found"));
    const { grad } = makeGrad(server);
    const art = await grad.artifacts.get("support-sft@latest");
    expect(art).toBeInstanceOf(Artifact);
    expect(art.ref).toBe(`${artifactFixture.name}@${artifactFixture.version}`);
    expect(JSON.parse(JSON.stringify(art)).id).toBe(artifactFixture.id);
    const page = await grad.artifacts.list({ name: "support-sft", limit: 10 });
    expect(page.data[0]).toBeInstanceOf(Artifact);
    expect(server.callsTo("GET", "/v1/artifacts")[0]?.url.search).toBe("?limit=10&name=support-sft");
    const e = await grad.artifacts.get("missing").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NotFoundError);
    expect((e as NotFoundError).requestId).toMatch(/^req_/);
  });

  const IMPORT = {
    id: "imp_1",
    workspace_id: "ws_e2e",
    status: "queued",
    name: "my-lora",
    base_model: "test/tiny-qwen3",
    format: "peft_lora",
    source: { kind: "upload", upload_id: "a".repeat(64), repo: null, revision: null },
    artifact_id: null,
    error: null,
    error_code: null,
    attempt: 0,
    created_at: "t",
    updated_at: "t",
  };

  it("uploads a directory as a gzip tar and waits for the validated artifact", async () => {
    const ticket = wire<{ url: string; upload_id: string }>("upload-ticket.json");
    const ticketPath = new URL(ticket.url, BASE).pathname;
    let sent: Buffer | undefined;
    const server = new FakeServer()
      .on("POST", "/v1/uploads", json(ticket, 201))
      .on("PUT", ticketPath, async (call) => {
        sent = Buffer.from(await (call.rawBody as Blob).arrayBuffer());
        return new Response(null, { status: 200 });
      })
      .on("POST", "/v1/artifact-imports", json(IMPORT, 202))
      .on(
        "GET",
        "/v1/artifact-imports/imp_1",
        json({ ...IMPORT, status: "running" }),
        json({ ...IMPORT, status: "completed", artifact_id: artifactFixture.id }),
      )
      .on("GET", `/v1/artifacts/${encodeURIComponent(artifactFixture.id)}`, json(artifactFixture));
    const { grad } = makeGrad(server);
    const dir = path.join(scratch(), "My LoRA");
    mkdirSync(path.join(dir, "sub"), { recursive: true });
    writeFileSync(path.join(dir, "adapter_config.json"), "{}");
    writeFileSync(path.join(dir, "sub", "x.bin"), "xyz");

    const pending = grad.artifacts.upload(dir, { base: "test/tiny-qwen3" });
    const art = await pending.wait();
    expect(art).toBeInstanceOf(Artifact);
    expect(art.provenance.source).toBe("run");
    expect(server.lastBody("POST", "/v1/uploads")).toMatchObject({ purpose: "artifact_import", filename: "upload.tar.gz" });
    expect(server.lastBody("POST", "/v1/artifact-imports")).toEqual({
      source: { kind: "upload", upload_id: ticket.upload_id },
      base_model: "test/tiny-qwen3",
      format: "peft_lora",
      name: "my-lora",
    });
    expect(server.callsTo("POST", "/v1/artifact-imports")[0]?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    // A ustar archive of the regular files, at their relative paths.
    const tar = gunzipSync(sent!);
    const names: string[] = [];
    for (let at = 0; at + 512 <= tar.length && tar[at] !== 0; ) {
      const name = tar.subarray(at, at + 100).toString("utf8").replace(/\0.*$/s, "");
      const size = parseInt(tar.subarray(at + 124, at + 135).toString("utf8"), 8);
      names.push(name);
      expect(tar.subarray(at + 257, at + 262).toString("utf8")).toBe("ustar");
      at += 512 + Math.ceil(size / 512) * 512;
    }
    expect(names).toEqual(["adapter_config.json", "sub/x.bin"]);
    await expect(grad.artifacts.upload(path.join(dir, "missing"), { base: "b" })).rejects.toThrow(/No such file/);
  });

  it("throws ArtifactImportFailedError (invalid_artifact, 422) naming the file", async () => {
    const failed = { ...IMPORT, status: "failed", error: "adapter_model.safetensors: tensor shape mismatch", error_code: "invalid_artifact" };
    const server = new FakeServer().on("GET", "/v1/artifact-imports/imp_1", json(failed));
    const { grad } = makeGrad(server);
    const job = await grad.artifacts.getImport("imp_1");
    const e = await job.wait().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ArtifactImportFailedError);
    expect((e as ArtifactImportFailedError).status).toBe(422);
    expect((e as ArtifactImportFailedError).code).toBe("invalid_artifact");
    expect((e as Error).message).toContain("adapter_model.safetensors");
    expect(JSON.parse(JSON.stringify(job)).errorCode).toBe("invalid_artifact");
  });

  it("imports from the Hub, parses hf:// URIs and deletes artifacts", async () => {
    const server = new FakeServer()
      .on("POST", "/v1/artifact-imports", json({ ...IMPORT, source: { kind: "hf", upload_id: null, repo: "acme/lora", revision: "main" } }, 202))
      .on("DELETE", `/v1/artifacts/${encodeURIComponent(artifactFixture.id)}`, new Response(null, { status: 204 }))
      .on("GET", `/v1/artifacts/${encodeURIComponent(artifactFixture.id)}`, json(artifactFixture));
    const { grad } = makeGrad(server);
    const job = await grad.artifacts.fromHf("hf://acme/lora@main", { base: "test/tiny-qwen3", secret: "hf-token" });
    expect(job.source.repo).toBe("acme/lora");
    expect(server.lastBody("POST", "/v1/artifact-imports")).toEqual({
      source: { kind: "hf", repo: "acme/lora", revision: "main", secret: "hf-token" },
      base_model: "test/tiny-qwen3",
      format: "peft_lora",
    });
    await grad.artifacts.fromHf("acme/lora", { base: "b", revision: "v1", name: "x", format: "cartridge" });
    expect(server.lastBody("POST", "/v1/artifact-imports")).toMatchObject({ source: { kind: "hf", repo: "acme/lora", revision: "v1" }, name: "x", format: "cartridge" });
    expect(() => parseHfUri("hf://acme/lora@a", "b")).toThrow(/pins revision/);
    expect(() => parseHfUri("hf://../x")).toThrow(/not a Hugging Face repo/);
    await (await grad.artifacts.get(artifactFixture.id)).delete();
    await grad.artifacts.delete({ name: artifactFixture.name, version: artifactFixture.version });
    expect(server.callsTo("DELETE", `/v1/artifacts/${encodeURIComponent(artifactFixture.id)}`)).toHaveLength(2);
  });
});

describe("models, keys, low-level api", () => {
  it("lists models and manages keys", async () => {
    const server = new FakeServer()
      .on("GET", "/v1/base-models", json(wire("models.json")))
      .on("POST", "/v1/keys", json(wire("api-key-created.json"), 201))
      .on("GET", "/v1/keys", json(wire("api-keys-page.json")))
      .on("DELETE", "/v1/keys/key_1", json({ ...wire<{ key: Record<string, unknown> }>("api-key-created.json").key, revoked_at: "2026-11-27T05:00:00Z" }));
    const { grad } = makeGrad(server);
    const models = await grad.models.list();
    expect(models.length).toBeGreaterThan(3);
    expect(models[0]).toHaveProperty("pricePerMillionTokensUsd");
    const created = await grad.keys.create({ name: "ci", scopes: ["runs:read"] });
    expect(created.secret).toContain("grad_");
    expect((await grad.keys.list()).data.length).toBeGreaterThan(0);
    expect((await grad.keys.revoke("key_1")).revokedAt).toBe("2026-11-27T05:00:00Z");
    expect(grad.api).toBeInstanceOf(ApiClient);
  });

  it("surfaces validation field errors on create calls", async () => {
    const server = new FakeServer().on("POST", "/v1/datasets", problemFixture("validation"));
    const { grad } = makeGrad(server);
    const e = await grad.datasets.create("Bad Name!").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as ValidationError).fieldErrors.map((f) => f.field)).toEqual(["name", "recipe.batch_size"]);
    expect(e).toBeInstanceOf(GradError);
  });

  it("maps conflicts", async () => {
    const server = new FakeServer().on("POST", "/v1/datasets", problemFixture("conflict"));
    await expect(makeGrad(server).grad.datasets.create("support-prod")).rejects.toBeInstanceOf(ConflictError);
  });

  it("Paginator.all walks every page once", async () => {
    const fetchPage = vi.fn(async (cursor: string | undefined) => (cursor ? { data: [3], nextCursor: null } : { data: [1, 2], nextCursor: "c" }));
    const p = new Paginator<number>(fetchPage);
    expect(await p.all()).toEqual([1, 2, 3]);
    expect((await p).data).toEqual([1, 2]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});

describe("node file helpers", () => {
  it("parses content-disposition safely", async () => {
    const { filenameFromDisposition } = await import("../src/node/files.js");
    expect(filenameFromDisposition('attachment; filename="support-sft-2026.grad.tar.gz"')).toBe("support-sft-2026.grad.tar.gz");
    expect(filenameFromDisposition("attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd")).toBe("passwd");
    expect(filenameFromDisposition('attachment; filename=".."')).toBeUndefined();
    expect(filenameFromDisposition("attachment; filename*=UTF-8''%E0%A4%A")).toBe("_E0_A4_A");
    expect(filenameFromDisposition(null)).toBeUndefined();
    expect(filenameFromDisposition("inline")).toBeUndefined();
    const { readTextFile } = await import("../src/node/files.js");
    const f = path.join(scratch(), "a.txt");
    writeFileSync(f, "ctx");
    expect(await readTextFile(f)).toBe("ctx");
    expect(readFileSync(f, "utf8")).toBe("ctx");
  });
});
