import { afterEach, describe, expect, it } from "vitest";

import { makeTestApp, WORKSPACE_A, type TestApp } from "./fixtures/app.js";
import {
  makeEvalHarness,
  qaRecords,
  seedDataset,
  type EvalHarness,
} from "./fixtures/evals.js";
import { judgeResponder } from "./fixtures/fake-openai.js";
import { FakeWorker } from "./fixtures/worker.js";

const JUDGE = {
  name: "resolved",
  kind: "judge",
  model: "qwen/qwen3-32b",
  prompt: "Did the assistant solve the user's issue?",
};

const routerRequest = (recipe: Record<string, unknown> = {}) => ({
  dataset: "prompts",
  name: "support-router",
  recipe: {
    kind: "router",
    model: "test/tiny-qwen3",
    models: ["qwen/qwen3-8b", "qwen/qwen3-1.7b"],
    rubric: [JUDGE],
    ...recipe,
  },
});

describe("router rubric: a labeling eval replays prompts and judges them", () => {
  let h: EvalHarness | undefined;
  let plain: TestApp | undefined;

  afterEach(async () => {
    await h?.close();
    await plain?.close();
    h = undefined;
    plain = undefined;
  });

  const harness = async () => {
    h = await makeEvalHarness();
    await seedDataset(h.t, "prompts", qaRecords(6));
    // The cheap model's answers are judged worse than the strong model's.
    h.fake.setModel(
      "qwen/qwen3-32b",
      judgeResponder((req) =>
        String(req.messages.at(-1)?.content).includes("cheap") ? 0.2 : 0.9,
      ),
    );
    h.fake.setModel("qwen/qwen3-1.7b", () => ({ content: "cheap answer" }));

    return h;
  };

  it("plans the labeling eval and validates the rubric", async () => {
    const { t } = await harness();
    const plan = await t.json<Record<string, any>>("/v1/runs/plan", {
      body: routerRequest(),
    });
    expect(plan.status).toBe(200);
    expect(plan.body.labeling).toMatchObject({
      estimated_model_calls: 12,
      estimated_judge_calls: 12,
    });
    expect(plan.body.labeling.estimated_cost_usd).toBeGreaterThan(0);
    expect(plan.body.estimated_cost_usd).toBeGreaterThanOrEqual(
      plan.body.labeling.estimated_cost_usd,
    );
    expect(plan.body.warnings.join(" ")).toMatch(/labeling eval replays/);
    expect(plan.body.resolved_config).toMatchObject({
      label_eval_id: null,
      recipe_params: {
        rubric: "rubric",
        models: ["qwen/qwen3-8b", "qwen/qwen3-1.7b"],
      },
    });

    const noModels = await t.json("/v1/runs/plan", {
      body: routerRequest({ models: undefined }),
    });
    expect(noModels.body).toMatchObject({ code: "router_candidates_required" });
    const code = await t.json("/v1/runs/plan", {
      body: routerRequest({
        rubric: [{ name: "fn", kind: "code", runtime: "local" }],
      }),
    });
    expect(code.body).toMatchObject({ code: "scorer_sandbox_unavailable" });
  });

  it("needs an inference endpoint", async () => {
    plain = await makeTestApp();
    await seedDataset(plain, "prompts", qaRecords(2));
    const res = await plain.json("/v1/runs/plan", { body: routerRequest() });
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({ code: "inference_unavailable" });
  });

  it("waits for the labels, then trains on the judged answers", async () => {
    const { t } = await harness();
    const worker = new FakeWorker(t);
    const created = await t.json<Record<string, any>>("/v1/runs", {
      body: routerRequest(),
    });
    expect(created.status).toBe(202);
    const evalId = created.body.resolved_config.label_eval_id as string;
    const labels = await t.services.evals.get(WORKSPACE_A, evalId);
    expect(labels).toMatchObject({
      name: "support-router-labels",
      models: ["qwen/qwen3-8b", "qwen/qwen3-1.7b"],
      status: "queued",
    });
    expect(await worker.claim()).toBeNull();

    await t.services.evals.drain();
    const job = await worker.claim();
    expect(job?.id).toBe(created.body.id);
    expect(job?.dataset?.record_count).toBe(12);
    const records = await worker.downloadDataset(job!);
    expect(records).toHaveLength(12);
    const cheap = records.find(
      (r) => (r.metadata as { model: string }).model === "qwen/qwen3-1.7b",
    ) as Record<string, any>;
    expect(cheap.scores).toEqual({ rubric: 0.2 });
    expect(cheap.messages.at(-1)).toEqual({
      role: "assistant",
      content: "cheap answer",
    });
    expect(cheap.metrics.cost_usd).toBeGreaterThan(0);
    const strong = records.find(
      (r) =>
        r.group_id === cheap.group_id &&
        (r.metadata as { model: string }).model === "qwen/qwen3-8b",
    ) as Record<string, any>;
    expect(strong.scores).toEqual({ rubric: 0.9 });
  });

  it("cancels the run when labeling fails, stops at the cap or is cancelled", async () => {
    const { t, fake } = await harness();
    const getRun = async (id: string) =>
      (await t.json<Record<string, any>>(`/v1/runs/${id}`)).body;

    fake.failNext(100, 400);
    const failed = await t.json<{ id: string }>("/v1/runs", {
      body: routerRequest(),
    });
    await t.services.evals.drain();
    const failedRun = await getRun(failed.body.id);
    expect(failedRun.status).toBe("cancelled");
    expect(failedRun.error).toMatch(/labeling eval .* ended failed/);
    fake.failNext(0);

    fake.setModel("qwen/qwen3-8b", () => ({
      content: "answer",
      usage: { prompt_tokens: 1_000_000, completion_tokens: 0 },
    }));
    const capped = await t.json<{ id: string }>("/v1/runs", {
      body: { ...routerRequest(), max_cost_usd: 1 },
    });
    expect(capped.status).toBe(202);
    await t.services.evals.drain();
    expect((await getRun(capped.body.id)).error).toMatch(
      /stopped at max_cost_usd/,
    );

    const cancelled = await t.json<Record<string, any>>("/v1/runs", {
      body: routerRequest(),
    });
    await t.json(`/v1/runs/${cancelled.body.id}/cancel`, { body: {} });
    const labels = await t.services.evals.get(
      WORKSPACE_A,
      cancelled.body.resolved_config.label_eval_id,
    );
    expect(labels.status).toBe("cancelled");
  });
});
