import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import {
  ArtifactSchema,
  CheckpointSchema,
  ClaimJobRequestSchema,
  CompleteRunRequestSchema,
  DatasetRecordSchema,
  MetricPointSchema,
  PlanRunRequestSchema,
  PlanRunResponseSchema,
  PromoteCheckpointRequestSchema,
  RegisterCheckpointRequestSchema,
  ReportRunProgressSchema,
  ResumeRunRequestSchema,
  RunSchema,
} from "../contracts.js";
import { planRun } from "../planner.js";
import {
  defaultErrors,
  defaultFormatForRecipe,
  jsonResponse,
  readDatasetRecords,
  requireScope,
  respondProblem,
  type AppDependencies,
  type AppEnv,
} from "./helpers.js";

export const registerRunRoutes = (
  app: OpenAPIHono<AppEnv>,
  deps: AppDependencies,
): void => {
  const planRunRoute = createRoute({
    method: "post",
    path: "/v1/runs/plan",
    operationId: "planRun",
    summary: "Dry-run a training recipe at zero cost",
    tags: ["Runs"],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: PlanRunRequestSchema } },
      },
    },
    responses: {
      200: jsonResponse(
        PlanRunResponseSchema,
        "Resolved defaults and cost estimate.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(planRunRoute, async (c) => {
    const denied = requireScope(c, "runs:read");
    if (denied) return denied;

    const body = c.req.valid("json");
    const dataset = await deps.store.getDataset(
      c.get("principal").workspaceId,
      body.dataset,
    );
    if (!dataset) {
      return respondProblem(
        c,
        404,
        "dataset_not_found",
        "Dataset not found",
        `Dataset '${body.dataset}' was not found.`,
      );
    }

    const records = await readDatasetRecords(deps.storage, dataset.storage_key);

    try {
      const plan = planRun(body, records, {
        allowWave2: deps.allowWave2Recipes ?? false,
      });

      return c.json(plan, 200);
    } catch (error) {
      return respondProblem(
        c,
        422,
        "plan_error",
        "Cannot plan training run",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  const createRunRoute = createRoute({
    method: "post",
    path: "/v1/runs",
    operationId: "createRun",
    summary: "Create and enqueue a training run",
    tags: ["Runs"],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: PlanRunRequestSchema } },
      },
    },
    responses: {
      202: jsonResponse(RunSchema, "Enqueued training run."),
      ...defaultErrors,
    },
  });

  app.openapi(createRunRoute, async (c) => {
    const denied = requireScope(c, "runs:write");
    if (denied) return denied;

    const body = c.req.valid("json");
    const workspaceId = c.get("principal").workspaceId;
    const dataset = await deps.store.getDataset(workspaceId, body.dataset);
    if (!dataset) {
      return respondProblem(
        c,
        404,
        "dataset_not_found",
        "Dataset not found",
        `Dataset '${body.dataset}' was not found.`,
      );
    }

    const records = await readDatasetRecords(deps.storage, dataset.storage_key);
    if (records.length === 0) {
      return respondProblem(
        c,
        422,
        "empty_dataset",
        "Dataset is empty",
        `Dataset '${body.dataset}' has zero records.`,
      );
    }

    let plan;
    try {
      plan = planRun(body, records, {
        allowWave2: deps.allowWave2Recipes ?? false,
      });
    } catch (error) {
      return respondProblem(
        c,
        422,
        "plan_error",
        "Invalid run configuration",
        error instanceof Error ? error.message : String(error),
      );
    }

    const billingCheck = await deps.billing.checkCanStartRun(
      workspaceId,
      plan.estimated_cost_usd,
    );
    if (!billingCheck.allowed) {
      return respondProblem(
        c,
        403,
        "billing_denied",
        "Billing check failed",
        billingCheck.reason ?? "Insufficient balance to start training run.",
      );
    }

    const run = await deps.store.createRun({
      workspaceId,
      name: body.name,
      datasetId: dataset.id,
      datasetName: dataset.name,
      recipeKind: body.recipe.kind,
      resolvedConfig: plan.resolved_config,
      maxCostUsd: body.max_cost_usd ?? null,
      totalSteps: plan.estimated_steps,
    });

    return c.json(run, 202);
  });

  const listRunsRoute = createRoute({
    method: "get",
    path: "/v1/runs",
    operationId: "listRuns",
    summary: "List training runs",
    tags: ["Runs"],
    responses: {
      200: jsonResponse(
        z.object({ data: z.array(RunSchema) }),
        "Training runs.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(listRunsRoute, async (c) => {
    const denied = requireScope(c, "runs:read");
    if (denied) return denied;

    const data = await deps.store.listRuns(c.get("principal").workspaceId);

    return c.json({ data }, 200);
  });

  const getRunRoute = createRoute({
    method: "get",
    path: "/v1/runs/{id}",
    operationId: "getRun",
    summary: "Get a training run",
    tags: ["Runs"],
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: {
      200: jsonResponse(RunSchema, "Training run."),
      ...defaultErrors,
    },
  });

  app.openapi(getRunRoute, async (c) => {
    const denied = requireScope(c, "runs:read");
    if (denied) return denied;

    const { id } = c.req.valid("param");
    const run = await deps.store.getRun(c.get("principal").workspaceId, id);
    if (!run) {
      return respondProblem(
        c,
        404,
        "run_not_found",
        "Run not found",
        `Run '${id}' was not found.`,
      );
    }

    return c.json(run, 200);
  });

  const getRunMetricsRoute = createRoute({
    method: "get",
    path: "/v1/runs/{id}/metrics",
    operationId: "listRunMetrics",
    summary: "Fetch training step metrics for a run",
    tags: ["Runs"],
    request: {
      params: z.object({ id: z.string().min(1) }),
      query: z.object({
        after_step: z.coerce.number().int().min(-1).default(-1),
      }),
    },
    responses: {
      200: jsonResponse(
        z.object({
          run_id: z.string(),
          status: RunSchema.shape.status,
          data: z.array(MetricPointSchema),
        }),
        "Training step metrics.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(getRunMetricsRoute, async (c) => {
    const denied = requireScope(c, "runs:read");
    if (denied) return denied;

    const { id } = c.req.valid("param");
    const { after_step } = c.req.valid("query");
    const run = await deps.store.getRun(c.get("principal").workspaceId, id);
    if (!run) {
      return respondProblem(
        c,
        404,
        "run_not_found",
        "Run not found",
        `Run '${id}' was not found.`,
      );
    }

    return c.json(
      {
        run_id: run.id,
        status: run.status,
        data: run.metrics_history.filter((m) => m.step > after_step),
      },
      200,
    );
  });

  const cancelRunRoute = createRoute({
    method: "post",
    path: "/v1/runs/{id}/cancel",
    operationId: "cancelRun",
    summary: "Cancel a training run",
    tags: ["Runs"],
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: {
      200: jsonResponse(RunSchema, "Cancelled training run."),
      ...defaultErrors,
    },
  });

  app.openapi(cancelRunRoute, async (c) => {
    const denied = requireScope(c, "runs:write");
    if (denied) return denied;

    const { id } = c.req.valid("param");
    const run = await deps.store.cancelRun(c.get("principal").workspaceId, id);
    if (!run) {
      return respondProblem(
        c,
        404,
        "run_not_found",
        "Run not found",
        `Run '${id}' was not found.`,
      );
    }

    return c.json(run, 200);
  });

  const resumeRunRoute = createRoute({
    method: "post",
    path: "/v1/runs/{id}/resume",
    operationId: "resumeRun",
    summary: "Resume a stopped or failed training run",
    tags: ["Runs"],
    request: {
      params: z.object({ id: z.string().min(1) }),
      body: {
        required: false,
        content: { "application/json": { schema: ResumeRunRequestSchema } },
      },
    },
    responses: {
      200: jsonResponse(RunSchema, "Re-queued training run."),
      ...defaultErrors,
    },
  });

  app.openapi(resumeRunRoute, async (c) => {
    const denied = requireScope(c, "runs:write");
    if (denied) return denied;

    const { id } = c.req.valid("param");
    const body = c.req.valid("json") ?? {};
    const outcome = await deps.store.resumeRun(
      c.get("principal").workspaceId,
      id,
      body.max_cost_usd,
    );
    if (outcome.conflict) {
      return respondProblem(
        c,
        409,
        "run_not_resumable",
        "Run cannot be resumed",
        `Run '${id}' is not in a resumable state (must be stopped_budget, failed, cancelled, or paused).`,
      );
    }
    if (!outcome.run) {
      return respondProblem(
        c,
        404,
        "run_not_found",
        "Run not found",
        `Run '${id}' was not found.`,
      );
    }

    return c.json(outcome.run, 200);
  });

  const listCheckpointsRoute = createRoute({
    method: "get",
    path: "/v1/runs/{id}/checkpoints",
    operationId: "listRunCheckpoints",
    summary: "List checkpoints saved during a run",
    tags: ["Checkpoints"],
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: {
      200: jsonResponse(
        z.object({ data: z.array(CheckpointSchema) }),
        "Checkpoints.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(listCheckpointsRoute, async (c) => {
    const denied = requireScope(c, "runs:read");
    if (denied) return denied;

    const { id } = c.req.valid("param");
    const data = await deps.store.listCheckpoints(
      c.get("principal").workspaceId,
      id,
    );

    return c.json({ data }, 200);
  });

  const promoteCheckpointRoute = createRoute({
    method: "post",
    path: "/v1/checkpoints/{id}/promote",
    operationId: "promoteCheckpoint",
    summary: "Promote an intermediate checkpoint into a permanent artifact",
    tags: ["Checkpoints"],
    request: {
      params: z.object({ id: z.string().min(1) }),
      body: {
        required: false,
        content: {
          "application/json": { schema: PromoteCheckpointRequestSchema },
        },
      },
    },
    responses: {
      201: jsonResponse(ArtifactSchema, "Promoted artifact."),
      ...defaultErrors,
    },
  });

  app.openapi(promoteCheckpointRoute, async (c) => {
    const denied = requireScope(c, "artifacts:write");
    if (denied) return denied;

    const { id } = c.req.valid("param");
    const body = c.req.valid("json") ?? {};
    const workspaceId = c.get("principal").workspaceId;
    const ckpt = await deps.store.getCheckpoint(workspaceId, id);
    if (!ckpt) {
      return respondProblem(
        c,
        404,
        "checkpoint_not_found",
        "Checkpoint not found",
        `Checkpoint '${id}' was not found.`,
      );
    }

    const run = await deps.store.getRun(workspaceId, ckpt.run_id);
    if (!run) {
      return respondProblem(
        c,
        404,
        "run_not_found",
        "Run not found",
        `Parent run '${ckpt.run_id}' was not found.`,
      );
    }

    const artifact = await deps.store.createArtifact({
      workspaceId,
      name: body.name ?? run.name,
      runId: run.id,
      checkpointId: ckpt.id,
      baseModel: run.resolved_config.model,
      recipeKind: run.recipe_kind,
      format: defaultFormatForRecipe(run.recipe_kind),
      storageKey: ckpt.storage_key,
      sha256: ckpt.sha256,
      sizeBytes: ckpt.size_bytes,
      manifest: {
        schema: "grad.artifact/1",
        promoted_from_checkpoint: ckpt.id,
        step: ckpt.step,
        resolved_config: run.resolved_config,
        ...ckpt.metadata,
      },
      evalReport: run.eval_report,
    });

    return c.json(artifact, 201);
  });

  // --- Trainer Worker Job Protocol ---
  const claimJobRoute = createRoute({
    method: "post",
    path: "/v1/trainer-jobs/claim",
    operationId: "claimTrainerJob",
    summary: "Claim the next queued training run for execution",
    tags: ["TrainerJobs"],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: ClaimJobRequestSchema } },
      },
    },
    responses: {
      200: jsonResponse(
        z.object({
          run: RunSchema.nullable(),
          records: z.array(DatasetRecordSchema).optional(),
        }),
        "Claimed run and dataset records, or null when idle.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(claimJobRoute, async (c) => {
    const denied = requireScope(c, "trainer:worker");
    if (denied) return denied;

    const body = c.req.valid("json");
    const principal = c.get("principal");
    const run = await deps.store.claimNextRun(
      body.worker_id,
      body.lease_seconds,
      principal.isPlatformAdmin || principal.scopes.includes("trainer:worker")
        ? undefined
        : principal.workspaceId,
    );
    if (!run) return c.json({ run: null }, 200);

    const dataset = await deps.store.getDataset(
      run.workspace_id,
      run.dataset_name,
    );
    const records = dataset
      ? await readDatasetRecords(deps.storage, dataset.storage_key)
      : [];

    return c.json({ run, records }, 200);
  });

  const reportProgressRoute = createRoute({
    method: "post",
    path: "/v1/trainer-jobs/{id}/progress",
    operationId: "reportTrainerProgress",
    summary: "Report training step metrics and renew worker lease",
    tags: ["TrainerJobs"],
    request: {
      params: z.object({ id: z.string().min(1) }),
      body: {
        required: true,
        content: { "application/json": { schema: ReportRunProgressSchema } },
      },
    },
    responses: {
      200: jsonResponse(
        z.object({ run: RunSchema, should_stop: z.boolean() }),
        "Updated run and stop flag.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(reportProgressRoute, async (c) => {
    const denied = requireScope(c, "trainer:worker");
    if (denied) return denied;

    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const run = await deps.store.recordRunProgress({
      runId: id,
      workerId: body.worker_id,
      metric: body.metric,
      leaseSeconds: body.lease_seconds,
    });
    if (!run) {
      return respondProblem(
        c,
        404,
        "run_not_claimed",
        "Run not claimed by worker",
        `Run '${id}' is not currently leased by worker '${body.worker_id}'.`,
      );
    }

    const overBudget =
      run.max_cost_usd !== null && run.cost_usd >= run.max_cost_usd;

    return c.json(
      { run, should_stop: run.status === "cancelled" || overBudget },
      200,
    );
  });

  const registerCheckpointRoute = createRoute({
    method: "post",
    path: "/v1/trainer-jobs/{id}/checkpoints",
    operationId: "registerTrainerCheckpoint",
    summary: "Upload and register an intermediate checkpoint",
    tags: ["TrainerJobs"],
    request: {
      params: z.object({ id: z.string().min(1) }),
      body: {
        required: true,
        content: {
          "application/json": { schema: RegisterCheckpointRequestSchema },
        },
      },
    },
    responses: {
      201: jsonResponse(CheckpointSchema, "Stored checkpoint."),
      ...defaultErrors,
    },
  });

  app.openapi(registerCheckpointRoute, async (c) => {
    const denied = requireScope(c, "trainer:worker");
    if (denied) return denied;

    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const run = await deps.store.getRunByWorker(id, body.worker_id);
    if (!run) {
      return respondProblem(
        c,
        404,
        "run_not_claimed",
        "Run not claimed by worker",
        `Run '${id}' is not leased by worker '${body.worker_id}'.`,
      );
    }

    const bytes = Buffer.from(body.payload_base64, "base64");
    const storageKey = `checkpoints/${run.workspace_id}/${run.id}/step-${body.step}.tar.gz`;
    const stored = await deps.storage.put(storageKey, bytes);
    const ttlMs = run.resolved_config.checkpoint_ttl_days * 24 * 60 * 60 * 1000;

    const checkpoint = await deps.store.createCheckpoint({
      workspaceId: run.workspace_id,
      runId: run.id,
      step: body.step,
      evalScore: body.eval_score ?? null,
      storageKey: stored.key,
      sha256: stored.sha256,
      sizeBytes: stored.sizeBytes,
      metadata: body.metadata,
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    });

    return c.json(checkpoint, 201);
  });

  const completeJobRoute = createRoute({
    method: "post",
    path: "/v1/trainer-jobs/{id}/complete",
    operationId: "completeTrainerJob",
    summary: "Finish a training run and publish its immutable artifact",
    tags: ["TrainerJobs"],
    request: {
      params: z.object({ id: z.string().min(1) }),
      body: {
        required: true,
        content: { "application/json": { schema: CompleteRunRequestSchema } },
      },
    },
    responses: {
      200: jsonResponse(
        z.object({ run: RunSchema, artifact: ArtifactSchema.nullable() }),
        "Completed run and optional artifact.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(completeJobRoute, async (c) => {
    const denied = requireScope(c, "trainer:worker");
    if (denied) return denied;

    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const existing = await deps.store.getRunByWorker(id, body.worker_id);
    if (!existing) {
      return respondProblem(
        c,
        404,
        "run_not_claimed",
        "Run not claimed by worker",
        `Run '${id}' is not leased by worker '${body.worker_id}'.`,
      );
    }

    let artifact = null;
    if (body.artifact_base64) {
      const bytes = Buffer.from(body.artifact_base64, "base64");
      const storageKey = `artifacts/${existing.workspace_id}/${existing.name}/${existing.id}.grad.tar.gz`;
      const stored = await deps.storage.put(storageKey, bytes);

      artifact = await deps.store.createArtifact({
        workspaceId: existing.workspace_id,
        name: existing.name,
        runId: existing.id,
        checkpointId: null,
        baseModel: existing.resolved_config.model,
        recipeKind: existing.recipe_kind,
        format: body.format ?? defaultFormatForRecipe(existing.recipe_kind),
        storageKey: stored.key,
        sha256: stored.sha256,
        sizeBytes: stored.sizeBytes,
        manifest: {
          schema: "grad.artifact/1",
          resolved_config: existing.resolved_config,
          ...(body.manifest ?? {}),
        },
        evalReport: body.eval_report ?? null,
      });
    }

    const completed = await deps.store.completeRun({
      runId: existing.id,
      workerId: body.worker_id,
      status: body.status,
      ...(body.eval_report ? { evalReport: body.eval_report } : {}),
      ...(artifact ? { artifactId: artifact.id } : {}),
      ...(body.tokens_processed !== undefined
        ? { tokensProcessed: body.tokens_processed }
        : {}),
      ...(body.cost_usd !== undefined ? { costUsd: body.cost_usd } : {}),
      ...(body.error ? { error: body.error } : {}),
    });
    if (!completed) {
      return respondProblem(
        c,
        409,
        "run_completion_conflict",
        "Run completion failed",
        `Could not finalize run '${id}'.`,
      );
    }

    await deps.billing.recordRunUsage({
      workspaceId: completed.workspace_id,
      runId: completed.id,
      tokensProcessed: completed.tokens_processed,
      costUsd: completed.cost_usd,
    });

    return c.json({ run: completed, artifact }, 200);
  });
};
