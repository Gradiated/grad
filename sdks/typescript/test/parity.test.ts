import { describe, expect, it } from "vitest";

import { adapters, Context, Judge, loggers, losses, optim, pooling, recipes, rollouts, Scorer, SecretRef, sources, splits, validators, type Grad } from "../src/index.js";
import type {
  Artifact as ArtifactData,
  ArtifactImport as ArtifactImportData,
  EvalRun,
  PlanEvalResponse, PlanRunResponse, Run, RunEventsPage, Secret, Source, UsageRecord, UsageSummary } from "../src/generated/models.js";
import { CODEC } from "../src/generated/client.js";
import { convertKeys } from "../src/transport.js";
import { FakeServer, json, makeGrad, wire } from "./helpers.js";

/** tests/fixtures/wire/sdk-parity.json: every SDK and the CLI send these requests for the same calls. */
interface Parity {
  requests: { case: string; method: string; path: string; idempotency_key: string | null; body: unknown; query?: Record<string, string> }[];
  responses: { run: unknown; eval: unknown; eval_plan: unknown; scoring: unknown; run_plan: unknown; source: unknown; secret: unknown; usage_page: { data: unknown[] }; usage_summary: unknown; run_events: { run_id: string }; artifact: unknown; artifact_import: unknown };
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
  plan_sft_checkpoint_evals_loggers: () =>
    grad.runs.plan({
      dataset: "support",
      name: "sft-tracked",
      recipe: recipes.sft({
        model: "test/tiny-qwen3",
        evals: ["gsm8k-200", { dataset: "support-holdout", rubric: new Scorer("starts_select", { fn: validators.regex("^SELECT"), weight: 1 }), limit: 50, name: "sql" }],
        loggers: [loggers.wandb({ project: "support", secret: "wandb-key" }), loggers.mlflow({ trackingUri: "https://mlflow.internal", experiment: "sft" })],
      }),
    }),
  import_benchmark: () => grad.datasets.fromBenchmark("gsm8k", { limit: 200, name: "gsm8k-test-200", wait: false }),
  filter_dataset_ids: () => grad.datasets.filter("support-logs", { ids: ["rec_a", "rec_c"] }),
  import_artifact_hf: async () =>
    await grad.artifacts.fromHf("hf://acme/support-lora@v2", {
      base: "test/tiny-qwen3",
      name: "support-lora",
      secret: "hf-token",
      idempotencyKey: "parity-artifact-import-key",
    }),
  artifact_download_url: () => grad.artifacts.downloadUrl("support-sft@2026-11-27-1"),
  delete_artifact: () => grad.artifacts.delete("support-sft@2026-11-27-1"),
  set_secret: () => grad.secrets.set("langfuse-prod", "pk-lf-1:sk-lf-2"),
  set_secret_hosts: () =>
    grad.secrets.set("langfuse-self", "pk-lf-1:sk-lf-2", { allowedHosts: ["langfuse.internal:3000"] }),
  add_source: () =>
    grad.sources.create("support-prod", {
      provider: sources.langfuse({ host: "https://cloud.langfuse.com", secret: new SecretRef({ name: "langfuse-prod" } as Secret) }),
      schedule: "*/15 * * * *",
      idempotencyKey: "parity-source-key",
    }),
  add_source_gradiated: () =>
    grad.sources.create("support-prod", { provider: sources.gradiated({ models: ["acme/support"] }), schedule: "0 * * * *" }),
  add_source_filtered: () =>
    grad.sources.create("support-prod", {
      provider: sources.langfuse({ secret: "langfuse-prod", filters: { environment: ["production"], min_score: { helpfulness: 0.8 } } }),
      sampleRate: 0.1,
      maxRecordsPerDay: 100000,
      versionInterval: 600,
    }),
  update_source: () => grad.sources.update("src_01J9X", { filters: { tags: ["prod"] }, sampleRate: 0.5, maxRecordsPerSync: null }),
  sync_source_full: async () => grad.sources.sync("src_01J9X", { full: true }),
  list_usage: () => grad.usage.list({ limit: 10 }).pages().next(),
  list_usage_filtered: () =>
    grad.usage
      .list({ from: "2026-11-01", to: "2026-11-30", runId: { id: "run_015437ae0c01e09a573e4811" }, kind: "labeling", limit: 10 })
      .pages()
      .next(),
  usage_summary: () => grad.usage.summary({ from: "2026-11-01", to: "2026-11-30", groupBy: "model" }),
  list_run_events: () => grad.runs.events(parity.responses.run_events.run_id, { limit: 100 }).next(),
});

describe("shared parity fixture (tests/fixtures/wire/sdk-parity.json)", () => {
  it("sends the fixture's request for every case", async () => {
    const server = new FakeServer();
    for (const c of parity.requests) server.on(c.method, encodeURI(c.path).replace(/@/g, "%40"), () => json({ id: "x", status: "queued" }));
    server.on("GET", "/v1/usage", () => json({ data: [], next_cursor: null }));
    server.on("GET", `/v1/runs/${parity.responses.run_events.run_id}/events`, () => json({ data: [], next_cursor: null }));
    // fromBenchmark reads the dataset back.
    server.on("GET", "/v1/datasets/gsm8k-test-200", () => json({ id: "x", name: "gsm8k-test-200" }));
    const { grad } = makeGrad(server);
    const table = calls(grad);
    expect(Object.keys(table).sort()).toEqual(parity.requests.map((c) => c.case).sort());
    for (const c of parity.requests) {
      await table[c.case]?.();
      // The last request to the case's endpoint (a helper may read the result back).
      const sent = server.calls.filter((call) => call.method === c.method && decodeURIComponent(call.url.pathname) === c.path).at(-1);
      expect([sent?.method, decodeURIComponent(sent?.url.pathname ?? "")], c.case).toEqual([c.method, c.path]);
      expect(JSON.parse(sent?.body ?? "null"), c.case).toEqual(c.body);
      const key = sent?.headers.get("idempotency-key");
      if (c.method === "GET") {
        expect(Object.fromEntries(sent?.url.searchParams ?? []), c.case).toEqual(c.query);
        expect(key, c.case).toBeNull();
      } else if (c.method === "PATCH" || c.method === "DELETE") expect(key, c.case).toBeNull();
      else if (c.idempotency_key === null) expect(key, c.case).toMatch(/^[0-9a-f-]{36}$/);
      else expect(key, c.case).toBe(c.idempotency_key);
    }
  });

  it("reads typed eval reports, eval metrics and eval billing", () => {
    const decode = <T>(schema: string, body: unknown): T => convertKeys(CODEC, schema, body, "decode") as T;
    const run = decode<Run>("Run", parity.responses.run);
    const ev = decode<EvalRun>("EvalRun", parity.responses.eval);
    const plan = decode<PlanEvalResponse>("PlanEvalResponse", parity.responses.eval_plan);
    const scoring = decode<EvalRun>("EvalRun", parity.responses.scoring);
    const runPlan = decode<PlanRunResponse>("PlanRunResponse", parity.responses.run_plan);
    const source = decode<Source>("Source", parity.responses.source);
    const secret = decode<Secret>("Secret", parity.responses.secret);
    const usage = decode<UsageRecord>("UsageRecord", parity.responses.usage_page.data[0]);
    const totals = decode<UsageSummary>("UsageSummary", parity.responses.usage_summary);
    const events = decode<RunEventsPage>("RunEventsPage", parity.responses.run_events).data;
    const artifact = decode<ArtifactData>("Artifact", parity.responses.artifact);
    const artifactImport = decode<ArtifactImportData>("ArtifactImport", parity.responses.artifact_import);
    const at = <T extends RunEventsPage["data"][number]["type"]>(i: number, type: T) => {
      const event = events[i];
      if (event?.type !== type) throw new Error(`event ${i} is ${event?.type}, not ${type}`);
      return event as Extract<RunEventsPage["data"][number], { type: T }>;
    };
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
      "run_plan.estimated_duration_s": runPlan.estimatedDurationS,
      "run_plan.min_gpu_memory_gb": runPlan.minGpuMemoryGb,
      "run_plan.cost_breakdown.train_usd": runPlan.costBreakdown.trainUsd,
      "source.id": source.id,
      "source.provider.kind": source.provider.kind,
      "source.provider.secret": source.provider.secret,
      "source.schedule": source.schedule,
      "source.sample_rate": source.sampleRate,
      "source.max_records_per_day": source.maxRecordsPerDay,
      "source.records_today": source.recordsToday,
      "source.pending_records": source.pendingRecords,
      "source.last_sync.status": source.lastSync?.status,
      "source.last_sync.dataset_version": source.lastSync?.datasetVersion,
      "source.status": source.status,
      "source.consecutive_failures": source.consecutiveFailures,
      "source.last_error": source.lastError,
      "secret.name": secret.name,
      "secret.allowed_hosts[0]": secret.allowedHosts[0],
      "usage[0].kind": usage.kind,
      "usage[0].tokens_through": usage.tokensThrough,
      "usage[0].ref_name": usage.refName,
      "usage[0].run_id": usage.runId,
      "usage[0].cost_usd": usage.costUsd,
      "usage_summary.from": totals.from,
      "usage_summary.cost_usd": totals.costUsd,
      "usage_summary.tokens": totals.tokens,
      "usage_summary.by_kind[0].kind": totals.byKind[0]?.kind,
      "usage_summary.top_runs[0].name": totals.topRuns[0]?.name,
      "usage_summary.top_evals[0].kind": totals.topEvals[0]?.kind,
      "usage_summary.groups[1].key": totals.groups[1]?.key,
      "usage_summary.groups[1].tokens": totals.groups[1]?.tokens,
      "artifact.provenance.source": artifact.provenance.source,
      "artifact.provenance.uploader": artifact.provenance.uploader,
      "artifact_import.status": artifactImport.status,
      "artifact_import.error_code": artifactImport.errorCode,
      "run.phase": run.phase,
      "run.last_interruption.reason": run.lastInterruption?.reason,
      "run.last_interruption.resume_step": run.lastInterruption?.resumeStep,
      "run_events.data[2].phase": at(2, "phase").phase,
      "run_events.data[2].workers_online": at(2, "phase").workersOnline,
      "run_events.data[0].queue_position": at(0, "phase").queuePosition,
      "run_events.data[2].message": at(2, "phase").message,
      "run.min_gpu_memory_gb": run.minGpuMemoryGb,
      "run_events.data[4].gpu.name": at(4, "phase").gpu?.name,
      "run_events.data[7].metric.step": at(7, "metric").metric?.step,
      "run_events.data[11].checkpoint_id": at(11, "checkpoint").checkpointId,
      "run_events.data[12].event": at(12, "attempt").event,
      "run_events.data[12].reason": at(12, "attempt").reason,
      "run_events.data[14].resume_step": at(14, "attempt").resumeStep,
      "run_events.data[24].status": at(24, "completed").status,
      "run_events.data[24].run.last_interruption.reason": at(24, "completed").run.lastInterruption?.reason,
    }).toEqual(parity.expect);
  });
});
