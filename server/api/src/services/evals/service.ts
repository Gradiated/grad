import { hostname } from "node:os";

import { addSeconds } from "../../clock.js";
import {
  NON_DEPLOYABLE_FORMATS,
  PlanEvalRequestSchema,
  RECORD_MODEL,
  type CheckpointEvalResult,
  type EvalMode,
  type EvalOutput,
  type EvalRun,
  type EvalStatus,
  type EvalTaskOutcome,
  type PlanEvalRequest,
  type PlanEvalResponse,
  type ScoreDatasetRequest,
} from "../../contracts.js";
import type { AppDependencies } from "../../deps.js";
import {
  ApiError,
  conflict,
  errorMessage,
  forbidden,
  invalid,
  notFound,
} from "../../errors.js";
import { createOnce, type Created } from "../../idempotency.js";
import { newId } from "../../ids.js";
import {
  recordPromptAndReference,
  recordPromptAndResponse,
} from "../../records.js";
import type {
  CheckpointRecord,
  EvalOutputRow,
  EvalRecord,
  EvalTask,
  IdempotencyInput,
  JobExpectation,
  Page,
  PageRequest,
  Repositories,
  RunRecord,
} from "../../store/types.js";

const EVAL_DONE: readonly EvalStatus[] = ["completed", "failed", "cancelled"];
import { writeRecordsPart } from "../dataset-records.js";
import { datasetPartKey, type DatasetService } from "../datasets.js";
import {
  fenceOf,
  RELEASE,
  requeuePatch,
  type JobKindHandler,
  type JobQueue,
} from "../jobs.js";
import { scoreUpdate } from "../record-merge.js";
import { settleLabelledRuns } from "../router-labels.js";
import type { UsageService } from "../usage.js";
import { aggregateEval } from "./aggregate.js";
import { assertNonEmptyPlan, buildTasks, planEvalRequest } from "./planner.js";
import { scoreOutput, type ScoringContext } from "./scoring.js";

export interface EvalService {
  plan(
    workspaceId: string,
    request: PlanEvalRequest,
  ): Promise<PlanEvalResponse>;
  create(
    workspaceId: string,
    request: PlanEvalRequest,
    idempotency?: IdempotencyInput,
  ): Promise<Created<EvalRun>>;
  /**
   * `dataset.score()`: a scoring job (mode `score`) over the records' own
   * answers; on completion their scores are the dataset's next version.
   */
  scoreDataset(
    workspaceId: string,
    dataset: string,
    request: ScoreDatasetRequest,
    idempotency?: IdempotencyInput,
  ): Promise<Created<EvalRun>>;
  /** Plans and inserts an eval (joins the caller's transaction). */
  createRecord(
    workspaceId: string,
    request: PlanEvalRequest,
  ): Promise<EvalRecord>;
  /** recipe.evals: queues the run's checkpoint evals on a new checkpoint. */
  evaluateCheckpoint(
    run: Pick<RunRecord, "id" | "workspace_id" | "name" | "resolved_config">,
    checkpoint: Pick<CheckpointRecord, "id" | "step" | "format">,
  ): Promise<void>;
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
  /** The eval kind's hooks in the job queue. */
  handler: JobKindHandler;
  /**
   * Finalizes awaiting_scores evals that have every score (a crash between the
   * last scores and finalize) and fails those the SDK stopped scoring.
   */
  settleAwaitingScores(now: Date): Promise<number>;
}

/** An eval no SDK has posted scores to for this long fails. */
export const AWAITING_SCORES_TIMEOUT_SECONDS = 24 * 3600;

const LEASE_SECONDS = 120;

/** Runs `fn` every `ms` (unref'd); a rejection is logged, never left unhandled. */
export const backgroundInterval = (
  fn: () => Promise<unknown>,
  ms: number,
  what: string,
): ReturnType<typeof setInterval> => {
  const timer = setInterval(() => {
    fn().catch((error: unknown) => {
      console.error(
        JSON.stringify({
          level: "warn",
          msg: `${what} failed`,
          error: errorMessage(error),
        }),
      );
    });
  }, ms);
  timer.unref();

  return timer;
};

/** Thrown inside finalize's transaction when another caller finalized first. */
class LostRace extends Error {}
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

const toPublicOutput = (row: EvalOutputRow): EvalOutput => ({
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
  collaborators: {
    datasets: DatasetService;
    usage: UsageService;
    queue: () => JobQueue;
  },
): EvalService => {
  const { datasets, usage } = collaborators;
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
    mode: record.mode,
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
    scored_dataset_version: record.scored_dataset_version,
    error: record.error,
    created_at: record.created_at,
    updated_at: record.updated_at,
    completed_at: record.finished_at,
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

  /**
   * Bills what `record`'s attempt generated beyond what it already billed:
   * at its close (`final`), and in increments while it runs.
   */
  const billAttempt = async (
    tx: Pick<Repositories, "evals" | "jobs" | "usage">,
    record: Pick<EvalRecord, "id" | "kind" | "workspace_id" | "attempt">,
    final = true,
  ): Promise<void> => {
    if (record.attempt < 1) return;
    const spent = await tx.evals.attemptUsage(record.id, record.attempt);
    await usage.flush(
      tx,
      record,
      { tokens: spent.tokens, costUsd: spent.cost_usd },
      final,
    );
  };

  /**
   * A finished eval: bills its open attempt and starts or cancels the router
   * run waiting on it as a labeling eval.
   */
  const onFinished = async (
    record: Pick<
      EvalRecord,
      "id" | "kind" | "workspace_id" | "status" | "error" | "attempt"
    >,
  ): Promise<void> => {
    await billAttempt(store, record);
    await settleLabelledRuns(store, record, clock.now().toISOString());
    const full = await store.evals.getById(record.id);
    const result = full && checkpointResult(full);
    if (result && full?.run_id) await recordCheckpointEval(full.run_id, result);
  };

  /**
   * A scoring job's score-update part (one record per scored task, without
   * scores that failed). Content-addressed, so a retried finalize writes the
   * same object. Null when nothing was scored.
   */
  const writeScorePart = async (
    record: EvalRecord,
    outputs: readonly EvalOutputRow[],
  ) => {
    const updates = outputs
      .filter((o) => o.output !== null && Object.keys(o.scores).length > 0)
      .map((o) => scoreUpdate(o.task_id, o.scores));
    if (updates.length === 0) return null;

    return writeRecordsPart(
      deps.storage,
      (sha) => datasetPartKey(record.workspace_id, record.dataset_id, sha),
      updates,
    );
  };

  /** Aggregates outputs and marks the eval completed; CAS on `expect`. */
  const finalize = async (
    record: EvalRecord,
    expect: JobExpectation,
  ): Promise<EvalRecord | null> => {
    const outputs = await allOutputs(record.id);
    const aggregation = aggregateEval(record, outputs);
    const scorePart =
      record.mode === "score" ? await writeScorePart(record, outputs) : null;
    // Scores, status, usage and the labelled run commit together, or not at all.
    return store
      .transaction(async () => {
        await store.evals.setCombinedScores(
          record.id,
          aggregation.outputScores,
        );
        const scoredVersion =
          record.mode !== "score"
            ? null
            : scorePart
              ? (
                  await store.datasets.appendVersion({
                    datasetId: record.dataset_id,
                    parts: [scorePart],
                  })
                ).version
              : record.dataset_version;
        const done = await store.evals.update(
          record.id,
          {
            ...RELEASE,
            status: "completed",
            summary: aggregation.summary,
            total_cost_usd: aggregation.totalCostUsd,
            generated: outputs.length,
            finished_at: clock.now().toISOString(),
            scored_dataset_version: scoredVersion,
          },
          expect,
        );
        if (!done) throw new LostRace();
        await onFinished(done);

        return done;
      })
      .catch((error: unknown) => {
        if (error instanceof LostRace) return null;
        throw error;
      });
  };

  // Per eval: regex items that timed out once are not run again (bounded).
  const timedOutRegex = new Map<string, Set<string>>();
  const timedOutRegexFor = (evalId: string): Set<string> => {
    let set = timedOutRegex.get(evalId);
    if (!set) {
      set = new Set();
      timedOutRegex.set(evalId, set);
      if (timedOutRegex.size > 1000) {
        timedOutRegex.delete(timedOutRegex.keys().next().value as string);
      }
    }
    return set;
  };

  /** A scoring job's output: the record's own answer, scored by the rubric. */
  const scoringContext = (record: EvalRecord): ScoringContext => ({
    regex: deps.regex,
    timedOutRegex: timedOutRegexFor(record.id),
    judge: deps.inference?.judge ?? null,
    workspace: record.workspace_id,
    judgeTargets: record.judge_targets,
  });

  /** A judge's tokens at the price resolved at plan time (judges are always priced). */
  const judgeCost = (record: EvalRecord, judge: string, tokens: number) =>
    (tokens / 1_000_000) *
    (record.judge_targets[judge]?.price_per_million_tokens ??
      deps.catalog.judgePriceFor(judge) ??
      0);

  const scoreOne = async (
    record: EvalRecord,
    task: EvalTask,
  ): Promise<EvalOutputRow> => {
    const parts = recordPromptAndResponse(task.record);
    const base: EvalOutputRow = {
      id: newId("evout"),
      eval_id: record.id,
      attempt: record.attempt,
      record: task.record,
      task_index: task.task_index,
      task_id: task.task_id,
      model: RECORD_MODEL,
      sample_index: 0,
      input: parts?.prompt ?? [],
      output: parts?.response ?? null,
      expected_output: task.record.expected_output ?? null,
      scores: {},
      error: null,
      prompt_tokens: 0,
      completion_tokens: 0,
      cost_usd: 0,
      created_at: clock.now().toISOString(),
    };
    if (!parts || parts.response === null) {
      return { ...base, error: "record has no answer to score" };
    }

    const scored = await scoreOutput(
      record.rubric,
      {
        prompt: parts.prompt,
        output: parts.response,
        reference: parts.expected,
      },
      scoringContext(record),
    );
    let cost = 0;
    let tokens = 0;
    for (const [judge, judgeTokens] of Object.entries(scored.judgeTokens)) {
      tokens += judgeTokens;
      cost += judgeCost(record, judge, judgeTokens);
    }
    const scores = Object.fromEntries(
      Object.entries(scored.scores).filter(
        ([name]) => !scored.failed.includes(name),
      ),
    );

    return {
      ...base,
      scores,
      error:
        scored.errors.length > 0
          ? scored.errors.join("; ").slice(0, 2000)
          : null,
      prompt_tokens: tokens,
      cost_usd: Number(cost.toFixed(8)),
    };
  };

  const generateOne = async (
    record: EvalRecord,
    task: EvalTask,
    model: string,
    sampleIndex: number,
  ): Promise<EvalOutputRow> => {
    if (record.mode === "score") return scoreOne(record, task);
    const pr = recordPromptAndReference(task.record);
    const target = record.model_targets[model];
    const base: EvalOutputRow = {
      id: newId("evout"),
      eval_id: record.id,
      attempt: record.attempt,
      record: task.record,
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
        workspace: record.workspace_id,
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
      scoringContext(record),
    );
    const tokens =
      completion.usage.prompt_tokens + completion.usage.completion_tokens;
    let cost = (tokens / 1_000_000) * (target.price_per_million_tokens ?? 0);
    for (const [judge, judgeTokens] of Object.entries(scored.judgeTokens)) {
      cost += judgeCost(record, judge, judgeTokens);
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

  /** The eval's tasks: the usable records of its pinned dataset version. */
  const tasksOf = async (record: EvalRecord): Promise<EvalTask[]> => {
    const resolved = await datasets.resolve(
      record.workspace_id,
      record.dataset_name,
      record.dataset_version,
    );

    return buildTasks(
      await datasets.readRecords(resolved.version),
      record.limit ?? undefined,
      record.mode === "score" ? record.rubric.map((r) => r.name) : null,
    ).tasks;
  };

  const runJob = async (job: EvalRecord): Promise<void> => {
    const expect = fenceOf(job, ["running"]);
    let lost = false;
    const extend = async () => {
      if (lost) return;
      if (!(await collaborators.queue().renew(job, LEASE_SECONDS))) lost = true;
    };
    // A failed renewal (DB blip) never rejects unhandled: the next one
    // retries, and a lease that really expired is noticed then.
    const heartbeat = backgroundInterval(
      extend,
      (LEASE_SECONDS * 1000) / 3,
      `eval ${job.id} lease renewal`,
    );

    try {
      const existing = await store.evals.listOutputKeys(job.id);
      let generated = existing.size;
      const tasks = await tasksOf(job);

      for (let start = 0; start < tasks.length; start += TASK_PAGE) {
        const work: Array<{ task: EvalTask; model: string; sample: number }> =
          [];
        for (const task of tasks.slice(start, start + TASK_PAGE)) {
          for (const model of job.models) {
            for (let sample = 0; sample < job.samples; sample += 1) {
              if (!existing.has(outputKey(model, task.task_index, sample))) {
                work.push({ task, model, sample });
              }
            }
          }
        }

        const generate = async (item: (typeof work)[number]) => {
          if (lost || stopping) return;
          await store.evals.insertOutput(
            await generateOne(job, item.task, item.model, item.sample),
          );
          generated += 1;
        };
        await runPool(work, deps.settings.evalConcurrency, generate);

        await extend();
        if (lost) return;
        if (stopping) break;
        await store.transaction(async (tx) => {
          const progressed = await tx.evals.update(
            job.id,
            { generated },
            expect,
          );
          if (progressed) await billAttempt(tx, progressed, false);
        });
      }

      if (stopping) {
        // A graceful stop hands the eval back without counting an attempt.
        await store.transaction(async (tx) => {
          const released = await tx.evals.update(
            job.id,
            { ...RELEASE, status: "queued", generated },
            expect,
          );
          if (released) await billAttempt(tx, released);
        });
        return;
      }

      const outputs = await allOutputs(job.id);
      const firstGenerationError = outputs.find(
        (o) => o.output === null,
      )?.error;
      if (
        job.mode === "eval" &&
        outputs.length > 0 &&
        outputs.every((o) => o.output === null)
      ) {
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
          await store.transaction(async (tx) => {
            const waiting = await tx.evals.update(
              job.id,
              {
                ...RELEASE,
                status: "awaiting_scores",
                generated: outputs.length,
              },
              expect,
            );
            if (waiting) await billAttempt(tx, waiting);
          });
          return;
        }
      }

      await finalize(current, expect);
    } catch (error) {
      const failed = await store.evals.update(
        job.id,
        {
          ...RELEASE,
          status: "failed",
          error: errorMessage(error).slice(0, 4000),
          finished_at: clock.now().toISOString(),
        },
        expect,
      );
      if (failed) await onFinished(failed);
    } finally {
      clearInterval(heartbeat);
    }
  };

  const handler: JobKindHandler = {
    onLeaseLost: async (row, fence, now) => {
      const updated = await store.transaction(async (tx) => {
        const closed = await tx.evals.update(
          row.id,
          requeuePatch(
            row,
            `Eval executor attempt ${row.attempt} lost its lease`,
            now.toISOString(),
          ) as Parameters<typeof tx.evals.update>[1],
          fence,
        );
        if (closed) await billAttempt(tx, { ...closed, attempt: row.attempt });

        return closed;
      });
      if (updated?.status === "failed") await onFinished(updated);
    },
  };

  const drain = async (): Promise<number> => {
    let ran = 0;
    await collaborators.queue().expireLeases(clock.now());
    while (!stopping) {
      const row = await collaborators.queue().claimRow({
        workerId: executorId,
        leaseSeconds: LEASE_SECONDS,
        kinds: ["eval"],
      });
      if (!row) break;
      const job = await store.evals.getById(row.id);
      if (job) await runJob(job);
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
      {
        model: input.model,
        maxScore: input.maxScore,
        passThreshold: record.pass_threshold,
      },
      { limit: input.limit, cursor: input.cursor },
    );
    const judgeModel = record.judge_models[0] ?? null;

    return {
      data: page.data.map((row) => ({
        task_id: row.task_id,
        model: row.model,
        score: row.score,
        passed: row.passed,
        sample_scores: row.sample_scores,
        judge_model: judgeModel,
        record: row.record,
      })),
      next_cursor: page.next_cursor,
    };
  };

  const createRecord = async (
    workspaceId: string,
    request: PlanEvalRequest,
    idempotency?: IdempotencyInput,
    mode: EvalMode = "eval",
    checkpoint?: {
      runId: string;
      step: number;
      targets: EvalRecord["model_targets"];
    },
  ): Promise<EvalRecord> => {
    const plan = await planEvalRequest(
      deps,
      datasets,
      workspaceId,
      request,
      mode,
      checkpoint?.targets,
    );
    if (mode === "eval") assertNonEmptyPlan(plan);
    // Evals and dataset.score() spend on the platform's inference and judge
    // endpoints: the same start-time balance check as runs.
    const check = await deps.billing.checkCanStartRun(
      workspaceId,
      plan.response.estimated_cost_usd,
    );
    if (!check.allowed) {
      throw forbidden(
        "billing_denied",
        check.reason ??
          `Insufficient balance to start this ${mode === "score" ? "scoring job" : "eval"}.`,
      );
    }

    return store.evals.create({
      workspaceId,
      maxAttempts: deps.settings.maxAttempts,
      idempotency,
      name: request.name,
      models: request.models,
      model_targets: plan.targets,
      baseline: request.baseline ?? null,
      dataset_id: plan.dataset.dataset.id,
      dataset_name: plan.dataset.dataset.name,
      dataset_version: plan.dataset.version.version,
      rubric: plan.rubric,
      mode,
      samples: request.samples,
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      limit: request.limit ?? null,
      pass_threshold: plan.passThreshold,
      judge_models: plan.judgeModels,
      judge_targets: plan.judgeTargets,
      local_scorers: plan.localScorers,
      run_id: checkpoint?.runId ?? null,
      run_step: checkpoint?.step ?? null,
      totalOutputs: plan.tasks.length * request.models.length * request.samples,
    });
  };

  /** Records a recipe.evals result on its run: in run.checkpoint_evals and a job event. */
  const recordCheckpointEval = async (
    runId: string,
    result: CheckpointEvalResult,
  ): Promise<void> => {
    await store.runs.appendCheckpointEval(runId, result);
    await store.jobs.appendEvent({
      jobId: runId,
      attempt: 0,
      type: `checkpoint_eval:${result.name}`,
      step: result.step,
      payload: result,
    });
  };

  const checkpointResult = (
    record: EvalRecord,
  ): CheckpointEvalResult | null => {
    if (record.run_id === null || record.run_step === null) return null;
    if (!EVAL_DONE.includes(record.status)) return null;

    return {
      name: record.name,
      step: record.run_step,
      checkpoint_id: record.models[0] ?? "",
      eval_id: record.id,
      dataset: record.dataset_name,
      dataset_version: record.dataset_version,
      status: record.status as CheckpointEvalResult["status"],
      score:
        record.status === "completed"
          ? (record.summary[0]?.overall ?? null)
          : null,
      cost_usd: record.total_cost_usd,
      error: record.error,
    };
  };

  /**
   * recipe.evals: queues one eval per spec on a new checkpoint (served by
   * the inference endpoint under the checkpoint id). A checkpoint that can't
   * be served, or an eval that can't be created, is recorded as failed; the
   * run itself never fails for it.
   */
  const evaluateCheckpoint = async (
    run: Pick<RunRecord, "id" | "workspace_id" | "name" | "resolved_config">,
    checkpoint: Pick<CheckpointRecord, "id" | "step" | "format">,
  ): Promise<void> => {
    for (const spec of run.resolved_config.checkpoint_evals ?? []) {
      const failed = (error: string): CheckpointEvalResult => ({
        name: spec.name,
        step: checkpoint.step,
        checkpoint_id: checkpoint.id,
        eval_id: null,
        dataset: spec.dataset,
        dataset_version: spec.dataset_version,
        status: "failed",
        score: null,
        cost_usd: 0,
        error,
      });
      if (
        checkpoint.format === null ||
        NON_DEPLOYABLE_FORMATS.includes(checkpoint.format)
      ) {
        await recordCheckpointEval(
          run.id,
          failed(
            `Checkpoint ${checkpoint.id} has format '${checkpoint.format ?? "none"}', which an inference endpoint can't serve.`,
          ),
        );
        continue;
      }
      try {
        await createRecord(
          run.workspace_id,
          PlanEvalRequestSchema.parse({
            name: spec.name,
            models: [checkpoint.id],
            dataset: spec.dataset,
            dataset_version: spec.dataset_version,
            rubric: spec.rubric,
            samples: 1,
            temperature: 0,
            ...(spec.limit !== null ? { limit: spec.limit } : {}),
          }),
          undefined,
          "eval",
          {
            runId: run.id,
            step: checkpoint.step,
            targets: {
              [checkpoint.id]: {
                inference_model: checkpoint.id,
                price_per_million_tokens:
                  deps.catalog.priceFor(run.resolved_config.model) ?? null,
              },
            },
          },
        );
      } catch (error) {
        await recordCheckpointEval(run.id, failed(errorMessage(error)));
      }
    }
  };

  return {
    plan: async (workspaceId, request) =>
      (await planEvalRequest(deps, datasets, workspaceId, request)).response,

    create: (workspaceId, request, idempotency) =>
      createOnce(
        idempotency,
        (key) => store.jobs.findIdempotent(workspaceId, key),
        async (id) => toPublic(await load(workspaceId, id)),
        async () =>
          toPublic(await createRecord(workspaceId, request, idempotency)),
      ),

    createRecord,

    evaluateCheckpoint,

    scoreDataset: (workspaceId, dataset, request, idempotency) =>
      createOnce(
        idempotency,
        (key) => store.jobs.findIdempotent(workspaceId, key),
        async (id) => toPublic(await load(workspaceId, id)),
        async () =>
          toPublic(
            await createRecord(
              workspaceId,
              {
                name: request.name ?? `${dataset.slice(0, 58)}-score`,
                models: [RECORD_MODEL],
                dataset,
                dataset_version: request.version,
                rubric: request.rubric,
                samples: 1,
                temperature: 0,
                max_tokens: 1,
                limit: request.limit,
                pass_threshold: null,
              } as PlanEvalRequest,
              idempotency,
              "score",
            ),
          ),
      ),

    handler,

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
        // Scoring is alive: restart the awaiting_scores timeout.
        await store.evals.update(
          id,
          { updated_at: clock.now().toISOString() },
          { status: ["awaiting_scores"] },
        );
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
          ...RELEASE,
          finished_at: clock.now().toISOString(),
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
      await onFinished(updated);

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

    settleAwaitingScores: async (now) => {
      const cutoff = addSeconds(now, -AWAITING_SCORES_TIMEOUT_SECONDS);
      let settled = 0;
      for (const record of await store.evals.listAwaitingScores(100)) {
        const missing = await store.evals.countMissingScores(
          record.id,
          record.local_scorers,
        );
        if (missing === 0) {
          if (await finalize(record, { status: ["awaiting_scores"] })) {
            settled += 1;
          }
          continue;
        }
        if (Date.parse(record.updated_at) > cutoff.getTime()) continue;
        const failed = await store.evals.update(
          record.id,
          {
            status: "failed",
            error: `Timed out after ${AWAITING_SCORES_TIMEOUT_SECONDS / 3600} h waiting for ${missing} local score(s) (code scorers ${record.local_scorers.join(", ")}). They are computed by the SDK: keep ev.wait() running until the eval completes, or run the scorers server-side.`,
            finished_at: now.toISOString(),
          },
          { status: ["awaiting_scores"] },
        );
        if (failed) {
          await onFinished(failed);
          settled += 1;
        }
      }

      return settled;
    },
  };
};
