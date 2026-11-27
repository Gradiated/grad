import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
import { cloudBillingDeps, startTestCloud } from "./fixtures/cloud.js";
import {
  createEval,
  qaRecords,
  seedArtifact,
  seedDataset,
  startEvalWorker,
  type TestEvalWorker,
} from "./fixtures/evals.js";
import type { FakeCloudApi } from "./fixtures/fake-cloud-api.js";
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
    cloud.failNext(1, 503, "/api/internal/v1/training/eval-versions");
    await expect(
      resolver.servingModel(WORKSPACE_A, "a@1"),
    ).rejects.toMatchObject({ status: 503, code: "inference_unavailable" });
    const dead = createEvalModelResolver({
      internalApiBaseUrl: "http://127.0.0.1:9",
      serviceToken: "t",
      timeoutMs: 500,
    });
    await expect(dead.servingModel(WORKSPACE_A, "a@1")).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
