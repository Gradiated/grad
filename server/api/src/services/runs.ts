import type { AuthPrincipal } from "../adapters.js";
import { costForTokens } from "../catalog.js";
import { addDays } from "../clock.js";
import {
  ArtifactFormatSchema,
  PlanEvalRequestSchema,
  type CheckpointEvalSpec,
  RUN_EVENT_TYPES,
  type Artifact,
  type ArtifactFormat,
  type Checkpoint,
  type DatasetRecord,
  type EvalStatus,
  type MetricPoint,
  type PlanRunRequest,
  type InterruptionReason,
  type PlanRunResponse,
  type RecipeKind,
  type Run,
  type RunEvent,
  type TrainerJob,
  type UploadTicket,
} from "../contracts.js";
import type { z } from "@hono/zod-openapi";
import type {
  CompleteJobRequestSchema,
  RegisterCheckpointRequestSchema,
  ReportEventRequestSchema,
  ReportProgressRequestSchema,
  WorkerUploadRequestSchema,
} from "../contracts/trainer-jobs.js";
import type { AppDependencies } from "../deps.js";
import {
  conflict,
  forbidden,
  invalid,
  notFound,
  unavailable,
} from "../errors.js";
import { createOnce, type Created } from "../idempotency.js";
import { isArtifactRef } from "../continued-training.js";
import { planRun } from "../planner.js";
import { assertSecretHost, loggerUrl } from "../secret-hosts.js";
import { assertNonEmptyPlan, planEvalRequest } from "./evals/planner.js";
import { decodeCursor, encodeCursor } from "../store/cursor.js";
import type {
  ArtifactRecord,
  CheckpointRecord,
  DatasetVersion,
  IdempotencyInput,
  JobExpectation,
  JobRow,
  Page,
  PageRequest,
  Repositories,
  RunPatch,
  RunRecord,
} from "../store/types.js";
import { gzipJsonlStream, streamVersionGzip } from "./dataset-records.js";
import type { DatasetService } from "./datasets.js";
import type { EvalService } from "./evals/service.js";
import {
  labelingEvalRequest,
  labelRecords,
  settleLabelledRuns,
  toLabelingPlan,
} from "./router-labels.js";
import {
  DEFAULT_MAX_PREEMPTIONS,
  fenceOf,
  holdsLease,
  leaseLost,
  RELEASE,
  requeuePatch,
  type JobKindHandler,
  observeInterruption,
  type JobQueue,
  type StopReason,
} from "./jobs.js";
import {
  REASON_TEXT,
  appendAttempt,
  appendNote,
  appendPhase,
  toInterruption,
  toMetricPoint,
  toRunEvent,
} from "./run-events.js";
import { jobBlobKey, type UploadService } from "./uploads.js";
import type { UsageService } from "./usage.js";
import {
  metrics,
  modelFamily,
  observeCheckpoint,
} from "../telemetry/metrics.js";

type ProgressBody = z.infer<typeof ReportProgressRequestSchema>;
type WorkerUploadBody = z.infer<typeof WorkerUploadRequestSchema>;
type CheckpointBody = z.infer<typeof RegisterCheckpointRequestSchema>;
type CompleteBody = z.infer<typeof CompleteJobRequestSchema>;
type EventBody = z.infer<typeof ReportEventRequestSchema>;

/** Live queue context of a queued run (null fields otherwise). */
export interface RunCompute {
  workers_online: number | null;
  autoscaling: boolean | null;
}

const NO_COMPUTE: RunCompute = { workers_online: null, autoscaling: null };

const EVAL_TERMINAL: readonly EvalStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

const TERMINAL: readonly Run["status"][] = [
  "completed",
  "failed",
  "cancelled",
  "stopped_budget",
  "stopped_balance",
];

export const defaultFormatForRecipe = (kind: RecipeKind): ArtifactFormat => {
  switch (kind) {
    case "cartridge":
      return "cartridge";
    case "embedding":
      return "encoder_safetensors";
    case "router":
      return "router_bundle";
    case "decision":
      return "decision_bundle";
    case "reward":
      return "reward_bundle";
    default:
      return "peft_lora";
  }
};

/** Tokens are the source of truth; cost is derived from them in one place. */
/** Retention: the last N checkpoints of a run stay, plus the best and final ones. */
export const CHECKPOINTS_KEPT = 3;

/**
 * The best checkpoint by eval score, in the direction of the run's metric
 * (`metadata.metric_mode`: eval_loss is "min", accuracy-style metrics "max").
 * Ties go to the later checkpoint, like the trainer's select="best".
 */
export const bestCheckpoint = (
  checkpoints: readonly CheckpointRecord[],
): CheckpointRecord | null =>
  checkpoints.reduce<CheckpointRecord | null>((acc, c) => {
    if (c.eval_score === null) return acc;
    if (acc === null || acc.eval_score === null) return c;
    // The trainer stores the selection metric's direction with it: minimised
    // (eval_loss, eval_kl) or maximised (accuracy, recall@10).
    const lower = metricMode(c.metadata) === "min";

    return (
      lower ? c.eval_score <= acc.eval_score : c.eval_score >= acc.eval_score
    )
      ? c
      : acc;
  }, null);

const runCost = (run: RunRecord, attemptTokens = run.attempt_tokens): number =>
  costForTokens(
    run.billed_tokens + attemptTokens,
    run.price_per_million_tokens,
  );

const billedCost = (run: RunRecord): number => runCost(run, 0);

export const toPublicRun = (
  run: RunRecord,
  compute: RunCompute = NO_COMPUTE,
): Run => ({
  id: run.id,
  workspace_id: run.workspace_id,
  name: run.name,
  dataset_id: run.dataset_id,
  dataset_name: run.dataset_name,
  dataset_version: run.dataset_version,
  recipe_kind: run.recipe_kind,
  status: run.status,
  resolved_config: run.resolved_config,
  max_cost_usd: run.max_cost_usd,
  price_per_million_tokens: run.price_per_million_tokens,
  tokens_processed: run.billed_tokens + run.attempt_tokens,
  cost_usd: runCost(run),
  current_step: run.current_step,
  total_steps: run.total_steps,
  attempt: run.attempt,
  max_attempts: run.max_attempts,
  phase: (run.phase_event?.payload.phase as Run["phase"] | undefined) ?? null,
  phase_since: run.phase_event?.created_at ?? null,
  last_interruption: toInterruption(run.interruption_event),
  workers_online: compute.workers_online,
  autoscaling: compute.autoscaling,
  latest_metric: run.latest_metric,
  eval_report:
    run.eval_report && run.checkpoint_evals.length > 0
      ? { ...run.eval_report, checkpoint_evals: run.checkpoint_evals }
      : run.eval_report,
  checkpoint_evals: run.checkpoint_evals,
  artifact_id: run.artifact_id,
  error: run.error,
  created_at: run.created_at,
  updated_at: run.updated_at,
  finished_at: run.finished_at,
});

export const toPublicArtifact = ({
  storage_key: _key,
  ...artifact
}: ArtifactRecord): Artifact => artifact;

export const toPublicCheckpoint = ({
  storage_key: _key,
  ...checkpoint
}: CheckpointRecord): Checkpoint => checkpoint;

/** Losses are minimised; a checkpoint without metric_mode falls back on its metric name. */
const MINIMISED_METRICS = new Set(["eval_loss", "eval_kl", "loss"]);

export const metricMode = (
  metadata: Record<string, unknown>,
): "min" | "max" => {
  const mode = metadata["metric_mode"];
  if (mode === "min" || mode === "max") return mode;
  const name = metadata["metric_name"];

  return typeof name === "string" && MINIMISED_METRICS.has(name)
    ? "min"
    : "max";
};

/** The error of a run stopped for lack of workspace balance (stopped_balance). */
export const BALANCE_STOPPED =
  "Stopped because the workspace ran out of balance (insufficient_balance); top up, then resume the run.";

/** The error of a run stopped at its own cost cap (stopped_budget). */
const budgetStopped = (spent: number, cap: number | null): string =>
  `Stopped at the run's cost cap ($${spent.toFixed(4)} of $${(cap ?? spent).toFixed(4)}); resume with a higher max_cost_usd.`;

const stopReason = (run: RunRecord): StopReason => {
  if (run.status === "cancelled") return "cancelled";
  if (run.max_cost_usd !== null && runCost(run) >= run.max_cost_usd)
    return "budget";

  return null;
};

export interface EventsQuery {
  cursor?: string | undefined;
  limit: number;
}

export interface MetricsQuery {
  cursor?: string | undefined;
  afterStep?: number | undefined;
  limit: number;
}

export interface RunLifecycle {
  plan(workspaceId: string, request: PlanRunRequest): Promise<PlanRunResponse>;
  create(
    workspaceId: string,
    request: PlanRunRequest,
    idempotency?: IdempotencyInput,
  ): Promise<Created<Run>>;
  get(workspaceId: string, id: string): Promise<Run>;
  list(workspaceId: string, page: PageRequest): Promise<Page<Run>>;
  metrics(
    workspaceId: string,
    id: string,
    query: MetricsQuery,
  ): Promise<{
    run: Run;
    data: MetricPoint[];
    next_cursor: string | null;
    tail_cursor: string;
  }>;
  events(
    workspaceId: string,
    id: string,
    query: EventsQuery,
  ): Promise<{
    run: Run;
    data: RunEvent[];
    next_cursor: string | null;
    tail_cursor: string;
  }>;
  /** The terminal event once the run is final and released, else null. */
  completedEvent(run: RunRecord, lastSeq: number): Promise<RunEvent | null>;
  cancel(workspaceId: string, id: string): Promise<Run>;
  resume(workspaceId: string, id: string, maxCostUsd?: number): Promise<Run>;
  listCheckpoints(
    workspaceId: string,
    runId: string,
    page: PageRequest,
  ): Promise<Page<Checkpoint>>;
  promoteCheckpoint(
    workspaceId: string,
    checkpointId: string,
    name?: string,
  ): Promise<Artifact>;

  // Worker protocol (train jobs).
  progress(
    principal: AuthPrincipal,
    id: string,
    body: ProgressBody,
  ): Promise<{
    status: Run["status"];
    should_stop: boolean;
    stop_reason: StopReason;
    cost_usd: number;
  }>;
  createUpload(
    principal: AuthPrincipal,
    id: string,
    body: WorkerUploadBody,
  ): Promise<UploadTicket>;
  registerCheckpoint(
    principal: AuthPrincipal,
    id: string,
    body: CheckpointBody,
  ): Promise<{ checkpoint: Checkpoint; created: boolean }>;
  complete(
    principal: AuthPrincipal,
    id: string,
    body: CompleteBody,
  ): Promise<{ run: Run; artifact: Artifact | null }>;
  reportEvent(
    principal: AuthPrincipal,
    id: string,
    body: EventBody,
  ): Promise<void>;
  datasetStream(
    principal: AuthPrincipal,
    id: string,
    attempt: number,
  ): Promise<ReadableStream<Uint8Array>>;

  /** The train kind's hooks in the job queue. */
  handler: JobKindHandler;
  /** Deletes expired checkpoints (and blobs no release shares). */
  collectExpiredCheckpoints(now: Date): Promise<number>;
  /** Marks queued runs nobody claimed in time waiting_for_compute. */
  markWaitingForCompute(now: Date): Promise<number>;
}

export { toMetricPoint };

export const createRunLifecycle = (
  deps: AppDependencies,
  collaborators: {
    datasets: DatasetService;
    uploads: UploadService;
    usage: UsageService;
    evals: EvalService;
    queue: () => JobQueue;
  },
): RunLifecycle => {
  const { store, storage, catalog, clock, settings } = deps;
  const { datasets, uploads, usage, evals } = collaborators;

  const loadRun = async (
    workspaceId: string,
    id: string,
  ): Promise<RunRecord> => {
    const run = await store.runs.get(workspaceId, id);
    if (!run) throw notFound("run", id);

    return run;
  };

  const loadById = async (id: string): Promise<RunRecord> => {
    const run = await store.runs.getById(id);
    if (!run) throw notFound("trainer_job", id);

    return run;
  };

  /** The run behind a worker write, if this worker holds `attempt`'s lease. */
  const loadLeased = async (
    principal: AuthPrincipal,
    id: string,
    workerId: string,
    attempt: number,
  ): Promise<RunRecord> => {
    await collaborators.queue().loadLeased(principal, id, workerId, attempt);

    return loadById(id);
  };

  const planFor = async (workspaceId: string, request: PlanRunRequest) => {
    const resolved = await datasets.resolve(workspaceId, request.dataset);
    const records = await datasets.readRecords(resolved.version);
    const baseArtifact = isArtifactRef(request.recipe.model)
      ? await store.artifacts.get(workspaceId, request.recipe.model)
      : null;
    const labelRequest = labelingEvalRequest(request, resolved.version.version);
    if (labelRequest && deps.inference === null) {
      throw unavailable(
        "inference_unavailable",
        request.recipe.kind === "router"
          ? 'This router labels your prompts with an eval (it replays them through recipe.models and scores the answers), which needs a model endpoint: set GRAD_INFERENCE_BASE_URL on the server (for `grad local up`, export it before starting the stack), or train on scores already in your records (rubric="resolved", a score name).'
          : "Off-policy distillation generates the teacher's answers with an eval, which needs a model endpoint: set GRAD_INFERENCE_BASE_URL on the server (for `grad local up`, export it before starting the stack), or use rollout=OnPolicy(...).",
      );
    }
    const labeling = labelRequest
      ? toLabelingPlan(await evals.plan(workspaceId, labelRequest))
      : null;
    const plan = planRun(request, records, {
      catalog,
      datasetVersion: resolved.version.version,
      baseArtifact: baseArtifact && toPublicArtifact(baseArtifact),
      labeling,
    });
    await planCheckpointEvals(workspaceId, request, plan);
    if (request.recipe.loggers) {
      plan.resolved_config.loggers = request.recipe.loggers;
      plan.warnings.push(...(await loggerWarnings(workspaceId, request)));
    }

    return { plan, dataset: resolved.dataset, labelRequest };
  };

  /**
   * recipe.evals: pins each eval's dataset version and rubric into the
   * resolved config (judges need an inference endpoint, code scorers can't
   * run during training) and warns with the cost per checkpoint.
   */
  const planCheckpointEvals = async (
    workspaceId: string,
    request: PlanRunRequest,
    plan: PlanRunResponse,
  ): Promise<void> => {
    const specs = request.recipe.evals;
    if (!specs) return;

    const names = specs.map((s) => s.name ?? s.dataset);
    if (new Set(names).size !== names.length) {
      throw invalid(
        "duplicate_checkpoint_eval",
        `recipe.evals names must be unique (got ${names.join(", ")}); pass name= to tell evals on the same dataset apart.`,
      );
    }
    const pinned: CheckpointEvalSpec[] = [];
    let costPerCheckpoint = 0;
    for (const [i, spec] of specs.entries()) {
      // Planned against the base model: the checkpoints share its price.
      const evalPlan = await planEvalRequest(
        deps,
        datasets,
        workspaceId,
        PlanEvalRequestSchema.parse({
          name: names[i],
          models: [plan.resolved_config.model],
          dataset: spec.dataset,
          ...(spec.version !== undefined
            ? { dataset_version: spec.version }
            : {}),
          ...(spec.rubric ? { rubric: spec.rubric } : {}),
          ...(spec.limit !== undefined ? { limit: spec.limit } : {}),
          samples: 1,
          temperature: 0,
        }),
      );
      if (evalPlan.localScorers.length > 0) {
        throw invalid(
          "checkpoint_eval_code_scorer",
          `recipe.evals '${names[i]}' has code scorers (${evalPlan.localScorers.join(", ")}); evals during training take judges, regexes and validators. Run code scorers in an eval on run.artifact after training.`,
        );
      }
      assertNonEmptyPlan(evalPlan);
      pinned.push({
        name: names[i] as string,
        dataset: evalPlan.dataset.dataset.name,
        dataset_version: evalPlan.dataset.version.version,
        rubric: evalPlan.rubric,
        limit: spec.limit ?? null,
      });
      costPerCheckpoint += evalPlan.response.estimated_cost_usd;
    }
    plan.resolved_config.checkpoint_evals = pinned;
    const points = Math.max(
      1,
      Math.ceil(plan.estimated_steps / plan.resolved_config.eval_every_steps),
    );
    plan.warnings.push(
      `recipe.evals run ${pinned.length} eval(s) on each checkpoint (about ${points}), estimated $${costPerCheckpoint.toFixed(4)} per checkpoint, billed as evals and not capped by max_cost_usd.`,
    );
  };

  /** The run's training records: its pinned dataset version, or its labeling eval's answers. */
  const trainingRecords = async (
    run: RunRecord,
  ): Promise<
    | { kind: "dataset"; version: DatasetVersion }
    | { kind: "labels"; records: DatasetRecord[] }
  > => {
    const evalId = run.resolved_config.label_eval_id;
    if (evalId) {
      const labels = await store.evals.getById(evalId);
      if (!labels) {
        throw new Error(
          `Labeling eval '${evalId}' of run '${run.id}' is missing.`,
        );
      }

      return { kind: "labels", records: await labelRecords(store, labels) };
    }
    const version = await store.datasets.getVersion(
      run.dataset_id,
      run.dataset_version,
    );
    if (!version) {
      throw notFound(
        "dataset_version",
        `${run.dataset_name}@${run.dataset_version}`,
      );
    }

    return { kind: "dataset", version };
  };

  /**
   * Checkpoint retention, applied as each one registers: a run keeps its last
   * CHECKPOINTS_KEPT checkpoints plus the best by eval so far; the others expire
   * now (best and final are pinned when the run ends; kept ones expire after
   * checkpoint_ttl_days).
   */
  const applyCheckpointRetention = async (
    run: RunRecord,
    now: Date,
  ): Promise<void> => {
    const all = await store.artifacts.allCheckpoints(run.id, now);
    const keep = new Set(all.slice(-CHECKPOINTS_KEPT).map((c) => c.id));
    const best = bestCheckpoint(all);
    if (best) keep.add(best.id);
    await store.artifacts.expireCheckpoints(
      run.id,
      all.filter((c) => !keep.has(c.id)).map((c) => c.id),
      now,
    );
  };

  const pinCheckpoints = async (
    tx: Repositories,
    run: RunRecord,
    now: Date,
  ): Promise<void> => {
    const all = await tx.artifacts.allCheckpoints(run.id, now);
    if (all.length === 0) return;

    const best = bestCheckpoint(all);
    const final = all.reduce((acc, c) =>
      c.step > acc.step || (c.step === acc.step && c.attempt >= acc.attempt)
        ? c
        : acc,
    );

    await tx.artifacts.pinCheckpoints(run.id, {
      bestId: best?.id ?? null,
      finalId: final.id,
    });
  };

  /** The open attempt's usage when it has processed `tokens`. */
  const attemptUsage = (run: RunRecord, tokens: number) => ({
    tokens,
    costUsd: costForTokens(tokens, run.price_per_million_tokens),
  });

  /** Live queue context while a run waits for a worker. */
  const computeFor = async (run: RunRecord): Promise<RunCompute> =>
    run.status === "queued" && run.waiting_on === null
      ? {
          workers_online: await store.jobs.countLeasedWorkers(
            "train",
            clock.now(),
          ),
          autoscaling: settings.workerAutoscaling ?? false,
        }
      : NO_COMPUTE;

  const publicRun = async (run: RunRecord): Promise<Run> =>
    toPublicRun(run, await computeFor(run));

  /** The step the next attempt resumes from (its newest checkpoint), or null. */
  const resumeStepOf = async (tx: Repositories, runId: string) => {
    const steps = (await tx.artifacts.allCheckpoints(runId, clock.now())).map(
      (c) => c.step,
    );

    return steps.length > 0 ? Math.max(...steps) : null;
  };

  /** The `queued` phase of the run's next attempt. */
  const markQueued = async (tx: Repositories, run: RunRecord) => {
    const compute = await computeFor(run);
    await appendPhase(tx.jobs, {
      jobId: run.id,
      attempt: run.attempt + 1,
      phase: "queued",
      step: (await resumeStepOf(tx, run.id)) ?? 0,
      info: { ...compute },
    });
  };

  /** Closes an open attempt: bills the rest of it and applies `patch`, atomically. */
  const closeAttempt = async (
    tx: Repositories,
    run: RunRecord,
    tokens: number,
    patch: RunPatch,
    fence: JobExpectation = fenceOf(run),
  ): Promise<RunRecord> => {
    const now = clock.now();
    // The fenced write locks the job row, so the progress reports that
    // committed before it are visible to the reads below.
    const closed = await tx.runs.update(
      run.id,
      { ...patch, ...RELEASE, updated_at: now.toISOString() },
      fence,
    );
    if (!closed) throw leaseLost(run.id);
    const used = Math.max(tokens, closed.attempt_tokens);
    await usage.flush(tx, closed, attemptUsage(closed, used), true);
    const updated = (await tx.runs.update(run.id, {
      billed_tokens: closed.billed_tokens + used,
      attempt_tokens: 0,
    })) as RunRecord;
    if (TERMINAL.includes(updated.status)) {
      await pinCheckpoints(tx, updated, now);
    }

    return updated;
  };

  /**
   * Closes an attempt that ended without a result: requeues the run (or
   * fails it once its cap is reached) and records the interruption.
   * Preemptions count toward their own cap, everything else toward
   * max_attempts.
   */
  const interrupt = async (
    tx: Repositories,
    run: RunRecord,
    input: {
      reason: InterruptionReason;
      tokens: number;
      now: string;
      fence?: JobExpectation;
    },
  ): Promise<RunRecord> => {
    if (run.status === "cancelled") {
      return closeAttempt(
        tx,
        run,
        input.tokens,
        { status: "cancelled", finished_at: input.now },
        input.fence,
      );
    }
    const what =
      input.reason === "lease_lost"
        ? `Attempt ${run.attempt} lost its lease`
        : `Attempt ${run.attempt} ended early (${REASON_TEXT[input.reason]})`;
    const patch = requeuePatch(
      run,
      what,
      input.now,
      input.reason === "compute_reclaimed"
        ? {
            maxPreemptions: settings.maxPreemptions ?? DEFAULT_MAX_PREEMPTIONS,
          }
        : undefined,
    );
    const updated = await closeAttempt(
      tx,
      run,
      input.tokens,
      patch,
      input.fence,
    );

    const event = {
      jobId: run.id,
      attempt: run.attempt,
      reason: input.reason,
      step: run.current_step,
      resumeStep: await resumeStepOf(tx, run.id),
      maxAttempts: run.max_attempts,
    };
    await appendAttempt(tx.jobs, { ...event, event: "interrupted" });
    if (updated.status === "queued") await markQueued(tx, updated);
    else await appendAttempt(tx.jobs, { ...event, event: "gave_up" });

    return updated;
  };

  const buildJob = async (run: RunRecord): Promise<TrainerJob> => {
    const training = await trainingRecords(run);

    const resume = (await store.artifacts.allCheckpoints(run.id, clock.now()))
      .sort((a, b) => b.step - a.step || b.attempt - a.attempt)
      .at(0);
    const baseRef = run.resolved_config.base_artifact;
    const base = baseRef
      ? await store.artifacts.get(run.workspace_id, baseRef.id)
      : null;
    if (baseRef && base?.sha256 !== baseRef.sha256) {
      throw new Error(
        `Starting artifact '${baseRef.id}' of run '${run.id}' is missing or changed.`,
      );
    }

    return {
      id: run.id,
      kind: "train",
      attempt: run.attempt,
      lease_seconds: run.lease_seconds,
      lease_expires_at: run.lease_expires_at as string,
      run: {
        id: run.id,
        workspace_id: run.workspace_id,
        name: run.name,
        recipe_kind: run.recipe_kind,
        resolved_config: run.resolved_config,
        total_steps: run.total_steps,
      },
      import: null,
      price_per_million_tokens: run.price_per_million_tokens,
      max_cost_usd:
        run.max_cost_usd === null
          ? null
          : Number(Math.max(0, run.max_cost_usd - billedCost(run)).toFixed(6)),
      dataset: {
        version: run.dataset_version,
        record_count:
          training.kind === "dataset"
            ? training.version.record_count
            : training.records.length,
        download_url: `/v1/trainer-jobs/${run.id}/dataset?attempt=${run.attempt}`,
      },
      resume: resume
        ? {
            checkpoint_id: resume.id,
            step: resume.step,
            download_url: await uploads.downloadUrl(resume.storage_key),
          }
        : null,
      base: base
        ? {
            artifact_id: base.id,
            sha256: base.sha256,
            download_url: await uploads.downloadUrl(base.storage_key),
          }
        : null,
      ...(run.resolved_config.loggers
        ? { loggers: await resolveLoggers(run) }
        : {}),
    };
  };

  /**
   * The secret a logger names, or null when it can't be read (the plan
   * warned) or may no longer be sent to the logger's host (re-set since).
   */
  const loggerSecret = async (
    workspaceId: string,
    name: string,
    url: string,
  ): Promise<string | null> => {
    if (!deps.secrets) return null;
    const secret = await store.secrets.get(workspaceId, name);
    const sealed = await store.secrets.getSealed(workspaceId, name);
    if (!secret || !sealed) return null;
    try {
      assertSecretHost(secret, url, "logger");
    } catch {
      return null;
    }

    return deps.secrets.open(workspaceId, name, sealed);
  };

  /** recipe.loggers with their secrets as `api_key`, for the worker only. */
  const resolveLoggers = async (
    run: RunRecord,
  ): Promise<Array<Record<string, unknown>>> => {
    const out: Array<Record<string, unknown>> = [];
    for (const spec of run.resolved_config.loggers ?? []) {
      const { secret, ...logger } = spec;
      if (secret === undefined) {
        out.push(logger);
        continue;
      }
      const key = await loggerSecret(run.workspace_id, secret, loggerUrl(spec));
      if (key !== null) out.push({ ...logger, api_key: key });
    }

    return out;
  };

  /**
   * Plan warnings for loggers whose secret this server can't read; 422
   * secret_host_not_allowed for a secret that may not go to the logger's host.
   */
  const loggerWarnings = async (
    workspaceId: string,
    request: PlanRunRequest,
  ): Promise<string[]> => {
    const warnings: string[] = [];
    for (const logger of request.recipe.loggers ?? []) {
      if (logger.secret === undefined) continue;
      const secret = deps.secrets
        ? await store.secrets.get(workspaceId, logger.secret)
        : null;
      if (!deps.secrets) {
        warnings.push(
          `Logger '${logger.kind}' needs secret '${logger.secret}', but workspace secrets are not configured (GRAD_SECRETS_KEY); the run trains without it.`,
        );
      } else if (!secret) {
        warnings.push(
          `Logger '${logger.kind}': no secret named '${logger.secret}' (store it with 'grad secrets set ${logger.secret}'); the run trains without it.`,
        );
      } else {
        assertSecretHost(secret, loggerUrl(logger), `${logger.kind} logger`);
      }
    }

    return warnings;
  };
  const completedEvent = async (
    run: RunRecord,
    lastSeq: number,
  ): Promise<RunEvent | null> =>
    TERMINAL.includes(run.status) && run.worker_id === null
      ? {
          type: "completed",
          run_id: run.id,
          seq: lastSeq,
          attempt: Math.max(1, run.attempt),
          timestamp: run.finished_at ?? run.updated_at,
          status: run.status,
          run: toPublicRun(run),
        }
      : null;

  const handler: JobKindHandler = {
    onClaim: async (row, renewed, worker) => {
      const run = await loadById(row.id);
      const now = clock.now().toISOString();
      if (
        !renewed &&
        run.max_cost_usd !== null &&
        billedCost(run) >= run.max_cost_usd
      ) {
        await store.transaction((tx) =>
          closeAttempt(tx, run, 0, {
            status: "stopped_budget",
            finished_at: now,
            error: null,
          }),
        );
        return null;
      }
      let job: TrainerJob;
      try {
        job = await buildJob(run);
      } catch (error) {
        await store.transaction((tx) =>
          closeAttempt(tx, run, 0, {
            status: "failed",
            finished_at: now,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        return null;
      }
      // Keyed per attempt: a claim retried after a lost response adds nothing.
      const resumeStep = job.resume?.step ?? null;
      await appendAttempt(store.jobs, {
        jobId: run.id,
        attempt: run.attempt,
        event: "started",
        resumeStep,
        maxAttempts: run.max_attempts,
      });
      await appendPhase(store.jobs, {
        jobId: run.id,
        attempt: run.attempt,
        phase: "starting",
        step: resumeStep ?? 0,
        info: { gpu: worker.gpu },
      });

      return job;
    },
    stopReason: async (row) => {
      const run = await loadById(row.id);
      const reason = stopReason(run);
      if (reason || run.status !== "running") return reason;
      // Cloud: an exhausted workspace balance stops the run (resumable).
      const allowed =
        (await deps.billing.canContinue?.(run.workspace_id)) ?? true;

      return allowed ? null : "insufficient_balance";
    },
    onLeaseLost: async (row: JobRow, fence, now) => {
      const run = await loadById(row.id);
      // Re-checks expiry: a heartbeat that landed after the SELECT wins.
      await store.transaction((tx) =>
        interrupt(tx, run, {
          reason: "lease_lost",
          tokens: run.attempt_tokens,
          now: now.toISOString(),
          fence: {
            ...fenceOf(run),
            leaseExpiredBefore: fence.leaseExpiredBefore as string,
          },
        }),
      );
    },
  };

  return {
    handler,

    plan: async (workspaceId, request) =>
      (await planFor(workspaceId, request)).plan,

    create: (workspaceId, request, idempotency) =>
      createOnce(
        idempotency,
        (key) => store.jobs.findIdempotent(workspaceId, key),
        async (id) => toPublicRun(await loadRun(workspaceId, id)),
        async () => {
          const { plan, dataset, labelRequest } = await planFor(
            workspaceId,
            request,
          );
          const check = await deps.billing.checkCanStartRun(
            workspaceId,
            plan.estimated_cost_usd,
          );
          if (!check.allowed) {
            throw forbidden(
              "billing_denied",
              check.reason ??
                "Insufficient balance to start this training run.",
            );
          }

          // Router rubric items: the labeling eval runs first, the run waits
          // on it. Both commit together (or neither, on a key race).
          const { run, labels } = await store.transaction(async () => {
            const labels = labelRequest
              ? await evals.createRecord(workspaceId, labelRequest)
              : null;
            const run = await store.runs.create({
              workspaceId,
              name: request.name,
              datasetId: dataset.id,
              datasetName: dataset.name,
              datasetVersion: plan.dataset_version,
              recipeKind: request.recipe.kind,
              resolvedConfig: labels
                ? { ...plan.resolved_config, label_eval_id: labels.id }
                : plan.resolved_config,
              maxCostUsd: request.max_cost_usd ?? null,
              pricePerMillionTokens: plan.price_per_million_tokens,
              totalSteps: plan.estimated_steps,
              maxAttempts: settings.maxAttempts,
              waitingOn: labels?.id ?? null,
              idempotency,
            });
            await markQueued(store, run);
            for (const [i, message] of plan.warnings.entries()) {
              await appendNote(store.jobs, {
                jobId: run.id,
                attempt: 1,
                type: "warning",
                key: `plan:${i}`,
                message,
              });
            }
            return { run, labels };
          });
          if (!labels) return publicRun(await loadById(run.id));

          // The labeling eval may have finished before the run was inserted.
          const labelEval = await store.evals.getById(labels.id);
          if (labelEval && EVAL_TERMINAL.includes(labelEval.status)) {
            await settleLabelledRuns(
              store,
              labelEval,
              clock.now().toISOString(),
            );
          }

          return publicRun((await store.runs.getById(run.id)) ?? run);
        },
      ),

    get: async (workspaceId, id) => publicRun(await loadRun(workspaceId, id)),

    list: async (workspaceId, page) => {
      const result = await store.runs.list(workspaceId, page);
      const queued = result.data.find(
        (r) => r.status === "queued" && r.waiting_on === null,
      );
      const compute = queued ? await computeFor(queued) : NO_COMPUTE;

      return {
        data: result.data.map((r) =>
          toPublicRun(
            r,
            r.status === "queued" && r.waiting_on === null
              ? compute
              : NO_COMPUTE,
          ),
        ),
        next_cursor: result.next_cursor,
      };
    },

    events: async (workspaceId, id, query) => {
      const run = await loadRun(workspaceId, id);
      const after = decodeCursor(query.cursor, 1);
      const afterSeq = after ? Number(after[0]) : 0;
      if (!Number.isInteger(afterSeq) || afterSeq < 0) {
        throw invalid("invalid_cursor", "The pagination cursor is malformed.");
      }

      const rows = await store.jobs.listEvents(
        run.id,
        RUN_EVENT_TYPES,
        afterSeq,
        query.limit + 1,
      );
      const page = rows.slice(0, query.limit);
      const lastSeq = page.at(-1)?.seq ?? afterSeq;
      const data: RunEvent[] = page
        .map((e) => toRunEvent(run.id, e))
        .filter((e) => e !== null);
      const more = rows.length > query.limit;
      const done = more ? null : await completedEvent(run, lastSeq);
      if (done) data.push(done);

      return {
        run: await publicRun(run),
        data,
        next_cursor: more ? encodeCursor([lastSeq]) : null,
        tail_cursor: encodeCursor([lastSeq]),
      };
    },

    completedEvent: (run, lastSeq) => completedEvent(run, lastSeq),

    metrics: async (workspaceId, id, query) => {
      const run = await loadRun(workspaceId, id);
      const after = decodeCursor(query.cursor, 1);
      const afterSeq = after ? Number(after[0]) : 0;
      if (!Number.isInteger(afterSeq) || afterSeq < 0) {
        throw invalid("invalid_cursor", "The pagination cursor is malformed.");
      }

      const rows = (
        await store.jobs.listEvents(run.id, "metric", afterSeq, query.limit + 1)
      ).map(toMetricPoint);
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      const data =
        query.afterStep === undefined
          ? page
          : page.filter((m) => m.step > (query.afterStep as number));

      return {
        run: toPublicRun(run),
        data,
        next_cursor:
          rows.length > query.limit && last ? encodeCursor([last.seq]) : null,
        tail_cursor: encodeCursor([last?.seq ?? afterSeq]),
      };
    },

    cancel: async (workspaceId, id) => {
      const run = await loadRun(workspaceId, id);
      if (run.status === "cancelled") return toPublicRun(run);
      if (run.status !== "queued" && run.status !== "running") {
        throw conflict(
          "run_not_cancellable",
          `Run '${id}' already finished with status '${run.status}'.`,
        );
      }

      const now = clock.now().toISOString();
      // Without a worker the run is final now; with one, closeAttempt settles it.
      const updated = await store.runs.update(
        id,
        run.worker_id === null
          ? {
              status: "cancelled",
              waiting_on: null,
              finished_at: now,
              updated_at: now,
            }
          : { status: "cancelled", updated_at: now },
        { status: [run.status], workerId: run.worker_id },
      );
      if (!updated)
        throw conflict(
          "run_state_changed",
          `Run '${id}' changed concurrently; retry.`,
        );
      const labelEval = run.resolved_config.label_eval_id;
      if (labelEval !== null && run.waiting_on === labelEval) {
        await evals.cancel(workspaceId, labelEval).catch(() => undefined);
      }

      return toPublicRun(updated);
    },

    resume: async (workspaceId, id, maxCostUsd) => {
      const run = await loadRun(workspaceId, id);
      // A replayed resume (lost response, SDK retry) gets the current state.
      if (run.status === "queued" || run.status === "running") {
        return publicRun(run);
      }
      if (
        !["stopped_budget", "stopped_balance", "failed", "cancelled"].includes(
          run.status,
        ) ||
        run.worker_id !== null
      ) {
        throw conflict(
          "run_not_resumable",
          `Run '${id}' is ${run.status}${run.worker_id ? " and its worker is still finalizing" : ""}; only stopped_budget, stopped_balance, failed or cancelled runs can be resumed.`,
        );
      }

      // A run stopped at its own cap resumes only with a higher one; a
      // balance stop resumes with the same cap once the workspace can pay.
      const cap = maxCostUsd ?? run.max_cost_usd;
      const spent = billedCost(run);
      if (
        cap !== null &&
        (spent >= cap ||
          (run.status === "stopped_budget" && maxCostUsd === undefined))
      ) {
        throw conflict(
          "budget_exhausted",
          `Run '${id}' has spent $${spent.toFixed(4)} of its $${(run.max_cost_usd ?? cap).toFixed(4)} cap; resume with a higher max_cost_usd.`,
        );
      }

      const check = await deps.billing.checkCanStartRun(
        workspaceId,
        cap === null ? 0 : Math.max(0, cap - spent),
      );
      if (!check.allowed) {
        throw forbidden(
          "billing_denied",
          check.reason ?? "Insufficient balance to resume this training run.",
        );
      }

      const updated = await store.runs.update(
        id,
        {
          status: "queued",
          max_cost_usd: cap,
          error: null,
          failed_attempts: 0,
          preemptions: 0,
          finished_at: null,
          updated_at: clock.now().toISOString(),
        },
        { status: [run.status], workerId: null },
      );
      if (!updated)
        throw conflict(
          "run_state_changed",
          `Run '${id}' changed concurrently; retry.`,
        );
      await markQueued(store, updated);

      return publicRun(await loadById(id));
    },

    listCheckpoints: async (workspaceId, runId, page) => {
      await loadRun(workspaceId, runId);
      const result = await store.artifacts.listCheckpoints(
        workspaceId,
        runId,
        page,
        clock.now(),
      );

      return {
        data: result.data.map(toPublicCheckpoint),
        next_cursor: result.next_cursor,
      };
    },

    promoteCheckpoint: async (workspaceId, checkpointId, name) => {
      const checkpoint = await store.artifacts.getCheckpoint(
        workspaceId,
        checkpointId,
      );
      const now = clock.now();
      if (
        !checkpoint ||
        (checkpoint.expires_at !== null &&
          Date.parse(checkpoint.expires_at) <= now.getTime())
      ) {
        throw notFound("checkpoint", checkpointId);
      }
      if (checkpoint.format === null) {
        throw conflict(
          "checkpoint_not_exportable",
          `Checkpoint '${checkpointId}' holds training state only (the recipe did not export it as an artifact); promote the run's final artifact or a checkpoint with a format.`,
        );
      }

      const run = await loadRun(workspaceId, checkpoint.run_id);
      const releaseName = name ?? run.name;
      // The release references the checkpoint's immutable blob (no copy);
      // the expiry sweep keeps blobs a release shares. Natural key
      // (checkpoint, name): promoting twice returns the first release.
      const artifact = await store.artifacts.createRelease({
        workspaceId,
        name: releaseName,
        runId: run.id,
        sourceId: checkpoint.id,
        baseModel: run.resolved_config.model,
        recipeKind: run.recipe_kind,
        format: checkpoint.format,
        storageKey: checkpoint.storage_key,
        sha256: checkpoint.sha256,
        sizeBytes: checkpoint.size_bytes,
        manifest: {
          ...checkpoint.metadata,
          schema: "grad.artifact/1",
          run_id: run.id,
          promoted_from_checkpoint: checkpoint.id,
          step: checkpoint.step,
          attempt: checkpoint.attempt,
          resolved_config: run.resolved_config,
        },
        evalReport: null,
      });

      return toPublicArtifact(artifact);
    },

    progress: async (principal, id, body) => {
      const run = await loadLeased(principal, id, body.worker_id, body.attempt);
      const attemptTokens = Math.max(run.attempt_tokens, body.metric.tokens);
      const cost = runCost(run, attemptTokens);
      // One step's point is stored once per attempt (a retry returns it), and
      // only while this worker still holds the lease.
      const updated = await store.transaction(async (tx) => {
        const fenced = await tx.runs.update(
          id,
          {
            attempt_tokens: attemptTokens,
            lease_expires_at: new Date(
              clock.now().getTime() + run.lease_seconds * 1000,
            ).toISOString(),
          },
          fenceOf(run),
        );
        if (!fenced) throw leaseLost(id);
        metrics.trainingTokens.inc(
          {
            recipe_kind: run.recipe_kind,
            model_family: modelFamily(run.resolved_config.model),
          },
          attemptTokens - run.attempt_tokens,
        );
        const point = toMetricPoint(
          await tx.jobs.appendEvent({
            jobId: run.id,
            attempt: run.attempt,
            type: "metric",
            step: body.metric.step,
            payload: {
              ...body.metric,
              tokens: run.billed_tokens + attemptTokens,
              cost_usd: cost,
            },
          }),
        );

        // Bill the attempt in increments (every N tokens or minutes).
        await usage.flush(
          tx,
          fenced,
          attemptUsage(fenced, attemptTokens),
          false,
        );

        return (
          (await tx.runs.update(id, {
            current_step: Math.max(run.current_step, point.step),
            latest_metric:
              point.step >= (run.latest_metric?.step ?? -1)
                ? point
                : run.latest_metric,
          })) ?? fenced
        );
      });

      const reason = stopReason(updated);

      return {
        status: updated.status,
        should_stop: reason !== null,
        stop_reason: reason,
        cost_usd: cost,
      };
    },

    createUpload: async (principal, id, body) => {
      const run = await loadLeased(principal, id, body.worker_id, body.attempt);

      return uploads.ticket(
        jobBlobKey(run, run.attempt, body.sha256),
        body.size_bytes,
      );
    },

    registerCheckpoint: async (principal, id, body) => {
      const run = await loadLeased(principal, id, body.worker_id, body.attempt);
      const blob = await uploads.commit(body.upload_id, (sha) =>
        jobBlobKey(run, run.attempt, sha),
      );

      const result = await store.artifacts.insertCheckpoint({
        workspaceId: run.workspace_id,
        runId: run.id,
        attempt: run.attempt,
        step: body.step,
        evalScore: body.eval_score ?? null,
        format: body.format ?? null,
        baseModel: run.resolved_config.model,
        recipeKind: run.recipe_kind,
        storageKey: blob.key,
        sha256: blob.sha256,
        sizeBytes: blob.sizeBytes,
        metadata: body.metadata,
        expiresAt: addDays(
          clock.now(),
          run.resolved_config.checkpoint_ttl_days,
        ).toISOString(),
      });
      // A checkpoint bills the attempt's usage so far.
      if (result.created) {
        observeCheckpoint(run.recipe_kind, blob.sizeBytes, body.metadata);
        await applyCheckpointRetention(run, clock.now());
        await store.transaction((tx) =>
          usage.flush(tx, run, attemptUsage(run, run.attempt_tokens), true),
        );
        await evals.evaluateCheckpoint(run, result.checkpoint);
      }
      if (result.checkpoint.sha256 === blob.sha256) {
        await store.jobs.appendEvent({
          jobId: run.id,
          attempt: run.attempt,
          type: "checkpoint",
          step: body.step,
          payload: {
            checkpoint_id: result.checkpoint.id,
            eval_score: result.checkpoint.eval_score,
            format: result.checkpoint.format,
          },
        });
      }
      // A retried registration is that checkpoint; other bytes are a conflict.
      if (!result.created && result.checkpoint.sha256 !== blob.sha256) {
        throw conflict(
          "checkpoint_conflict",
          `Checkpoint for step ${body.step} of attempt ${run.attempt} already exists with different contents.`,
        );
      }

      return {
        checkpoint: toPublicCheckpoint(result.checkpoint),
        created: result.created,
      };
    },

    complete: async (principal, id, body) => {
      await collaborators.queue().loadForWorker(principal, id);
      const run = await loadById(id);

      if (!holdsLease(principal, run, body.worker_id, body.attempt)) {
        // Idempotent retry of a completion that already committed: this
        // attempt was closed with a result (not requeued by the reaper).
        if (
          run.attempt === body.attempt &&
          run.worker_id === null &&
          TERMINAL.includes(run.status)
        ) {
          const artifact = run.artifact_id
            ? await store.artifacts.get(run.workspace_id, run.artifact_id)
            : null;

          return {
            run: toPublicRun(run),
            artifact: artifact ? toPublicArtifact(artifact) : null,
          };
        }
        throw leaseLost(id);
      }

      const wantsArtifact =
        run.status !== "cancelled" &&
        (body.status === "completed" || body.status === "stopped_budget");
      // The worker says why it stopped (the heartbeat told it, or its own cap
      // check). An older worker doesn't: then only an exhausted balance makes
      // it a balance stop. Never inferred from cost < cap, since workers stop
      // just under the cap.
      const balanceStop =
        body.status === "stopped_budget" &&
        (body.stop_reason === "insufficient_balance" ||
          (body.stop_reason === undefined &&
            (await deps.billing.canContinue?.(run.workspace_id)) === false));
      if (
        run.status !== "cancelled" &&
        body.status === "completed" &&
        !body.upload_id
      ) {
        throw invalid(
          "artifact_required",
          "A completed train job must reference an uploaded artifact (upload_id).",
        );
      }

      const blob =
        wantsArtifact && body.upload_id
          ? await uploads.commit(body.upload_id, (sha) =>
              jobBlobKey(run, run.attempt, sha),
            )
          : null;

      const tokens = Math.max(body.tokens_processed, run.attempt_tokens);
      const now = clock.now().toISOString();
      if (body.status === "abandoned") {
        const updated = await store.transaction((tx) =>
          interrupt(tx, run, {
            reason: body.reason ?? "worker_error",
            tokens,
            now,
          }),
        );
        observeInterruption(
          { kind: "train", origin: "api" },
          body.reason ?? "worker_error",
        );

        return { run: toPublicRun(updated), artifact: null };
      }
      const status = body.status;
      const format = body.format ?? defaultFormatForRecipe(run.recipe_kind);
      if (!ArtifactFormatSchema.safeParse(format).success) {
        throw invalid("invalid_format", `Unknown artifact format '${format}'.`);
      }

      const result = await store.transaction(async (tx) => {
        const artifact = blob
          ? await tx.artifacts.createRelease({
              workspaceId: run.workspace_id,
              name: run.name,
              runId: run.id,
              sourceId: null,
              baseModel: run.resolved_config.model,
              recipeKind: run.recipe_kind,
              format,
              storageKey: blob.key,
              sha256: blob.sha256,
              sizeBytes: blob.sizeBytes,
              manifest: {
                ...body.manifest,
                schema: "grad.artifact/1",
                format,
                run_id: run.id,
                attempt: run.attempt,
                dataset: run.dataset_name,
                dataset_version: run.dataset_version,
                resolved_config: run.resolved_config,
              },
              evalReport: body.eval_report ?? null,
            })
          : null;

        const patch: RunPatch =
          run.status === "cancelled"
            ? { status: "cancelled", finished_at: now }
            : {
                status: balanceStop ? "stopped_balance" : status,
                finished_at: now,
                error:
                  body.status === "failed"
                    ? (body.error ?? "The trainer reported a failure.")
                    : balanceStop
                      ? BALANCE_STOPPED
                      : body.status === "stopped_budget"
                        ? budgetStopped(runCost(run, tokens), run.max_cost_usd)
                        : null,
                ...(artifact ? { artifact_id: artifact.id } : {}),
                ...(body.eval_report !== undefined
                  ? { eval_report: body.eval_report }
                  : {}),
              };

        const updated = await closeAttempt(tx, run, tokens, patch);
        const warnings = body.eval_report?.warnings ?? [];
        for (const [i, message] of warnings.entries()) {
          await appendNote(tx.jobs, {
            jobId: run.id,
            attempt: run.attempt,
            type: "warning",
            key: `report:${i}`,
            message: String(message),
            step: updated.current_step,
          });
        }

        return { run: updated, artifact };
      });

      return {
        run: toPublicRun(result.run),
        artifact: result.artifact ? toPublicArtifact(result.artifact) : null,
      };
    },

    reportEvent: async (principal, id, body) => {
      const run = await loadLeased(principal, id, body.worker_id, body.attempt);
      if (body.type === "phase") {
        await appendPhase(store.jobs, {
          jobId: run.id,
          attempt: run.attempt,
          phase: body.phase,
          step: body.step,
        });
        return;
      }
      await appendNote(store.jobs, {
        jobId: run.id,
        attempt: run.attempt,
        type: body.type,
        key: `worker:${body.seq}`,
        message: body.message,
        step: body.step,
      });
    },

    markWaitingForCompute: async (now) => {
      const threshold = settings.waitingForComputeSeconds ?? 30;
      const rows = await store.jobs.listUnclaimedSince(
        "train",
        new Date(now.getTime() - threshold * 1000),
        100,
      );
      if (rows.length === 0) return 0;
      const workers = await store.jobs.countLeasedWorkers("train", now);
      for (const row of rows) {
        await appendPhase(store.jobs, {
          jobId: row.id,
          attempt: row.attempt + 1,
          phase: "waiting_for_compute",
          info: {
            workers_online: workers,
            autoscaling: settings.workerAutoscaling ?? false,
          },
        });
      }

      return rows.length;
    },

    datasetStream: async (principal, id, attempt) => {
      const row = await collaborators.queue().loadForWorker(principal, id);
      if (row.attempt !== attempt || row.worker_id === null)
        throw leaseLost(id);

      const training = await trainingRecords(await loadById(id));

      return training.kind === "dataset"
        ? streamVersionGzip(storage, training.version)
        : gzipJsonlStream(training.records);
    },

    collectExpiredCheckpoints: async (now) => {
      const keys = await store.artifacts.deleteExpiredCheckpoints(now, 100);
      for (const key of keys) await storage.delete(key);

      return keys.length;
    },
  };
};
