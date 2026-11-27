import { hostname } from "node:os";

import { addSeconds } from "../../clock.js";
import type {
  EvalOutput,
  EvalRun,
  EvalStatus,
  EvalTaskOutcome,
  PlanEvalRequest,
  PlanEvalResponse,
} from "../../contracts.js";
import type { AppDependencies } from "../../deps.js";
import {
  ApiError,
  conflict,
  errorMessage,
  invalid,
  notFound,
} from "../../errors.js";
import { newId } from "../../ids.js";
import { recordPromptAndReference } from "../../records.js";
import type {
  EvalOutputRow,
  EvalRecord,
  EvalTaskRow,
  JobExpectation,
  Page,
  PageRequest,
} from "../../store/types.js";
import type { DatasetService } from "../datasets.js";
import { aggregateEval } from "./aggregate.js";
import { assertNonEmptyPlan, planEvalRequest } from "./planner.js";
import { scoreOutput } from "./scoring.js";

export interface EvalService {
  plan(
    workspaceId: string,
    request: PlanEvalRequest,
  ): Promise<PlanEvalResponse>;
  create(workspaceId: string, request: PlanEvalRequest): Promise<EvalRun>;
  get(workspaceId: string, id: string): Promise<EvalRun>;
  list(workspaceId: string, page: PageRequest): Promise<Page<EvalRun>>;
  listOutputs(
    workspaceId: string,
    id: string,
    input: PageRequest & {
      model?: string | undefined;
      missingScorer?: string | undefined;
    },
  ): Promise<Page<EvalOutput>>;
  postScores(
    workspaceId: string,
    id: string,
    scores: ReadonlyArray<{ output_id: string; scorer: string; score: number }>,
  ): Promise<{
    accepted: number;
    status: EvalStatus;
    pending_local_scores: number;
  }>;
  listResults(
    workspaceId: string,
    id: string,
    input: PageRequest & {
      model?: string | undefined;
      maxScore?: number | undefined;
    },
  ): Promise<Page<EvalTaskOutcome>>;
  /** Results scoring below `threshold` (default: the eval's pass_threshold). */
  listFailures(
    workspaceId: string,
    id: string,
    input: PageRequest & {
      model?: string | undefined;
      threshold?: number | undefined;
    },
  ): Promise<Page<EvalTaskOutcome>>;
  cancel(workspaceId: string, id: string): Promise<EvalRun>;
  /** Runs queued eval jobs until none are claimable; returns how many ran. */
  drain(): Promise<number>;
  start(intervalMs: number): void;
  stop(): Promise<void>;
  /** Requeues (or fails, past max attempts) evals whose executor lease expired. */
  recoverExpired(now: Date): Promise<number>;
}

const LEASE_SECONDS = 120;
const TASK_PAGE = 200;
const OUTPUT_PAGE = 1000;
const ACTIVE: readonly EvalStatus[] = ["queued", "running", "awaiting_scores"];

const outputKey = (model: string, taskIndex: number, sample: number): string =>
  `${model}\u0000${taskIndex}\u0000${sample}`;

const runPool = async <T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> => {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next] as T;
        next += 1;
        await fn(item);
      }
    },
  );
  await Promise.all(workers);
};

const toPublicOutput = (
  row: EvalOutputRow & { record: EvalTaskRow["record"] },
): EvalOutput => ({
  id: row.id,
  eval_id: row.eval_id,
  task_id: row.task_id,
  model: row.model,
  sample_index: row.sample_index,
  input: row.input,
  output: row.output,
  expected_output: row.expected_output ?? null,
  record: row.record,
  scores: row.scores,
  error: row.error,
  usage: {
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
  },
});

export const createEvalService = (
  deps: AppDependencies,
  datasets: DatasetService,
): EvalService => {
  const { store, clock } = deps;
  const executorId = `eval-executor-${hostname()}-${process.pid}-${newId("x").slice(2, 10)}`;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<unknown> | null = null;
  let stopping = false;

  const load = async (workspaceId: string, id: string): Promise<EvalRecord> => {
    const record = await store.evals.get(workspaceId, id);
    if (!record) throw notFound("eval", id);

    return record;
  };

  const pendingScores = (record: EvalRecord): Promise<number> =>
    record.status === "awaiting_scores"
      ? store.evals.countMissingScores(record.id, record.local_scorers)
      : Promise.resolve(0);

  const toPublic = async (record: EvalRecord): Promise<EvalRun> => ({
    id: record.id,
    workspace_id: record.workspace_id,
    name: record.name,
    status: record.status,
    models: record.models,
    baseline: record.baseline,
    task_source: {
      kind: "dataset",
      dataset: record.dataset_name,
      version: record.dataset_version,
    },
    rubric: record.rubric,
    samples: record.samples,
    temperature: record.temperature,
    max_tokens: record.max_tokens,
    pass_threshold: record.pass_threshold,
    judge_models: record.judge_models,
    local_scorers: record.local_scorers,
    progress: {
      total_outputs: record.total_outputs,
      generated: record.generated,
      pending_local_scores: await pendingScores(record),
    },
    summary: record.summary,
    total_cost_usd: record.total_cost_usd,
    error: record.error,
    created_at: record.created_at,
    updated_at: record.updated_at,
    completed_at: record.completed_at,
  });

  const allOutputs = async (evalId: string): Promise<EvalOutputRow[]> => {
    const rows: EvalOutputRow[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.evals.listOutputs(
        evalId,
        {},
        { limit: OUTPUT_PAGE, cursor },
      );
      rows.push(...page.data);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);

    return rows;
  };

  /** Aggregates outputs and marks the eval completed (CAS on `expect`). */
  const finalize = async (
    record: EvalRecord,
    expect: JobExpectation<EvalStatus>,
  ): Promise<EvalRecord | null> => {
    const outputs = await allOutputs(record.id);
    const aggregation = aggregateEval(record, outputs);
    await store.evals.replaceResults(record.id, aggregation.results);

    return store.evals.update(
      record.id,
      {
        status: "completed",
        summary: aggregation.summary,
        total_cost_usd: aggregation.totalCostUsd,
        generated: outputs.length,
        worker_id: null,
        lease_expires_at: null,
        completed_at: clock.now().toISOString(),
      },
      expect,
    );
  };

  const generateOne = async (
    record: EvalRecord,
    task: EvalTaskRow,
    model: string,
    sampleIndex: number,
  ): Promise<EvalOutputRow> => {
    const pr = recordPromptAndReference(task.record);
    const target = record.model_targets[model];
    const base: EvalOutputRow = {
      id: newId("evout"),
      eval_id: record.id,
      task_index: task.task_index,
      task_id: task.task_id,
      model,
      sample_index: sampleIndex,
      input: pr?.prompt ?? [],
      output: null,
      expected_output: task.record.expected_output ?? pr?.reference ?? null,
      scores: {},
      error: null,
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      created_at: clock.now().toISOString(),
    };
    if (!pr || !target || !deps.inference) {
      return { ...base, error: "record has no usable prompt" };
    }

    let completion;
    try {
      completion = await deps.inference.models.complete({
        model: target.inference_model,
        messages: pr.prompt,
        temperature: record.temperature,
        max_tokens: record.max_tokens,
        tools: task.record.tools ?? task.record.input?.tools,
      });
    } catch (error) {
      return { ...base, error: errorMessage(error).slice(0, 2000) };
    }

    const scored = await scoreOutput(
      record.rubric,
      { prompt: pr.prompt, output: completion.text, reference: pr.reference },
      { regex: deps.regex, judge: deps.inference.judge },
    );
    const tokens =
      completion.usage.prompt_tokens + completion.usage.completion_tokens;
    let cost = (tokens / 1_000_000) * (target.price_per_million_tokens ?? 0);
    for (const [judge, judgeTokens] of Object.entries(scored.judgeTokens)) {
      cost += (judgeTokens / 1_000_000) * (deps.catalog.priceFor(judge) ?? 0);
    }

    return {
      ...base,
      output: completion.text,
      scores: scored.scores,
      error:
        scored.errors.length > 0
          ? scored.errors.join("; ").slice(0, 2000)
          : null,
      prompt_tokens: completion.usage.prompt_tokens,
      completion_tokens: completion.usage.completion_tokens,
      cost_usd: Number(cost.toFixed(8)),
    };
  };

  const runJob = async (job: EvalRecord): Promise<void> => {
    const expect: JobExpectation<EvalStatus> = {
      status: ["running"],
      workerId: executorId,
      attempt: job.attempt,
    };
    let lost = false;
    const extend = async () => {
      if (lost) return;
      const ok = await store.evals.update(
        job.id,
        {
          lease_expires_at: addSeconds(
            clock.now(),
            LEASE_SECONDS,
          ).toISOString(),
        },
        expect,
      );
      if (!ok) lost = true;
    };
    const heartbeat = setInterval(
      () => void extend(),
      (LEASE_SECONDS * 1000) / 3,
    );
    heartbeat.unref();

    try {
      const existing = await store.evals.listOutputKeys(job.id);
      let generated = existing.size;
      let afterIndex = -1;

      for (;;) {
        const tasks = await store.evals.listTasks(
          job.id,
          afterIndex,
          TASK_PAGE,
        );
        if (tasks.length === 0) break;
        afterIndex = (tasks[tasks.length - 1] as EvalTaskRow).task_index;

        const work: Array<{
          task: EvalTaskRow;
          model: string;
          sample: number;
        }> = [];
        for (const task of tasks) {
          for (const model of job.models) {
            for (let sample = 0; sample < job.samples; sample += 1) {
              if (!existing.has(outputKey(model, task.task_index, sample))) {
                work.push({ task, model, sample });
              }
            }
          }
        }

        await runPool(work, deps.settings.evalConcurrency, async (item) => {
          if (lost || stopping) return;
          const output = await generateOne(
            job,
            item.task,
            item.model,
            item.sample,
          );
          await store.evals.upsertOutput(output);
          generated += 1;
        });

        await extend();
        if (lost) return;
        if (stopping) break;
        await store.evals.update(job.id, { generated }, expect);
      }

      if (stopping) {
        await store.evals.update(
          job.id,
          {
            status: "queued",
            worker_id: null,
            lease_expires_at: null,
            generated,
          },
          expect,
        );
        return;
      }

      const outputs = await allOutputs(job.id);
      const firstGenerationError = outputs.find(
        (o) => o.output === null,
      )?.error;
      if (outputs.length > 0 && outputs.every((o) => o.output === null)) {
        throw new Error(
          `Every model call failed; first error: ${firstGenerationError ?? "unknown"}`,
        );
      }

      const current = { ...job, generated: outputs.length };
      if (job.local_scorers.length > 0) {
        const missing = await store.evals.countMissingScores(
          job.id,
          job.local_scorers,
        );
        if (missing > 0) {
          await store.evals.update(
            job.id,
            {
              status: "awaiting_scores",
              generated: outputs.length,
              worker_id: null,
              lease_expires_at: null,
            },
            expect,
          );
          return;
        }
      }

      await finalize(current, expect);
    } catch (error) {
      await store.evals.update(
        job.id,
        {
          status: "failed",
          error: errorMessage(error).slice(0, 4000),
          worker_id: null,
          lease_expires_at: null,
          completed_at: clock.now().toISOString(),
        },
        expect,
      );
    } finally {
      clearInterval(heartbeat);
    }
  };

  const recoverExpired = async (now: Date): Promise<number> => {
    const expired = await store.evals.listExpiredLeases(now, 100);
    let recovered = 0;
    for (const e of expired) {
      const exhausted = e.attempt >= deps.settings.maxAttempts;
      const updated = await store.evals.update(
        e.id,
        exhausted
          ? {
              status: "failed",
              error: `Eval executor lease expired ${e.attempt} time(s); giving up after max_attempts=${deps.settings.maxAttempts}.`,
              worker_id: null,
              lease_expires_at: null,
              completed_at: now.toISOString(),
            }
          : { status: "queued", worker_id: null, lease_expires_at: null },
        { status: ["running"], workerId: e.worker_id, attempt: e.attempt },
      );
      if (updated) recovered += 1;
    }

    return recovered;
  };

  const drain = async (): Promise<number> => {
    let ran = 0;
    await recoverExpired(clock.now());
    while (!stopping) {
      const job = await store.evals.claimNext({
        workerId: executorId,
        leaseSeconds: LEASE_SECONDS,
        now: clock.now(),
      });
      if (!job) break;
      await runJob(job);
      ran += 1;
    }

    return ran;
  };

  const resultsPage = async (
    record: EvalRecord,
    input: PageRequest & {
      model?: string | undefined;
      maxScore?: number | undefined;
    },
  ): Promise<Page<EvalTaskOutcome>> => {
    if (record.status !== "completed") {
      throw conflict(
        "eval_not_completed",
        `Eval '${record.id}' is ${record.status}; results are available once it completes.`,
      );
    }
    const page = await store.evals.listResults(
      record.id,
      { model: input.model, maxScore: input.maxScore },
      { limit: input.limit, cursor: input.cursor },
    );

    return {
      data: page.data.map((row) => ({
        task_id: row.task_id,
        model: row.model,
        score: row.score,
        passed: row.passed,
        sample_scores: row.sample_scores,
        judge_model: row.judge_model,
        record: row.record,
      })),
      next_cursor: page.next_cursor,
    };
  };

  return {
    plan: async (workspaceId, request) =>
      (await planEvalRequest(deps, datasets, workspaceId, request)).response,

    create: async (workspaceId, request) => {
      const plan = await planEvalRequest(deps, datasets, workspaceId, request);
      assertNonEmptyPlan(plan);

      const record = await store.transaction(async (tx) => {
        const created = await tx.evals.create({
          workspace_id: workspaceId,
          name: request.name,
          models: request.models,
          model_targets: plan.targets,
          baseline: request.baseline ?? null,
          dataset_id: plan.dataset.dataset.id,
          dataset_name: plan.dataset.dataset.name,
          dataset_version: plan.dataset.version.version,
          rubric: request.rubric,
          samples: request.samples,
          temperature: request.temperature,
          max_tokens: request.max_tokens,
          limit: request.limit ?? null,
          pass_threshold: plan.passThreshold,
          judge_models: plan.judgeModels,
          local_scorers: plan.localScorers,
        });
        await tx.evals.insertTasks(
          created.id,
          plan.tasks.map((task) => ({ ...task, eval_id: created.id })),
        );

        return (await tx.evals.update(created.id, {
          total_outputs:
            plan.tasks.length * request.models.length * request.samples,
        })) as EvalRecord;
      });

      return toPublic(record);
    },

    get: async (workspaceId, id) => toPublic(await load(workspaceId, id)),

    list: async (workspaceId, page) => {
      const rows = await store.evals.list(workspaceId, page);

      return {
        data: await Promise.all(rows.data.map(toPublic)),
        next_cursor: rows.next_cursor,
      };
    },

    listOutputs: async (workspaceId, id, input) => {
      const record = await load(workspaceId, id);
      if (
        input.missingScorer !== undefined &&
        !record.local_scorers.includes(input.missingScorer)
      ) {
        throw invalid(
          "unknown_scorer",
          `'${input.missingScorer}' is not a code scorer of eval '${id}' (local scorers: ${record.local_scorers.join(", ") || "none"}).`,
        );
      }
      const page = await store.evals.listOutputs(
        id,
        { model: input.model, missingScorer: input.missingScorer },
        { limit: input.limit, cursor: input.cursor },
      );

      return {
        data: page.data.map(toPublicOutput),
        next_cursor: page.next_cursor,
      };
    },

    postScores: async (workspaceId, id, scores) => {
      const record = await load(workspaceId, id);
      if (record.status !== "awaiting_scores") {
        throw conflict(
          "eval_not_awaiting_scores",
          `Eval '${id}' is ${record.status}; scores can only be posted while it is awaiting_scores.`,
        );
      }
      const unknown = [
        ...new Set(
          scores
            .map((s) => s.scorer)
            .filter((s) => !record.local_scorers.includes(s)),
        ),
      ];
      if (unknown.length > 0) {
        throw invalid(
          "unknown_scorer",
          `Scorer(s) ${unknown.join(", ")} are not code scorers of eval '${id}' (local scorers: ${record.local_scorers.join(", ") || "none"}).`,
        );
      }

      const accepted = await store.evals.setScores(id, scores);
      const pending = await store.evals.countMissingScores(
        id,
        record.local_scorers,
      );
      if (pending > 0) {
        return {
          accepted,
          status: "awaiting_scores",
          pending_local_scores: pending,
        };
      }

      const finalized = await finalize(record, { status: ["awaiting_scores"] });
      const status = finalized?.status ?? (await load(workspaceId, id)).status;

      return { accepted, status, pending_local_scores: 0 };
    },

    listResults: async (workspaceId, id, input) =>
      resultsPage(await load(workspaceId, id), input),

    listFailures: async (workspaceId, id, input) => {
      const record = await load(workspaceId, id);

      return resultsPage(record, {
        ...input,
        maxScore: input.threshold ?? record.pass_threshold,
      });
    },

    cancel: async (workspaceId, id) => {
      const record = await load(workspaceId, id);
      const updated = await store.evals.update(
        id,
        {
          status: "cancelled",
          worker_id: null,
          lease_expires_at: null,
          completed_at: clock.now().toISOString(),
        },
        { status: ACTIVE },
      );
      if (!updated) {
        throw new ApiError(
          409,
          "eval_not_cancellable",
          "Eval cannot be cancelled",
          `Eval '${id}' is already ${record.status}.`,
        );
      }

      return toPublic(updated);
    },

    drain,

    start: (intervalMs) => {
      if (timer) return;
      stopping = false;
      timer = setInterval(() => {
        if (inFlight) return;
        inFlight = drain()
          .catch((error: unknown) => {
            console.error(
              JSON.stringify({
                level: "error",
                msg: "eval executor failed",
                error: errorMessage(error),
              }),
            );
          })
          .finally(() => {
            inFlight = null;
          });
      }, intervalMs);
      timer.unref();
    },

    stop: async () => {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      await inFlight;
      stopping = false;
    },

    recoverExpired,
  };
};
