import { describe, expect, it } from "vitest";

import { adapters, Context, Judge, losses, optim, pooling, recipes, rollouts, Scorer, splits, validators, type Grad } from "../src/index.js";
import type { EvalRun, PlanEvalResponse, Run } from "../src/generated/models.js";
import { CODEC } from "../src/generated/client.js";
import { convertKeys } from "../src/transport.js";
import { FakeServer, json, makeGrad, wire } from "./helpers.js";

/** tests/fixtures/wire/sdk-parity.json: every SDK and the CLI send these requests for the same calls. */
interface Parity {
  requests: { case: string; method: string; path: string; idempotency_key: string | null; body: unknown }[];
  responses: { run: unknown; eval: unknown; eval_plan: unknown; scoring: unknown };
  expect: Record<string, unknown>;
}
const parity = wire<Parity>("sdk-parity.json");

const judge = new Judge({ name: "quality", model: "judge/m", prompt: "Is the answer correct?", weight: 1 });
const artifact = { name: "support-sft", version: "2026-11-27-1" };

const calls = (grad: Grad): Record<string, () => Promise<unknown>> => ({
  plan_sft_every_param: () =>
    grad.runs.plan({
      dataset: "support",
      name: "sft-params",
      maxCostUsd: 5,
      split: splits.bySession({ evalFraction: 0.2, seed: 7 }),
      recipe: recipes.sft({
        model: "test/tiny-qwen3",
        adapter: adapters.lora({ rank: 16, alpha: 16 }),
        mergeOnExport: true,
        lr: 0.0002,
        lrScale: 0.5,
        optimizer: optim.adamW({ betas: [0.8, 0.9], weightDecay: 0.1, gradClip: 0.5 }),
        batchSize: 4,
        epochs: 2,
        schedule: "cosine",
        warmup: 0.05,
        trainOn: "all_assistant",
        thinking: "off",
        preserveThinking: true,
        reduction: "per_token",
        select: "last",
        checkpointTtlDays: 7,
        evalEvery: 2,
      }),
    }),
  create_dpo_from_artifact: async () =>
    grad.runs.create({ dataset: "prefs", name: "dpo-continued", recipe: recipes.dpo({ model: artifact, loss: losses.dpo({ beta: 0.3 }) }) }, { idempotencyKey: "parity-run-key" }),
  plan_router_judge_rubric: () =>
    grad.runs.plan({
      dataset: "support-logs",
      name: "router-params",
      recipe: recipes.router({
        model: "test/tiny-qwen3",
        models: ["cheap/m", "strong/m"],
        rubric: judge,
        maxQualityDrop: 0.05,
        pricing: { "cheap/m": 0.001, "strong/m": 0.01 },
        fallback: "strong/m",
      }),
    }),
  plan_cartridge: () =>
    grad.runs.plan({
      dataset: "docs",
      name: "cartridge-params",
      recipe: recipes.cartridge({
        model: "test/tiny-qwen3",
        context: Context.fromText("The capital of Testland is Tinytown."),
        numTokens: 16,
        teacher: "test/tiny-qwen3-teacher",
        loss: losses.topKKLDistill({ topK: 7 }),
        maxNewTokens: 5,
      }),
    }),
  plan_embedding: () => grad.runs.plan({ dataset: "pairs", name: "embedding-params", recipe: recipes.embedding({ model: "test/tiny-bert", pool: pooling.cls(), temp: 0.1 }) }),
  plan_decision: () => grad.runs.plan({ dataset: "decisions", name: "decision", recipe: recipes.decisionModel() }),
  plan_distill: () =>
    grad.runs.plan({
      dataset: "support-prompts",
      name: "distill-params",
      recipe: recipes.distill({
        model: "test/tiny-qwen3",
        teacher: "test/tiny-qwen3-teacher",
        rollout: rollouts.onPolicy({ maxNewTokens: 64 }),
        loss: losses.topKKLDistill({ topK: 16 }),
        context: Context.fromText("Refunds take 30 days."),
      }),
    }),
  plan_distill_off_policy: () =>
    grad.runs.plan({
      dataset: "support-prompts",
      name: "distill-off",
      recipe: recipes.distill({ teacher: artifact, rollout: rollouts.offPolicy({ maxNewTokens: 128 }), loss: losses.crossEntropy() }),
    }),
  plan_reward: () =>
    grad.runs.plan({
      dataset: "sql-preferences",
      name: "sql-verifier",
      recipe: recipes.rewardModel({ model: "test/tiny-qwen3", adapter: adapters.frozenHead(), rubric: "resolved" }),
    }),
  create_eval: async () =>
    grad.evals.create(
      {
        name: "parity-eval",
        models: ["test/tiny-qwen3", artifact],
        dataset: "support",
        rubric: [judge, new Scorer("non_empty", { fn: validators.nonEmpty(), weight: 1 })],
        baseline: "test/tiny-qwen3",
        samples: 3,
        temperature: 0.7,
        maxTokens: 256,
        limit: 10,
        passThreshold: 0.5,
        datasetVersion: 1,
      },
      { idempotencyKey: "parity-eval-key" },
    ),
  score_dataset: async () =>
    grad.datasets.score("support-logs", judge, { version: 1, name: "support-logs-quality", limit: 100, idempotencyKey: "parity-score-key" }),
  filter_dataset_fields: () =>
    grad.datasets.filter("support-logs", { scores: { quality: ">=0.8" }, metadata: { env: "prod" }, createdAfter: "2026-11-01", version: 2, name: "support-good" }),
  filter_dataset_ids: () => grad.datasets.filter("support-logs", { ids: ["rec_a", "rec_c"] }),
  deploy: () => grad.deploy(artifact, { name: "support", fallback: "test/tiny-qwen3", exploreRate: 0.1, idempotencyKey: "parity-deploy-key" }),
});

describe("shared parity fixture (tests/fixtures/wire/sdk-parity.json)", () => {
  it("sends the fixture's request for every case", async () => {
    const server = new FakeServer();
    for (const c of parity.requests) server.on(c.method, c.path, () => json({ id: "x", status: "queued" }));
    const { grad } = makeGrad(server);
    const table = calls(grad);
    expect(Object.keys(table).sort()).toEqual(parity.requests.map((c) => c.case).sort());
    for (const c of parity.requests) {
      await table[c.case]?.();
      const sent = server.calls[server.calls.length - 1];
      expect([sent?.method, sent?.url.pathname], c.case).toEqual([c.method, c.path]);
      expect(JSON.parse(sent?.body ?? "null"), c.case).toEqual(c.body);
      const key = sent?.headers.get("idempotency-key");
      if (c.idempotency_key === null) expect(key, c.case).toMatch(/^[0-9a-f-]{36}$/);
      else expect(key, c.case).toBe(c.idempotency_key);
    }
  });

  it("reads typed eval reports, eval metrics and eval billing", () => {
    const decode = <T>(schema: string, body: unknown): T => convertKeys(CODEC, schema, body, "decode") as T;
    const run = decode<Run>("Run", parity.responses.run);
    const ev = decode<EvalRun>("EvalRun", parity.responses.eval);
    const plan = decode<PlanEvalResponse>("PlanEvalResponse", parity.responses.eval_plan);
    const scoring = decode<EvalRun>("EvalRun", parity.responses.scoring);
    expect({
      "run.eval_report.metric_name": run.evalReport?.metricName,
      "run.eval_report.selected_step": run.evalReport?.selectedStep,
      "run.eval_report.eval_loss": run.evalReport?.evalLoss,
      "run.eval_report.fallback_model": run.evalReport?.fallbackModel,
      "run.eval_report.pareto_summary.quality_drop": run.evalReport?.paretoSummary?.qualityDrop,
      "run.eval_report.pareto_summary.quality_drop_ci95": run.evalReport?.paretoSummary?.qualityDropCi95,
      "run.latest_metric.eval_metrics.routed_quality": run.latestMetric?.evalMetrics?.routed_quality,
      "eval.total_cost_usd": ev.totalCostUsd,
      "eval.summary[0].cost_per_1k_tasks_usd": ev.summary[0]?.costPer1kTasksUsd,
      "eval_plan.estimated_cost_usd": plan.estimatedCostUsd,
      "scoring.mode": scoring.mode,
      "scoring.scored_dataset_version": scoring.scoredDatasetVersion,
    }).toEqual(parity.expect);
  });
});
