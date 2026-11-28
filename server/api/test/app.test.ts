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
import { isDatabaseUnavailable } from "../src/store/postgres/db.js";
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
    expect((await t.request("/openapi.json")).status).toBe(200);
  });

  it("answers 503 with Retry-After when the database is unreachable", async () => {
    const broken = await makeTestApp();
    broken.deps.store.runs.list = async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
        code: "ECONNREFUSED",
      });
    };
    const res = await broken.request("/v1/runs");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(await res.json()).toMatchObject({ code: "database_unavailable" });
    await broken.close();
  });

  it("tells database outages from bugs", () => {
    const err = (message: string, code?: string) =>
      Object.assign(new Error(message), code ? { code } : {});
    for (const e of [
      err("x", "ECONNRESET"),
      err("x", "08006"),
      err("x", "57P01"),
      err("x", "53300"),
      err("canceling statement due to statement timeout", "57014"),
      err("timeout exceeded when trying to connect"),
      err("Connection terminated unexpectedly"),
      err("Client has encountered a connection error and is not queryable"),
    ]) {
      expect(isDatabaseUnavailable(e), e.message).toBe(true);
    }
    expect(isDatabaseUnavailable(err("dup", "23505"))).toBe(false);
    expect(isDatabaseUnavailable(new TypeError("bug"))).toBe(false);
    expect(isDatabaseUnavailable("nope")).toBe(false);
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

  it("fails readiness while draining and keeps serving everything else", async () => {
    const draining = await makeTestApp();
    draining.startDraining();
    const ready = await draining.json("/health/ready", { token: null });
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ code: "shutting_down" });
    expect(
      (await draining.request("/health/live", { token: null })).status,
    ).toBe(200);
    expect((await draining.request("/v1/runs")).status).toBe(200);
    await draining.close();
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
      [t.request("/v1/base-models", { token: null }), 401, "unauthorized"],
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

    const custom = await t.request("/v1/base-models", {
      headers: { "x-request-id": "trace-123" },
    });
    expect(custom.headers.get("x-request-id")).toBe("trace-123");
    const ignored = await t.request("/v1/base-models", {
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
    const res = await outage.json("/v1/base-models");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "auth_unavailable" });
    await outage.close();
  });

  it("returns 413 problem+json for oversized bodies", async () => {
    const res = await t.request("/v1/datasets/x/records", {
      method: "POST",
      body: "x".repeat(33 * 1024 * 1024),
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
    const clamped = await t.json<{ data: unknown[]; next_cursor: null }>(
      "/v1/keys?limit=100000",
    );
    expect(clamped.status).toBe(200);
    expect(clamped.body).toMatchObject({ next_cursor: null });
    expect((await t.json("/v1/keys?limit=0")).status).toBe(422);
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
    }>("/v1/base-models");
    expect(res.body.data.map((m) => m.id)).toContain("test/tiny-qwen3");
    expect(
      res.body.data.find((m) => m.id === "baai/bge-small-en-v1.5")?.recipes,
    ).toEqual(["embedding"]);
  });

  it("gates run creation on billing and rejects wave 2 recipes", async () => {
    const denied = await makeTestApp({
      billing: {
        checkCanStartRun: async () => ({
          allowed: false,
          reason: "No balance",
        }),
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

  it("resume replays on an active run and refuses one still finalizing", async () => {
    const run = await createSftRun(t);
    // A replayed resume (r8 A5) gets the current state, not 409.
    const queued = await t.json(`/v1/runs/${run.id}/resume`, {
      method: "POST",
    });
    expect(queued.status).toBe(200);
    expect(queued.body).toMatchObject({ id: run.id, status: "queued" });
    const worker = new FakeWorker(t);
    await worker.claim();
    await t.json(`/v1/runs/${run.id}/cancel`, { method: "POST" });
    const finalizing = await t.json(`/v1/runs/${run.id}/resume`, {
      method: "POST",
    });
    expect(finalizing.status).toBe(409);
    expect(finalizing.body).toMatchObject({
      code: "run_not_resumable",
      detail: expect.stringContaining("resume it again in a few seconds"),
    });
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
    const artifactImport = await t.json<{ id: string }>(
      "/v1/artifact-imports",
      {
        body: {
          source: { kind: "hf", repo: "acme/lora" },
          base_model: "test/tiny-qwen3",
        },
      },
    );
    expect(artifactImport.status).toBe(202);
    const pin = await t.json(`/v1/artifacts/${artifactId}/pins`, {
      body: { holder: "inference:version:v1", reason: "test" },
    });
    expect(pin.status).toBe(201);

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
      ["GET", `/v1/artifacts/${artifactId}/download-url`],
      [
        "POST",
        `/v1/artifacts/${artifactId}/pins`,
        { holder: "x", reason: "r" },
      ],
      ["DELETE", `/v1/artifacts/${artifactId}/pins/inference:version:v1`],
      ["DELETE", `/v1/artifacts/${artifactId}`],
      ["GET", `/v1/artifact-imports/${artifactImport.body.id}`],
      ["GET", `/v1/runs/${run.id}/events`],
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
      "/v1/usage",
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

  it("never lets a worker id stand in for the key: no claim theft by reusing a worker id (r8 P1-1)", async () => {
    const worker = (
      actor: string,
      workerWorkspaceId: string | null,
    ): AuthPrincipal => ({
      kind: "worker",
      workspaceId: workerWorkspaceId ?? "_platform",
      actor,
      scopes: ["trainer:worker"],
      isPlatformAdmin: false,
      workerWorkspaceId,
    });
    const auth: AuthAdapter = {
      authenticate: async (token) =>
        token === TRAINER_KEY
          ? worker("platform", null)
          : token === "scoped-b"
            ? worker("cloud-b", "ws_b")
            : token === "scoped-a"
              ? worker("cloud-a", "ws_a")
              : token === ADMIN_KEY
                ? {
                    kind: "workspace",
                    workspaceId: "ws_a",
                    actor: "a",
                    scopes: ["admin"],
                    isPlatformAdmin: true,
                    workerWorkspaceId: null,
                  }
                : null,
    };
    const app = await makeTestApp({ auth });
    await createSftRun(app);
    // Worker ids are pod names: public, and the same id in every pool.
    const victim = new FakeWorker(app, "trainer-gpu-01");
    const job = await victim.claim();
    expect(job?.run).toBeTruthy();

    // Another workspace's key, and even another key of the same workspace,
    // reusing the id get no claim retry: not the run config, not the URLs.
    for (const token of ["scoped-b", "scoped-a"]) {
      const thief = new FakeWorker(app, "trainer-gpu-01", token);
      expect(await thief.claim()).toBeNull();
      const beat = await thief.heartbeat(job!);
      expect([404, 409]).toContain(beat.status);
      const done = await thief.call(`/v1/trainer-jobs/${job!.id}/complete`, {
        ...thief.ref(job!),
        status: "failed",
        error: "stolen",
      });
      expect([404, 409]).toContain(done.status);
    }
    // The holder's own lost-response retry still gets its job back.
    expect((await victim.claim())?.id).toBe(job!.id);
    expect((await victim.heartbeat(job!)).status).toBe(200);
    await app.close();
  });
});
