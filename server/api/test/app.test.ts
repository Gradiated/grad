import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDisabledDeployAdapter,
  createLocalApiKeyAuth,
  createLocalDeployAdapter,
  createNoopBillingAdapter,
  hashApiKey,
  type BillingAdapter,
} from "../src/adapters.js";
import { buildOpenApiDocument, createApp } from "../src/app.js";
import { EnvWorkerHub } from "../src/env-hub.js";
import { LocalObjectStore } from "../src/storage.js";
import { InMemoryTrainingStore } from "../src/store.js";

const ADMIN_KEY = "grad_test_bootstrap_admin_key";

describe("grad-server HTTP API", () => {
  let tmpDir: string;
  let store: InMemoryTrainingStore;
  let storage: LocalObjectStore;
  let envHub: EnvWorkerHub;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "grad-api-test-"));
    store = new InMemoryTrainingStore();
    storage = new LocalObjectStore(tmpDir);
    envHub = new EnvWorkerHub();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const makeApp = (opts?: {
    deployEnabled?: boolean;
    billing?: BillingAdapter;
  }) =>
    createApp({
      store,
      storage,
      auth: createLocalApiKeyAuth({
        adminKeyHash: hashApiKey(ADMIN_KEY),
        workspaceId: "ws_main",
        lookup: store,
      }),
      billing: opts?.billing ?? createNoopBillingAdapter(),
      deploy: opts?.deployEnabled
        ? createLocalDeployAdapter()
        : createDisabledDeployAdapter(),
      envHub,
    });

  const authed = (token = ADMIN_KEY): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  });

  it("exposes health probes and valid OpenAPI 3.1 schema", async () => {
    const app = makeApp({ deployEnabled: true });

    const live = await app.request("/health/live");
    expect(live.status).toBe(200);

    const ready = await app.request("/health/ready");
    expect(ready.status).toBe(200);

    const doc = buildOpenApiDocument(app);
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths).toHaveProperty("/v1/runs/plan");
    expect(doc.paths).toHaveProperty("/v1/runs/{id}/metrics");
    expect(doc.paths).toHaveProperty("/v1/env-workers/register");
  });

  it("enforces authentication, scoped API keys, and revocation", async () => {
    const app = makeApp({ deployEnabled: true });

    const unauth = await app.request("/v1/models");
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("content-type")).toContain(
      "application/problem+json",
    );

    const createKeyRes = await app.request("/v1/keys", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        name: "ci-reader",
        scopes: ["datasets:read"],
      }),
    });
    expect(createKeyRes.status).toBe(201);
    const { key, secret } = (await createKeyRes.json()) as {
      key: { id: string };
      secret: string;
    };

    const allowedRead = await app.request("/v1/datasets", {
      headers: authed(secret),
    });
    expect(allowedRead.status).toBe(200);

    const deniedWrite = await app.request("/v1/datasets/demo/records", {
      method: "POST",
      headers: authed(secret),
      body: JSON.stringify({
        records: [{ messages: [{ role: "user", content: "hi" }] }],
      }),
    });
    expect(deniedWrite.status).toBe(403);

    const revokeRes = await app.request(`/v1/keys/${key.id}`, {
      method: "DELETE",
      headers: authed(),
    });
    expect(revokeRes.status).toBe(200);

    const revokedUse = await app.request("/v1/datasets", {
      headers: authed(secret),
    });
    expect(revokedUse.status).toBe(401);
  });

  it("runs the full dataset -> plan -> train -> checkpoint -> artifact -> deploy -> route -> feedback lifecycle", async () => {
    const app = makeApp({ deployEnabled: true });

    // 1. Push dataset records twice (append semantics)
    const push1 = await app.request("/v1/datasets/support/records", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        records: [
          {
            session_id: "s1",
            messages: [
              { role: "user", content: "How do I reset my password?" },
              { role: "assistant", content: "Click Forgot Password." },
            ],
          },
          {
            session_id: "s2",
            messages: [
              { role: "user", content: "Export billing CSV?" },
              { role: "assistant", content: "Go to Billing -> Export." },
            ],
          },
        ],
      }),
    });
    expect(push1.status).toBe(200);
    const ds1 = (await push1.json()) as { record_count: number };
    expect(ds1.record_count).toBe(2);

    // 2. Render preview
    const renderRes = await app.request("/v1/datasets/support/render", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "qwen/qwen3-8b",
        train_on: "last",
        thinking: "off",
        limit: 2,
      }),
    });
    expect(renderRes.status).toBe(200);
    const rendered = (await renderRes.json()) as {
      examples: Array<{ trained_tokens: number }>;
    };
    expect(rendered.examples).toHaveLength(2);
    expect(rendered.examples[0]?.trained_tokens).toBeGreaterThan(0);

    // 3. Plan run
    const planRes = await app.request("/v1/runs/plan", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        dataset: "support",
        name: "support-router",
        recipe: {
          kind: "router",
          models: ["qwen/qwen3-8b", "qwen/qwen3-32b"],
          max_quality_drop: 0.02,
        },
        max_cost_usd: 1.0,
      }),
    });
    expect(planRes.status).toBe(200);
    const plan = (await planRes.json()) as {
      resolved_config: { model: string };
    };
    expect(plan.resolved_config.model).toBe("qwen/qwen3-0.6b");

    // 4. Create run
    const createRunRes = await app.request("/v1/runs", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        dataset: "support",
        name: "support-router",
        recipe: {
          kind: "router",
          models: ["qwen/qwen3-8b", "qwen/qwen3-32b"],
        },
        max_cost_usd: 0.5,
      }),
    });
    expect(createRunRes.status).toBe(202);
    const run = (await createRunRes.json()) as { id: string; status: string };
    expect(run.status).toBe("queued");

    // 5. Create a dedicated trainer worker key in a separate service workspace
    const workerKey = await store.createApiKey({
      workspaceId: "ws_trainer_pool",
      name: "gpu-worker-0",
      scopes: ["trainer:worker"],
    });

    const claimRes = await app.request("/v1/trainer-jobs/claim", {
      method: "POST",
      headers: authed(workerKey.secret),
      body: JSON.stringify({ worker_id: "worker-0", lease_seconds: 120 }),
    });
    expect(claimRes.status).toBe(200);
    const claimed = (await claimRes.json()) as {
      run: { id: string } | null;
      records: unknown[];
    };
    expect(claimed.run?.id).toBe(run.id);
    expect(claimed.records).toHaveLength(2);

    // 6. Report progress (first under budget, second at budget -> should_stop: true)
    const prog1 = await app.request(`/v1/trainer-jobs/${run.id}/progress`, {
      method: "POST",
      headers: authed(workerKey.secret),
      body: JSON.stringify({
        worker_id: "worker-0",
        metric: {
          step: 1,
          loss: 1.2,
          tokens: 1000,
          cost_usd: 0.1,
          timestamp: new Date().toISOString(),
        },
      }),
    });
    expect(prog1.status).toBe(200);
    expect(((await prog1.json()) as { should_stop: boolean }).should_stop).toBe(
      false,
    );

    const prog2 = await app.request(`/v1/trainer-jobs/${run.id}/progress`, {
      method: "POST",
      headers: authed(workerKey.secret),
      body: JSON.stringify({
        worker_id: "worker-0",
        metric: {
          step: 2,
          loss: 0.9,
          tokens: 2000,
          cost_usd: 0.55,
          timestamp: new Date().toISOString(),
        },
      }),
    });
    expect(prog2.status).toBe(200);
    expect(((await prog2.json()) as { should_stop: boolean }).should_stop).toBe(
      true,
    );

    // Check /v1/runs/{id}/metrics filtering
    const metricsRes = await app.request(
      `/v1/runs/${run.id}/metrics?after_step=1`,
      { headers: authed() },
    );
    expect(metricsRes.status).toBe(200);
    const metricsPayload = (await metricsRes.json()) as {
      data: Array<{ step: number }>;
    };
    expect(metricsPayload.data).toHaveLength(1);
    expect(metricsPayload.data[0]?.step).toBe(2);

    // 7. Register intermediate checkpoint across workspaces (via getRunByWorker)
    const ckptRes = await app.request(
      `/v1/trainer-jobs/${run.id}/checkpoints`,
      {
        method: "POST",
        headers: authed(workerKey.secret),
        body: JSON.stringify({
          worker_id: "worker-0",
          step: 2,
          eval_score: 0.88,
          payload_base64: Buffer.from("ckpt-bytes").toString("base64"),
          metadata: { tag: "mid" },
        }),
      },
    );
    expect(ckptRes.status).toBe(201);
    const ckpt = (await ckptRes.json()) as { id: string };

    // Promote checkpoint to artifact
    const promoteRes = await app.request(`/v1/checkpoints/${ckpt.id}/promote`, {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ name: "support-router-ckpt" }),
    });
    expect(promoteRes.status).toBe(201);

    // 8. Complete job and publish final artifact
    const bundleBytes = Buffer.from("final-router-bundle");
    const completeRes = await app.request(
      `/v1/trainer-jobs/${run.id}/complete`,
      {
        method: "POST",
        headers: authed(workerKey.secret),
        body: JSON.stringify({
          worker_id: "worker-0",
          status: "completed",
          format: "router_bundle",
          artifact_base64: bundleBytes.toString("base64"),
          manifest: {
            router_config: {
              candidates: ["qwen/qwen3-8b", "qwen/qwen3-32b"],
              threshold: 0.65,
              fallback_model: "qwen/qwen3-32b",
            },
          },
          eval_report: { pass_rate: 0.96, cost_savings: 0.64 },
          tokens_processed: 2000,
          cost_usd: 0.55,
        }),
      },
    );
    expect(completeRes.status).toBe(200);
    const completed = (await completeRes.json()) as {
      artifact: { id: string; sha256: string };
    };
    expect(completed.artifact.id).toContain("support-router@");

    // 9. Download artifact and verify sha256 header
    const dlRes = await app.request(
      `/v1/artifacts/${encodeURIComponent("support-router@latest")}/download`,
      { headers: authed() },
    );
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get("x-artifact-sha256")).toBe(
      completed.artifact.sha256,
    );
    expect(Buffer.from(await dlRes.arrayBuffer()).toString("utf8")).toBe(
      "final-router-bundle",
    );

    // 10. Deploy artifact & verify /v1/route + /v1/feedback deduplication
    const deployRes = await app.request("/v1/deployments", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        artifact: "support-router@latest",
        fallback: "qwen/qwen3-32b",
        explore_rate: 0.05,
      }),
    });
    expect(deployRes.status).toBe(200);

    const routeRes = await app.request("/v1/route", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        deployment: "support-router",
        messages: [{ role: "user", content: "Reset password?" }],
        session_id: "sess_1",
      }),
    });
    expect(routeRes.status).toBe(200);
    const routed = (await routeRes.json()) as {
      inference_id: string;
      model: string;
    };
    expect(routeRes.headers.get("x-gradiated-inference-id")).toBe(
      routed.inference_id,
    );

    const fbBody = JSON.stringify({
      events: [
        {
          inference_id: routed.inference_id,
          deployment_name: "support-router",
          idempotency_key: "evt_unique_1",
          score: 1.0,
        },
      ],
    });
    const fb1 = await app.request("/v1/feedback", {
      method: "POST",
      headers: authed(),
      body: fbBody,
    });
    expect(((await fb1.json()) as { accepted: number }).accepted).toBe(1);

    const fb2 = await app.request("/v1/feedback", {
      method: "POST",
      headers: authed(),
      body: fbBody,
    });
    expect(((await fb2.json()) as { deduplicated: number }).deduplicated).toBe(
      1,
    );

    const depStatusRes = await app.request("/v1/deployments/support-router", {
      headers: authed(),
    });
    expect(depStatusRes.status).toBe(200);
    const depStatus = (await depStatusRes.json()) as {
      feedback_count: number;
      average_score: number;
    };
    expect(depStatus.feedback_count).toBe(1);
    expect(depStatus.average_score).toBe(1);

    // 11. Embeddings endpoint
    const embedRes = await app.request("/v1/embeddings", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        model: "support-embed@latest",
        input: ["reset password", "billing export"],
      }),
    });
    expect(embedRes.status).toBe(200);
    const embedPayload = (await embedRes.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    expect(embedPayload.data).toHaveLength(2);
    expect(embedPayload.data[0]?.embedding).toHaveLength(64);
  });

  it("returns 501 on /v1/deployments when hosted deploy is disabled and 403 when billing denies", async () => {
    const app = makeApp({
      deployEnabled: false,
      billing: {
        checkCanStartRun: async () => ({
          allowed: false,
          reason: "Insufficient credits",
        }),
        recordRunUsage: async () => undefined,
      },
    });

    await app.request("/v1/datasets/demo/records", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        records: [
          {
            messages: [
              { role: "user", content: "hi" },
              { role: "assistant", content: "hello" },
            ],
          },
        ],
      }),
    });

    const deniedRun = await app.request("/v1/runs", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        dataset: "demo",
        name: "demo-sft",
        recipe: { kind: "sft" },
      }),
    });
    expect(deniedRun.status).toBe(403);

    const disabledDeploy = await app.request("/v1/deployments", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ artifact: "demo@latest" }),
    });
    expect(disabledDeploy.status).toBe(501);
  });

  it("supports outbound grad env serve worker registration, task dispatch, claim, and completion", async () => {
    const app = makeApp({ deployEnabled: true });

    const regRes = await app.request("/v1/env-workers/register", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        name: "repo-ci",
        worker_id: "env_worker_1",
        concurrency: 2,
      }),
    });
    expect(regRes.status).toBe(200);

    const dispatchRes = await app.request("/v1/env-workers/tasks", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        env_name: "repo-ci",
        task: { prompt: "Fix failing unit test" },
        model_id: "qwen/qwen3-8b",
      }),
    });
    expect(dispatchRes.status).toBe(202);
    const dispatched = (await dispatchRes.json()) as {
      id: string;
      active_workers: number;
    };
    expect(dispatched.active_workers).toBe(1);

    const claimRes = await app.request("/v1/env-workers/repo-ci/claim", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ worker_id: "env_worker_1", wait_ms: 0 }),
    });
    expect(claimRes.status).toBe(200);
    const claimed = (await claimRes.json()) as { task: { id: string } };
    expect(claimed.task.id).toBe(dispatched.id);

    const completeRes = await app.request(
      `/v1/env-workers/tasks/${dispatched.id}/complete`,
      {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({
          worker_id: "env_worker_1",
          score: 1.0,
          scores: { pytest: 1.0 },
          trajectory: { messages: [] },
        }),
      },
    );
    expect(completeRes.status).toBe(200);

    const inspectRes = await app.request(
      `/v1/env-workers/tasks/${dispatched.id}`,
      { headers: authed() },
    );
    expect(inspectRes.status).toBe(200);
    const inspected = (await inspectRes.json()) as {
      status: string;
      result: { score: number };
    };
    expect(inspected.status).toBe("completed");
    expect(inspected.result.score).toBe(1.0);
  });

  it("plans, runs, and mines failures from standalone evals", async () => {
    const app = makeApp({ deployEnabled: true });

    await app.request("/v1/datasets/eval-ds/records", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        records: [
          {
            id: "e1",
            messages: [
              { role: "user", content: "q1" },
              { role: "assistant", content: '{"ok":true}' },
            ],
          },
          {
            id: "e2",
            messages: [
              { role: "user", content: "q2" },
              { role: "assistant", content: "not-json" },
            ],
          },
        ],
      }),
    });

    const badMultiSource = await app.request("/v1/evals/plan", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        models: ["qwen/qwen3-8b"],
        dataset: "eval-ds",
        benchmarks: [{ name: "ifeval", limit: 10 }],
      }),
    });
    expect(badMultiSource.status).toBe(422);

    const planRes = await app.request("/v1/evals/plan", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        models: ["qwen/qwen3-8b", "tuned@latest"],
        baseline: "qwen/qwen3-8b",
        dataset: "eval-ds",
        samples: 2,
        rubric: [
          { name: "json", kind: "validator", validator: "json", weight: 1 },
        ],
      }),
    });
    expect(planRes.status).toBe(200);
    const planned = (await planRes.json()) as { estimated_model_calls: number };
    expect(planned.estimated_model_calls).toBe(8);

    const createRes = await app.request("/v1/evals", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        name: "json-check",
        models: ["qwen/qwen3-8b", "tuned@latest"],
        baseline: "qwen/qwen3-8b",
        dataset: "eval-ds",
        samples: 2,
        rubric: [
          { name: "json", kind: "validator", validator: "json", weight: 1 },
        ],
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string;
      summary: Array<{ model: string; overall: number }>;
    };
    expect(created.summary).toHaveLength(2);

    const failuresRes = await app.request(
      `/v1/evals/${created.id}/failures?model=tuned%40latest&threshold=0.8`,
      { headers: authed() },
    );
    expect(failuresRes.status).toBe(200);
    const failures = (await failuresRes.json()) as {
      data: Array<{ task_id: string }>;
    };
    expect(failures.data).toHaveLength(1);
    expect(failures.data[0]?.task_id).toBe("e2");
  });

  it("enforces Round 1 security & state-machine guards (trainer:worker minting, cancel->should_stop, resume 409, ReDoS, x-request-id)", async () => {
    const app = makeApp({ deployEnabled: true });

    // Non-platform workspace admin cannot mint trainer:worker keys
    const tenantAdmin = await store.createApiKey({
      workspaceId: "ws_tenant",
      name: "tenant-admin",
      scopes: ["admin"],
    });
    const forbiddenMint = await app.request("/v1/keys", {
      method: "POST",
      headers: authed(tenantAdmin.secret),
      body: JSON.stringify({
        name: "rogue-worker",
        scopes: ["trainer:worker"],
      }),
    });
    expect(forbiddenMint.status).toBe(403);

    // Malformed x-request-id is replaced with a clean generated ID
    const liveWithBadId = await app.request("/health/live", {
      headers: { "x-request-id": "bad header with spaces!" },
    });
    expect(liveWithBadId.headers.get("x-request-id")).toMatch(/^req_/);

    // ReDoS nested quantifier pattern is rejected with 422
    const redosRes = await app.request("/v1/evals/plan", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        models: ["qwen/qwen3-8b"],
        benchmarks: [{ name: "ifeval", limit: 5 }],
        rubric: [{ name: "evil", kind: "regex", pattern: "(a+)+$" }],
      }),
    });
    expect(redosRes.status).toBe(422);

    // Cancel preserves worker_id so reportProgress returns should_stop: true, and resume enforces state guard
    await app.request("/v1/datasets/state-ds/records", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        records: [
          {
            messages: [
              { role: "user", content: "hi" },
              { role: "assistant", content: "ok" },
            ],
          },
        ],
      }),
    });
    const runRes = await app.request("/v1/runs", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        dataset: "state-ds",
        name: "state-sft",
        recipe: { kind: "sft" },
      }),
    });
    const run = (await runRes.json()) as { id: string };

    // Cannot resume a queued run -> 409
    const badResume = await app.request(`/v1/runs/${run.id}/resume`, {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({}),
    });
    expect(badResume.status).toBe(409);

    // Claim, then cancel -> progress reports should_stop: true
    await app.request("/v1/trainer-jobs/claim", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ worker_id: "w_cancel_test" }),
    });
    await app.request(`/v1/runs/${run.id}/cancel`, {
      method: "POST",
      headers: authed(),
    });

    const progAfterCancel = await app.request(
      `/v1/trainer-jobs/${run.id}/progress`,
      {
        method: "POST",
        headers: authed(),
        body: JSON.stringify({
          worker_id: "w_cancel_test",
          metric: {
            step: 1,
            loss: 1.0,
            tokens: 100,
            cost_usd: 0.01,
            timestamp: new Date().toISOString(),
          },
        }),
      },
    );
    expect(progAfterCancel.status).toBe(200);
    expect(
      ((await progAfterCancel.json()) as { should_stop: boolean }).should_stop,
    ).toBe(true);

    // Cancelled run CAN be resumed -> 200 queued
    const goodResume = await app.request(`/v1/runs/${run.id}/resume`, {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ max_cost_usd: 2.0 }),
    });
    expect(goodResume.status).toBe(200);
    expect(((await goodResume.json()) as { status: string }).status).toBe(
      "queued",
    );
  });
});
