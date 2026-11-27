import { afterEach, describe, expect, it } from "vitest";

import {
  PlanEvalRequestSchema,
  type PlanEvalRequest,
} from "../src/contracts.js";
import { makeTestApp, WORKSPACE_A } from "./fixtures/app.js";
import {
  goldResponder,
  makeEvalHarness,
  qaRecords,
  seedArtifact,
  seedDataset,
  type EvalHarness,
} from "./fixtures/evals.js";
import { judgeResponder } from "./fixtures/fake-openai.js";

const request = (raw: Record<string, unknown>): PlanEvalRequest =>
  PlanEvalRequestSchema.parse(raw);

const exactRubric = [
  { name: "exact", kind: "validator", validator: "exact_match" },
];

describe("eval service", () => {
  let h: EvalHarness | undefined;

  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it("fails with inference_unavailable when no inference endpoint is configured", async () => {
    const t = await makeTestApp();
    try {
      await seedDataset(t, "qa", qaRecords(2));
      await expect(
        t.services.evals.plan(
          WORKSPACE_A,
          request({ models: ["qwen/qwen3-8b"], dataset: "qa" }),
        ),
      ).rejects.toMatchObject({ status: 501, code: "inference_unavailable" });
      await expect(
        t.services.evals.create(
          WORKSPACE_A,
          request({ models: ["qwen/qwen3-8b"], dataset: "qa" }),
        ),
      ).rejects.toMatchObject({ status: 501, code: "inference_unavailable" });
    } finally {
      await t.close();
    }
  });

  it("rejects unknown models and unservable artifacts", async () => {
    h = await makeEvalHarness();
    const { t } = h;
    await seedDataset(t, "qa", qaRecords(2));
    await seedArtifact(t, "ref-art", { format: "reference" });
    const evals = t.services.evals;

    await expect(
      evals.plan(
        WORKSPACE_A,
        request({ models: ["meta/llama-405b"], dataset: "qa" }),
      ),
    ).rejects.toMatchObject({ status: 422, code: "unknown_model" });
    await expect(
      evals.plan(
        WORKSPACE_A,
        request({ models: ["nope@latest"], dataset: "qa" }),
      ),
    ).rejects.toMatchObject({ code: "unknown_model" });
    await expect(
      evals.plan(
        WORKSPACE_A,
        request({ models: ["ref-art@latest"], dataset: "qa" }),
      ),
    ).rejects.toMatchObject({ status: 422, code: "artifact_not_servable" });
    await expect(
      evals.plan(
        WORKSPACE_A,
        request({ models: ["qwen/qwen3-8b"], dataset: "missing" }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      evals.plan(
        WORKSPACE_A,
        request({
          models: ["qwen/qwen3-8b"],
          dataset: "qa",
          rubric: [
            { name: "a", kind: "validator", validator: "json" },
            { name: "a", kind: "validator", validator: "json" },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "duplicate_scorer" });
  });

  it("plans with estimates, warnings and a pinned dataset version", async () => {
    h = await makeEvalHarness();
    const { t } = h;
    await seedDataset(t, "qa", [
      ...qaRecords(4),
      { id: "noprompt", query: "x" },
    ]);
    await seedDataset(t, "qa", qaRecords(1));

    const plan = await t.services.evals.plan(
      WORKSPACE_A,
      request({
        models: ["qwen/qwen3-8b", "test/tiny-qwen3"],
        baseline: "qwen/qwen3-32b",
        dataset: "qa",
        dataset_version: 1,
        samples: 2,
        limit: 3,
        max_cost_usd: 0.0000001,
        rubric: [
          { name: "j", kind: "judge", model: "qwen/qwen3-32b" },
          { name: "fn", kind: "code" },
        ],
      }),
    );
    expect(plan.dataset_version).toBe(1);
    expect(plan.estimated_tasks).toBe(3);
    expect(plan.estimated_model_calls).toBe(12);
    expect(plan.estimated_judge_calls).toBe(12);
    expect(plan.estimated_cost_usd).toBeGreaterThan(0);
    expect(plan.judge_models).toEqual(["qwen/qwen3-32b"]);
    expect(plan.local_scorers).toEqual(["fn"]);
    expect(plan.pass_threshold).toBe(0.5);
    expect(plan.warnings.join("\n")).toMatch(/exceeds max_cost_usd/);
    expect(plan.warnings.join("\n")).toMatch(/baseline/);
    expect(plan.warnings.join("\n")).toMatch(/awaiting_scores/);

    const all = await t.services.evals.plan(
      WORKSPACE_A,
      request({ models: ["qwen/qwen3-8b"], dataset: "qa", dataset_version: 1 }),
    );
    expect(all.estimated_tasks).toBe(4);
    expect(all.pass_threshold).toBe(1);
    expect(all.warnings.join("\n")).toMatch(
      /1 record\(s\) have no usable prompt/,
    );

    await seedDataset(t, "empty", [{ id: "x", query: "q", positive: "p" }]);
    const empty = await t.services.evals.plan(
      WORKSPACE_A,
      request({ models: ["qwen/qwen3-8b"], dataset: "empty" }),
    );
    expect(empty.warnings.join("\n")).toMatch(/nothing would be evaluated/);
    await expect(
      t.services.evals.create(
        WORKSPACE_A,
        request({ models: ["qwen/qwen3-8b"], dataset: "empty" }),
      ),
    ).rejects.toMatchObject({ status: 422, code: "empty_eval" });
  });

  it("executes queued evals against real model outputs with a paired baseline diff", async () => {
    h = await makeEvalHarness();
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(6));
    const artifact = await seedArtifact(t, "tuned");
    fake.setModel(artifact.id, goldResponder);
    fake.setModel("qwen/qwen3-8b", () => ({ content: "wrong" }));

    const created = await t.services.evals.create(
      WORKSPACE_A,
      request({
        name: "gold-check",
        models: ["qwen/qwen3-8b", "tuned@latest"],
        baseline: "qwen/qwen3-8b",
        dataset: "qa",
        rubric: exactRubric,
      }),
    );
    expect(created.status).toBe("queued");
    expect(created.progress).toEqual({
      total_outputs: 12,
      generated: 0,
      pending_local_scores: 0,
    });
    await expect(
      t.services.evals.listResults(WORKSPACE_A, created.id, { limit: 10 }),
    ).rejects.toMatchObject({ status: 409, code: "eval_not_completed" });

    expect(await t.services.evals.drain()).toBe(1);
    const done = await t.services.evals.get(WORKSPACE_A, created.id);
    expect(done.status).toBe("completed");
    expect(done.progress.generated).toBe(12);
    const base = done.summary.find((s) => s.model === "qwen/qwen3-8b");
    const tuned = done.summary.find((s) => s.model === "tuned@latest");
    expect(base?.overall).toBe(0);
    expect(tuned?.overall).toBe(1);
    expect(tuned?.vs_baseline?.delta).toBe(1);
    expect(tuned?.tasks).toBe(6);
    expect(done.total_cost_usd).toBeGreaterThan(0);
    expect(fake.requests.some((r) => r.model === artifact.id)).toBe(true);

    const results = await t.services.evals.listResults(
      WORKSPACE_A,
      created.id,
      { limit: 5 },
    );
    expect(results.data).toHaveLength(5);
    expect(results.next_cursor).not.toBeNull();

    const failures = await t.services.evals.listFailures(
      WORKSPACE_A,
      created.id,
      {
        limit: 50,
        model: "qwen/qwen3-8b",
      },
    );
    expect(failures.data).toHaveLength(6);
    expect(failures.data.every((f) => !f.passed && f.record.messages)).toBe(
      true,
    );
    const mined = await t.services.datasets.push(
      WORKSPACE_A,
      "hard-cases",
      failures.data.map((f) => f.record),
    );
    expect(mined.record_count).toBe(6);

    const none = await t.services.evals.listFailures(WORKSPACE_A, created.id, {
      limit: 50,
      model: "tuned@latest",
    });
    expect(none.data).toHaveLength(0);
  });

  it("scores with a judge model and records the judge prompt", async () => {
    h = await makeEvalHarness();
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(3));
    fake.setModel("qwen/qwen3-32b", judgeResponder(0.8));

    const created = await t.services.evals.create(
      WORKSPACE_A,
      request({
        models: ["qwen/qwen3-8b"],
        dataset: "qa",
        samples: 2,
        rubric: [
          {
            name: "quality",
            kind: "judge",
            model: "qwen/qwen3-32b",
            prompt: "Be strict.",
          },
        ],
      }),
    );
    await t.services.evals.drain();
    const done = await t.services.evals.get(WORKSPACE_A, created.id);
    expect(done.status).toBe("completed");
    expect(done.summary[0]?.overall).toBe(0.8);
    expect(done.summary[0]?.pass_at_k).toEqual({ "pass@1": 1, "pass@2": 1 });
    const judgeCalls = fake.requests.filter(
      (r) => r.model === "qwen/qwen3-32b",
    );
    expect(judgeCalls).toHaveLength(6);
    expect(String(judgeCalls[0]?.messages[1]?.content)).toContain("Be strict.");
    expect(done.judge_models).toEqual(["qwen/qwen3-32b"]);
  });

  it("waits in awaiting_scores for local code scorers and aggregates once all are posted", async () => {
    h = await makeEvalHarness();
    const { t } = h;
    await seedDataset(t, "qa", qaRecords(3));
    const evals = t.services.evals;
    const created = await evals.create(
      WORKSPACE_A,
      request({
        models: ["qwen/qwen3-8b"],
        dataset: "qa",
        rubric: [
          { name: "nonempty", kind: "validator", validator: "non_empty" },
          { name: "fn", kind: "code", runtime: "local" },
        ],
      }),
    );
    await expect(
      evals.postScores(WORKSPACE_A, created.id, [
        { output_id: "x", scorer: "fn", score: 1 },
      ]),
    ).rejects.toMatchObject({ status: 409, code: "eval_not_awaiting_scores" });

    await evals.drain();
    const waiting = await evals.get(WORKSPACE_A, created.id);
    expect(waiting.status).toBe("awaiting_scores");
    expect(waiting.progress.pending_local_scores).toBe(3);

    await expect(
      evals.listOutputs(WORKSPACE_A, created.id, {
        limit: 2,
        missingScorer: "nope",
      }),
    ).rejects.toMatchObject({ status: 422, code: "unknown_scorer" });
    const page1 = await evals.listOutputs(WORKSPACE_A, created.id, {
      limit: 2,
      missingScorer: "fn",
    });
    expect(page1.data).toHaveLength(2);
    expect(page1.data[0]?.output).toBe("answer: question 0");
    expect(page1.data[0]?.input).toEqual([
      { role: "user", content: "question 0" },
    ]);
    expect(page1.data[0]?.expected_output).toBe("gold 0");
    expect(page1.data[0]?.scores).toEqual({ nonempty: 1 });
    const page2 = await evals.listOutputs(WORKSPACE_A, created.id, {
      limit: 2,
      missingScorer: "fn",
      cursor: page1.next_cursor ?? undefined,
    });
    expect(page2.data).toHaveLength(1);
    expect(page2.next_cursor).toBeNull();

    await expect(
      evals.postScores(WORKSPACE_A, created.id, [
        { output_id: page1.data[0]!.id, scorer: "nonempty", score: 0 },
      ]),
    ).rejects.toMatchObject({ status: 422, code: "unknown_scorer" });

    const partial = await evals.postScores(
      WORKSPACE_A,
      created.id,
      page1.data.map((o) => ({ output_id: o.id, scorer: "fn", score: 0 })),
    );
    expect(partial).toEqual({
      accepted: 2,
      status: "awaiting_scores",
      pending_local_scores: 1,
    });

    const final = await evals.postScores(WORKSPACE_A, created.id, [
      { output_id: page2.data[0]!.id, scorer: "fn", score: 1 },
      { output_id: "evout_unknown", scorer: "fn", score: 1 },
    ]);
    expect(final).toEqual({
      accepted: 1,
      status: "completed",
      pending_local_scores: 0,
    });

    const done = await evals.get(WORKSPACE_A, created.id);
    expect(done.summary[0]?.overall).toBeCloseTo((0.5 + 0.5 + 1) / 3, 3);
  });

  it("fails the eval with the inference error when every model call fails", async () => {
    h = await makeEvalHarness();
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(2));
    fake.setModel("qwen/qwen3-8b", () => ({ status: 500 }));
    const created = await t.services.evals.create(
      WORKSPACE_A,
      request({ models: ["qwen/qwen3-8b"], dataset: "qa" }),
    );
    await t.services.evals.drain();
    const failed = await t.services.evals.get(WORKSPACE_A, created.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/Every model call failed.*HTTP 500/);
  });

  it("keeps partial generation errors per output and counts them in the summary", async () => {
    h = await makeEvalHarness();
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(2));
    fake.setModel("qwen/qwen3-8b", (r) =>
      JSON.stringify(r.messages).includes("question 1")
        ? { status: 400 }
        : { content: "ok" },
    );
    const created = await t.services.evals.create(
      WORKSPACE_A,
      request({ models: ["qwen/qwen3-8b"], dataset: "qa" }),
    );
    await t.services.evals.drain();
    const done = await t.services.evals.get(WORKSPACE_A, created.id);
    expect(done.status).toBe("completed");
    expect(done.summary[0]?.errors).toBe(1);
    expect(done.summary[0]?.overall).toBe(0.5);
  });

  it("recovers an expired executor lease and resumes without regenerating outputs", async () => {
    h = await makeEvalHarness();
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(4));
    const created = await t.services.evals.create(
      WORKSPACE_A,
      request({ models: ["qwen/qwen3-8b"], dataset: "qa" }),
    );
    const store = t.deps.store;
    const crashed = await store.evals.claimNext({
      workerId: "dead-executor",
      leaseSeconds: 30,
      now: t.clock.now(),
    });
    expect(crashed?.id).toBe(created.id);
    await store.evals.upsertOutput({
      id: "evout_pre",
      eval_id: created.id,
      task_index: 0,
      task_id: "q0",
      model: "qwen/qwen3-8b",
      sample_index: 0,
      input: [{ role: "user", content: "question 0" }],
      output: "pre-generated",
      expected_output: "gold 0",
      scores: { non_empty: 1 },
      error: null,
      prompt_tokens: 1,
      completion_tokens: 1,
      cost_usd: 0,
      created_at: t.clock.now().toISOString(),
    });

    expect(await t.services.evals.drain()).toBe(0);
    t.clock.advanceSeconds(60);
    expect(await t.services.evals.drain()).toBe(1);

    const done = await t.services.evals.get(WORKSPACE_A, created.id);
    expect(done.status).toBe("completed");
    expect(done.progress.generated).toBe(4);
    expect(
      fake.requests.filter((r) => r.model === "qwen/qwen3-8b"),
    ).toHaveLength(3);
  });

  it("fails an eval whose lease expired max_attempts times", async () => {
    h = await makeEvalHarness({ maxAttempts: 1 });
    const { t } = h;
    await seedDataset(t, "qa", qaRecords(1));
    const created = await t.services.evals.create(
      WORKSPACE_A,
      request({ models: ["qwen/qwen3-8b"], dataset: "qa" }),
    );
    await t.deps.store.evals.claimNext({
      workerId: "dead",
      leaseSeconds: 30,
      now: t.clock.now(),
    });
    t.clock.advanceSeconds(31);
    expect(await t.services.evals.recoverExpired(t.clock.now())).toBe(1);
    const failed = await t.services.evals.get(WORKSPACE_A, created.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/max_attempts=1/);
  });

  it("cancels active evals once and never runs them", async () => {
    h = await makeEvalHarness();
    const { t } = h;
    await seedDataset(t, "qa", qaRecords(1));
    const created = await t.services.evals.create(
      WORKSPACE_A,
      request({ models: ["qwen/qwen3-8b"], dataset: "qa" }),
    );
    const cancelled = await t.services.evals.cancel(WORKSPACE_A, created.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.completed_at).not.toBeNull();
    await expect(
      t.services.evals.cancel(WORKSPACE_A, created.id),
    ).rejects.toMatchObject({
      status: 409,
      code: "eval_not_cancellable",
    });
    expect(await t.services.evals.drain()).toBe(0);

    const page = await t.services.evals.list(WORKSPACE_A, { limit: 10 });
    expect(page.data.map((e) => e.id)).toEqual([created.id]);
    await expect(
      t.services.evals.get("ws_other", created.id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("runs evals in the background executor until stopped", async () => {
    h = await makeEvalHarness();
    const { t } = h;
    await seedDataset(t, "qa", qaRecords(2));
    const created = await t.services.evals.create(
      WORKSPACE_A,
      request({ models: ["qwen/qwen3-8b"], dataset: "qa" }),
    );
    t.services.evals.start(5);
    t.services.evals.start(5);
    const deadline = Date.now() + 5000;
    let status = "queued";
    while (Date.now() < deadline && status !== "completed") {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = (await t.services.evals.get(WORKSPACE_A, created.id)).status;
    }
    await t.services.evals.stop();
    expect(status).toBe("completed");
  });

  it("releases the lease when stopped mid-job so another executor can resume", async () => {
    h = await makeEvalHarness();
    const { t, fake } = h;
    await seedDataset(t, "qa", qaRecords(3));
    fake.setModel("qwen/qwen3-8b", () => ({ content: "slow", delayMs: 150 }));
    const created = await t.services.evals.create(
      WORKSPACE_A,
      request({ models: ["qwen/qwen3-8b"], dataset: "qa" }),
    );
    t.services.evals.start(5);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await t.services.evals.stop();
    const released = await t.services.evals.get(WORKSPACE_A, created.id);
    expect(released.status).toBe("queued");

    fake.setModel("qwen/qwen3-8b", () => ({ content: "fast" }));
    await t.services.evals.drain();
    expect((await t.services.evals.get(WORKSPACE_A, created.id)).status).toBe(
      "completed",
    );
  });
});
