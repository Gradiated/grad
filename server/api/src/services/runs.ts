import type { AuthPrincipal } from "../adapters.js";
import { costForTokens } from "../catalog.js";
import { addDays, addSeconds, leaseGraceCutoff } from "../clock.js";
import {
  ArtifactFormatSchema,
  type Artifact,
  type ArtifactFormat,
  type Checkpoint,
  type DatasetRecord,
  type EvalStatus,
  type MetricPoint,
  type PlanRunRequest,
  type PlanRunResponse,
  type RecipeKind,
  type Run,
  type TrainerJob,
} from "../contracts.js";
import type { z } from "@hono/zod-openapi";
import type {
  CompleteJobRequestSchema,
  HeartbeatRequestSchema,
  RegisterCheckpointRequestSchema,
  ReportProgressRequestSchema,
  WorkerUploadRequestSchema,
} from "../contracts/trainer-jobs.js";
import type { AppDependencies } from "../deps.js";
import { ApiError, conflict, forbidden, invalid, notFound } from "../errors.js";
import { newId } from "../ids.js";
import { isArtifactRef } from "../continued-training.js";
import { planRun } from "../planner.js";
import { decodeCursor, encodeCursor } from "../store/cursor.js";
import type {
  ArtifactRecord,
  CheckpointRecord,
  DatasetVersion,
  Page,
  PageRequest,
  Repositories,
  RunPatch,
  RunRecord,
} from "../store/types.js";
import type { BillingOutbox } from "./billing-outbox.js";
import { streamVersionJsonl } from "./dataset-records.js";
import type { DatasetService } from "./datasets.js";
import type { EvalService } from "./evals/service.js";
import {
  jsonlStream,
  labelingEvalRequest,
  labelRecords,
  settleLabelledRuns,
  toLabelingPlan,
} from "./router-labels.js";
import type { UploadService } from "./uploads.js";

type HeartbeatBody = z.infer<typeof HeartbeatRequestSchema>;
type ProgressBody = z.infer<typeof ReportProgressRequestSchema>;
type WorkerUploadBody = z.infer<typeof WorkerUploadRequestSchema>;
type CheckpointBody = z.infer<typeof RegisterCheckpointRequestSchema>;
type CompleteBody = z.infer<typeof CompleteJobRequestSchema>;

export type StopReason = "cancelled" | "budget" | null;

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
const runCost = (run: RunRecord, attemptTokens = run.attempt_tokens): number =>
  costForTokens(
    run.billed_tokens + attemptTokens,
    run.price_per_million_tokens,
  );

const billedCost = (run: RunRecord): number => runCost(run, 0);

export const toPublicRun = (run: RunRecord): Run => ({
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
  latest_metric: run.latest_metric,
  eval_report: run.eval_report,
  artifact_id: run.artifact_id,
  error: run.error,
  created_at: run.created_at,
  updated_at: run.updated_at,
  finished_at: run.finished_at,
});

/**
 * The one attempt rule: an attempt that ends without a result (lease expired,
 * or abandoned by a preempted worker) counts, and the run fails once
 * max_attempts of them have happened since creation or the last resume.
 */
const requeuePatch = (run: RunRecord, what: string, now: string): RunPatch => {
  const failedAttempts = run.failed_attempts + 1;

  return failedAttempts >= run.max_attempts
    ? {
        status: "failed",
        failed_attempts: failedAttempts,
        finished_at: now,
        error: `${what}; ${failedAttempts} attempt(s) ended without a result (max_attempts=${run.max_attempts}).`,
      }
    : {
        status: "queued",
        failed_attempts: failedAttempts,
        error: `${what}; requeued.`,
      };
};

export const toPublicArtifact = ({
  storage_key: _key,
  ...artifact
}: ArtifactRecord): Artifact => artifact;

export const toPublicCheckpoint = ({
  storage_key: _key,
  ...checkpoint
}: CheckpointRecord): Checkpoint => checkpoint;

const stopReason = (run: RunRecord): StopReason => {
  if (run.status === "cancelled") return "cancelled";
  if (run.max_cost_usd !== null && runCost(run) >= run.max_cost_usd)
    return "budget";

  return null;
};

export interface MetricsQuery {
  cursor?: string | undefined;
  afterStep?: number | undefined;
  limit: number;
}

export interface RunLifecycle {
  plan(workspaceId: string, request: PlanRunRequest): Promise<PlanRunResponse>;
  create(workspaceId: string, request: PlanRunRequest): Promise<Run>;
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
  claim(
    principal: AuthPrincipal,
    input: {
      workerId: string;
      leaseSeconds: number;
      recipes?: readonly RecipeKind[] | undefined;
    },
  ): Promise<TrainerJob | null>;
  heartbeat(
    principal: AuthPrincipal,
    id: string,
    body: HeartbeatBody,
  ): Promise<{
    status: string;
    should_stop: boolean;
    stop_reason: StopReason;
    lease_expires_at: string;
  }>;
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
  ): ReturnType<UploadService["createTicket"]>;
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
  datasetStream(
    principal: AuthPrincipal,
    id: string,
    attempt: number,
  ): Promise<ReadableStream<Uint8Array>>;

  // Maintenance.
  expireLeases(now: Date): Promise<number>;
  collectExpiredCheckpoints(now: Date): Promise<number>;
}

/** Throws 404 when a worker may not see a job (workspace-scoped worker keys). */
export const assertWorkerScope = (
  principal: AuthPrincipal,
  workspaceId: string,
  id: string,
): void => {
  if (
    principal.workerWorkspaceId !== null &&
    principal.workerWorkspaceId !== workspaceId
  ) {
    throw notFound("trainer_job", id);
  }
};

const leaseLost = (id: string): ApiError =>
  conflict(
    "lease_lost",
    `This worker no longer holds the lease on job '${id}' (expired, reclaimed, or finished). Stop work on it.`,
  );

export const createRunLifecycle = (
  deps: AppDependencies,
  collaborators: {
    datasets: DatasetService;
    uploads: UploadService;
    billing: BillingOutbox;
    evals: EvalService;
  },
): RunLifecycle => {
  const { store, storage, catalog, clock, settings } = deps;
  const { datasets, uploads, billing, evals } = collaborators;

  const loadRun = async (
    workspaceId: string,
    id: string,
  ): Promise<RunRecord> => {
    const run = await store.runs.get(workspaceId, id);
    if (!run) throw notFound("run", id);

    return run;
  };

  /** The run behind a worker request, if this worker holds `attempt`'s lease. */
  const loadLeased = async (
    principal: AuthPrincipal,
    id: string,
    workerId: string,
    attempt: number,
  ): Promise<RunRecord> => {
    const run = await store.runs.getById(id);
    if (!run) throw notFound("trainer_job", id);
    assertWorkerScope(principal, run.workspace_id, id);
    if (run.worker_id !== workerId || run.attempt !== attempt)
      throw leaseLost(id);

    return run;
  };

  const planFor = async (workspaceId: string, request: PlanRunRequest) => {
    const resolved = await datasets.resolve(workspaceId, request.dataset);
    const records = await datasets.readRecords(resolved.version);
    const baseArtifact = isArtifactRef(request.recipe.model)
      ? await store.artifacts.get(workspaceId, request.recipe.model)
      : null;
    const labelRequest = labelingEvalRequest(request, resolved.version.version);
    const labeling = labelRequest
      ? toLabelingPlan(await evals.plan(workspaceId, labelRequest))
      : null;
    const plan = planRun(request, records, {
      catalog,
      datasetVersion: resolved.version.version,
      baseArtifact: baseArtifact && toPublicArtifact(baseArtifact),
      labeling,
    });

    return { plan, dataset: resolved.dataset, labelRequest };
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

  const pinCheckpoints = async (
    tx: Repositories,
    run: RunRecord,
    now: Date,
  ): Promise<void> => {
    const all = await tx.checkpoints.listAllForRun(run.id, now);
    if (all.length === 0) return;

    const scored = all.filter((c) => c.eval_score !== null);
    const best = scored.reduce<CheckpointRecord | null>(
      (acc, c) =>
        acc === null || (c.eval_score ?? 0) >= (acc.eval_score ?? 0) ? c : acc,
      null,
    );
    const final = all.reduce((acc, c) =>
      c.step > acc.step || (c.step === acc.step && c.attempt >= acc.attempt)
        ? c
        : acc,
    );

    await tx.checkpoints.pinRetention(run.id, {
      bestId: best?.id ?? null,
      finalId: final.id,
    });
  };

  /** Closes an open attempt: bills it and applies `patch`, atomically. */
  const closeAttempt = async (
    tx: Repositories,
    run: RunRecord,
    tokens: number,
    patch: RunPatch,
    leaseExpiredBefore?: string,
  ): Promise<RunRecord> => {
    const now = clock.now();
    const attemptCost = costForTokens(tokens, run.price_per_million_tokens);
    const updated = await tx.runs.update(
      run.id,
      {
        ...patch,
        billed_tokens: run.billed_tokens + tokens,
        attempt_tokens: 0,
        worker_id: null,
        lease_expires_at: null,
        updated_at: now.toISOString(),
      },
      {
        workerId: run.worker_id,
        attempt: run.attempt,
        status: ["running", "cancelled"],
        ...(leaseExpiredBefore ? { leaseExpiredBefore } : {}),
      },
    );
    if (!updated) throw leaseLost(run.id);

    await billing.enqueueUsage(tx, {
      workspaceId: run.workspace_id,
      runId: run.id,
      attempt: run.attempt,
      tokens,
      costUsd: attemptCost,
    });
    if (TERMINAL.includes(updated.status)) {
      await pinCheckpoints(tx, updated, now);
    }

    return updated;
  };

  const buildJob = async (run: RunRecord): Promise<TrainerJob> => {
    const training = await trainingRecords(run);

    const resume = await store.checkpoints.latestForRun(run.id, clock.now());
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
    };
  };

  const expireLeases = async (now: Date): Promise<number> => {
    const expired = await store.runs.listExpiredLeases(now, 100);
    let closed = 0;

    for (const run of expired) {
      const patch: RunPatch =
        run.status === "cancelled"
          ? { status: "cancelled", finished_at: now.toISOString() }
          : requeuePatch(
              run,
              `Attempt ${run.attempt} lost its lease`,
              now.toISOString(),
            );

      try {
        await store.transaction((tx) =>
          // Re-checks expiry: a heartbeat that landed after the SELECT wins.
          closeAttempt(
            tx,
            run,
            run.attempt_tokens,
            patch,
            leaseGraceCutoff(now, run.lease_seconds),
          ),
        );
        closed += 1;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
      }
    }
    if (closed > 0) billing.kick();

    return closed;
  };

  return {
    plan: async (workspaceId, request) =>
      (await planFor(workspaceId, request)).plan,

    create: async (workspaceId, request) => {
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
          check.reason ?? "Insufficient balance to start this training run.",
        );
      }

      // Router rubric items: the labeling eval runs first, the run waits on it.
      const labels = labelRequest
        ? await evals.create(workspaceId, labelRequest)
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
      });
      if (!labels) return toPublicRun(run);

      // The labeling eval may have finished before the run was inserted.
      const labelEval = await store.evals.getById(labels.id);
      if (labelEval && EVAL_TERMINAL.includes(labelEval.status)) {
        await settleLabelledRuns(store, labelEval, clock.now().toISOString());
      }

      return toPublicRun((await store.runs.getById(run.id)) ?? run);
    },

    get: async (workspaceId, id) => toPublicRun(await loadRun(workspaceId, id)),

    list: async (workspaceId, page) => {
      const result = await store.runs.list(workspaceId, page);

      return {
        data: result.data.map(toPublicRun),
        next_cursor: result.next_cursor,
      };
    },

    metrics: async (workspaceId, id, query) => {
      const run = await loadRun(workspaceId, id);
      const after = decodeCursor(query.cursor, 1);
      const afterSeq = after ? Number(after[0]) : 0;
      if (!Number.isInteger(afterSeq) || afterSeq < 0) {
        throw invalid("invalid_cursor", "The pagination cursor is malformed.");
      }

      const rows = await store.metrics.list(run.id, afterSeq, query.limit + 1);
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
      if (
        !["stopped_budget", "failed", "cancelled"].includes(run.status) ||
        run.worker_id !== null
      ) {
        throw conflict(
          "run_not_resumable",
          `Run '${id}' is ${run.status}${run.worker_id ? " and its worker is still finalizing" : ""}; only stopped_budget, failed or cancelled runs can be resumed.`,
        );
      }

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

      return toPublicRun(updated);
    },

    listCheckpoints: async (workspaceId, runId, page) => {
      await loadRun(workspaceId, runId);
      const result = await store.checkpoints.listByRun(
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
      const checkpoint = await store.checkpoints.get(workspaceId, checkpointId);
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
      const key = `artifacts/${encodeURIComponent(workspaceId)}/${newId("art")}.grad.tar.gz`;
      await storage.copy(checkpoint.storage_key, key);

      try {
        const artifact = await store.artifacts.create({
          workspaceId,
          name: name ?? run.name,
          runId: run.id,
          checkpointId: checkpoint.id,
          baseModel: run.resolved_config.model,
          recipeKind: run.recipe_kind,
          format: checkpoint.format,
          storageKey: key,
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
      } catch (error) {
        await storage.delete(key).catch(() => undefined);
        throw error;
      }
    },

    claim: async (principal, input) => {
      const now = clock.now();
      await expireLeases(now);

      // A worker retrying a claim whose response was lost gets its job back.
      const held = await store.runs.heldBy(input.workerId);
      if (held) {
        const renewed = await store.runs.update(
          held.id,
          {
            lease_expires_at: addSeconds(now, input.leaseSeconds).toISOString(),
            lease_seconds: input.leaseSeconds,
          },
          { workerId: held.worker_id, attempt: held.attempt },
        );
        if (renewed) return buildJob(renewed);
      }

      for (;;) {
        const run = await store.runs.claimNext({
          workerId: input.workerId,
          leaseSeconds: input.leaseSeconds,
          now,
          recipes: input.recipes,
          workspaceId: principal.workerWorkspaceId ?? undefined,
        });
        if (!run) return null;

        if (run.max_cost_usd !== null && billedCost(run) >= run.max_cost_usd) {
          await store.transaction((tx) =>
            closeAttempt(tx, run, 0, {
              status: "stopped_budget",
              finished_at: now.toISOString(),
              error: null,
            }),
          );
          continue;
        }

        try {
          return await buildJob(run);
        } catch (error) {
          await store.transaction((tx) =>
            closeAttempt(tx, run, 0, {
              status: "failed",
              finished_at: now.toISOString(),
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
    },

    heartbeat: async (principal, id, body) => {
      const run = await loadLeased(principal, id, body.worker_id, body.attempt);
      const leaseSeconds = body.lease_seconds ?? run.lease_seconds;
      const leaseExpiresAt = addSeconds(
        clock.now(),
        leaseSeconds,
      ).toISOString();
      const updated = await store.runs.update(
        id,
        { lease_expires_at: leaseExpiresAt, lease_seconds: leaseSeconds },
        {
          workerId: body.worker_id,
          attempt: body.attempt,
          status: ["running", "cancelled"],
        },
      );
      if (!updated) throw leaseLost(id);

      const reason = stopReason(updated);

      return {
        status: updated.status,
        should_stop: reason !== null,
        stop_reason: reason,
        lease_expires_at: leaseExpiresAt,
      };
    },

    progress: async (principal, id, body) => {
      const run = await loadLeased(principal, id, body.worker_id, body.attempt);
      const attemptTokens = Math.max(run.attempt_tokens, body.metric.tokens);
      const cost = runCost(run, attemptTokens);
      // One step's point is stored once per attempt (a retry returns it), and
      // only while this worker still holds the lease.
      const updated = await store.transaction(async (tx) => {
        const point = await tx.metrics.append(run.id, run.attempt, {
          ...body.metric,
          tokens: run.billed_tokens + attemptTokens,
          cost_usd: cost,
        });
        const fenced = await tx.runs.update(
          id,
          {
            attempt_tokens: attemptTokens,
            current_step: Math.max(run.current_step, point.step),
            latest_metric:
              point.step >= (run.latest_metric?.step ?? -1)
                ? point
                : run.latest_metric,
            lease_expires_at: addSeconds(
              clock.now(),
              run.lease_seconds,
            ).toISOString(),
          },
          {
            workerId: body.worker_id,
            attempt: body.attempt,
            status: ["running", "cancelled"],
          },
        );
        if (!fenced) throw leaseLost(id);

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
      const run = await loadLeased(principal, id, body.worker_id, body.attempt);

      return uploads.createTicket({
        workspaceId: run.workspace_id,
        purpose: body.kind,
        jobId: run.id,
        attempt: run.attempt,
        sha256: body.sha256,
        sizeBytes: body.size_bytes,
      });
    },

    registerCheckpoint: async (principal, id, body) => {
      const run = await loadLeased(principal, id, body.worker_id, body.attempt);
      const upload = await uploads.load({
        uploadId: body.upload_id,
        workspaceId: run.workspace_id,
        purpose: "checkpoint",
        jobId: run.id,
        attempt: run.attempt,
      });
      await uploads.verify(upload);

      const now = clock.now();
      const consumedBy = `checkpoint:${run.id}:${run.attempt}:${body.step}`;
      const result = await store.transaction(async (tx) => {
        // A retried registration of the same upload is a no-op.
        const consumed =
          upload.consumed_by === consumedBy
            ? upload
            : await uploads.consume(tx, upload, consumedBy);
        const inserted = await tx.checkpoints.insert({
          workspaceId: run.workspace_id,
          runId: run.id,
          attempt: run.attempt,
          step: body.step,
          evalScore: body.eval_score ?? null,
          format: body.format ?? null,
          storageKey: consumed.storage_key,
          sha256: consumed.sha256,
          sizeBytes: consumed.size_bytes,
          metadata: body.metadata,
          expiresAt: addDays(
            now,
            run.resolved_config.checkpoint_ttl_days,
          ).toISOString(),
        });
        if (
          !inserted.created &&
          inserted.checkpoint.sha256 !== consumed.sha256
        ) {
          throw conflict(
            "checkpoint_conflict",
            `Checkpoint for step ${body.step} of attempt ${run.attempt} already exists with different contents.`,
          );
        }

        return inserted;
      });

      // A re-upload of an existing checkpoint is dropped; a retry of the same
      // upload is that checkpoint.
      if (
        !result.created &&
        result.checkpoint.storage_key !== upload.storage_key
      ) {
        await storage.delete(upload.storage_key).catch(() => undefined);
      }

      return {
        checkpoint: toPublicCheckpoint(result.checkpoint),
        created: result.created,
      };
    },

    complete: async (principal, id, body) => {
      const run = await store.runs.getById(id);
      if (!run) throw notFound("trainer_job", id);
      assertWorkerScope(principal, run.workspace_id, id);

      const consumedBy = `run:${run.id}:${body.attempt}`;
      if (run.worker_id !== body.worker_id || run.attempt !== body.attempt) {
        // Idempotent retry of a completion that already committed.
        const upload = body.upload_id
          ? await store.uploads.get(body.upload_id)
          : null;
        const sameAttemptClosed =
          run.attempt === body.attempt && run.worker_id === null;
        if (
          sameAttemptClosed &&
          (!body.upload_id || upload?.consumed_by === consumedBy)
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

      const upload =
        wantsArtifact && body.upload_id
          ? await uploads.load({
              uploadId: body.upload_id,
              workspaceId: run.workspace_id,
              purpose: "artifact",
              jobId: run.id,
              attempt: run.attempt,
            })
          : null;
      if (upload) await uploads.verify(upload);

      const tokens = Math.max(body.tokens_processed, run.attempt_tokens);
      const now = clock.now().toISOString();
      const format = body.format ?? defaultFormatForRecipe(run.recipe_kind);
      if (!ArtifactFormatSchema.safeParse(format).success) {
        throw invalid("invalid_format", `Unknown artifact format '${format}'.`);
      }

      const result = await store.transaction(async (tx) => {
        let artifact: ArtifactRecord | null = null;
        if (upload) {
          const consumed = await uploads.consume(tx, upload, consumedBy);
          artifact = await tx.artifacts.create({
            workspaceId: run.workspace_id,
            name: run.name,
            runId: run.id,
            checkpointId: null,
            baseModel: run.resolved_config.model,
            recipeKind: run.recipe_kind,
            format,
            storageKey: consumed.storage_key,
            sha256: consumed.sha256,
            sizeBytes: consumed.size_bytes,
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
          });
        }

        const patch: RunPatch =
          run.status === "cancelled"
            ? { status: "cancelled", finished_at: now }
            : body.status === "abandoned"
              ? requeuePatch(
                  run,
                  `Attempt ${run.attempt} was abandoned by its worker (shutdown or preemption)`,
                  now,
                )
              : {
                  status:
                    body.status === "cancelled" ? "cancelled" : body.status,
                  finished_at: now,
                  error:
                    body.status === "failed"
                      ? (body.error ?? "The trainer reported a failure.")
                      : null,
                  ...(artifact ? { artifact_id: artifact.id } : {}),
                  ...(body.eval_report !== undefined
                    ? { eval_report: body.eval_report }
                    : {}),
                };

        const updated = await closeAttempt(tx, run, tokens, patch);

        return { run: updated, artifact };
      });

      billing.kick();

      return {
        run: toPublicRun(result.run),
        artifact: result.artifact ? toPublicArtifact(result.artifact) : null,
      };
    },

    datasetStream: async (principal, id, attempt) => {
      const run = await store.runs.getById(id);
      if (!run) throw notFound("trainer_job", id);
      assertWorkerScope(principal, run.workspace_id, id);
      if (run.attempt !== attempt || run.worker_id === null)
        throw leaseLost(id);

      const training = await trainingRecords(run);

      return training.kind === "dataset"
        ? streamVersionJsonl(storage, training.version)
        : jsonlStream(training.records);
    },

    expireLeases,

    collectExpiredCheckpoints: async (now) => {
      const expired = await store.checkpoints.listExpired(now, 100);
      for (const checkpoint of expired) {
        await storage.delete(checkpoint.storage_key);
        await store.checkpoints.delete(checkpoint.id);
      }

      return expired.length;
    },
  };
};
