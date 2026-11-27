import { describe, expect, it } from "vitest";

import {
  createCloudAuthAdapter,
  createCloudBillingAdapter,
  createCloudDeployAdapter,
} from "../src/adapters-cloud.js";
import type { Artifact } from "../src/contracts.js";

const sampleArtifact: Artifact = {
  id: "support-sft@2026-11-27-1",
  workspace_id: "ws_cloud",
  name: "support-sft",
  version: "2026-11-27-1",
  run_id: "run_1",
  checkpoint_id: null,
  base_model: "qwen/qwen3-8b",
  recipe_kind: "sft",
  format: "peft_lora",
  storage_key: "artifacts/ws_cloud/support-sft/run_1.grad.tar.gz",
  sha256: "a".repeat(64),
  size_bytes: 2048,
  manifest: { schema: "grad.artifact/1" },
  eval_report: null,
  created_at: new Date().toISOString(),
};

describe("Cloud adapters (Auth, Billing, ART-01/SERV-03 Deploy)", () => {
  it("authenticates tokens, filters scopes, checks/records billing with idempotency, and runs ART-01 -> SERV-03 deploy", async () => {
    const seenPaths: string[] = [];
    const seenIdempotencyKeys: Record<string, string | undefined> = {};

    const mockFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      seenPaths.push(url.pathname);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer svc_internal_token");
      expect(init?.redirect).toBe("error");
      seenIdempotencyKeys[url.pathname] = headers["Idempotency-Key"];

      if (url.pathname === "/api/internal/v1/auth/verify") {
        const body = JSON.parse(String(init?.body)) as { token: string };
        if (body.token === "valid_key") {
          return new Response(
            JSON.stringify({
              valid: true,
              workspace_id: "ws_cloud",
              actor: "user_1",
              scopes: ["runs:write", "deployments:write", "unknown:scope"],
              is_platform_admin: false,
            }),
            { status: 200 },
          );
        }
        if (body.token === "missing_workspace") {
          return new Response(
            JSON.stringify({
              valid: true,
              workspace_id: "   ",
              scopes: ["runs:write"],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ valid: false }), { status: 401 });
      }
      if (url.pathname === "/api/internal/v1/billing/check") {
        return new Response(JSON.stringify({ allowed: true }), { status: 200 });
      }
      if (url.pathname === "/api/internal/v1/billing/usage") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.pathname === "/api/internal/v1/artifacts/publish") {
        return new Response(JSON.stringify({ published: true }), {
          status: 200,
        });
      }
      if (url.pathname === "/api/internal/v1/deployments/promote") {
        return new Response(
          JSON.stringify({ model_id: "gradiated/ws_cloud/support-sft" }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const cfg = {
      internalApiBaseUrl: "https://api.gradiated.com",
      serviceToken: "svc_internal_token",
      fetchImpl: mockFetch,
    };

    const auth = createCloudAuthAdapter(cfg);
    expect(await auth.authenticate(undefined)).toBeNull();
    expect(await auth.authenticate("bad_key")).toBeNull();
    expect(await auth.authenticate("missing_workspace")).toBeNull();

    const principal = await auth.authenticate("valid_key");
    expect(principal?.workspaceId).toBe("ws_cloud");
    expect(principal?.scopes).toEqual(["runs:write", "deployments:write"]);
    expect(principal?.isPlatformAdmin).toBe(false);

    const billing = createCloudBillingAdapter(cfg);
    expect(await billing.checkCanStartRun("ws_cloud", 2.5)).toEqual({
      allowed: true,
    });
    await billing.recordRunUsage({
      workspaceId: "ws_cloud",
      runId: "run_1",
      tokensProcessed: 10_000,
      costUsd: 0.004,
    });
    expect(seenIdempotencyKeys["/api/internal/v1/billing/usage"]).toBe(
      "run-usage:run_1",
    );

    const deploy = createCloudDeployAdapter(cfg);
    const promoted = await deploy.publishAndPromote({
      workspaceId: "ws_cloud",
      name: "support-sft",
      artifact: sampleArtifact,
      fallbackModel: "qwen/qwen3-32b",
    });
    expect(promoted.modelId).toBe("gradiated/ws_cloud/support-sft");
    expect(seenPaths).toContain("/api/internal/v1/artifacts/publish");
    expect(seenPaths).toContain("/api/internal/v1/deployments/promote");
    expect(seenIdempotencyKeys["/api/internal/v1/artifacts/publish"]).toBe(
      "art-publish:ws_cloud:support-sft@2026-11-27-1",
    );
    expect(seenIdempotencyKeys["/api/internal/v1/deployments/promote"]).toBe(
      "deploy-promote:ws_cloud:support-sft:support-sft@2026-11-27-1",
    );
  });

  it("enforces HTTPS for non-loopback URLs and rejects invalid configs", () => {
    expect(() =>
      createCloudAuthAdapter({
        internalApiBaseUrl: "file:///etc/passwd",
        serviceToken: "tok",
      }),
    ).toThrow(/Invalid Cloud internal API URL/);

    expect(() =>
      createCloudAuthAdapter({
        internalApiBaseUrl: "http://internal.gradiated.svc:8080",
        serviceToken: "tok",
      }),
    ).toThrow(/Insecure HTTP/);

    expect(() =>
      createCloudAuthAdapter({
        internalApiBaseUrl: "https://api.gradiated.com",
        serviceToken: "   ",
      }),
    ).toThrow(/serviceToken/);

    expect(() =>
      createCloudAuthAdapter({
        internalApiBaseUrl: "http://127.0.0.1:8080",
        serviceToken: "tok",
      }),
    ).not.toThrow();

    expect(() =>
      createCloudAuthAdapter({
        internalApiBaseUrl: "http://internal.gradiated.svc:8080",
        serviceToken: "tok",
        allowInsecureHttp: true,
      }),
    ).not.toThrow();
  });
});
