import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createModelCatalog } from "../src/catalog.js";
import { PlanEvalRequestSchema } from "../src/contracts.js";
import {
  createEvalModelResolver,
  createGatewayInference,
} from "../src/cloud/gateway.js";
import { ApiError } from "../src/errors.js";
import {
  makeTestApp,
  TEST_JUDGE,
  WORKSPACE_A,
  type TestApp,
} from "./fixtures/app.js";
import { ManualClock } from "./fixtures/clock.js";
import {
  cloudBillingDeps,
  startTestCloud,
  TEST_PRICES,
} from "./fixtures/cloud.js";
import {
  createEval,
  qaRecords,
  seedArtifact,
  seedDataset,
  startEvalWorker,
  type TestEvalWorker,
} from "./fixtures/evals.js";
import type { FakeCloudApi } from "./fixtures/fake-cloud-api.js";
import { sftRecords } from "./fixtures/worker.js";
import {
  judgeResponder,
  startFakeOpenAI,
  type FakeOpenAI,
} from "./fixtures/fake-openai.js";

describe("evals on Gradiated Cloud: the gateway's eval lane", () => {
  let upstream: FakeOpenAI;
  let cloud: FakeCloudApi;
  let t: TestApp | undefined;
  let worker: TestEvalWorker | undefined;

  beforeEach(async () => {
    upstream = await startFakeOpenAI();
    cloud = await startTestCloud({ gatewayUpstream: upstream.baseUrl });
  });
  afterEach(async () => {
    await worker?.close();
    await t?.close();
    await cloud.close();
    await upstream.close();
    worker = undefined;
    t = undefined;
  });

  it("calls the gateway with its service credential, the workspace, the eval lane and the eval id", async () => {
    const gateway = createGatewayInference({
      baseUrl: cloud.gatewayUrl,
      token: cloud.gatewayToken,
    });
    const reply = await gateway.models.complete({
      model: "qwen/qwen3-8b",
      workspace: WORKSPACE_A,
      evalId: "ev_1",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0,
      max_tokens: 8,
    });
    expect(reply.text).toBe("answer: hi");
    expect(cloud.gatewayCalls).toEqual([
      {
        model: "qwen/qwen3-8b",
        workspace: WORKSPACE_A,
        source: "eval",
        eval_id: "ev_1",
      },
    ]);

    const wrong = createGatewayInference({
      baseUrl: cloud.gatewayUrl,
      token: "nope",
    });
    await expect(
      wrong.models.complete({
        model: "m",
        workspace: WORKSPACE_A,
        messages: [],
        temperature: 0,
        max_tokens: 1,
      }),
    ).rejects.toMatchObject({ status: 502, code: "inference_error" });
  });

  it("publishes artifact targets as eval-only Versions, runs the eval there, and bills nothing itself", async () => {
    const clock = new ManualClock();
    t = await makeTestApp({
      clock,
      ...(await cloudBillingDeps(cloud, clock, { gatewayBillsEvals: true })),
      inferenceConfigured: true,
      evalModels: createEvalModelResolver({
        internalApiBaseUrl: cloud.url,
        serviceToken: cloud.serviceToken,
      }),
    });
    upstream.setModel(TEST_JUDGE, judgeResponder(0.9));
    await seedDataset(t, "qa", qaRecords(2));
    const artifact = await seedArtifact(t, "support-sft");
    const created = await createEval(
      t.services.evals,
      WORKSPACE_A,
      PlanEvalRequestSchema.parse({
        dataset: "qa",
        models: [artifact.id, "test/tiny-qwen3"],
        rubric: [{ name: "quality", kind: "judge", model: TEST_JUDGE }],
      }),
    );
    const served = `acme/support-sft/${artifact.version}`;
    expect(cloud.evalVersions).toEqual([
      { workspace_id: WORKSPACE_A, artifact_id: artifact.id, model: served },
    ]);

    worker = startEvalWorker(
      t,
      createGatewayInference({
        baseUrl: cloud.gatewayUrl,
        token: cloud.gatewayToken,
      }),
    );
    await worker.drain();
    expect((await t.services.evals.get(WORKSPACE_A, created.id)).status).toBe(
      "completed",
    );
    expect(new Set(cloud.gatewayCalls.map((c) => c.model))).toEqual(
      new Set([served, "test/tiny-qwen3", TEST_JUDGE]),
    );
    expect(
      cloud.gatewayCalls.every(
        (c) =>
          c.source === "eval" &&
          c.workspace === WORKSPACE_A &&
          c.eval_id === created.id,
      ),
    ).toBe(true);

    const usage = await t.deps.store.usage.listByRef(created.id);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => u.billed_by === "gateway")).toBe(true);
    expect(await t.services.usage.exportPending()).toBe(0);
  });

  it("calls the gateway with a catalog model's canonical-case id; grad's ids, prices and SKUs stay lowercase", async () => {
    // The gateway matches model ids exactly (`Qwen/Qwen3-8B`); grad's catalog
    // and the price list use `qwen/qwen3-8b`.
    cloud.setPrices("pv_case", {
      ...TEST_PRICES,
      "train:qwen/qwen3-8b": 400_000_000,
      "inference:qwen/qwen3-8b": 400_000_000,
    });
    const clock = new ManualClock();
    t = await makeTestApp({
      clock,
      ...(await cloudBillingDeps(cloud, clock, { gatewayBillsEvals: true })),
      inferenceConfigured: true,
      evalModels: createEvalModelResolver({
        internalApiBaseUrl: cloud.url,
        serviceToken: cloud.serviceToken,
      }),
    });
    upstream.setModel(TEST_JUDGE, judgeResponder(0.9));
    await seedDataset(t, "qa", qaRecords(2));
    const created = await createEval(
      t.services.evals,
      WORKSPACE_A,
      PlanEvalRequestSchema.parse({
        dataset: "qa",
        // The id `grad models list` shows.
        models: ["qwen/qwen3-8b"],
        rubric: [{ name: "quality", kind: "judge", model: TEST_JUDGE }],
      }),
    );

    worker = startEvalWorker(
      t,
      createGatewayInference({
        baseUrl: cloud.gatewayUrl,
        token: cloud.gatewayToken,
      }),
    );
    await worker.drain();
    const done = await t.services.evals.get(WORKSPACE_A, created.id);
    expect(done.status).toBe("completed");
    expect(done.summary.map((m) => m.model)).toEqual(["qwen/qwen3-8b"]);
    expect(new Set(cloud.gatewayCalls.map((c) => c.model))).toEqual(
      new Set(["Qwen/Qwen3-8B", TEST_JUDGE]),
    );
  });

  it("serving ids: a model's Hugging Face repo, a configured serving_id, else the id as configured", () => {
    const catalog = createModelCatalog(
      JSON.stringify([
        {
          id: "Acme/Big-Model",
          family: "llm",
          adapters: ["lora"],
          price_per_million_tokens_usd: 1,
          calibrated_lrs: { sft: 1e-3 },
        },
        {
          id: "acme/other",
          serving_id: "ACME/Other-v2",
          family: "llm",
          adapters: ["lora"],
          price_per_million_tokens_usd: 1,
          calibrated_lrs: { sft: 1e-3 },
        },
      ]),
      JSON.stringify([
        { id: "Meta/Llama-Judge", price_per_million_tokens_usd: 2 },
      ]),
    );
    expect(catalog.servingId("qwen/qwen3-0.6b")).toBe("Qwen/Qwen3-0.6B");
    expect(catalog.servingId(" QWEN/qwen3-0.6B ")).toBe("Qwen/Qwen3-0.6B");
    expect(catalog.servingId("acme/big-model")).toBe("Acme/Big-Model");
    expect(catalog.servingId("acme/other")).toBe("ACME/Other-v2");
    expect(catalog.servingId("meta/llama-judge")).toBe("Meta/Llama-Judge");
    expect(catalog.servingId("nobody/knows")).toBeUndefined();
    // Lookups and prices stay on the lowercase id.
    expect(catalog.find("Acme/Big-Model")?.id).toBe("acme/big-model");
    expect(catalog.judgePriceFor("META/llama-judge")).toBe(2);
  });

  it("refuses recipe.evals on Cloud at plan and create: checkpoints can't be served there", async () => {
    const clock = new ManualClock();
    t = await makeTestApp({
      clock,
      ...(await cloudBillingDeps(cloud, clock, { gatewayBillsEvals: true })),
      inferenceConfigured: true,
      evalModels: createEvalModelResolver({
        internalApiBaseUrl: cloud.url,
        serviceToken: cloud.serviceToken,
      }),
    });
    await seedDataset(t, "support", sftRecords(20) as never);
    await seedDataset(t, "holdout", qaRecords(3));
    const body = {
      dataset: "support",
      name: "support-sft",
      recipe: {
        kind: "sft",
        model: "test/tiny-qwen3",
        evals: [
          {
            dataset: "holdout",
            rubric: [{ name: "a", kind: "regex", pattern: "answer" }],
          },
        ],
      },
    };
    for (const path of ["/v1/runs/plan", "/v1/runs"]) {
      const res = await t.request(path, { method: "POST", body });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe(
        "checkpoint_evals_unsupported_on_cloud",
      );
    }
    expect(cloud.evalVersions).toEqual([]);
  });

  it("maps the product's refusals to typed errors", async () => {
    const resolver = createEvalModelResolver({
      internalApiBaseUrl: cloud.url,
      serviceToken: cloud.serviceToken,
    });
    cloud.respondOnce("/api/internal/v1/training/eval-versions", 409, {
      detail: "checkpoints are not servable",
    });
    await expect(
      resolver.servingModel(WORKSPACE_A, "a@1"),
    ).rejects.toMatchObject({ status: 422, code: "artifact_not_servable" });
    // An unknown artifact is not servable (never retried as an outage).
    cloud.respondOnce("/api/internal/v1/training/eval-versions", 404, {
      detail: "unknown artifact",
    });
    await expect(
      resolver.servingModel(WORKSPACE_A, "a@1"),
    ).rejects.toMatchObject({ status: 422, code: "artifact_not_servable" });
    // A 5xx is retried (the call is idempotent per workspace and artifact):
    // two failures, then the answer.
    const quick = createEvalModelResolver({
      internalApiBaseUrl: cloud.url,
      serviceToken: cloud.serviceToken,
      retryDelayMs: 1,
    });
    cloud.failNext(2, 503, "/api/internal/v1/training/eval-versions");
    expect(await quick.servingModel(WORKSPACE_A, "a@1")).toMatch(/\/a\//);
    cloud.failNext(3, 503, "/api/internal/v1/training/eval-versions");
    await expect(quick.servingModel(WORKSPACE_A, "a@1")).rejects.toMatchObject({
      status: 503,
      code: "inference_unavailable",
    });
    const dead = createEvalModelResolver({
      internalApiBaseUrl: "http://127.0.0.1:9",
      serviceToken: "t",
      timeoutMs: 500,
      retryDelayMs: 1,
    });
    await expect(dead.servingModel(WORKSPACE_A, "a@1")).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
