import type { AuthPrincipal } from "../adapters.js";
import { costForTokens } from "../catalog.js";
import { addDays, addSeconds } from "../clock.js";
import {
  ArtifactFormatSchema,
  type Artifact,
  type ArtifactFormat,
  type Checkpoint,
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
import { isArtifactRef, toBaseArtifact } from "../continued-training.js";
import { planRun } from "../planner.js";
import { decodeCursor, encodeCursor } from "../store/cursor.js";
import type {
  ArtifactRecord,
  CheckpointRecord,
  Page,
  PageRequest,
  Repositories,
  RunPatch,
  RunRecord,
} from "../store/types.js";
import type { BillingOutbox } from "./billing-outbox.js";
import { streamVersionJsonl } from "./dataset-records.js";
import type { DatasetService } from "./datasets.js";
import type { UploadService } from "./uploads.js";

type HeartbeatBody = z.infer<typeof HeartbeatRequestSchema>;
type ProgressBody = z.infer<typeof ReportProgressRequestSchema>;
type WorkerUploadBody = z.infer<typeof WorkerUploadRequestSchema>;
type CheckpointBody = z.infer<typeof RegisterCheckpointRequestSchema>;
type CompleteBody = z.infer<typeof CompleteJobRequestSchema>;

export type StopReason = "cancelled" | "budget" | null;

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
    default:
      return "peft_lora";
  }
};

const runCost = (run: RunRecord, attemptTokens = run.attempt_tokens): number =>
  Number(
    (
      run.billed_cost_usd +
      costForTokens(attemptTokens, run.price_per_million_tokens)
    ).toFixed(6),
  );

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
  depends_on: run.depends_on,
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
  ): Promise<{ run: Run; data: MetricPoint[]; next_cursor: string | null }>;
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
  },
): RunLifecycle => {
  const { store, storage, catalog, clock, settings } = deps;
  const { datasets, uploads, billing } = collaborators;

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
    const dependency = request.depends_on
      ? await store.runs.get(workspaceId, request.depends_on)
      : null;
    const artifactRef = isArtifactRef(request.recipe.model)
      ? request.recipe.model
      : dependency?.artifact_id;
    const baseArtifact = artifactRef
      ? await store.artifacts.get(workspaceId, artifactRef)
      : null;
    const plan = planRun(request, records, {
      catalog,
      datasetVersion: resolved.version.version,
      allowWave2: settings.allowWave2Recipes,
      baseArtifact: baseArtifact && toPublicArtifact(baseArtifact),
      dependency: dependency && toPublicRun(dependency),
    });

    return { plan, dataset: resolved.dataset, dependency };
  };

  /**
   * After `run` reaches a terminal status: chained runs waiting on it start
   * from its artifact (completed) or are cancelled (failed, cancelled, or an
   * artifact that can't be continued). `stopped_budget` keeps them waiting,
   * since the run can be resumed.
   */
  const settleDependents = async (
    tx: Repositories,
    run: RunRecord,
  ): Promise<void> => {
    if (!TERMINAL.includes(run.status) || run.status === "stopped_budget") {
      return;
    }
    const waiting = await tx.runs.listWaitingOn(run.id);
    if (waiting.length === 0) return;

    const artifact =
      run.status === "completed" && run.artifact_id
        ? await tx.artifacts.get(run.workspace_id, run.artifact_id)
        : null;
    const now = clock.now().toISOString();
    for (const dependent of waiting) {
      if (artifact?.format === "peft_lora") {
        await tx.runs.update(
          dependent.id,
          {
            waiting_on: null,
            resolved_config: {
              ...dependent.resolved_config,
              base_artifact: toBaseArtifact(toPublicArtifact(artifact)),
            },
            updated_at: now,
          },
          { status: ["queued"] },
        );
        continue;
      }

      const why =
        run.status === "completed"
          ? `its artifact has format '${artifact?.format ?? "none"}', which can't be continued`
          : `it ended ${run.status}`;
      const cancelled = await tx.runs.update(
        dependent.id,
        {
          status: "cancelled",
          waiting_on: null,
          finished_at: now,
          updated_at: now,
          error: `Cancelled because dependency run '${run.id}' did not produce a starting point: ${why}.`,
        },
        { status: ["queued"] },
      );
      if (cancelled) await settleDependents(tx, cancelled);
    }
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
  ): Promise<RunRecord> => {
    const now = clock.now();
    const attemptCost = costForTokens(tokens, run.price_per_million_tokens);
    const updated = await tx.runs.update(
      run.id,
      {
        ...patch,
        billed_tokens: run.billed_tokens + tokens,
        billed_cost_usd: Number((run.billed_cost_usd + attemptCost).toFixed(6)),
        attempt_tokens: 0,
        worker_id: null,
        lease_expires_at: null,
        updated_at: now.toISOString(),
      },
      {
        workerId: run.worker_id,
        attempt: run.attempt,
        status: ["running", "cancelled"],
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
      await settleDependents(tx, updated);
    }

    return updated;
  };

  const buildJob = async (run: RunRecord): Promise<TrainerJob> => {
    const datasetVersion = await store.datasets.getVersion(
      run.dataset_id,
      run.dataset_version,
    );
    if (!datasetVersion) {
      throw new Error(
        `Dataset version ${run.dataset_version} of run '${run.id}' is missing.`,
      );
    }

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
          : Number(
              Math.max(0, run.max_cost_usd - run.billed_cost_usd).toFixed(6),
            ),
      dataset: {
        version: datasetVersion.version,
        record_count: datasetVersion.record_count,
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
      const failedAttempts =
        run.status === "cancelled"
          ? run.failed_attempts
          : run.failed_attempts + 1;
      const exhausted = failedAttempts >= run.max_attempts;
      const patch: RunPatch =
        run.status === "cancelled"
          ? { status: "cancelled", finished_at: now.toISOString() }
          : exhausted
            ? {
                status: "failed",
                failed_attempts: failedAttempts,
                finished_at: now.toISOString(),
                error: `The worker stopped heartbeating ${failedAttempts} time(s) (max_attempts=${run.max_attempts}); last error: ${run.error ?? "lease expired"}.`,
              }
            : {
                status: "queued",
                failed_attempts: failedAttempts,
                error: `Attempt ${run.attempt} lost its lease; requeued.`,
              };

      try {
        await store.transaction((tx) =>
          closeAttempt(tx, run, run.attempt_tokens, patch),
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
      const { plan, dataset, dependency } = await planFor(workspaceId, request);
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

      const run = await store.runs.create({
        workspaceId,
        name: request.name,
        datasetId: dataset.id,
        datasetName: dataset.name,
        datasetVersion: plan.dataset_version,
        recipeKind: request.recipe.kind,
        resolvedConfig: plan.resolved_config,
        maxCostUsd: request.max_cost_usd ?? null,
        pricePerMillionTokens: plan.price_per_million_tokens,
        totalSteps: plan.estimated_steps,
        maxAttempts: settings.maxAttempts,
        dependsOn: dependency
          ? {
              runId: dependency.id,
              waiting: plan.resolved_config.base_artifact === null,
            }
          : undefined,
      });
      if (run.waiting_on === null) return toPublicRun(run);

      // The dependency may have finished between planning and insert.
      const latest = await store.runs.getById(run.waiting_on);
      if (latest) await store.transaction((tx) => settleDependents(tx, latest));

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
        next_cursor: last ? encodeCursor([last.seq]) : (query.cursor ?? null),
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
      const updated = await store.transaction(async (tx) => {
        const cancelled = await tx.runs.update(
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
        // Without a worker the run is final now; with one, closeAttempt settles it.
        if (cancelled?.worker_id === null) {
          await settleDependents(tx, cancelled);
        }

        return cancelled;
      });
      if (!updated)
        throw conflict(
          "run_state_changed",
          `Run '${id}' changed concurrently; retry.`,
        );

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

      // A chained run cancelled with its dependency waits for it again.
      const pendingDependency =
        run.depends_on !== null && run.resolved_config.base_artifact === null
          ? await store.runs.getById(run.depends_on)
          : null;
      if (
        pendingDependency &&
        ["failed", "cancelled"].includes(pendingDependency.status)
      ) {
        throw conflict(
          "dependency_not_viable",
          `Run '${id}' starts from run '${pendingDependency.id}', which is ${pendingDependency.status}; resume that run first.`,
        );
      }

      const cap = maxCostUsd ?? run.max_cost_usd;
      const spent = run.billed_cost_usd;
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
          waiting_on: pendingDependency?.id ?? null,
          updated_at: clock.now().toISOString(),
        },
        { status: [run.status], workerId: null },
      );
      if (!updated)
        throw conflict(
          "run_state_changed",
          `Run '${id}' changed concurrently; retry.`,
        );
      if (pendingDependency?.status !== "completed")
        return toPublicRun(updated);

      await store.transaction((tx) => settleDependents(tx, pendingDependency));

      return toPublicRun(await loadRun(workspaceId, id));
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

      for (;;) {
        const run = await store.runs.claimNext({
          workerId: input.workerId,
          leaseSeconds: input.leaseSeconds,
          now,
          recipes: input.recipes,
          workspaceId: principal.workerWorkspaceId ?? undefined,
        });
        if (!run) return null;

        if (
          run.max_cost_usd !== null &&
          run.billed_cost_usd >= run.max_cost_usd
        ) {
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
      const point = await store.metrics.append(run.id, run.attempt, {
        ...body.metric,
        tokens: run.billed_tokens + attemptTokens,
        cost_usd: cost,
      });
      const updated = await store.runs.update(
        id,
        {
          attempt_tokens: attemptTokens,
          current_step: body.metric.step,
          latest_metric: point,
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
      if (!updated) throw leaseLost(id);

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
      const result = await store.transaction(async (tx) => {
        const consumed = await uploads.consume(
          tx,
          upload,
          `checkpoint:${run.id}:${run.attempt}:${body.step}`,
        );
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

      if (!result.created) {
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
              ? { status: "queued", error: null }
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

      const version = await store.datasets.getVersion(
        run.dataset_id,
        run.dataset_version,
      );
      if (!version)
        throw notFound(
          "dataset_version",
          `${run.dataset_name}@${run.dataset_version}`,
        );

      return streamVersionJsonl(storage, version);
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
