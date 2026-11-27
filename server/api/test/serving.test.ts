import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createCloudDeployAdapter,
  createCloudServingAdapter,
  type CloudAdapterConfig,
} from "../src/adapters-cloud.js";
import type { ArtifactFormat, RecipeKind } from "../src/contracts.js";
import { makeTestApp, WORKSPACE_A, type TestApp } from "./fixtures/app.js";
import {
  startFakeCloudApi,
  type FakeCloudApi,
} from "./fixtures/fake-cloud-api.js";

const WORKSPACE_B = "ws_b";

const seedArtifact = (
  t: TestApp,
  input: {
    name: string;
    recipe: RecipeKind;
    format: ArtifactFormat;
    workspaceId?: string;
    manifest?: Record<string, unknown>;
  },
) =>
  t.deps.store.artifacts.create({
    workspaceId: input.workspaceId ?? WORKSPACE_A,
    name: input.name,
    runId: null,
    checkpointId: null,
    baseModel: "qwen/qwen3-0.6b",
    recipeKind: input.recipe,
    format: input.format,
    storageKey: `artifacts/${input.name}/${Math.random()}`,
    sha256: "b".repeat(64),
    sizeBytes: 10,
    manifest: input.manifest ?? {},
    evalReport: null,
  });

const ROUTER_MANIFEST = {
  router_config: { candidates: ["qwen/qwen3-8b", "qwen/qwen3-32b"] },
};

const routeBody = (deployment: string, content = "short question") => ({
  deployment,
  messages: [{ role: "user", content }],
});

describe("serving (DEPLOY_MODE=cloud) against the fake Cloud API", () => {
  let cloud: FakeCloudApi;
  let t: TestApp;

  beforeEach(async () => {
    cloud = await startFakeCloudApi();
    const cfg: CloudAdapterConfig = {
      internalApiBaseUrl: cloud.url,
      serviceToken: cloud.serviceToken,
      timeoutMs: 2_000,
    };
    t = await makeTestApp({
      deploy: createCloudDeployAdapter(cfg),
      serving: createCloudServingAdapter(cfg),
    });
  });

  afterEach(async () => {
    await t.close();
    await cloud.close();
  });

  it("deploy → route → feedback → redeploy → rollback", async () => {
    const v1 = await seedArtifact(t, {
      name: "support-router",
      recipe: "router",
      format: "router_bundle",
      manifest: ROUTER_MANIFEST,
    });

    const deployed = await t.json("/v1/deployments", {
      body: { artifact: "support-router@latest", fallback: "qwen/qwen3-32b" },
    });
    expect(deployed.status).toBe(200);
    expect(deployed.body).toMatchObject({
      name: "support-router",
      model_id: `${WORKSPACE_A}/support-router`,
      active_artifact_id: v1.id,
      previous_artifact_id: null,
      fallback_model: "qwen/qwen3-32b",
      status: "active",
    });

    const routed = await t.json<{ inference_id: string; model: string }>(
      "/v1/route",
      { body: routeBody("support-router") },
    );
    expect(routed.status).toBe(200);
    expect(routed.body.model).toBe("qwen/qwen3-8b");
    expect(routed.body.inference_id).toMatch(/^inf_/);
    expect(routed.headers.get("x-gradiated-inference-id")).toBe(
      routed.body.inference_id,
    );

    const long = await t.json<{ model: string }>("/v1/route", {
      body: routeBody("support-router", "x".repeat(300)),
    });
    expect(long.body.model).toBe("qwen/qwen3-32b");

    const fb = await t.json<{
      accepted: number;
      deduplicated: number;
      records: Array<{ deployment_name: string }>;
    }>("/v1/feedback", {
      body: {
        events: [
          {
            inference_id: routed.body.inference_id,
            idempotency_key: "fb-1",
            score: 1,
          },
          {
            inference_id: routed.body.inference_id,
            idempotency_key: "fb-1",
            score: 1,
          },
          {
            deployment_name: "support-router",
            idempotency_key: "fb-2",
            score: 0.5,
          },
          { deployment_name: "support-router", idempotency_key: "fb-3" },
        ],
      },
    });
    expect(fb.status).toBe(200);
    expect(fb.body.accepted).toBe(3);
    expect(fb.body.deduplicated).toBe(1);
    expect(fb.body.records[0]?.deployment_name).toBe("support-router");

    const again = await t.json<{ accepted: number; deduplicated: number }>(
      "/v1/feedback",
      {
        body: {
          events: [
            {
              deployment_name: "support-router",
              idempotency_key: "fb-2",
              score: 0,
            },
          ],
        },
      },
    );
    expect(again.body).toMatchObject({ accepted: 0, deduplicated: 1 });

    const status = await t.json("/v1/deployments/support-router");
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      feedback_count: 3,
      average_score: 0.75,
    });

    t.clock.advanceSeconds(1);
    const v2 = await seedArtifact(t, {
      name: "support-router",
      recipe: "router",
      format: "router_bundle",
      manifest: ROUTER_MANIFEST,
    });
    const redeployed = await t.json("/v1/deployments", {
      body: {
        artifact: v2.id,
        name: "support-router",
        fallback: "qwen/qwen3-32b",
      },
    });
    expect(redeployed.body).toMatchObject({
      active_artifact_id: v2.id,
      previous_artifact_id: v1.id,
    });

    const rolledBack = await t.json("/v1/deployments/support-router/rollback", {
      method: "POST",
    });
    expect(rolledBack.status).toBe(200);
    expect(rolledBack.body).toMatchObject({
      active_artifact_id: v1.id,
      previous_artifact_id: v2.id,
      fallback_model: "qwen/qwen3-32b",
    });
    expect(
      cloud.deployments.get(`${WORKSPACE_A}:support-router`)?.artifact_id,
    ).toBe(v1.id);

    const listed = await t.json<{
      data: unknown[];
      next_cursor: string | null;
    }>("/v1/deployments?limit=10");
    expect(listed.body.data).toHaveLength(1);
    expect(listed.body.next_cursor).toBeNull();
  });

  it("keys the Cloud promote by the caller's Idempotency-Key and replays deploys", async () => {
    const a = await seedArtifact(t, {
      name: "keyed",
      recipe: "router",
      format: "router_bundle",
      manifest: ROUTER_MANIFEST,
    });
    t.clock.advanceSeconds(1);
    const b = await seedArtifact(t, {
      name: "keyed",
      recipe: "router",
      format: "router_bundle",
      manifest: ROUTER_MANIFEST,
    });
    const keyed = (path: string, key: string, body?: unknown) =>
      t.json(path, {
        method: "POST",
        ...(body === undefined ? {} : { body }),
        headers: { "Idempotency-Key": key },
      });

    expect(
      (await keyed("/v1/deployments", "deploy-a", { artifact: a.id })).status,
    ).toBe(200);
    expect(
      (await keyed("/v1/deployments", "deploy-b", { artifact: b.id })).status,
    ).toBe(200);
    const back = await keyed("/v1/deployments/keyed/rollback", "rollback-1");
    expect(back.body).toMatchObject({ active_artifact_id: a.id });
    const retried = await keyed("/v1/deployments/keyed/rollback", "rollback-1");
    expect(retried.headers.get("Idempotent-Replayed")).toBe("true");
    expect(retried.body).toMatchObject({ active_artifact_id: a.id });

    const keys = cloud
      .callsTo("/api/internal/v1/deployments/promote")
      .map((c) => c.idempotency_key);
    expect(keys).toEqual([
      `deploy-promote:${WORKSPACE_A}:keyed:deploy-a`,
      `deploy-promote:${WORKSPACE_A}:keyed:deploy-b`,
      `deploy-promote:${WORKSPACE_A}:keyed:rollback-1`,
    ]);
  });

  it("rejects unknown inference ids, unknown deployments and mismatches", async () => {
    await seedArtifact(t, {
      name: "r1",
      recipe: "router",
      format: "router_bundle",
    });
    await seedArtifact(t, {
      name: "r2",
      recipe: "router",
      format: "router_bundle",
    });
    await t.json("/v1/deployments", { body: { artifact: "r1@latest" } });
    await t.json("/v1/deployments", { body: { artifact: "r2@latest" } });
    const routed = await t.json<{ inference_id: string }>("/v1/route", {
      body: routeBody("r1"),
    });

    const unknown = await t.json<{ code: string; detail: string }>(
      "/v1/feedback",
      {
        body: {
          events: [
            { inference_id: "inf_nope", idempotency_key: "k1", score: 1 },
          ],
        },
      },
    );
    expect(unknown.status).toBe(422);
    expect(unknown.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(unknown.body.code).toBe("unknown_inference_id");
    expect(unknown.body.detail).toContain("inf_nope");

    const missingDep = await t.json<{ code: string }>("/v1/feedback", {
      body: { events: [{ deployment_name: "ghost", idempotency_key: "k2" }] },
    });
    expect(missingDep.body.code).toBe("unknown_deployment");

    const mismatch = await t.json<{ code: string }>("/v1/feedback", {
      body: {
        events: [
          {
            inference_id: routed.body.inference_id,
            deployment_name: "r2",
            idempotency_key: "k3",
          },
        ],
      },
    });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.code).toBe("deployment_mismatch");
  });

  it("counts feedback past 500 events with SQL-style aggregates", async () => {
    await seedArtifact(t, {
      name: "big",
      recipe: "router",
      format: "router_bundle",
    });
    await t.json("/v1/deployments", { body: { artifact: "big@latest" } });
    const events = Array.from({ length: 520 }, (_, i) => ({
      deployment_name: "big",
      idempotency_key: `e-${i}`,
      score: i % 2 === 0 ? 1 : 0,
    }));
    const res = await t.json<{ accepted: number }>("/v1/feedback", {
      body: { events },
    });
    expect(res.body.accepted).toBe(520);

    const status = await t.json("/v1/deployments/big");
    expect(status.body).toMatchObject({
      feedback_count: 520,
      average_score: 0.5,
    });
  });

  it("enforces artifact kinds and deployability", async () => {
    await seedArtifact(t, {
      name: "sft-model",
      recipe: "sft",
      format: "peft_lora",
    });
    await seedArtifact(t, {
      name: "ref-model",
      recipe: "sft",
      format: "reference",
    });
    await seedArtifact(t, {
      name: "encoder",
      recipe: "embedding",
      format: "encoder_safetensors",
    });

    const ref = await t.json<{ code: string }>("/v1/deployments", {
      body: { artifact: "ref-model@latest" },
    });
    expect(ref.status).toBe(409);
    expect(ref.body.code).toBe("artifact_not_deployable");

    const missing = await t.json<{ code: string }>("/v1/deployments", {
      body: { artifact: "ghost@latest" },
    });
    expect(missing.status).toBe(404);

    expect(
      (
        await t.json("/v1/deployments", {
          body: { artifact: "sft-model@latest" },
        })
      ).status,
    ).toBe(200);
    const notRouter = await t.json<{ code: string }>("/v1/route", {
      body: routeBody("sft-model"),
    });
    expect(notRouter.status).toBe(409);
    expect(notRouter.body.code).toBe("not_a_router");

    const notEncoder = await t.json<{ code: string }>("/v1/embeddings", {
      body: { model: "sft-model", input: "hello" },
    });
    expect(notEncoder.status).toBe(409);
    expect(notEncoder.body.code).toBe("not_an_embedding_model");

    expect(
      (
        await t.json("/v1/deployments", {
          body: { artifact: "encoder@latest" },
        })
      ).status,
    ).toBe(200);
    const emb = await t.json<{
      model: string;
      data: Array<{ index: number; embedding: number[] }>;
    }>("/v1/embeddings", {
      body: { model: "encoder", input: ["hello", "world"] },
    });
    expect(emb.status).toBe(200);
    expect(emb.body.model).toBe("encoder");
    expect(emb.body.data.map((d) => d.index)).toEqual([0, 1]);
    expect(emb.body.data[0]?.embedding).toHaveLength(8);

    const single = await t.json<{ data: unknown[] }>("/v1/embeddings", {
      body: { model: "encoder", input: "one" },
    });
    expect(single.body.data).toHaveLength(1);

    const noDep = await t.json("/v1/embeddings", {
      body: { model: "nope", input: "x" },
    });
    expect(noDep.status).toBe(404);
    expect(
      (await t.json("/v1/route", { body: routeBody("nope") })).status,
    ).toBe(404);

    const noPrev = await t.json<{ code: string }>(
      "/v1/deployments/encoder/rollback",
      {
        method: "POST",
      },
    );
    expect(noPrev.status).toBe(409);
    expect(noPrev.body.code).toBe("no_previous_artifact");
    expect(
      (await t.json("/v1/deployments/nope/rollback", { method: "POST" }))
        .status,
    ).toBe(404);
    expect((await t.json("/v1/deployments/nope")).status).toBe(404);
  });

  it("surfaces Cloud failures as problem+json without recording the deployment", async () => {
    await seedArtifact(t, {
      name: "r",
      recipe: "router",
      format: "router_bundle",
    });
    cloud.failNext(1, 500, "/api/internal/v1/deployments/promote");
    const failed = await t.json<{ code: string }>("/v1/deployments", {
      body: { artifact: "r@latest" },
    });
    expect(failed.status).toBe(502);
    expect(failed.body.code).toBe("cloud_upstream_error");
    expect((await t.json("/v1/deployments/r")).status).toBe(404);
  });

  it("serializes concurrent deploys of one name consistently with Cloud", async () => {
    const artifacts = [];
    for (let i = 0; i < 5; i += 1) {
      t.clock.advanceSeconds(1);
      artifacts.push(
        await seedArtifact(t, {
          name: "race",
          recipe: "router",
          format: "router_bundle",
        }),
      );
    }
    cloud.setLatency(5);
    const results = await Promise.all(
      artifacts.map((a) =>
        t.json("/v1/deployments", { body: { artifact: a.id, name: "race" } }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);

    const status = await t.json<{
      deployment: { active_artifact_id: string; previous_artifact_id: string };
    }>("/v1/deployments/race");
    expect(cloud.deployments.get(`${WORKSPACE_A}:race`)?.artifact_id).toBe(
      status.body.deployment.active_artifact_id,
    );
    expect(status.body.deployment.previous_artifact_id).not.toBe(
      status.body.deployment.active_artifact_id,
    );
  });

  it("isolates workspaces on every serving route", async () => {
    await seedArtifact(t, {
      name: "mine",
      recipe: "router",
      format: "router_bundle",
    });
    await seedArtifact(t, {
      name: "enc",
      recipe: "embedding",
      format: "encoder_safetensors",
    });
    await t.json("/v1/deployments", { body: { artifact: "mine@latest" } });
    await t.json("/v1/deployments", { body: { artifact: "enc@latest" } });
    const routed = await t.json<{ inference_id: string }>("/v1/route", {
      body: routeBody("mine"),
    });

    const other = await t.mintKey(WORKSPACE_B, ["admin"]);
    const as = { token: other };

    expect(
      (
        await t.json("/v1/deployments", {
          ...as,
          body: { artifact: "mine@latest" },
        })
      ).status,
    ).toBe(404);
    expect((await t.json("/v1/deployments/mine", as)).status).toBe(404);
    expect(
      (await t.json("/v1/deployments/mine/rollback", { ...as, method: "POST" }))
        .status,
    ).toBe(404);
    expect(
      (await t.json("/v1/route", { ...as, body: routeBody("mine") })).status,
    ).toBe(404);
    expect(
      (
        await t.json("/v1/embeddings", {
          ...as,
          body: { model: "enc", input: "x" },
        })
      ).status,
    ).toBe(404);
    const fb = await t.json<{ code: string }>("/v1/feedback", {
      ...as,
      body: {
        events: [
          { inference_id: routed.body.inference_id, idempotency_key: "x" },
        ],
      },
    });
    expect(fb.status).toBe(422);
    expect(fb.body.code).toBe("unknown_inference_id");
    const list = await t.json<{ data: unknown[] }>("/v1/deployments", as);
    expect(list.body.data).toEqual([]);
  });

  it("enforces scopes on serving routes", async () => {
    const reader = await t.mintKey(WORKSPACE_A, ["artifacts:read"]);
    const as = { token: reader };
    expect(
      (
        await t.json("/v1/deployments", {
          ...as,
          body: { artifact: "a@latest" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await t.json("/v1/deployments/a/rollback", { ...as, method: "POST" }))
        .status,
    ).toBe(403);
    expect(
      (
        await t.json("/v1/feedback", {
          ...as,
          body: { events: [{ idempotency_key: "k" }] },
        })
      ).status,
    ).toBe(403);
    const writer = await t.mintKey(WORKSPACE_A, ["feedback:write"]);
    expect((await t.json("/v1/deployments", { token: writer })).status).toBe(
      403,
    );
  });
});

describe("serving (DEPLOY_MODE=disabled)", () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await makeTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  it("returns 501 deploy_unavailable for deploy, rollback, route and embeddings", async () => {
    await seedArtifact(t, {
      name: "r",
      recipe: "router",
      format: "router_bundle",
    });
    for (const [path, body] of [
      ["/v1/deployments", { artifact: "r@latest" }],
      ["/v1/deployments/r/rollback", undefined],
      ["/v1/route", routeBody("r")],
      ["/v1/embeddings", { model: "r", input: "x" }],
    ] as const) {
      const res = await t.json<{ code: string; detail: string }>(path, {
        method: "POST",
        ...(body ? { body } : {}),
      });
      expect(res.status, path).toBe(501);
      expect(res.headers.get("content-type")).toContain(
        "application/problem+json",
      );
      expect(res.body.code).toBe("deploy_unavailable");
      expect(res.body.detail).toContain("vLLM");
    }
  });

  it("still lists and reads deployments and accepts feedback for known deployments", async () => {
    const list = await t.json<{ data: unknown[]; next_cursor: null }>(
      "/v1/deployments",
    );
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ data: [], next_cursor: null });
    expect((await t.json("/v1/deployments/none")).status).toBe(404);

    const fb = await t.json<{ code: string }>("/v1/feedback", {
      body: { events: [{ deployment_name: "none", idempotency_key: "k" }] },
    });
    expect(fb.status).toBe(422);
    const plain = await t.json<{ accepted: number }>("/v1/feedback", {
      body: { events: [{ session_id: "s1", idempotency_key: "k", score: 1 }] },
    });
    expect(plain.body.accepted).toBe(1);
  });
});
