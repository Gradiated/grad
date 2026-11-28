import type { AuthPrincipal } from "../adapters.js";
import { costForTokens, nanoUsd, trainSku } from "../catalog.js";
import { addDays, addSeconds } from "../clock.js";
import {
  ArtifactFormatSchema,
  RUN_EVENT_TYPES,
  RUN_STATUSES,
  type Artifact,
  type CompletedEvent,
  type ArtifactFormat,
  type Checkpoint,
  type DatasetRecord,
  type MetricsPage,
  type PlanRunRequest,
  type InterruptionReason,
  type PlanRunResponse,
  type RecipeKind,
  type Run,
  type RunCounts,
  type RunEvent,
  type RunEventsPage,
  type RunPhase,
  type RunStatus,
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
  ApiError,
  conflict,
  errorMessage,
  forbidden,
  invalid,
  isTransient,
  notFound,
  workspaceInactive,
} from "../errors.js";
import { createOnce, type Created } from "../idempotency.js";
import { loggerUrl } from "../secret-hosts.js";
import { log } from "../telemetry/log.js";
import { decodeIntCursor, encodeCursor } from "../store/cursor.js";
import type {
  DatasetVersion,
  IdempotencyInput,
  JobExpectation,
  JobRow,
  Page,
  ListFilter,
  PageRequest,
  RunPatch,
  RunRecord,
} from "../store/types.js";
import { gzipJsonlStream, streamVersionGzip } from "./dataset-records.js";
import type { DatasetService } from "./datasets.js";
import type { EvalService } from "./evals/service.js";
import { labelRecords, settleLabelledRuns } from "./router-labels.js";
import {
  fenceOf,
  closedBy,
  isSettled,
  isTerminal,
  holdsLease,
  leaseLost,
  RELEASE,
  requeuePatch,
  type JobKindHandler,
  observeInterruption,
  queueView,
  loadForWorker,
  loadLeased,
  type StopReason,
  loadForReader,
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
import { holdBlob, toPublicArtifact } from "./artifacts.js";
import { toPublicCheckpoint, type CheckpointService } from "./checkpoints.js";
import { createRunPlanner } from "./run-plan.js";
import type { SecretService } from "./secrets.js";
import {
  artifactKey,
  jobBlobKey,
  uploadIncomplete,
  type UploadService,
} from "./uploads.js";

import type { AttemptUsage, UsageService } from "./usage.js";
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
interface RunCompute {
  workers_online: number | null;
  autoscaling: boolean | null;
  queue_position: number | null;
  queue_message: string | null;
}

const NO_COMPUTE: RunCompute = {
  workers_online: null,
  autoscaling: null,
  queue_position: null,
  queue_message: null,
};

const defaultFormatForRecipe = (kind: RecipeKind): ArtifactFormat => {
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
const runCost = (run: RunRecord, attemptTokens = run.attempt_tokens): number =>
  costForTokens(
    run.billed_tokens + attemptTokens,
    run.price_per_million_tokens,
  );

const billedCost = (run: RunRecord): number => runCost(run, 0);

/**
 * The tokens of an open attempt the run bills: a step can carry a run a little
 * past max_cost_usd before it stops, and that overshoot isn't billed.
 */
const billableTokens = (run: RunRecord, tokens: number): number => {
  const price = nanoUsd(run.price_per_million_tokens);
  if (run.max_cost_usd === null || price <= 0) return tokens;
  const capTokens = Number(
    (BigInt(nanoUsd(run.max_cost_usd)) * 1_000_000n) / BigInt(price),
  );

  return Math.max(0, Math.min(tokens, capTokens - run.billed_tokens));
};

const toPublicRun = (
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
  phase: isSettled(run)
    ? null
    : ((run.phase_event?.payload.phase as Run["phase"] | undefined) ?? null),
  phase_since: isSettled(run) ? null : (run.phase_event?.created_at ?? null),
  last_interruption: toInterruption(run.interruption_event),
  workers_online: compute.workers_online,
  autoscaling: compute.autoscaling,
  queue_position: compute.queue_position,
  queue_message: compute.queue_message,
  min_gpu_memory_gb: run.min_gpu_memory_gb,
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

/** The error of a run stopped for lack of workspace balance (stopped_balance). */
export const BALANCE_STOPPED =
  "Stopped because the workspace ran out of balance (insufficient_balance); top up, then resume the run.";

/** The error of a run stopped because Gradiated Cloud suspended its workspace (stopped_balance). */
export const SUSPENDED_STOPPED =
  "Stopped because the workspace was suspended; once it is active again, resume the run.";

/** The error of a run stopped at its own cost cap (stopped_budget). */
const budgetStopped = (spent: number, cap: number | null): string =>
  `Stopped at the run's cost cap ($${spent.toFixed(4)} of $${(cap ?? spent).toFixed(4)}); resume with a higher max_cost_usd.`;

const stopReason = (run: RunRecord): StopReason => {
  if (run.status === "cancelled") return "cancelled";
  if (run.max_cost_usd !== null && runCost(run) >= run.max_cost_usd)
    return "budget";

  return null;
};

interface EventsQuery {
  cursor?: string | undefined;
  limit: number;
}

interface MetricsQuery {
  cursor?: string | undefined;
  after_step?: number | undefined;
  limit: number;
  max_points?: number | undefined;
}

export interface RunLifecycle {
  plan(workspaceId: string, request: PlanRunRequest): Promise<PlanRunResponse>;
  create(
    workspaceId: string,
    request: PlanRunRequest,
    idempotency?: IdempotencyInput,
  ): Promise<Created<Run>>;
  get(workspaceId: string, id: string): Promise<Run>;
  list(
    workspaceId: string,
    query: PageRequest & ListFilter,
  ): Promise<Page<Run>>;
  counts(workspaceId: string, q?: string): Promise<RunCounts>;
  metrics(
    workspaceId: string,
    id: string,
    query: MetricsQuery,
  ): Promise<MetricsPage>;
  events(
    workspaceId: string,
    id: string,
    query: EventsQuery,
  ): Promise<RunEventsPage>;
  /**
   * How a run's event stream ends once the event hub reports it settled:
   * `done` is false when it was resumed meanwhile (keep following); `event`
   * is the closing event (null when the run is gone).
   */
  streamEnd(
    workspaceId: string,
    id: string,
    lastSeq: number,
  ): Promise<{ done: boolean; event: CompletedEvent | null }>;
  cancel(workspaceId: string, id: string): Promise<Run>;
  /** A queued run of a suspended workspace: stopped_balance (resumable), no attempt spent. */
  stopForSuspension(id: string): Promise<void>;
  resume(workspaceId: string, id: string, maxCostUsd?: number): Promise<Run>;
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
  /** Marks queued runs nobody claimed in time waiting_for_compute. */
  markWaitingForCompute(now: Date): Promise<number>;
}

export const createRunLifecycle = (
  deps: AppDependencies,
  collaborators: {
    datasets: DatasetService;
    uploads: UploadService;
    usage: UsageService;
    evals: EvalService;
    checkpoints: CheckpointService;
    secrets: SecretService;
  },
): RunLifecycle => {
  const { store, storage, clock, settings } = deps;
  const { datasets, uploads, usage, evals, checkpoints, secrets } =
    collaborators;
  const planFor = createRunPlanner(deps, { datasets, evals });

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
  const loadLeasedRun = async (
    principal: AuthPrincipal,
    id: string,
    holder: { worker_id: string; attempt: number },
  ): Promise<RunRecord> => {
    await loadLeased(store, principal, id, holder.worker_id, holder.attempt);

    return loadById(id);
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
        throw conflict(
          "run_unbuildable",
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

  /** The open attempt's billed usage once it has processed `processed` tokens. */
  const attemptUsage = (run: RunRecord, processed: number): AttemptUsage => {
    const tokens = billableTokens(run, processed);

    return {
      tokens,
      costUsd: costForTokens(tokens, run.price_per_million_tokens),
      sku: trainSku(run.resolved_config.model),
      priceNanoPerMtok: nanoUsd(run.price_per_million_tokens),
      priceVersion: run.price_version ?? undefined,
    };
  };

  const limits = settings.queue;
  const waitingForWorker = (run: RunRecord): boolean =>
    run.status === "queued" && run.waiting_on === null;

  /** Live queue context of the runs among `runs` that wait for a worker. */
  const computeOf = async (
    runs: readonly RunRecord[],
  ): Promise<Map<string, RunCompute>> => {
    const queued = runs.filter(waitingForWorker);
    const out = new Map<string, RunCompute>();
    if (queued.length === 0) return out;
    const now = clock.now();
    const workers = await store.jobs.countLeasedWorkers("train", now);
    const snapshot = await store.jobs.queueSnapshot(
      "train",
      queued.map((r) => r.id),
      now,
    );
    for (const run of queued) {
      out.set(run.id, {
        workers_online: workers,
        autoscaling: settings.workerAutoscaling,
        ...queueView(run, snapshot, limits.maxRunning.train, "run"),
      });
    }

    return out;
  };

  /** Live queue context while a run waits for a worker. */
  const computeFor = async (run: RunRecord): Promise<RunCompute> =>
    (await computeOf([run])).get(run.id) ?? NO_COMPUTE;

  const publicRun = async (run: RunRecord): Promise<Run> =>
    toPublicRun(run, await computeFor(run));

  /**
   * Observes how long the run's current attempt spent in its latest phase,
   * as it moves on to `next` (null: the attempt ends). A repeated report of
   * the same phase observes nothing.
   */
  const observePhaseEnd = (run: RunRecord, next: RunPhase | null): void => {
    const ended = run.phase_event;
    const phase = ended?.payload.phase;
    if (!ended || ended.attempt !== run.attempt || phase === next) return;
    if (typeof phase !== "string") return;
    const seconds =
      (clock.now().getTime() - Date.parse(ended.created_at)) / 1000;
    metrics.runPhaseDuration.observe({ phase }, Math.max(0, seconds));
  };

  /** The step the next attempt resumes from (its newest checkpoint), or null. */
  const resumeStepOf = async (runId: string) =>
    (await store.artifacts.allCheckpoints(runId, clock.now())).at(-1)?.step ??
    null;

  /** The `queued` phase of the run's next attempt. */
  const markQueued = async (run: RunRecord) => {
    const { queue_message, ...compute } = await computeFor(run);
    await appendPhase(store.jobs, {
      jobId: run.id,
      attempt: run.attempt + 1,
      phase: "queued",
      step: (await resumeStepOf(run.id)) ?? 0,
      info: { ...compute, message: queue_message },
    });
  };

  /** Closes an open attempt: bills the rest of it and applies `patch`, atomically. */
  const closeAttempt = async (
    run: RunRecord,
    tokens: number,
    patch: RunPatch,
    fence: JobExpectation = fenceOf(run),
  ): Promise<RunRecord> => {
    const now = clock.now();
    // The fenced write locks the job row, so the progress reports that
    // committed before it are visible to the reads below.
    const closed = await store.runs.update(
      run.id,
      { ...patch, ...RELEASE, updated_at: now.toISOString() },
      fence,
    );
    if (!closed) throw leaseLost(run.id);
    const used = Math.max(tokens, closed.attempt_tokens);
    await usage.flush(closed, attemptUsage(closed, used), true);
    const updated = (await store.runs.update(run.id, {
      billed_tokens: closed.billed_tokens + used,
      attempt_tokens: 0,
    })) as RunRecord;
    if (isTerminal(updated.status)) {
      await checkpoints.pinBestAndFinal(updated, now);
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
            maxPreemptions: settings.maxPreemptions,
            // A reclaim after a checkpoint lost little and moved the run on.
            progressed: (
              await store.artifacts.allCheckpoints(run.id, clock.now())
            ).some((c) => c.attempt === run.attempt),
          }
        : undefined,
    );
    const updated = await closeAttempt(run, input.tokens, patch, input.fence);

    const event = {
      jobId: run.id,
      attempt: run.attempt,
      reason: input.reason,
      step: run.current_step,
      resumeStep: await resumeStepOf(run.id),
      maxAttempts: run.max_attempts,
    };
    await appendAttempt(store.jobs, { ...event, event: "interrupted" });
    if (updated.status === "queued") await markQueued(updated);
    else await appendAttempt(store.jobs, { ...event, event: "gave_up" });

    return updated;
  };

  const buildJob = async (run: RunRecord): Promise<TrainerJob> => {
    const training = await trainingRecords(run);

    // Ordered by (step, attempt): the newest is last.
    const resume = (
      await store.artifacts.allCheckpoints(run.id, clock.now())
    ).at(-1);
    const baseRef = run.resolved_config.base_artifact;
    const base = baseRef
      ? await store.artifacts.get(run.workspace_id, baseRef.id)
      : null;
    if (baseRef && base?.sha256 !== baseRef.sha256) {
      throw conflict(
        "run_unbuildable",
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
      eval: null,
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
   * A failure to open it (KMS, the database) fails the claim instead.
   */
  const loggerSecret = (
    workspaceId: string,
    name: string,
    url: string,
  ): Promise<string | null> =>
    secrets.reveal(workspaceId, name, { url, use: "logger" }).catch((error) => {
      if (isTransient(error)) throw error;
      return null;
    });

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

  /** The closing event of a settled run's stream, else null. */
  const completedEvent = (
    run: RunRecord,
    lastSeq: number,
  ): CompletedEvent | null =>
    isSettled(run)
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
        await store.transaction(() =>
          closeAttempt(run, 0, {
            status: "stopped_budget",
            finished_at: now,
            error: budgetStopped(billedCost(run), run.max_cost_usd),
          }),
        );
        return null;
      }
      let job: TrainerJob;
      try {
        job = await buildJob(run);
      } catch (error) {
        // A transient failure (storage, KMS, the database) requeues the run,
        // spending the attempt; an unbuildable run fails.
        const message = errorMessage(error);
        const transient = isTransient(error);
        const closed = await store.transaction(async () => {
          const updated = await closeAttempt(
            run,
            0,
            transient
              ? requeuePatch(
                  run,
                  `Attempt ${run.attempt} couldn't start (${message})`,
                  now,
                )
              : { status: "failed", finished_at: now, error: message },
          );
          if (updated.status === "queued") await markQueued(updated);

          return updated;
        });
        // Answer the claim with the error: the worker backs off before it
        // claims again, instead of this claim picking the run straight back up.
        if (closed.status === "queued") throw error;
        return null;
      }
      // Keyed per attempt: a claim retried after a lost response adds nothing.
      const resumeStep = job.resume?.step ?? null;
      if (!renewed) observePhaseEnd(run, "starting");
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
      // Cloud: a suspended workspace or an exhausted balance stops the run
      // (resumable, stopped_balance).
      if ((await store.workspaces.state(run.workspace_id)) !== "active") {
        return "insufficient_balance";
      }
      const allowed =
        (await deps.billing.canContinue?.(run.workspace_id)) ?? true;

      return allowed ? null : "insufficient_balance";
    },
    onLeaseLost: async (row: JobRow, fence, now) => {
      const run = await loadById(row.id);
      // The queue's fence re-checks expiry: a heartbeat that landed after
      // the reaper's read wins.
      await store.transaction(() =>
        interrupt(run, {
          reason: "lease_lost",
          tokens: run.attempt_tokens,
          now: now.toISOString(),
          fence,
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
          // The price and its list version, read together: the run bills
          // at them whatever the price list says later.
          const priceVersion = deps.catalog.priceVersion;
          const price =
            deps.catalog.priceFor(plan.resolved_config.model) ??
            plan.price_per_million_tokens;
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
              pricePerMillionTokens: price,
              priceVersion,
              totalSteps: plan.estimated_steps,
              minGpuMemoryGb: plan.min_gpu_memory_gb,
              maxAttempts: settings.maxAttempts,
              maxQueued: limits.maxQueued,
              waitingOn: labels?.id ?? null,
              idempotency,
            });
            await markQueued(run);
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
          const created = (run: Run): Run => ({
            ...run,
            warnings: plan.warnings,
          });
          if (!labels) return created(await publicRun(await loadById(run.id)));

          // The labeling eval may have finished before the run was inserted.
          const labelEval = await store.evals.getById(labels.id);
          if (labelEval && isTerminal(labelEval.status)) {
            await settleLabelledRuns(
              store,
              labelEval,
              clock.now().toISOString(),
            );
          }

          return created(
            await publicRun((await store.runs.getById(run.id)) ?? run),
          );
        },
      ),

    get: async (workspaceId, id) => publicRun(await loadRun(workspaceId, id)),

    list: async (workspaceId, { limit, cursor, ...filter }) => {
      const result = await store.runs.list(
        workspaceId,
        { limit, cursor },
        filter,
      );
      const compute = await computeOf(result.data);

      return {
        data: result.data.map((r) =>
          toPublicRun(r, compute.get(r.id) ?? NO_COMPUTE),
        ),
        next_cursor: result.next_cursor,
      };
    },

    counts: async (workspaceId, q) => {
      const by_status = Object.fromEntries(
        RUN_STATUSES.map((status) => [status, 0]),
      ) as RunCounts["by_status"];
      let total = 0;
      for (const { status, n } of await store.runs.countByStatus(
        workspaceId,
        q,
      )) {
        if (status in by_status) by_status[status as RunStatus] = n;
        total += n;
      }

      return { total, by_status };
    },

    events: async (workspaceId, id, query) => {
      const run = await loadRun(workspaceId, id);
      const afterSeq = decodeIntCursor(query.cursor);

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
      const done = more ? null : completedEvent(run, lastSeq);
      if (done) data.push(done);

      return {
        run_id: run.id,
        status: run.status,
        data,
        next_cursor: more ? encodeCursor([lastSeq]) : null,
        tail_cursor: encodeCursor([lastSeq]),
      };
    },

    streamEnd: async (workspaceId, id, lastSeq) => {
      const run = await store.runs.get(workspaceId, id);
      if (!run) return { done: true, event: null };
      const event = completedEvent(run, lastSeq);

      return { done: event !== null, event };
    },

    metrics: async (workspaceId, id, query) => {
      const run = await loadRun(workspaceId, id);
      const afterSeq = decodeIntCursor(query.cursor);

      if (query.max_points !== undefined) {
        const curve = (
          await store.jobs.listMetricCurve(run.id, afterSeq, query.max_points)
        ).map(toMetricPoint);
        const newest = curve[curve.length - 1];
        const afterStep = query.after_step;

        return {
          run_id: run.id,
          status: run.status,
          data:
            afterStep === undefined
              ? curve
              : curve.filter((m) => m.step > afterStep),
          next_cursor: null,
          tail_cursor: encodeCursor([newest?.seq ?? afterSeq]),
        };
      }

      const rows = (
        await store.jobs.listEvents(run.id, "metric", afterSeq, query.limit + 1)
      ).map(toMetricPoint);
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      const afterStep = query.after_step;
      const data =
        afterStep === undefined ? page : page.filter((m) => m.step > afterStep);

      return {
        run_id: run.id,
        status: run.status,
        data,
        next_cursor:
          rows.length > query.limit && last ? encodeCursor([last.seq]) : null,
        tail_cursor: encodeCursor([last?.seq ?? afterSeq]),
      };
    },

    stopForSuspension: async (id) => {
      const now = clock.now().toISOString();
      await store.runs.update(
        id,
        {
          status: "stopped_balance",
          error: SUSPENDED_STOPPED,
          waiting_on: null,
          finished_at: now,
          updated_at: now,
        },
        { status: ["queued"], workerId: null },
      );
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
      // Without a worker the run is final now; with one, closeAttempt settles
      // it once the worker stops (or its lease expires), and followers see
      // the stopping phase meanwhile.
      const updated = await store.transaction(async () => {
        const cancelled = await store.runs.update(
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
        if (cancelled && run.worker_id !== null) {
          observePhaseEnd(run, "stopping");
          await appendPhase(store.jobs, {
            jobId: run.id,
            attempt: run.attempt,
            phase: "stopping",
            step: run.current_step,
            info: {
              message:
                "Cancelled: waiting for the worker to stop (if it is gone, until its lease expires).",
            },
          });
        }

        return cancelled;
      });
      if (!updated)
        throw conflict(
          "run_state_changed",
          `Run '${id}' changed concurrently; retry.`,
        );
      const labelEval = run.resolved_config.label_eval_id;
      if (labelEval !== null && run.waiting_on === labelEval) {
        await evals.cancel(workspaceId, labelEval).catch((error: unknown) => {
          // 409: it finished meanwhile, so there is nothing to stop.
          if (error instanceof ApiError && error.status === 409) return;
          log("warn", "labeling eval not cancelled", {
            run_id: id,
            eval_id: labelEval,
            error,
          });
        });
      }

      // Reloaded: the stopping phase is the run's phase now.
      return toPublicRun(
        run.worker_id === null ? updated : await loadRun(workspaceId, id),
      );
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
          run.worker_id !== null && run.status === "cancelled"
            ? `Run '${id}' was just cancelled and its worker is still stopping; resume it again in a few seconds.`
            : `Run '${id}' is ${run.status}${run.worker_id ? " and its worker is still finalizing" : ""}; only stopped_budget, stopped_balance, failed or cancelled runs can be resumed.`,
        );
      }

      const state = await store.workspaces.state(workspaceId);
      if (state !== "active") throw workspaceInactive(state);

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
      await markQueued(updated);

      return publicRun(await loadById(id));
    },

    progress: async (principal, id, body) => {
      const run = await loadLeasedRun(principal, id, body);
      const attemptTokens = Math.max(run.attempt_tokens, body.metric.tokens);
      const cost = runCost(run, attemptTokens);
      // One step's point is stored once per attempt (a retry returns it), and
      // only while this worker still holds the lease.
      // One transaction, one run write: the event insert takes the job row's
      // lock, and the fenced update fails the whole write if the lease moved
      // (p1-scale: two run updates made ~16 round trips per point).
      const updated = await store.transaction(async () => {
        const point = toMetricPoint(
          await store.jobs.appendEvent({
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
        const fenced = await store.runs.update(
          id,
          {
            attempt_tokens: attemptTokens,
            lease_expires_at: addSeconds(
              clock.now(),
              run.lease_seconds,
            ).toISOString(),
            current_step: Math.max(run.current_step, point.step),
            latest_metric:
              point.step >= (run.latest_metric?.step ?? -1)
                ? point
                : run.latest_metric,
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

        // Bill the attempt in increments (every N tokens or minutes).
        await usage.flush(fenced, attemptUsage(fenced, attemptTokens), false);

        return fenced;
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
      const run = await loadLeasedRun(principal, id, body);

      return uploads.ticket(
        // The final bundle goes straight to the released-artifacts prefix;
        // checkpoints stay under the job until promoted.
        body.kind === "artifact"
          ? artifactKey(run.workspace_id, body.sha256)
          : jobBlobKey(run, run.attempt, body.sha256),
        body.size_bytes,
      );
    },

    registerCheckpoint: async (principal, id, body) => {
      const run = await loadLeasedRun(principal, id, body);
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
        await checkpoints.applyRetention(run, clock.now());
        await store.transaction(() =>
          usage.flush(run, attemptUsage(run, run.attempt_tokens), true),
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
      await loadForWorker(store, principal, id);
      const run = await loadById(id);

      if (!holdsLease(principal, run, body.worker_id, body.attempt)) {
        // Idempotent retry of a completion that already committed: this
        // attempt was closed with a result (not requeued by the reaper).
        if (closedBy(principal, run, body.attempt) && isTerminal(run.status)) {
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
      observePhaseEnd(run, null);

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
      const suspended =
        balanceStop &&
        (await store.workspaces.state(run.workspace_id)) !== "active";
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
              artifactKey(run.workspace_id, sha),
            )
          : null;

      const tokens = Math.max(body.tokens_processed, run.attempt_tokens);
      const now = clock.now().toISOString();
      if (body.status === "abandoned") {
        const updated = await store.transaction(() =>
          interrupt(run, {
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

      /** Why the run stopped, in words (null when it completed). */
      const closingError = (): string | null => {
        if (body.status === "failed") {
          return body.error ?? "The trainer reported a failure.";
        }
        if (balanceStop) return suspended ? SUSPENDED_STOPPED : BALANCE_STOPPED;
        if (body.status === "stopped_budget") {
          return budgetStopped(runCost(run, tokens), run.max_cost_usd);
        }

        return null;
      };

      const result = await store.transaction(async () => {
        if (blob && !(await holdBlob(deps, blob.key))) {
          throw uploadIncomplete(blob.sha256);
        }
        const artifact = blob
          ? await store.artifacts.createRelease({
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
                provenance: { source: "run", run_id: run.id },
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
                error: closingError(),
                ...(artifact ? { artifact_id: artifact.id } : {}),
                ...(body.eval_report !== undefined
                  ? { eval_report: body.eval_report }
                  : {}),
              };

        const updated = await closeAttempt(run, tokens, patch);
        const warnings = body.eval_report?.warnings ?? [];
        for (const [i, message] of warnings.entries()) {
          await appendNote(store.jobs, {
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
      const run = await loadLeasedRun(principal, id, body);
      if (body.type === "phase") {
        // A cancelled run stays stopping until it settles.
        if (run.status === "cancelled") return;
        observePhaseEnd(run, body.phase);
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
      const threshold = settings.waitingForComputeSeconds;
      // Runs whose workspace is at its running cap wait on themselves:
      // they stay `queued` (their queue_message says why).
      const rows = await store.jobs.listUnclaimedSince(
        "train",
        new Date(now.getTime() - threshold * 1000),
        100,
        limits.maxRunning.train,
      );
      if (rows.length === 0) return 0;
      const workers = await store.jobs.countLeasedWorkers("train", now);
      const snapshot = await store.jobs.queueSnapshot(
        "train",
        rows.map((r) => r.id),
        now,
      );
      for (const row of rows) {
        const view = queueView(row, snapshot, limits.maxRunning.train, "run");
        await appendPhase(store.jobs, {
          jobId: row.id,
          attempt: row.attempt + 1,
          phase: "waiting_for_compute",
          info: {
            workers_online: workers,
            autoscaling: settings.workerAutoscaling,
            queue_position: view.queue_position,
            message: view.queue_message,
          },
        });
      }
      await store.jobs.markWaiting(rows.map((r) => r.id));

      return rows.length;
    },

    datasetStream: async (principal, id, attempt) => {
      await loadForReader(store, principal, id, attempt);
      const training = await trainingRecords(await loadById(id));

      return training.kind === "dataset"
        ? streamVersionGzip(storage, training.version)
        : gzipJsonlStream(training.records);
    },
  };
};
