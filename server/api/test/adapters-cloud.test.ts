import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashApiKey } from "../src/adapters.js";
import {
  createCloudAuthAdapter,
  createCloudBillingAdapter,
  createCloudDeployAdapter,
  createCloudServingAdapter,
  validateCloudConfig,
  type CloudAdapterConfig,
} from "../src/adapters-cloud.js";
import { ApiError } from "../src/errors.js";
import type { ArtifactRecord } from "../src/store/types.js";
import { ManualClock } from "./fixtures/clock.js";
import {
  startFakeCloudApi,
  type FakeCloudApi,
} from "./fixtures/fake-cloud-api.js";

const artifact: ArtifactRecord = {
  id: "support-router@2026-11-27-1",
  workspace_id: "ws_cloud",
  name: "support-router",
  version: "2026-11-27-1",
  run_id: "run_1",
  checkpoint_id: null,
  base_model: "qwen/qwen3-0.6b",
  recipe_kind: "router",
  format: "router_bundle",
  storage_key: "uploads/ws_cloud/upl_1",
  sha256: "a".repeat(64),
  size_bytes: 42,
  manifest: {
    candidates: ["qwen/qwen3-8b", "qwen/qwen3-32b"],
    fallback_model: "qwen/qwen3-32b",
  },
  eval_report: null,
  created_at: "2026-11-27T12:00:00.000Z",
};

const expectApiError = async (
  promise: Promise<unknown>,
  status: number,
  code: string,
) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
  expect((error as ApiError).code).toBe(code);
};

describe("cloud adapter config validation", () => {
  it("accepts https and loopback http, rejects the rest", () => {
    expect(
      validateCloudConfig({
        internalApiBaseUrl: "https://api.example.com/",
        serviceToken: "t",
      }).baseUrl,
    ).toBe("https://api.example.com");
    expect(() =>
      validateCloudConfig({
        internalApiBaseUrl: "http://127.0.0.1:1",
        serviceToken: "t",
      }),
    ).not.toThrow();
    expect(() =>
      validateCloudConfig({
        internalApiBaseUrl: "http://api.example.com",
        serviceToken: "t",
      }),
    ).toThrow(/Insecure HTTP/);
    expect(() =>
      validateCloudConfig({
        internalApiBaseUrl: "http://api.example.com",
        serviceToken: "t",
        allowInsecureHttp: true,
      }),
    ).not.toThrow();
    expect(() =>
      validateCloudConfig({
        internalApiBaseUrl: "ftp://api.example.com",
        serviceToken: "t",
      }),
    ).toThrow(/protocol/);
    expect(() =>
      validateCloudConfig({
        internalApiBaseUrl: "https://u:p@api.example.com",
        serviceToken: "t",
      }),
    ).toThrow(/credentials/);
    expect(() =>
      validateCloudConfig({
        internalApiBaseUrl: "https://api.example.com",
        serviceToken: " ",
      }),
    ).toThrow(/serviceToken/);
  });
});

describe("cloud adapters against the fake Cloud API", () => {
  let cloud: FakeCloudApi;
  let clock: ManualClock;
  let cfg: CloudAdapterConfig;

  beforeEach(async () => {
    cloud = await startFakeCloudApi();
    clock = new ManualClock();
    cfg = {
      internalApiBaseUrl: cloud.url,
      serviceToken: cloud.serviceToken,
      clock,
      timeoutMs: 2_000,
    };
  });

  afterEach(async () => {
    await cloud.close();
  });

  describe("auth", () => {
    it("verifies tokens, keeps only known scopes, and caches positives for 30 s", async () => {
      cloud.tokens.set("tok_a", {
        workspace_id: "ws_a",
        scopes: ["runs:read", "bogus:scope", "admin"],
        actor: "alice",
      });
      const auth = createCloudAuthAdapter(cfg);

      const principal = await auth.authenticate("tok_a");
      expect(principal).toEqual({
        kind: "workspace",
        workspaceId: "ws_a",
        actor: "alice",
        scopes: ["runs:read", "admin"],
        isPlatformAdmin: false,
        workerWorkspaceId: null,
      });

      await auth.authenticate("tok_a");
      expect(cloud.callsTo("/api/internal/v1/auth/verify")).toHaveLength(1);

      clock.advanceSeconds(31);
      await auth.authenticate("tok_a");
      expect(cloud.callsTo("/api/internal/v1/auth/verify")).toHaveLength(2);
    });

    it("caches negatives for 5 s and returns null for empty tokens", async () => {
      const auth = createCloudAuthAdapter(cfg);
      expect(await auth.authenticate(undefined)).toBeNull();
      expect(await auth.authenticate("   ")).toBeNull();

      expect(await auth.authenticate("tok_unknown")).toBeNull();
      expect(await auth.authenticate("tok_unknown")).toBeNull();
      expect(cloud.callsTo("/api/internal/v1/auth/verify")).toHaveLength(1);

      cloud.tokens.set("tok_unknown", {
        workspace_id: "ws_late",
        scopes: ["runs:read"],
      });
      clock.advanceSeconds(6);
      expect((await auth.authenticate("tok_unknown"))?.workspaceId).toBe(
        "ws_late",
      );
    });

    it("evicts the oldest entry when the cache is full", async () => {
      cloud.tokens.set("t1", { workspace_id: "w1", scopes: [] });
      cloud.tokens.set("t2", { workspace_id: "w2", scopes: [] });
      const auth = createCloudAuthAdapter({
        ...cfg,
        authCache: { maxEntries: 1 },
      });
      await auth.authenticate("t1");
      await auth.authenticate("t2");
      await auth.authenticate("t1");
      expect(cloud.callsTo("/api/internal/v1/auth/verify")).toHaveLength(3);
    });

    it("rejects malformed workspace ids from Cloud", async () => {
      cloud.tokens.set("tok_bad", { workspace_id: "a/b", scopes: ["admin"] });
      cloud.tokens.set("tok_empty", { workspace_id: "", scopes: ["admin"] });
      const auth = createCloudAuthAdapter(cfg);
      expect(await auth.authenticate("tok_bad")).toBeNull();
      expect(await auth.authenticate("tok_empty")).toBeNull();
    });

    it("maps trainer:worker scopes to worker principals", async () => {
      cloud.tokens.set("tok_ws_worker", {
        workspace_id: "ws_a",
        scopes: ["trainer:worker"],
      });
      cloud.tokens.set("tok_platform_worker", {
        workspace_id: "ws_p",
        scopes: ["trainer:worker"],
        is_platform_admin: true,
      });
      cloud.tokens.set("tok_admin", {
        workspace_id: "ws_a",
        scopes: ["admin"],
        is_platform_admin: true,
      });
      const auth = createCloudAuthAdapter(cfg);

      expect(await auth.authenticate("tok_ws_worker")).toMatchObject({
        kind: "worker",
        workerWorkspaceId: "ws_a",
        isPlatformAdmin: false,
      });
      expect(await auth.authenticate("tok_platform_worker")).toMatchObject({
        kind: "worker",
        workerWorkspaceId: null,
      });
      expect(await auth.authenticate("tok_admin")).toMatchObject({
        kind: "workspace",
        isPlatformAdmin: true,
        actor: "cloud-key",
      });
    });

    it("short-circuits the platform trainer key without calling Cloud", async () => {
      const auth = createCloudAuthAdapter({
        ...cfg,
        trainerKeyHash: hashApiKey("trainer-secret"),
      });
      expect(await auth.authenticate("trainer-secret")).toMatchObject({
        kind: "worker",
        scopes: ["trainer:worker"],
        workerWorkspaceId: null,
      });
      expect(cloud.requests).toHaveLength(0);
    });

    it("throws auth_unavailable on 5xx, 429 and network failures (never cached)", async () => {
      cloud.tokens.set("tok_a", { workspace_id: "ws_a", scopes: [] });
      const auth = createCloudAuthAdapter(cfg);

      cloud.failNext(1, 503);
      await expectApiError(auth.authenticate("tok_a"), 503, "auth_unavailable");
      cloud.failNext(1, 429);
      await expectApiError(auth.authenticate("tok_a"), 503, "auth_unavailable");
      expect((await auth.authenticate("tok_a"))?.workspaceId).toBe("ws_a");

      const dead = createCloudAuthAdapter({
        ...cfg,
        internalApiBaseUrl: "http://127.0.0.1:1",
      });
      await expectApiError(dead.authenticate("tok_a"), 503, "auth_unavailable");
    });

    it("treats a 4xx verify response as an invalid key", async () => {
      cloud.respondOnce("/api/internal/v1/auth/verify", 403, [
        "not",
        "an",
        "object",
      ]);
      const auth = createCloudAuthAdapter(cfg);
      expect(await auth.authenticate("tok_x")).toBeNull();
    });

    it("rejects a wrong service token as an invalid key", async () => {
      cloud.tokens.set("tok_a", { workspace_id: "ws_a", scopes: [] });
      const auth = createCloudAuthAdapter({ ...cfg, serviceToken: "wrong" });
      expect(await auth.authenticate("tok_a")).toBeNull();
    });
  });

  describe("billing", () => {
    it("checks balances", async () => {
      cloud.balances.set("ws_poor", 1);
      const billing = createCloudBillingAdapter(cfg);
      expect(await billing.checkCanStartRun("ws_rich", 100)).toEqual({
        allowed: true,
      });
      expect(await billing.checkCanStartRun("ws_poor", 5)).toEqual({
        allowed: false,
        reason: "Balance $1 is below $5.",
      });
    });

    it("maps check failures to billing_unavailable", async () => {
      const billing = createCloudBillingAdapter(cfg);
      cloud.failNext(1, 500);
      await expectApiError(
        billing.checkCanStartRun("ws", 1),
        503,
        "billing_unavailable",
      );
      cloud.respondOnce("/api/internal/v1/billing/check", 400, "bad");
      await expectApiError(
        billing.checkCanStartRun("ws", 1),
        503,
        "billing_unavailable",
      );
      const dead = createCloudBillingAdapter({
        ...cfg,
        internalApiBaseUrl: "http://127.0.0.1:1",
      });
      await expectApiError(
        dead.checkCanStartRun("ws", 1),
        503,
        "billing_unavailable",
      );
    });

    it("records usage idempotently per attempt key", async () => {
      const billing = createCloudBillingAdapter(cfg);
      const usage = (attempt: number, costUsd: number) => ({
        workspaceId: "ws_a",
        runId: "run_1",
        attempt,
        tokensProcessed: 1000 * attempt,
        costUsd,
        idempotencyKey: `run-usage:run_1:${attempt}`,
      });

      await billing.recordRunUsage(usage(1, 5));
      await billing.recordRunUsage(usage(1, 5));
      await billing.recordRunUsage(usage(2, 9));

      expect(cloud.callsTo("/api/internal/v1/billing/usage")).toHaveLength(3);
      expect(cloud.usage).toEqual([
        {
          idempotency_key: "run-usage:run_1:1",
          workspace_id: "ws_a",
          run_id: "run_1",
          attempt: 1,
          tokens_processed: 1000,
          cost_usd: 5,
        },
        {
          idempotency_key: "run-usage:run_1:2",
          workspace_id: "ws_a",
          run_id: "run_1",
          attempt: 2,
          tokens_processed: 2000,
          cost_usd: 9,
        },
      ]);

      await billing.recordEvalUsage({
        workspaceId: "ws_a",
        evalId: "eval_1",
        tokensProcessed: 300,
        costUsd: 0.25,
        idempotencyKey: "eval-usage:eval_1",
      });
      expect(cloud.usage.at(-1)).toEqual({
        idempotency_key: "eval-usage:eval_1",
        workspace_id: "ws_a",
        eval_id: "eval_1",
        tokens_processed: 300,
        cost_usd: 0.25,
      });
    });

    it("throws when usage cannot be recorded so the outbox retries", async () => {
      const billing = createCloudBillingAdapter(cfg);
      cloud.failNext(1, 503);
      await expect(
        billing.recordRunUsage({
          workspaceId: "ws",
          runId: "r",
          attempt: 1,
          tokensProcessed: 1,
          costUsd: 1,
          idempotencyKey: "run-usage:r:1",
        }),
      ).rejects.toThrow(/HTTP 503/);
      expect(cloud.usage).toHaveLength(0);
    });
  });

  describe("deploy", () => {
    it("publishes then promotes with idempotency keys and returns model_id", async () => {
      const deploy = createCloudDeployAdapter(cfg);
      expect(deploy.mode).toBe("cloud");
      const result = await deploy.publishAndPromote({
        workspaceId: "ws_cloud",
        name: "support",
        artifact,
        fallbackModel: "qwen/qwen3-32b",
      });
      expect(result).toEqual({ modelId: "ws_cloud/support" });

      const [publish] = cloud.callsTo("/api/internal/v1/artifacts/publish");
      expect(publish?.idempotency_key).toBe(
        `art-publish:ws_cloud:${artifact.id}`,
      );
      expect(publish?.body).toMatchObject({
        workspace_id: "ws_cloud",
        artifact_id: artifact.id,
        storage_key: artifact.storage_key,
        sha256: artifact.sha256,
        size_bytes: 42,
        format: "router_bundle",
        base_model: "qwen/qwen3-0.6b",
      });
      const [promote] = cloud.callsTo("/api/internal/v1/deployments/promote");
      expect(promote?.idempotency_key).toBe(
        `deploy-promote:ws_cloud:support:${artifact.id}`,
      );
      expect(promote?.body).toMatchObject({
        deployment_name: "support",
        fallback_model: "qwen/qwen3-32b",
      });
    });

    it("fails instead of fabricating a model id", async () => {
      const deploy = createCloudDeployAdapter(cfg);
      const input = {
        workspaceId: "ws_cloud",
        name: "support",
        artifact,
        fallbackModel: null,
      };

      cloud.respondOnce("/api/internal/v1/deployments/promote", 200, {});
      await expectApiError(
        deploy.publishAndPromote(input),
        502,
        "cloud_upstream_error",
      );

      cloud.failNext(1, 500, "/api/internal/v1/artifacts/publish");
      await expectApiError(
        deploy.publishAndPromote(input),
        502,
        "cloud_upstream_error",
      );

      cloud.failNext(1, 500, "/api/internal/v1/deployments/promote");
      await expectApiError(
        deploy.publishAndPromote(input),
        502,
        "cloud_upstream_error",
      );
    });
  });

  describe("serving", () => {
    const routeInput = {
      workspaceId: "ws_cloud",
      inferenceId: "inf_1",
      deploymentName: "support",
      modelId: "ws_cloud/support",
      artifactId: artifact.id,
      fallbackModel: "qwen/qwen3-32b",
      exploreRate: 0,
      messages: [{ role: "user" as const, content: "hi" }],
    };

    beforeEach(async () => {
      await createCloudDeployAdapter(cfg).publishAndPromote({
        workspaceId: "ws_cloud",
        name: "support",
        artifact,
        fallbackModel: "qwen/qwen3-32b",
      });
    });

    it("routes and forwards the inference id", async () => {
      const serving = createCloudServingAdapter(cfg);
      expect(serving.mode).toBe("cloud");
      const decision = await serving.route({ ...routeInput, sessionId: "s1" });
      expect(decision.model).toBe("qwen/qwen3-8b");
      const [call] = cloud.callsTo("/api/internal/v1/serving/route");
      expect(call?.body).toMatchObject({
        inference_id: "inf_1",
        deployment: "support",
        session_id: "s1",
        tools: null,
      });
    });

    it("validates route responses and maps failures", async () => {
      const serving = createCloudServingAdapter(cfg);
      cloud.respondOnce("/api/internal/v1/serving/route", 200, { model: "" });
      await expectApiError(
        serving.route(routeInput),
        502,
        "cloud_upstream_error",
      );
      cloud.failNext(1, 503);
      await expectApiError(
        serving.route(routeInput),
        503,
        "serving_unavailable",
      );
      cloud.respondOnce("/api/internal/v1/serving/route", 400, {
        detail: "nope",
      });
      await expectApiError(
        serving.route(routeInput),
        502,
        "cloud_upstream_error",
      );
      await expectApiError(
        serving.route({ ...routeInput, deploymentName: "missing" }),
        404,
        "deployment_not_serving",
      );
      const dead = createCloudServingAdapter({
        ...cfg,
        internalApiBaseUrl: "http://127.0.0.1:1",
      });
      await expectApiError(dead.route(routeInput), 503, "serving_unavailable");
    });

    it("embeds in input order and checks the count", async () => {
      const serving = createCloudServingAdapter(cfg);
      const input = {
        workspaceId: "ws_cloud",
        deploymentName: "support",
        modelId: "ws_cloud/support",
        inputs: ["a", "bb"],
      };
      const result = await serving.embed(input);
      expect(result.embeddings).toHaveLength(2);
      expect(result.usage.total_tokens).toBe(2);

      cloud.respondOnce("/api/internal/v1/serving/embeddings", 200, {
        data: [
          { index: 1, embedding: [2] },
          { index: 0, embedding: [1] },
        ],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
      expect((await serving.embed(input)).embeddings).toEqual([[1], [2]]);

      cloud.respondOnce("/api/internal/v1/serving/embeddings", 200, {
        data: [{ index: 0, embedding: [1] }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
      await expectApiError(serving.embed(input), 502, "cloud_upstream_error");
    });
  });
});
