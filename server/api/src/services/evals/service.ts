import type { z } from "@hono/zod-openapi";

import type { AuthPrincipal } from "../../adapters.js";
import { costForTokens } from "../../catalog.js";
import {
  checkpointEvalsUnsupported,
  evalsOnCloud,
} from "../../cloud/gateway.js";
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
  type TrainerJob,
} from "../../contracts.js";
import type {
  CompleteJobRequestSchema,
  PostEvalOutputsRequestSchema,
} from "../../contracts/trainer-jobs.js";
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
import type {
  CheckpointRecord,
  EvalOutputRow,
  EvalRecord,
  IdempotencyInput,
  JobExpectation,
  Page,
  ListFilter,
  PageRequest,
  RunRecord,
} from "../../store/types.js";

import { streamVersionGzip, writeRecordsPart } from "../dataset-records.js";
import { datasetPartKey, type DatasetService } from "../datasets.js";
import {
  DEFAULT_MAX_PREEMPTIONS,
  fenceOf,
  closedBy,
  holdsLease,
  leaseLost,
  observeInterruption,
  queueLimits,
  RELEASE,
  requeuePatch,
  workerKeyOf,
  type JobKindHandler,
  type JobQueue,
  isTerminal,
} from "../jobs.js";
import { metrics } from "../../telemetry/metrics.js";
import { scoreUpdate } from "../record-merge.js";
import { settleLabelledRuns } from "../router-labels.js";
import type { UsageService } from "../usage.js";
import { aggregateEval } from "./aggregate.js";
import { assertNonEmptyPlan, planEvalRequest } from "./planner.js";

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
  list(
    workspaceId: string,
    query: PageRequest & ListFilter,
  ): Promise<Page<EvalRun>>;
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
  /** Eval worker: stores a batch of outputs (once per key), prices and bills them. */
  postOutputs(
    principal: AuthPrincipal,
    id: string,
    body: z.infer<typeof PostEvalOutputsRequestSchema>,
  ): Promise<{ accepted: number; generated: number; should_stop: boolean }>;
  /** Eval worker: ends the attempt (aggregates a completed eval). */
  complete(
    principal: AuthPrincipal,
    id: string,
    body: z.infer<typeof CompleteJobRequestSchema>,
  ): Promise<EvalRun>;
  /** Eval worker: the eval's pinned dataset version as gzip JSONL. */
  datasetStream(
    principal: AuthPrincipal,
    id: string,
    attempt: number,
  ): Promise<ReadableStream<Uint8Array>>;
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

/** Thrown inside finalize's transaction when another caller finalized first. */
class LostRace extends Error {}
const OUTPUT_PAGE = 1000;
const ACTIVE: readonly EvalStatus[] = ["queued", "running", "awaiting_scores"];

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

/** The heartbeat phases an eval worker reports while its calls wait. */
const WAITING_REASONS: Readonly<
  Record<string, NonNullable<EvalRun["waiting_reason"]>>
> = {
  waiting_for_capacity: "capacity_unavailable",
  waiting_for_rate_limit: "rate_limited",
  waiting_for_inference: "inference_unavailable",
};

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
    waiting_reason:
      record.status !== "running"
        ? null
        : (WAITING_REASONS[record.worker_phase ?? ""] ?? null),
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
    record: Pick<EvalRecord, "id" | "kind" | "workspace_id" | "attempt">,
    final = true,
  ): Promise<void> => {
    if (record.attempt < 1) return;
    const spent = await store.evals.attemptUsage(record.id, record.attempt);
    await usage.flush(
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
    await billAttempt(record);
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
            // A requeue's note ("lost its lease; requeued") is history now.
            error: null,
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

  /** A judge's tokens at the price resolved at plan time (judges are always priced). */
  const judgeCost = (record: EvalRecord, judge: string, tokens: number) =>
    costForTokens(
      tokens,
      record.judge_targets[judge]?.price_per_million_tokens ??
        deps.catalog.judgePriceFor(judge) ??
        0,
    );

  /** What an output costs: its model's tokens plus its judges', at plan-time prices. */
  const outputCost = (
    record: EvalRecord,
    output: Pick<
      EvalOutputRow,
      "model" | "prompt_tokens" | "completion_tokens"
    > & { judge_tokens: Record<string, number> },
  ): number => {
    let cost = costForTokens(
      output.prompt_tokens + output.completion_tokens,
      record.model_targets[output.model]?.price_per_million_tokens ?? 0,
    );
    for (const [judge, tokens] of Object.entries(output.judge_tokens)) {
      cost += judgeCost(record, judge, tokens);
    }

    return Number(cost.toFixed(8));
  };

  /**
   * Ends the open attempt without a result: requeued, or failed at
   * max_attempts (or, for reclaimed compute, at MAX_PREEMPTIONS).
   */
  const requeueAttempt = async (
    row: Parameters<typeof requeuePatch>[0] & { id: string },
    what: string,
    fence: Parameters<typeof store.evals.update>[2],
    now: string,
    preempted = false,
  ): Promise<EvalRecord | null> =>
    store.transaction(async () => {
      const closed = await store.evals.update(
        row.id,
        requeuePatch(
          row,
          what,
          now,
          preempted
            ? {
                maxPreemptions:
                  deps.settings.maxPreemptions ?? DEFAULT_MAX_PREEMPTIONS,
              }
            : undefined,
        ) as Parameters<typeof store.evals.update>[1],
        fence,
      );
      if (closed) await billAttempt({ ...closed, attempt: row.attempt });
      if (closed?.status === "failed") await onFinished(closed);

      return closed;
    });

  /** Ends a cancelled eval's attempt: the lease goes, the outputs it posted bill. */
  const releaseCancelled = async (
    row: Pick<EvalRecord, "id" | "attempt">,
    fence: JobExpectation,
  ): Promise<void> => {
    await store.transaction(async () => {
      const released = await store.evals.update(row.id, { ...RELEASE }, fence);
      if (released) await billAttempt({ ...released, attempt: row.attempt });
    });
  };

  /** Done outputs per model as task_index * samples + sample_index. */
  const doneOutputs = async (
    record: EvalRecord,
  ): Promise<Record<string, number[]>> => {
    const done: Record<string, number[]> = {};
    for (const key of await store.evals.listOutputKeys(record.id)) {
      const [model, task, sample] = key.split("\u0000");
      (done[model as string] ??= []).push(
        Number(task) * record.samples + Number(sample),
      );
    }

    return done;
  };

  /** The job an eval worker gets: what to generate, and what is already stored. */
  const claimJob = async (row: EvalRecord): Promise<TrainerJob> => {
    const inferenceModels = (
      targets: Record<string, { inference_model: string }>,
    ) =>
      Object.fromEntries(
        Object.entries(targets).map(([ref, t]) => [
          ref,
          { inference_model: t.inference_model },
        ]),
      );
    const resolved = await datasets.resolve(
      row.workspace_id,
      row.dataset_name,
      row.dataset_version,
    );

    return {
      id: row.id,
      kind: "eval",
      attempt: row.attempt,
      lease_seconds: row.lease_seconds,
      lease_expires_at: row.lease_expires_at as string,
      run: null,
      import: null,
      eval: {
        id: row.id,
        workspace_id: row.workspace_id,
        name: row.name,
        mode: row.mode,
        models: row.models,
        model_targets: inferenceModels(row.model_targets),
        judge_targets: inferenceModels(row.judge_targets),
        rubric: row.rubric,
        samples: row.samples,
        temperature: row.temperature,
        max_tokens: row.max_tokens,
        limit: row.limit,
        done: await doneOutputs(row),
      },
      price_per_million_tokens: null,
      max_cost_usd: null,
      dataset: {
        version: resolved.version.version,
        record_count: resolved.version.record_count,
        download_url: `/v1/trainer-jobs/${row.id}/dataset?attempt=${row.attempt}`,
      },
      resume: null,
      base: null,
    };
  };

  const handler: JobKindHandler = {
    onClaim: async (row) => {
      const record = await store.evals.getById(row.id);
      if (!record) return null;
      try {
        return await claimJob(record);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        // Unbuildable (its dataset was deleted): fail it, claim the next.
        await store.transaction(async () => {
          const failed = await store.evals.update(
            record.id,
            {
              ...RELEASE,
              status: "failed",
              error: error.detail,
              finished_at: clock.now().toISOString(),
            },
            fenceOf(record, ["running"]),
          );
          if (failed) await onFinished(failed);
        });
        return null;
      }
    },
    stopReason: async (row) =>
      row.status === "cancelled" ? "cancelled" : null,
    onLeaseLost: async (row, fence, now) => {
      if (row.status === "cancelled") {
        await releaseCancelled(row, fence);
        return;
      }
      await requeueAttempt(
        row,
        `Eval attempt ${row.attempt} lost its lease`,
        fence,
        now.toISOString(),
      );
    },
  };

  /** The eval behind a worker write, if this worker holds `attempt`'s lease. */
  const loadLeased = async (
    principal: AuthPrincipal,
    id: string,
    workerId: string,
    attempt: number,
  ): Promise<EvalRecord> => {
    const row = await collaborators.queue().loadForWorker(principal, id);
    const record = row.kind === "eval" && (await store.evals.getById(id));
    if (!record) throw notFound("trainer_job", id);
    if (!holdsLease(principal, record, workerId, attempt)) throw leaseLost(id);

    return record;
  };

  /** A completed attempt: aggregate, wait for local scores, or fail. */
  const completeGenerated = async (
    job: EvalRecord,
    expect: JobExpectation,
  ): Promise<void> => {
    const outputs = await allOutputs(job.id);
    if (
      job.mode === "eval" &&
      outputs.length > 0 &&
      outputs.every((o) => o.output === null)
    ) {
      const first = outputs.find((o) => o.output === null)?.error;
      await failAttempt(
        job,
        expect,
        `Every model call failed; first error: ${first ?? "unknown"}`,
      );
      return;
    }

    if (job.local_scorers.length > 0) {
      const missing = await store.evals.countMissingScores(
        job.id,
        job.local_scorers,
      );
      if (missing > 0) {
        await store.transaction(async () => {
          const waiting = await store.evals.update(
            job.id,
            {
              ...RELEASE,
              status: "awaiting_scores",
              generated: outputs.length,
            },
            expect,
          );
          if (waiting) await billAttempt(waiting);
        });
        return;
      }
    }

    await finalize({ ...job, generated: outputs.length }, expect);
  };

  /** Fails the eval; the status and its bill commit together. */
  const failAttempt = async (
    job: EvalRecord,
    expect: JobExpectation,
    error: string,
  ): Promise<void> => {
    await store.transaction(async () => {
      const failed = await store.evals.update(
        job.id,
        {
          ...RELEASE,
          status: "failed",
          error: error.slice(0, 4000),
          finished_at: clock.now().toISOString(),
        },
        expect,
      );
      if (failed) await onFinished(failed);
    });
  };

  const postOutputs: EvalService["postOutputs"] = async (
    principal,
    id,
    body,
  ) => {
    const job = await loadLeased(principal, id, body.worker_id, body.attempt);
    const judges = new Set(Object.keys(job.judge_targets));
    for (const o of body.outputs) {
      const known =
        job.models.includes(o.model) &&
        o.sample_index < job.samples &&
        Object.keys(o.judge_tokens).every((j) => judges.has(j));
      if (!known) {
        throw invalid(
          "unknown_eval_output",
          `Output (${o.model}, task ${o.task_index}, sample ${o.sample_index}) is not part of eval '${id}' (models ${job.models.join(", ")}, ${job.samples} sample(s), judges ${[...judges].join(", ") || "none"}).`,
        );
      }
    }
    const now = clock.now().toISOString();
    const rows: EvalOutputRow[] = body.outputs.map((o) => ({
      id: newId("evout"),
      eval_id: id,
      attempt: job.attempt,
      record: o.record as EvalOutputRow["record"],
      task_index: o.task_index,
      task_id: o.task_id,
      model: o.model,
      sample_index: o.sample_index,
      input: o.input as EvalOutputRow["input"],
      output: o.output,
      expected_output: o.expected_output ?? null,
      scores: o.scores,
      error: o.error,
      prompt_tokens: o.prompt_tokens,
      completion_tokens: o.completion_tokens,
      cost_usd: outputCost(job, o),
      created_at: now,
    }));

    // The outputs, the progress and the bill commit together, fenced on
    // the lease: a worker that lost it stores nothing.
    const result = await store.transaction(async () => {
      const accepted = await store.evals.insertOutputs(rows);
      const generated = await store.evals.countOutputs(id);
      const progressed = await store.evals.update(
        id,
        { generated },
        fenceOf(job, ["running", "cancelled"]),
      );
      if (!progressed) throw leaseLost(id);
      // A cancelled eval's last outputs bill now: its close may never come.
      await billAttempt(progressed, progressed.status === "cancelled");

      return {
        accepted,
        generated,
        should_stop: progressed.status === "cancelled",
      };
    });
    if (result.accepted > 0 && body.calls) {
      const c = body.calls;
      if (c.model_ok) metrics.evalOutputs.inc({ result: "ok" }, c.model_ok);
      if (c.model_error) {
        metrics.evalOutputs.inc({ result: "error" }, c.model_error);
      }
      if (c.judge_ok) metrics.judgeCalls.inc({ result: "ok" }, c.judge_ok);
      if (c.judge_error) {
        metrics.judgeCalls.inc({ result: "error" }, c.judge_error);
      }
      for (const [target, errors] of [
        ["model", c.model_errors],
        ["judge", c.judge_errors],
      ] as const) {
        for (const [reason, n] of Object.entries(errors ?? {})) {
          if (n) metrics.evalInferenceErrors.inc({ target, reason }, n);
        }
      }
    }

    return result;
  };

  const complete: EvalService["complete"] = async (principal, id, body) => {
    const row = await collaborators.queue().loadForWorker(principal, id);
    const job = row.kind === "eval" ? await store.evals.getById(id) : null;
    if (!job) throw notFound("trainer_job", id);
    if (!holdsLease(principal, job, body.worker_id, body.attempt)) {
      // Idempotent retry of a completion that already committed.
      if (closedBy(principal, job, body.attempt)) {
        return toPublic(job);
      }
      throw leaseLost(id);
    }
    const now = clock.now().toISOString();
    if (job.status === "cancelled") {
      // Cancelled while it ran: whatever the worker reports, it ends here.
      await releaseCancelled(job, fenceOf(job, ["cancelled"]));
      return toPublic(await load(job.workspace_id, id));
    }
    const expect = fenceOf(job, ["running"]);

    if (body.status === "completed") {
      await completeGenerated(job, expect);
    } else if (body.status === "abandoned") {
      const reason = body.reason ?? "worker_error";
      observeInterruption(job, reason);
      await requeueAttempt(
        job,
        `Eval attempt ${job.attempt} was handed back by its worker${body.error ? ` (${body.error.slice(0, 200)})` : ""}`,
        expect,
        now,
        reason === "compute_reclaimed",
      );
    } else if (body.status === "failed") {
      await failAttempt(
        job,
        expect,
        body.error ?? "The eval worker reported a failure.",
      );
    } else {
      throw invalid(
        "unsupported_completion",
        `Eval '${id}' is ${job.status}: its attempt completes as completed, failed or abandoned, not '${body.status}'.`,
      );
    }

    return toPublic(await load(job.workspace_id, id));
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

  /**
   * Cloud: artifact targets (`name@version`) are served by the gateway under
   * the eval-only Version the product publishes for them; catalog models and
   * judges under their canonical-case serving id (the gateway matches ids
   * exactly; grad's own ids are lowercase).
   */
  const servedTargets = async <T extends { inference_model: string }>(
    workspaceId: string,
    targets: Record<string, T>,
  ): Promise<Record<string, T>> => {
    const resolver = deps.evalModels;
    if (!resolver) return targets;
    const served: Record<string, T> = {};
    for (const [ref, target] of Object.entries(targets)) {
      served[ref] = target.inference_model.includes("@")
        ? {
            ...target,
            inference_model: await resolver.servingModel(
              workspaceId,
              target.inference_model,
            ),
          }
        : {
            ...target,
            inference_model:
              deps.catalog.servingId(target.inference_model) ??
              target.inference_model,
          };
    }

    return served;
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
    if (checkpoint && evalsOnCloud(deps)) throw checkpointEvalsUnsupported();
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
    const modelTargets = await servedTargets(workspaceId, plan.targets);
    const judgeTargets = await servedTargets(workspaceId, plan.judgeTargets);

    return store.evals.create({
      workspaceId,
      maxAttempts: deps.settings.maxAttempts,
      maxQueued: queueLimits(deps.settings).maxQueued,
      idempotency,
      name: request.name,
      models: request.models,
      model_targets: modelTargets,
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
      judge_targets: judgeTargets,
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
    if (!isTerminal(record.status)) return null;

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

    list: async (workspaceId, { limit, cursor, ...filter }) => {
      const rows = await store.evals.list(
        workspaceId,
        { limit, cursor },
        filter,
      );

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
      // A replayed cancel (lost response, SDK retry) gets the current state.
      if (record.status === "cancelled") return toPublic(record);
      // A running eval keeps its lease, so the worker can still post (and
      // bill) the outputs in flight; it stops at its next batch or beat.
      const leased = record.status === "running" && record.worker_id !== null;
      // The status and its bill commit together.
      const updated = await store.transaction(async () => {
        const cancelled = await store.evals.update(
          id,
          {
            status: "cancelled",
            ...(leased ? {} : RELEASE),
            finished_at: clock.now().toISOString(),
          },
          leased
            ? { status: ["running"], workerId: record.worker_id }
            : { status: ACTIVE },
        );
        if (cancelled) await onFinished(cancelled);
        return cancelled;
      });
      if (!updated) {
        const now = await load(workspaceId, id);
        if (now.status === "cancelled") return toPublic(now);
        throw new ApiError(
          409,
          "eval_not_cancellable",
          "Eval cannot be cancelled",
          `Eval '${id}' is already ${now.status}.`,
        );
      }

      return toPublic(updated);
    },

    postOutputs,

    complete,

    datasetStream: async (principal, id, attempt) => {
      const row = await collaborators.queue().loadForWorker(principal, id);
      if (row.kind !== "eval") throw notFound("trainer_job", id);
      // Only the credential holding the lease reads the eval's data.
      if (
        row.attempt !== attempt ||
        row.worker_id === null ||
        row.worker_key !== workerKeyOf(principal)
      ) {
        throw leaseLost(id);
      }
      const record = await load(row.workspace_id, id);
      const resolved = await datasets.resolve(
        record.workspace_id,
        record.dataset_name,
        record.dataset_version,
      );

      return streamVersionGzip(deps.storage, resolved.version);
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
