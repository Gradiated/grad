import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createLocalApiKeyAuth,
  createLocalNoneAuth,
  hashApiKey,
  hasScope,
  type AuthAdapter,
  type AuthPrincipal,
} from "../src/adapters.js";
import { buildOpenApiDocument } from "../src/app.js";
import { ApiError } from "../src/errors.js";
import {
  ADMIN_KEY,
  makeTestApp,
  TRAINER_KEY,
  type TestApp,
} from "./fixtures/app.js";
import { createSftRun, FakeWorker } from "./fixtures/worker.js";

const principal = (scopes: AuthPrincipal["scopes"]): AuthPrincipal => ({
  kind: "workspace",
  workspaceId: "ws",
  actor: "t",
  scopes,
  isPlatformAdmin: false,
  workerWorkspaceId: null,
});

describe("scopes", () => {
  it("admin implies workspace scopes but never trainer:worker; write implies read", () => {
    expect(hasScope(principal(["admin"]), "runs:write")).toBe(true);
    expect(hasScope(principal(["admin"]), "trainer:worker")).toBe(false);
    expect(hasScope(principal(["datasets:write"]), "datasets:read")).toBe(true);
    expect(hasScope(principal(["datasets:read"]), "datasets:write")).toBe(
      false,
    );
    expect(hasScope(principal(["runs:read"]), "artifacts:read")).toBe(false);
    expect(hasScope(principal(["trainer:worker"]), "trainer:worker")).toBe(
      true,
    );
  });

  it("local api-key auth validates digests and recognises admin, trainer and workspace keys", async () => {
    expect(() =>
      createLocalApiKeyAuth({
        adminKeyHash: "zz",
        lookup: { findActiveByHash: async () => null },
      }),
    ).toThrow(/SHA-256/);
    const auth = createLocalApiKeyAuth({
      adminKeyHash: hashApiKey("a"),
      trainerKeyHash: hashApiKey("t"),
      lookup: {
        findActiveByHash: async (h) =>
          h === hashApiKey("k")
            ? {
                id: "key_1",
                workspace_id: "ws_k",
                name: "k",
                scopes: ["runs:read"],
              }
            : null,
      },
    });
    expect(await auth.authenticate(undefined)).toBeNull();
    expect(await auth.authenticate("  ")).toBeNull();
    expect(await auth.authenticate("nope")).toBeNull();
    expect(await auth.authenticate("a")).toMatchObject({
      isPlatformAdmin: true,
      scopes: ["admin"],
      workspaceId: "default",
    });
    expect(await auth.authenticate("t")).toMatchObject({
      kind: "worker",
      scopes: ["trainer:worker"],
      workerWorkspaceId: null,
    });
    expect(await auth.authenticate("k")).toMatchObject({
      workspaceId: "ws_k",
      isPlatformAdmin: false,
    });
    expect(await createLocalNoneAuth().authenticate(undefined)).toMatchObject({
      kind: "dev",
      workspaceId: "local",
    });
  });
});

describe("grad-server HTTP API", () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await makeTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  it("exposes health probes and an OpenAPI 3.1 document", async () => {
    expect((await t.request("/health/live", { token: null })).status).toBe(200);
    expect((await t.request("/health/ready", { token: null })).status).toBe(
      200,
    );
    const doc = buildOpenApiDocument(t.app);
    expect(doc.openapi).toBe("3.1.0");
    for (const path of [
      "/v1/trainer-jobs/claim",
      "/v1/trainer-jobs/{id}/heartbeat",
      "/v1/datasets/{name}/imports",
      "/v1/runs/{id}/metrics",
      "/v1/evals/{id}/scores",
    ]) {
      expect(doc.paths).toHaveProperty(path);
    }
    expect(JSON.stringify(doc.paths)).not.toContain("/blobs/");
    expect((await t.request("/openapi.json")).status).toBe(200);
  });

  it("reports readiness failure as problem+json", async () => {
    const broken = await makeTestApp();
    broken.deps.store.ping = async () => false;
    const res = await broken.request("/health/ready", { token: null });
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    await broken.close();
  });

  it("renders every error as application/problem+json with a request id", async () => {
    const cases: Array<[Promise<Response>, number, string]> = [
      [t.request("/v1/nope"), 404, "route_not_found"],
      [t.request("/nope", { token: null }), 404, "route_not_found"],
      [
        t.request("/v1/runs", {
          method: "POST",
          body: "{not json",
          headers: { "Content-Type": "application/json" },
        }),
        400,
        "malformed_request",
      ],
      [
        t.request("/v1/runs", { body: { dataset: "UPPER" } }),
        422,
        "validation_error",
      ],
      [t.request("/v1/models", { token: null }), 401, "unauthorized"],
      [t.request("/v1/runs/run_missing"), 404, "run_not_found"],
    ];
    for (const [pending, status, code] of cases) {
      const res = await pending;
      expect(res.status, code).toBe(status);
      expect(res.headers.get("content-type"), code).toContain(
        "application/problem+json",
      );
      const body = (await res.json()) as {
        code: string;
        request_id: string;
        type: string;
      };
      expect(body.code).toBe(code);
      expect(body.request_id).toMatch(/^req_/);
      expect(body.type).toBe(`https://gradiated.com/problems/${code}`);
    }

    const custom = await t.request("/v1/models", {
      headers: { "x-request-id": "trace-123" },
    });
    expect(custom.headers.get("x-request-id")).toBe("trace-123");
    const ignored = await t.request("/v1/models", {
      headers: { "x-request-id": "bad id!" },
    });
    expect(ignored.headers.get("x-request-id")).toMatch(/^req_/);
  });

  it("hides internal error messages behind internal_error", async () => {
    t.deps.store.runs.list = async () => {
      throw new Error("password=hunter2 connection refused");
    };
    const res = await t.request("/v1/runs");
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("internal_error");
    expect(body).not.toContain("hunter2");
  });

  it("maps auth adapter outages to 503 problem+json", async () => {
    const down: AuthAdapter = {
      authenticate: async () => {
        throw new ApiError(
          503,
          "auth_unavailable",
          "Auth unavailable",
          "Cloud auth is down.",
        );
      },
    };
    const outage = await makeTestApp({ auth: down });
    const res = await outage.json("/v1/models");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "auth_unavailable" });
    await outage.close();
  });

  it("returns 413 problem+json for oversized bodies", async () => {
    const res = await t.request("/v1/datasets/x/records", {
      method: "POST",
      body: "x".repeat(65 * 1024 * 1024),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("creates, lists, scopes and revokes keys; trainer:worker cannot be minted", async () => {
    const created = await t.json<{
      key: { id: string; scopes: string[] };
      secret: string;
    }>("/v1/keys", {
      body: { name: "reader", scopes: ["datasets:read", "datasets:read"] },
    });
    expect(created.status).toBe(201);
    expect(created.body.key.scopes).toEqual(["datasets:read"]);
    const { secret } = created.body;

    expect((await t.json("/v1/datasets", { token: secret })).status).toBe(200);
    const denied = await t.json("/v1/datasets/x/records", {
      token: secret,
      body: { records: [{ messages: [] }] },
    });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: "forbidden" });
    expect((await t.json("/v1/keys", { token: secret })).status).toBe(403);

    const worker = await t.json("/v1/keys", {
      body: { name: "w", scopes: ["trainer:worker"] },
    });
    expect(worker.status).toBe(422);

    const listed = await t.json<{
      data: unknown[];
      next_cursor: string | null;
    }>("/v1/keys?limit=1");
    expect(listed.body.data).toHaveLength(1);
    expect(
      (await t.json(`/v1/keys/${created.body.key.id}`, { method: "DELETE" }))
        .status,
    ).toBe(200);
    expect((await t.json("/v1/datasets", { token: secret })).status).toBe(401);
    expect(
      (await t.json("/v1/keys/key_missing", { method: "DELETE" })).status,
    ).toBe(404);
  });

  it("serves the catalog including extra models", async () => {
    const res = await t.json<{
      data: Array<{ id: string; recipes: string[] }>;
    }>("/v1/models");
    expect(res.body.data.map((m) => m.id)).toContain("test/tiny-qwen3");
    expect(
      res.body.data.find((m) => m.id === "baai/bge-small-en-v1.5")?.recipes,
    ).toEqual(["embedding"]);
  });

  it("gates run creation on billing and wave 2 recipes", async () => {
    const denied = await makeTestApp({
      billing: {
        checkCanStartRun: async () => ({
          allowed: false,
          reason: "No balance",
        }),
        recordRunUsage: async () => undefined,
      },
    });
    await denied.json("/v1/datasets/d/records", {
      body: {
        records: [
          {
            messages: [
              { role: "user", content: "q" },
              { role: "assistant", content: "a" },
            ],
          },
        ],
      },
    });
    const res = await denied.json("/v1/runs", {
      body: { dataset: "d", name: "r", recipe: { kind: "sft" } },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: "billing_denied",
      detail: "No balance",
    });
    const wave2 = await denied.json("/v1/runs/plan", {
      body: { dataset: "d", name: "r", recipe: { kind: "grpo" } },
    });
    expect(wave2.body).toMatchObject({ code: "recipe_deferred" });
    await denied.close();
  });

  it("resume refuses runs that are still queued or finalizing", async () => {
    const run = await createSftRun(t);
    const queued = await t.json(`/v1/runs/${run.id}/resume`, {
      method: "POST",
    });
    expect(queued.status).toBe(409);
    expect(queued.body).toMatchObject({ code: "run_not_resumable" });
    const worker = new FakeWorker(t);
    await worker.claim();
    await t.json(`/v1/runs/${run.id}/cancel`, { method: "POST" });
    const finalizing = await t.json(`/v1/runs/${run.id}/resume`, {
      method: "POST",
    });
    expect(finalizing.status).toBe(409);
  });

  it("isolates every workspace route between two workspaces", async () => {
    const run = await createSftRun(t);
    const worker = new FakeWorker(t);
    const job = await worker.claim();
    await worker.checkpoint(job!, 1, "c", { format: "peft_lora" });
    const done = await worker.complete(
      job!,
      { status: "completed", tokens_processed: 1 },
      "a",
    );
    const artifactId = (done.body.artifact as { id: string }).id;
    const ckpts = await t.json<{ data: Array<{ id: string }> }>(
      `/v1/runs/${run.id}/checkpoints`,
    );
    const imp = await t.json<{ id: string }>("/v1/datasets/support/imports", {
      body: { source: { kind: "hf", repo: "o/n" } },
    });
    const key = await t.json<{ key: { id: string } }>("/v1/keys", {
      body: { name: "k", scopes: ["runs:read"] },
    });

    const other = await t.mintKey("ws_b", ["admin"]);
    const notFound: Array<[string, string, unknown?]> = [
      ["GET", "/v1/datasets/support"],
      ["GET", "/v1/datasets/support/records"],
      ["POST", "/v1/datasets/support/render", {}],
      ["GET", `/v1/runs/${run.id}`],
      ["GET", `/v1/runs/${run.id}/metrics`],
      ["GET", `/v1/runs/${run.id}/checkpoints`],
      ["POST", `/v1/runs/${run.id}/cancel`],
      ["POST", `/v1/runs/${run.id}/resume`, {}],
      ["POST", `/v1/checkpoints/${ckpts.body.data[0]!.id}/promote`, {}],
      ["GET", `/v1/artifacts/${artifactId}`],
      ["GET", `/v1/artifacts/${artifactId}/download`],
      ["GET", "/v1/artifacts/support-sft@latest"],
      ["GET", `/v1/imports/${imp.body.id}`],
      ["DELETE", `/v1/keys/${key.body.key.id}`],
      [
        "POST",
        "/v1/runs/plan",
        { dataset: "support", name: "x", recipe: { kind: "sft" } },
      ],
      [
        "POST",
        "/v1/runs",
        { dataset: "support", name: "x", recipe: { kind: "sft" } },
      ],
    ];
    for (const [method, path, body] of notFound) {
      const res = await t.json(path, {
        method,
        token: other,
        ...(body !== undefined ? { body } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }

    const ownKeys = await t.json<{ data: Array<{ workspace_id: string }> }>(
      "/v1/keys",
      { token: other },
    );
    expect(ownKeys.body.data.every((k) => k.workspace_id === "ws_b")).toBe(
      true,
    );
    const lists = [
      "/v1/datasets",
      "/v1/runs",
      "/v1/artifacts",
      "/v1/imports",
      "/v1/evals",
      "/v1/deployments",
    ];
    for (const path of lists) {
      const res = await t.json<{ data: unknown[] }>(path, { token: other });
      expect(res.status, path).toBe(200);
      expect(res.body.data, path).toEqual([]);
    }
  });

  it("restricts workspace-scoped trainer workers to their workspace", async () => {
    const scopedWorker: AuthAdapter = {
      authenticate: async (token) =>
        token === "scoped-worker"
          ? {
              kind: "worker",
              workspaceId: "ws_b",
              actor: "w",
              scopes: ["trainer:worker"],
              isPlatformAdmin: false,
              workerWorkspaceId: "ws_b",
            }
          : token === ADMIN_KEY
            ? {
                kind: "workspace",
                workspaceId: "ws_a",
                actor: "a",
                scopes: ["admin"],
                isPlatformAdmin: true,
                workerWorkspaceId: null,
              }
            : token === TRAINER_KEY
              ? {
                  kind: "worker",
                  workspaceId: "_platform",
                  actor: "p",
                  scopes: ["trainer:worker"],
                  isPlatformAdmin: false,
                  workerWorkspaceId: null,
                }
              : null,
    };
    const scoped = await makeTestApp({ auth: scopedWorker });
    await createSftRun(scoped);
    const wsWorker = new FakeWorker(scoped, "scoped", "scoped-worker");
    expect(await wsWorker.claim()).toBeNull();

    const platform = new FakeWorker(scoped);
    const job = await platform.claim();
    const res = await wsWorker.call(`/v1/trainer-jobs/${job!.id}/heartbeat`, {
      worker_id: "worker-1",
      attempt: 1,
    });
    expect(res.status).toBe(404);
    await scoped.close();
  });

  it("serves outbound env workers with a bounded queue", async () => {
    const register = await t.json("/v1/env-workers/register", {
      body: { name: "sandbox", worker_id: "w1" },
    });
    expect(register.status).toBe(200);
    const dispatched = await t.json<{ id: string; active_workers: number }>(
      "/v1/env-workers/tasks",
      {
        body: { env_name: "sandbox", task: { prompt: "x" }, model_id: "m" },
      },
    );
    expect(dispatched.status).toBe(202);
    expect(dispatched.body.active_workers).toBe(1);
    const claim = await t.json<{ task: { id: string } | null }>(
      "/v1/env-workers/sandbox/claim",
      { body: { worker_id: "w1", wait_ms: 0 } },
    );
    expect(claim.body.task?.id).toBe(dispatched.body.id);
    const complete = await t.json(
      `/v1/env-workers/tasks/${dispatched.body.id}/complete`,
      { body: { worker_id: "w1", score: 1, scores: { ok: 1 } } },
    );
    expect(complete.status).toBe(200);
    const wrong = await t.json(
      `/v1/env-workers/tasks/${dispatched.body.id}/complete`,
      { body: { worker_id: "w2", scores: {} } },
    );
    expect(wrong.status).toBe(404);
    const task = await t.json(`/v1/env-workers/tasks/${dispatched.body.id}`);
    expect(task.body).toMatchObject({ status: "completed" });
    expect((await t.json("/v1/env-workers/tasks/envtask_missing")).status).toBe(
      404,
    );
  });
});
