import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

import { hashApiKey, type KeyLookup } from "./adapters.js";
import {
  ApiKeySchema,
  ArtifactSchema,
  CheckpointSchema,
  DatasetSchema,
  DeploymentSchema,
  EvalRunSchema,
  FeedbackRecordSchema,
  RunSchema,
  type ApiKey,
  type ApiKeyScope,
  type Artifact,
  type ArtifactFormat,
  type Checkpoint,
  type Dataset,
  type Deployment,
  type EvalModelSummary,
  type EvalRubricItem,
  type EvalRun,
  type EvalTaskOutcome,
  type FeedbackRecord,
  type MetricPoint,
  type RecipeKind,
  type ResolvedRunConfig,
  type Run,
} from "./contracts.js";

export interface TrainingStore extends KeyLookup {
  migrate?(): Promise<void>;
  ping(): Promise<boolean>;
  close?(): Promise<void>;

  createApiKey(input: {
    workspaceId: string;
    name: string;
    scopes: ApiKeyScope[];
  }): Promise<{ key: ApiKey; secret: string }>;
  listApiKeys(workspaceId: string): Promise<ApiKey[]>;
  revokeApiKey(workspaceId: string, id: string): Promise<ApiKey | null>;

  upsertDataset(input: {
    workspaceId: string;
    name: string;
    recordCount: number;
    storageKey: string;
    metadata?: Record<string, unknown>;
  }): Promise<Dataset>;
  getDataset(workspaceId: string, name: string): Promise<Dataset | null>;
  listDatasets(workspaceId: string): Promise<Dataset[]>;

  createRun(input: {
    workspaceId: string;
    name: string;
    datasetId: string;
    datasetName: string;
    recipeKind: RecipeKind;
    resolvedConfig: ResolvedRunConfig;
    maxCostUsd: number | null;
    totalSteps: number;
  }): Promise<Run>;
  getRun(workspaceId: string, runId: string): Promise<Run | null>;
  getRunByWorker(runId: string, workerId: string): Promise<Run | null>;
  listRuns(workspaceId: string): Promise<Run[]>;
  cancelRun(workspaceId: string, runId: string): Promise<Run | null>;
  resumeRun(
    workspaceId: string,
    runId: string,
    maxCostUsd?: number,
  ): Promise<{ run: Run | null; conflict?: boolean }>;
  claimNextRun(
    workerId: string,
    leaseSeconds: number,
    workspaceId?: string,
  ): Promise<Run | null>;
  recordRunProgress(input: {
    runId: string;
    workerId: string;
    metric: MetricPoint;
    leaseSeconds: number;
  }): Promise<Run | null>;
  completeRun(input: {
    runId: string;
    workerId: string;
    status: "completed" | "failed" | "stopped_budget";
    evalReport?: Record<string, unknown>;
    artifactId?: string;
    tokensProcessed?: number;
    costUsd?: number;
    error?: string;
  }): Promise<Run | null>;

  createCheckpoint(input: {
    workspaceId: string;
    runId: string;
    step: number;
    evalScore: number | null;
    storageKey: string;
    sha256: string;
    sizeBytes: number;
    metadata: Record<string, unknown>;
    expiresAt: string | null;
  }): Promise<Checkpoint>;
  listCheckpoints(workspaceId: string, runId: string): Promise<Checkpoint[]>;
  getCheckpoint(
    workspaceId: string,
    checkpointId: string,
  ): Promise<Checkpoint | null>;

  createArtifact(input: {
    workspaceId: string;
    name: string;
    runId: string | null;
    checkpointId: string | null;
    baseModel: string;
    recipeKind: RecipeKind;
    format: ArtifactFormat;
    storageKey: string;
    sha256: string;
    sizeBytes: number;
    manifest: Record<string, unknown>;
    evalReport: Record<string, unknown> | null;
  }): Promise<Artifact>;
  getArtifact(workspaceId: string, reference: string): Promise<Artifact | null>;
  listArtifacts(workspaceId: string, name?: string): Promise<Artifact[]>;

  upsertDeployment(input: {
    workspaceId: string;
    name: string;
    modelId: string;
    activeArtifactId: string;
    fallbackModel: string | null;
    exploreRate: number;
  }): Promise<Deployment>;
  getDeployment(workspaceId: string, name: string): Promise<Deployment | null>;
  listDeployments(workspaceId: string): Promise<Deployment[]>;

  recordFeedback(input: {
    workspaceId: string;
    inferenceId: string | null;
    sessionId: string | null;
    deploymentName: string | null;
    idempotencyKey: string;
    score: number | null;
    expectedOutput: unknown;
    metrics: Record<string, number>;
  }): Promise<{ record: FeedbackRecord; deduplicated: boolean }>;
  listFeedback(
    workspaceId: string,
    deploymentName?: string,
  ): Promise<FeedbackRecord[]>;

  createEval(input: {
    workspaceId: string;
    name: string;
    models: string[];
    baseline: string | null;
    taskSource: Record<string, unknown>;
    rubric: EvalRubricItem[];
    samples: number;
    passThreshold: number;
    judgeModels: string[];
    summary: EvalModelSummary[];
    results: EvalTaskOutcome[];
    totalCostUsd: number;
  }): Promise<EvalRun>;
  getEval(workspaceId: string, evalId: string): Promise<EvalRun | null>;
  listEvals(workspaceId: string): Promise<EvalRun[]>;
}

const shortId = (prefix: string): string =>
  `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

const formatDateSlug = (date: Date): string => date.toISOString().slice(0, 10);

const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const toIsoNullable = (
  value: Date | string | null | undefined,
): string | null => (value ? toIso(value) : null);

export class InMemoryTrainingStore implements TrainingStore {
  private readonly apiKeys = new Map<
    string,
    { record: ApiKey; keyHash: string }
  >();
  private readonly datasets = new Map<string, Dataset>();
  private readonly runs = new Map<string, Run>();
  private readonly checkpoints = new Map<string, Checkpoint>();
  private readonly artifacts = new Map<string, Artifact>();
  private readonly artifactCounters = new Map<string, number>();
  private readonly deployments = new Map<string, Deployment>();
  private readonly feedback = new Map<string, FeedbackRecord>();
  private readonly evals = new Map<string, EvalRun>();

  ping = async (): Promise<boolean> => true;

  findActiveKeyByHash = async (keyHash: string) => {
    for (const entry of this.apiKeys.values()) {
      if (entry.keyHash === keyHash && entry.record.revoked_at === null) {
        return {
          id: entry.record.id,
          workspace_id: entry.record.workspace_id,
          name: entry.record.name,
          scopes: entry.record.scopes,
        };
      }
    }

    return null;
  };

  createApiKey = async (input: {
    workspaceId: string;
    name: string;
    scopes: ApiKeyScope[];
  }) => {
    const raw = `grad_${randomBytes(24).toString("hex")}`;
    const record = ApiKeySchema.parse({
      id: shortId("key"),
      workspace_id: input.workspaceId,
      name: input.name,
      prefix: raw.slice(0, 12),
      scopes: input.scopes,
      created_at: new Date().toISOString(),
      revoked_at: null,
    });

    this.apiKeys.set(record.id, { record, keyHash: hashApiKey(raw) });

    return { key: record, secret: raw };
  };

  listApiKeys = async (workspaceId: string): Promise<ApiKey[]> =>
    Array.from(this.apiKeys.values())
      .filter((entry) => entry.record.workspace_id === workspaceId)
      .map((entry) => ApiKeySchema.parse(entry.record));

  revokeApiKey = async (
    workspaceId: string,
    id: string,
  ): Promise<ApiKey | null> => {
    const entry = this.apiKeys.get(id);
    if (!entry || entry.record.workspace_id !== workspaceId) return null;

    entry.record = ApiKeySchema.parse({
      ...entry.record,
      revoked_at: entry.record.revoked_at ?? new Date().toISOString(),
    });

    return entry.record;
  };

  upsertDataset = async (input: {
    workspaceId: string;
    name: string;
    recordCount: number;
    storageKey: string;
    metadata?: Record<string, unknown>;
  }): Promise<Dataset> => {
    const now = new Date().toISOString();
    const existing = await this.getDataset(input.workspaceId, input.name);

    const record = DatasetSchema.parse({
      id: existing?.id ?? shortId("ds"),
      workspace_id: input.workspaceId,
      name: input.name,
      record_count: input.recordCount,
      storage_key: input.storageKey,
      metadata: { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) },
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });

    this.datasets.set(`${input.workspaceId}:${input.name}`, record);

    return record;
  };

  getDataset = async (
    workspaceId: string,
    name: string,
  ): Promise<Dataset | null> => {
    const row = this.datasets.get(`${workspaceId}:${name}`);

    return row ? DatasetSchema.parse(row) : null;
  };

  listDatasets = async (workspaceId: string): Promise<Dataset[]> =>
    Array.from(this.datasets.values())
      .filter((d) => d.workspace_id === workspaceId)
      .map((d) => DatasetSchema.parse(d));

  createRun = async (input: {
    workspaceId: string;
    name: string;
    datasetId: string;
    datasetName: string;
    recipeKind: RecipeKind;
    resolvedConfig: ResolvedRunConfig;
    maxCostUsd: number | null;
    totalSteps: number;
  }): Promise<Run> => {
    const now = new Date().toISOString();
    const run = RunSchema.parse({
      id: shortId("run"),
      workspace_id: input.workspaceId,
      name: input.name,
      dataset_id: input.datasetId,
      dataset_name: input.datasetName,
      recipe_kind: input.recipeKind,
      status: "queued",
      resolved_config: input.resolvedConfig,
      max_cost_usd: input.maxCostUsd,
      tokens_processed: 0,
      cost_usd: 0,
      current_step: 0,
      total_steps: input.totalSteps,
      metrics_history: [],
      eval_report: null,
      artifact_id: null,
      error: null,
      worker_id: null,
      lease_expires_at: null,
      created_at: now,
      updated_at: now,
    });

    this.runs.set(run.id, run);

    return run;
  };

  getRun = async (workspaceId: string, runId: string): Promise<Run | null> => {
    const row = this.runs.get(runId);
    if (!row || row.workspace_id !== workspaceId) return null;

    return RunSchema.parse(row);
  };

  getRunByWorker = async (
    runId: string,
    workerId: string,
  ): Promise<Run | null> => {
    const row = this.runs.get(runId);
    if (!row || row.worker_id !== workerId || row.status !== "running") {
      return null;
    }

    return RunSchema.parse(row);
  };

  listRuns = async (workspaceId: string): Promise<Run[]> =>
    Array.from(this.runs.values())
      .filter((r) => r.workspace_id === workspaceId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((r) => RunSchema.parse(r));

  cancelRun = async (
    workspaceId: string,
    runId: string,
  ): Promise<Run | null> => {
    const row = this.runs.get(runId);
    if (!row || row.workspace_id !== workspaceId) return null;

    if (
      row.status === "completed" ||
      row.status === "failed" ||
      row.status === "cancelled"
    ) {
      return RunSchema.parse(row);
    }

    const updated = RunSchema.parse({
      ...row,
      status: "cancelled",
      updated_at: new Date().toISOString(),
    });
    this.runs.set(runId, updated);

    return updated;
  };

  resumeRun = async (
    workspaceId: string,
    runId: string,
    maxCostUsd?: number,
  ): Promise<{ run: Run | null; conflict?: boolean }> => {
    const row = this.runs.get(runId);
    if (!row || row.workspace_id !== workspaceId) return { run: null };

    if (
      row.status !== "stopped_budget" &&
      row.status !== "failed" &&
      row.status !== "cancelled" &&
      row.status !== "paused"
    ) {
      return { run: null, conflict: true };
    }

    const updated = RunSchema.parse({
      ...row,
      status: "queued",
      max_cost_usd: maxCostUsd ?? row.max_cost_usd,
      error: null,
      worker_id: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    });
    this.runs.set(runId, updated);

    return { run: updated };
  };

  claimNextRun = async (
    workerId: string,
    leaseSeconds: number,
    workspaceId?: string,
  ): Promise<Run | null> => {
    const now = Date.now();
    const candidates = Array.from(this.runs.values())
      .filter((run) => {
        if (workspaceId && run.workspace_id !== workspaceId) return false;
        if (run.status === "queued") return true;
        if (
          run.status === "running" &&
          run.lease_expires_at &&
          Date.parse(run.lease_expires_at) < now
        ) {
          return true;
        }

        return false;
      })
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

    const next = candidates[0];
    if (!next) return null;

    const updated = RunSchema.parse({
      ...next,
      status: "running",
      worker_id: workerId,
      lease_expires_at: new Date(now + leaseSeconds * 1000).toISOString(),
      updated_at: new Date(now).toISOString(),
    });
    this.runs.set(updated.id, updated);

    return updated;
  };

  recordRunProgress = async (input: {
    runId: string;
    workerId: string;
    metric: MetricPoint;
    leaseSeconds: number;
  }): Promise<Run | null> => {
    const row = this.runs.get(input.runId);
    if (
      !row ||
      row.worker_id !== input.workerId ||
      (row.status !== "running" && row.status !== "cancelled")
    ) {
      return null;
    }

    const now = Date.now();
    const updated = RunSchema.parse({
      ...row,
      current_step: Math.max(row.current_step, input.metric.step),
      tokens_processed: Math.max(row.tokens_processed, input.metric.tokens),
      cost_usd: Math.max(row.cost_usd, input.metric.cost_usd),
      metrics_history: [...row.metrics_history, input.metric],
      lease_expires_at: new Date(now + input.leaseSeconds * 1000).toISOString(),
      updated_at: new Date(now).toISOString(),
    });
    this.runs.set(updated.id, updated);

    return updated;
  };

  completeRun = async (input: {
    runId: string;
    workerId: string;
    status: "completed" | "failed" | "stopped_budget";
    evalReport?: Record<string, unknown>;
    artifactId?: string;
    tokensProcessed?: number;
    costUsd?: number;
    error?: string;
  }): Promise<Run | null> => {
    const row = this.runs.get(input.runId);
    if (!row || row.worker_id !== input.workerId || row.status !== "running") {
      return null;
    }

    const updated = RunSchema.parse({
      ...row,
      status: input.status,
      eval_report: input.evalReport ?? row.eval_report,
      artifact_id: input.artifactId ?? row.artifact_id,
      tokens_processed: input.tokensProcessed ?? row.tokens_processed,
      cost_usd: input.costUsd ?? row.cost_usd,
      error: input.error ?? null,
      worker_id: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    });
    this.runs.set(updated.id, updated);

    return updated;
  };

  createCheckpoint = async (input: {
    workspaceId: string;
    runId: string;
    step: number;
    evalScore: number | null;
    storageKey: string;
    sha256: string;
    sizeBytes: number;
    metadata: Record<string, unknown>;
    expiresAt: string | null;
  }): Promise<Checkpoint> => {
    const checkpoint = CheckpointSchema.parse({
      id: shortId("ckpt"),
      workspace_id: input.workspaceId,
      run_id: input.runId,
      step: input.step,
      eval_score: input.evalScore,
      storage_key: input.storageKey,
      sha256: input.sha256,
      size_bytes: input.sizeBytes,
      metadata: input.metadata,
      expires_at: input.expiresAt,
      created_at: new Date().toISOString(),
    });

    this.checkpoints.set(checkpoint.id, checkpoint);

    return checkpoint;
  };

  listCheckpoints = async (
    workspaceId: string,
    runId: string,
  ): Promise<Checkpoint[]> =>
    Array.from(this.checkpoints.values())
      .filter((c) => c.workspace_id === workspaceId && c.run_id === runId)
      .sort((a, b) => a.step - b.step)
      .map((c) => CheckpointSchema.parse(c));

  getCheckpoint = async (
    workspaceId: string,
    checkpointId: string,
  ): Promise<Checkpoint | null> => {
    const row = this.checkpoints.get(checkpointId);
    if (!row || row.workspace_id !== workspaceId) return null;

    return CheckpointSchema.parse(row);
  };

  createArtifact = async (input: {
    workspaceId: string;
    name: string;
    runId: string | null;
    checkpointId: string | null;
    baseModel: string;
    recipeKind: RecipeKind;
    format: ArtifactFormat;
    storageKey: string;
    sha256: string;
    sizeBytes: number;
    manifest: Record<string, unknown>;
    evalReport: Record<string, unknown> | null;
  }): Promise<Artifact> => {
    const now = new Date();
    const today = formatDateSlug(now);
    const counterKey = `${input.workspaceId}:${input.name}:${today}`;
    const nextSeq = (this.artifactCounters.get(counterKey) ?? 0) + 1;
    this.artifactCounters.set(counterKey, nextSeq);

    const version = `${today}-${nextSeq}`;
    const id = `${input.name}@${version}`;
    const artifact = ArtifactSchema.parse({
      id,
      workspace_id: input.workspaceId,
      name: input.name,
      version,
      run_id: input.runId,
      checkpoint_id: input.checkpointId,
      base_model: input.baseModel,
      recipe_kind: input.recipeKind,
      format: input.format,
      storage_key: input.storageKey,
      sha256: input.sha256,
      size_bytes: input.sizeBytes,
      manifest: input.manifest,
      eval_report: input.evalReport,
      created_at: now.toISOString(),
    });

    this.artifacts.set(`${input.workspaceId}:${id}`, artifact);

    return artifact;
  };

  getArtifact = async (
    workspaceId: string,
    reference: string,
  ): Promise<Artifact | null> => {
    if (reference.endsWith("@latest")) {
      const name = reference.slice(0, -"@latest".length);
      const matches = await this.listArtifacts(workspaceId, name);

      return matches[0] ?? null;
    }

    const row = this.artifacts.get(`${workspaceId}:${reference}`);

    return row ? ArtifactSchema.parse(row) : null;
  };

  listArtifacts = async (
    workspaceId: string,
    name?: string,
  ): Promise<Artifact[]> =>
    Array.from(this.artifacts.values())
      .filter(
        (a) => a.workspace_id === workspaceId && (!name || a.name === name),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((a) => ArtifactSchema.parse(a));

  upsertDeployment = async (input: {
    workspaceId: string;
    name: string;
    modelId: string;
    activeArtifactId: string;
    fallbackModel: string | null;
    exploreRate: number;
  }): Promise<Deployment> => {
    const now = new Date().toISOString();
    const existing = await this.getDeployment(input.workspaceId, input.name);

    const deployment = DeploymentSchema.parse({
      id: existing?.id ?? shortId("dep"),
      workspace_id: input.workspaceId,
      name: input.name,
      model_id: input.modelId,
      active_artifact_id: input.activeArtifactId,
      previous_artifact_id:
        existing && existing.active_artifact_id !== input.activeArtifactId
          ? existing.active_artifact_id
          : (existing?.previous_artifact_id ?? null),
      fallback_model: input.fallbackModel,
      explore_rate: input.exploreRate,
      status: "active",
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });

    this.deployments.set(`${input.workspaceId}:${input.name}`, deployment);

    return deployment;
  };

  getDeployment = async (
    workspaceId: string,
    name: string,
  ): Promise<Deployment | null> => {
    const row = this.deployments.get(`${workspaceId}:${name}`);

    return row ? DeploymentSchema.parse(row) : null;
  };

  listDeployments = async (workspaceId: string): Promise<Deployment[]> =>
    Array.from(this.deployments.values())
      .filter((d) => d.workspace_id === workspaceId)
      .map((d) => DeploymentSchema.parse(d));

  recordFeedback = async (input: {
    workspaceId: string;
    inferenceId: string | null;
    sessionId: string | null;
    deploymentName: string | null;
    idempotencyKey: string;
    score: number | null;
    expectedOutput: unknown;
    metrics: Record<string, number>;
  }): Promise<{ record: FeedbackRecord; deduplicated: boolean }> => {
    const dedupeKey = `${input.workspaceId}:${input.idempotencyKey}`;
    const existing = this.feedback.get(dedupeKey);
    if (existing) {
      return {
        record: FeedbackRecordSchema.parse(existing),
        deduplicated: true,
      };
    }

    const record = FeedbackRecordSchema.parse({
      id: shortId("fb"),
      workspace_id: input.workspaceId,
      inference_id: input.inferenceId,
      session_id: input.sessionId,
      deployment_name: input.deploymentName,
      idempotency_key: input.idempotencyKey,
      score: input.score,
      expected_output: input.expectedOutput ?? null,
      metrics: input.metrics,
      created_at: new Date().toISOString(),
    });

    this.feedback.set(dedupeKey, record);

    return { record, deduplicated: false };
  };

  listFeedback = async (
    workspaceId: string,
    deploymentName?: string,
  ): Promise<FeedbackRecord[]> =>
    Array.from(this.feedback.values())
      .filter(
        (f) =>
          f.workspace_id === workspaceId &&
          (!deploymentName || f.deployment_name === deploymentName),
      )
      .map((f) => FeedbackRecordSchema.parse(f));

  createEval = async (input: {
    workspaceId: string;
    name: string;
    models: string[];
    baseline: string | null;
    taskSource: Record<string, unknown>;
    rubric: EvalRubricItem[];
    samples: number;
    passThreshold: number;
    judgeModels: string[];
    summary: EvalModelSummary[];
    results: EvalTaskOutcome[];
    totalCostUsd: number;
  }): Promise<EvalRun> => {
    const evalRun = EvalRunSchema.parse({
      id: shortId("eval"),
      workspace_id: input.workspaceId,
      name: input.name,
      status: "completed",
      models: input.models,
      baseline: input.baseline,
      task_source: input.taskSource,
      rubric: input.rubric,
      samples: input.samples,
      pass_threshold: input.passThreshold,
      judge_models: input.judgeModels,
      summary: input.summary,
      results: input.results,
      total_cost_usd: input.totalCostUsd,
      created_at: new Date().toISOString(),
    });
    this.evals.set(evalRun.id, evalRun);

    return evalRun;
  };

  getEval = async (
    workspaceId: string,
    evalId: string,
  ): Promise<EvalRun | null> => {
    const row = this.evals.get(evalId);
    if (!row || row.workspace_id !== workspaceId) return null;

    return EvalRunSchema.parse(row);
  };

  listEvals = async (workspaceId: string): Promise<EvalRun[]> =>
    Array.from(this.evals.values())
      .filter((e) => e.workspace_id === workspaceId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((e) => EvalRunSchema.parse(e));
}

const mapRunRow = (row: Record<string, unknown>): Run =>
  RunSchema.parse({
    id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    dataset_id: row.dataset_id,
    dataset_name: row.dataset_name,
    recipe_kind: row.recipe_kind,
    status: row.status,
    resolved_config: row.resolved_config,
    max_cost_usd: row.max_cost_usd ?? null,
    tokens_processed: Number(row.tokens_processed ?? 0),
    cost_usd: Number(row.cost_usd ?? 0),
    current_step: Number(row.current_step ?? 0),
    total_steps: Number(row.total_steps ?? 0),
    metrics_history: row.metrics_history ?? [],
    eval_report: row.eval_report ?? null,
    artifact_id: row.artifact_id ?? null,
    error: row.error ?? null,
    worker_id: row.worker_id ?? null,
    lease_expires_at: toIsoNullable(
      row.lease_expires_at as Date | string | null,
    ),
    created_at: toIso(row.created_at as Date | string),
    updated_at: toIso(row.updated_at as Date | string),
  });

export class PostgresTrainingStore implements TrainingStore {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  migrate = async (): Promise<void> => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const sqlPath = path.resolve(dir, "../migrations/0001_initial.sql");
    const sql = await readFile(sqlPath, "utf8");

    await this.pool.query(sql);
  };

  ping = async (): Promise<boolean> => {
    try {
      await this.pool.query("SELECT 1");

      return true;
    } catch {
      return false;
    }
  };

  close = async (): Promise<void> => {
    await this.pool.end();
  };

  findActiveKeyByHash = async (keyHash: string) => {
    const result = await this.pool.query(
      "SELECT id, workspace_id, name, scopes FROM grad_api_keys WHERE key_hash = $1 AND revoked_at IS NULL LIMIT 1",
      [keyHash],
    );
    const row = result.rows[0] as
      | {
          id: string;
          workspace_id: string;
          name: string;
          scopes: ApiKeyScope[];
        }
      | undefined;

    return row ?? null;
  };

  createApiKey = async (input: {
    workspaceId: string;
    name: string;
    scopes: ApiKeyScope[];
  }) => {
    const secret = `grad_${randomBytes(24).toString("hex")}`;
    const id = shortId("key");
    const prefix = secret.slice(0, 12);
    const result = await this.pool.query(
      `INSERT INTO grad_api_keys (id, workspace_id, name, prefix, key_hash, scopes)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id, workspace_id, name, prefix, scopes, created_at, revoked_at`,
      [
        id,
        input.workspaceId,
        input.name,
        prefix,
        hashApiKey(secret),
        JSON.stringify(input.scopes),
      ],
    );
    const row = result.rows[0] as Record<string, unknown>;

    return {
      key: ApiKeySchema.parse({
        ...row,
        created_at: toIso(row.created_at as Date | string),
        revoked_at: toIsoNullable(row.revoked_at as Date | string | null),
      }),
      secret,
    };
  };

  listApiKeys = async (workspaceId: string): Promise<ApiKey[]> => {
    const result = await this.pool.query(
      "SELECT id, workspace_id, name, prefix, scopes, created_at, revoked_at FROM grad_api_keys WHERE workspace_id = $1 ORDER BY created_at DESC",
      [workspaceId],
    );

    return result.rows.map((row: Record<string, unknown>) =>
      ApiKeySchema.parse({
        ...row,
        created_at: toIso(row.created_at as Date | string),
        revoked_at: toIsoNullable(row.revoked_at as Date | string | null),
      }),
    );
  };

  revokeApiKey = async (
    workspaceId: string,
    id: string,
  ): Promise<ApiKey | null> => {
    const result = await this.pool.query(
      `UPDATE grad_api_keys SET revoked_at = COALESCE(revoked_at, NOW())
       WHERE workspace_id = $1 AND id = $2
       RETURNING id, workspace_id, name, prefix, scopes, created_at, revoked_at`,
      [workspaceId, id],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;

    return ApiKeySchema.parse({
      ...row,
      created_at: toIso(row.created_at as Date | string),
      revoked_at: toIsoNullable(row.revoked_at as Date | string | null),
    });
  };

  upsertDataset = async (input: {
    workspaceId: string;
    name: string;
    recordCount: number;
    storageKey: string;
    metadata?: Record<string, unknown>;
  }): Promise<Dataset> => {
    const result = await this.pool.query(
      `INSERT INTO grad_datasets (id, workspace_id, name, record_count, storage_key, metadata)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (workspace_id, name) DO UPDATE
       SET record_count = EXCLUDED.record_count,
           storage_key = EXCLUDED.storage_key,
           metadata = grad_datasets.metadata || EXCLUDED.metadata,
           updated_at = NOW()
       RETURNING *`,
      [
        shortId("ds"),
        input.workspaceId,
        input.name,
        input.recordCount,
        input.storageKey,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const row = result.rows[0] as Record<string, unknown>;

    return DatasetSchema.parse({
      ...row,
      created_at: toIso(row.created_at as Date | string),
      updated_at: toIso(row.updated_at as Date | string),
    });
  };

  getDataset = async (
    workspaceId: string,
    name: string,
  ): Promise<Dataset | null> => {
    const result = await this.pool.query(
      "SELECT * FROM grad_datasets WHERE workspace_id = $1 AND name = $2 LIMIT 1",
      [workspaceId, name],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;

    return DatasetSchema.parse({
      ...row,
      created_at: toIso(row.created_at as Date | string),
      updated_at: toIso(row.updated_at as Date | string),
    });
  };

  listDatasets = async (workspaceId: string): Promise<Dataset[]> => {
    const result = await this.pool.query(
      "SELECT * FROM grad_datasets WHERE workspace_id = $1 ORDER BY updated_at DESC",
      [workspaceId],
    );

    return result.rows.map((row: Record<string, unknown>) =>
      DatasetSchema.parse({
        ...row,
        created_at: toIso(row.created_at as Date | string),
        updated_at: toIso(row.updated_at as Date | string),
      }),
    );
  };

  createRun = async (input: {
    workspaceId: string;
    name: string;
    datasetId: string;
    datasetName: string;
    recipeKind: RecipeKind;
    resolvedConfig: ResolvedRunConfig;
    maxCostUsd: number | null;
    totalSteps: number;
  }): Promise<Run> => {
    const result = await this.pool.query(
      `INSERT INTO grad_runs (id, workspace_id, name, dataset_id, dataset_name, recipe_kind, status, resolved_config, max_cost_usd, total_steps)
       VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7::jsonb, $8, $9)
       RETURNING *`,
      [
        shortId("run"),
        input.workspaceId,
        input.name,
        input.datasetId,
        input.datasetName,
        input.recipeKind,
        JSON.stringify(input.resolvedConfig),
        input.maxCostUsd,
        input.totalSteps,
      ],
    );

    return mapRunRow(result.rows[0] as Record<string, unknown>);
  };

  getRun = async (workspaceId: string, runId: string): Promise<Run | null> => {
    const result = await this.pool.query(
      "SELECT * FROM grad_runs WHERE workspace_id = $1 AND id = $2 LIMIT 1",
      [workspaceId, runId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;

    return row ? mapRunRow(row) : null;
  };

  getRunByWorker = async (
    runId: string,
    workerId: string,
  ): Promise<Run | null> => {
    const result = await this.pool.query(
      `SELECT * FROM grad_runs
       WHERE id = $1 AND worker_id = $2 AND status = 'running'
         AND (lease_expires_at IS NULL OR lease_expires_at > NOW())
       LIMIT 1`,
      [runId, workerId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;

    return row ? mapRunRow(row) : null;
  };

  listRuns = async (workspaceId: string): Promise<Run[]> => {
    const result = await this.pool.query(
      "SELECT * FROM grad_runs WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200",
      [workspaceId],
    );

    return result.rows.map((row: Record<string, unknown>) => mapRunRow(row));
  };

  cancelRun = async (
    workspaceId: string,
    runId: string,
  ): Promise<Run | null> => {
    const result = await this.pool.query(
      `UPDATE grad_runs
       SET status = CASE WHEN status IN ('completed', 'failed', 'cancelled') THEN status ELSE 'cancelled' END,
           updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2
       RETURNING *`,
      [workspaceId, runId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;

    return row ? mapRunRow(row) : null;
  };

  resumeRun = async (
    workspaceId: string,
    runId: string,
    maxCostUsd?: number,
  ): Promise<{ run: Run | null; conflict?: boolean }> => {
    const result = await this.pool.query(
      `UPDATE grad_runs
       SET status = 'queued',
           max_cost_usd = COALESCE($3, max_cost_usd),
           error = NULL,
           worker_id = NULL,
           lease_expires_at = NULL,
           updated_at = NOW()
       WHERE workspace_id = $1 AND id = $2
         AND status IN ('stopped_budget', 'failed', 'cancelled', 'paused')
       RETURNING *`,
      [workspaceId, runId, maxCostUsd ?? null],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row) return { run: mapRunRow(row) };

    const exists = await this.getRun(workspaceId, runId);
    if (exists) return { run: null, conflict: true };

    return { run: null };
  };

  claimNextRun = async (
    workerId: string,
    leaseSeconds: number,
    workspaceId?: string,
  ): Promise<Run | null> => {
    const result = await this.pool.query(
      `WITH next_run AS (
         SELECT id FROM grad_runs
         WHERE ($3::text IS NULL OR workspace_id = $3)
           AND (status = 'queued' OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())))
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE grad_runs r
       SET status = 'running',
           worker_id = $1,
           lease_expires_at = NOW() + make_interval(secs => $2),
           updated_at = NOW()
       FROM next_run
       WHERE r.id = next_run.id
       RETURNING r.*`,
      [workerId, leaseSeconds, workspaceId ?? null],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;

    return row ? mapRunRow(row) : null;
  };

  recordRunProgress = async (input: {
    runId: string;
    workerId: string;
    metric: MetricPoint;
    leaseSeconds: number;
  }): Promise<Run | null> => {
    const result = await this.pool.query(
      `UPDATE grad_runs
       SET current_step = GREATEST(current_step, $3),
           tokens_processed = GREATEST(tokens_processed, $4),
           cost_usd = GREATEST(cost_usd, $5),
           metrics_history = metrics_history || $6::jsonb,
           lease_expires_at = NOW() + make_interval(secs => $7),
           updated_at = NOW()
       WHERE id = $1 AND worker_id = $2 AND status IN ('running', 'cancelled')
       RETURNING *`,
      [
        input.runId,
        input.workerId,
        input.metric.step,
        input.metric.tokens,
        input.metric.cost_usd,
        JSON.stringify([input.metric]),
        input.leaseSeconds,
      ],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;

    return row ? mapRunRow(row) : null;
  };

  completeRun = async (input: {
    runId: string;
    workerId: string;
    status: "completed" | "failed" | "stopped_budget";
    evalReport?: Record<string, unknown>;
    artifactId?: string;
    tokensProcessed?: number;
    costUsd?: number;
    error?: string;
  }): Promise<Run | null> => {
    const result = await this.pool.query(
      `UPDATE grad_runs
       SET status = $3,
           eval_report = COALESCE($4::jsonb, eval_report),
           artifact_id = COALESCE($5, artifact_id),
           tokens_processed = COALESCE($6, tokens_processed),
           cost_usd = COALESCE($7, cost_usd),
           error = $8,
           worker_id = NULL,
           lease_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND worker_id = $2 AND status = 'running'
       RETURNING *`,
      [
        input.runId,
        input.workerId,
        input.status,
        input.evalReport ? JSON.stringify(input.evalReport) : null,
        input.artifactId ?? null,
        input.tokensProcessed ?? null,
        input.costUsd ?? null,
        input.error ?? null,
      ],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;

    return row ? mapRunRow(row) : null;
  };

  createCheckpoint = async (input: {
    workspaceId: string;
    runId: string;
    step: number;
    evalScore: number | null;
    storageKey: string;
    sha256: string;
    sizeBytes: number;
    metadata: Record<string, unknown>;
    expiresAt: string | null;
  }): Promise<Checkpoint> => {
    const result = await this.pool.query(
      `INSERT INTO grad_checkpoints (id, workspace_id, run_id, step, eval_score, storage_key, sha256, size_bytes, metadata, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       RETURNING *`,
      [
        shortId("ckpt"),
        input.workspaceId,
        input.runId,
        input.step,
        input.evalScore,
        input.storageKey,
        input.sha256,
        input.sizeBytes,
        JSON.stringify(input.metadata),
        input.expiresAt,
      ],
    );
    const row = result.rows[0] as Record<string, unknown>;

    return CheckpointSchema.parse({
      ...row,
      size_bytes: Number(row.size_bytes),
      expires_at: toIsoNullable(row.expires_at as Date | string | null),
      created_at: toIso(row.created_at as Date | string),
    });
  };

  listCheckpoints = async (
    workspaceId: string,
    runId: string,
  ): Promise<Checkpoint[]> => {
    const result = await this.pool.query(
      "SELECT * FROM grad_checkpoints WHERE workspace_id = $1 AND run_id = $2 ORDER BY step ASC",
      [workspaceId, runId],
    );

    return result.rows.map((row: Record<string, unknown>) =>
      CheckpointSchema.parse({
        ...row,
        size_bytes: Number(row.size_bytes),
        expires_at: toIsoNullable(row.expires_at as Date | string | null),
        created_at: toIso(row.created_at as Date | string),
      }),
    );
  };

  getCheckpoint = async (
    workspaceId: string,
    checkpointId: string,
  ): Promise<Checkpoint | null> => {
    const result = await this.pool.query(
      "SELECT * FROM grad_checkpoints WHERE workspace_id = $1 AND id = $2 LIMIT 1",
      [workspaceId, checkpointId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;

    return CheckpointSchema.parse({
      ...row,
      size_bytes: Number(row.size_bytes),
      expires_at: toIsoNullable(row.expires_at as Date | string | null),
      created_at: toIso(row.created_at as Date | string),
    });
  };

  createArtifact = async (input: {
    workspaceId: string;
    name: string;
    runId: string | null;
    checkpointId: string | null;
    baseModel: string;
    recipeKind: RecipeKind;
    format: ArtifactFormat;
    storageKey: string;
    sha256: string;
    sizeBytes: number;
    manifest: Record<string, unknown>;
    evalReport: Record<string, unknown> | null;
  }): Promise<Artifact> => {
    const today = formatDateSlug(new Date());
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2 || ':' || $3))",
        [input.workspaceId, input.name, today],
      );
      const maxResult = await client.query(
        `SELECT COALESCE(MAX(CASE WHEN split_part(version, '-', 4) ~ '^[0-9]+$' THEN split_part(version, '-', 4)::int END), 0) AS max_seq
         FROM grad_artifacts
         WHERE workspace_id = $1 AND name = $2 AND version LIKE $3`,
        [input.workspaceId, input.name, `${today}-%`],
      );
      const nextIndex =
        Number((maxResult.rows[0] as { max_seq: number }).max_seq) + 1;
      const version = `${today}-${nextIndex}`;
      const id = `${input.name}@${version}`;

      const result = await client.query(
        `INSERT INTO grad_artifacts (id, workspace_id, name, version, run_id, checkpoint_id, base_model, recipe_kind, format, storage_key, sha256, size_bytes, manifest, eval_report)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
         RETURNING *`,
        [
          id,
          input.workspaceId,
          input.name,
          version,
          input.runId,
          input.checkpointId,
          input.baseModel,
          input.recipeKind,
          input.format,
          input.storageKey,
          input.sha256,
          input.sizeBytes,
          JSON.stringify(input.manifest),
          input.evalReport ? JSON.stringify(input.evalReport) : null,
        ],
      );
      await client.query("COMMIT");
      const row = result.rows[0] as Record<string, unknown>;

      return ArtifactSchema.parse({
        ...row,
        size_bytes: Number(row.size_bytes),
        created_at: toIso(row.created_at as Date | string),
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  getArtifact = async (
    workspaceId: string,
    reference: string,
  ): Promise<Artifact | null> => {
    if (reference.endsWith("@latest")) {
      const name = reference.slice(0, -"@latest".length);
      const list = await this.listArtifacts(workspaceId, name);

      return list[0] ?? null;
    }

    const result = await this.pool.query(
      "SELECT * FROM grad_artifacts WHERE workspace_id = $1 AND id = $2 LIMIT 1",
      [workspaceId, reference],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;

    return ArtifactSchema.parse({
      ...row,
      size_bytes: Number(row.size_bytes),
      created_at: toIso(row.created_at as Date | string),
    });
  };

  listArtifacts = async (
    workspaceId: string,
    name?: string,
  ): Promise<Artifact[]> => {
    const result = name
      ? await this.pool.query(
          "SELECT * FROM grad_artifacts WHERE workspace_id = $1 AND name = $2 ORDER BY created_at DESC",
          [workspaceId, name],
        )
      : await this.pool.query(
          "SELECT * FROM grad_artifacts WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200",
          [workspaceId],
        );

    return result.rows.map((row: Record<string, unknown>) =>
      ArtifactSchema.parse({
        ...row,
        size_bytes: Number(row.size_bytes),
        created_at: toIso(row.created_at as Date | string),
      }),
    );
  };

  upsertDeployment = async (input: {
    workspaceId: string;
    name: string;
    modelId: string;
    activeArtifactId: string;
    fallbackModel: string | null;
    exploreRate: number;
  }): Promise<Deployment> => {
    const result = await this.pool.query(
      `INSERT INTO grad_deployments (id, workspace_id, name, model_id, active_artifact_id, fallback_model, explore_rate, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
       ON CONFLICT (workspace_id, name) DO UPDATE
       SET previous_artifact_id = CASE
             WHEN grad_deployments.active_artifact_id <> EXCLUDED.active_artifact_id
             THEN grad_deployments.active_artifact_id
             ELSE grad_deployments.previous_artifact_id
           END,
           model_id = EXCLUDED.model_id,
           active_artifact_id = EXCLUDED.active_artifact_id,
           fallback_model = EXCLUDED.fallback_model,
           explore_rate = EXCLUDED.explore_rate,
           status = 'active',
           updated_at = NOW()
       RETURNING *`,
      [
        shortId("dep"),
        input.workspaceId,
        input.name,
        input.modelId,
        input.activeArtifactId,
        input.fallbackModel,
        input.exploreRate,
      ],
    );
    const row = result.rows[0] as Record<string, unknown>;

    return DeploymentSchema.parse({
      ...row,
      created_at: toIso(row.created_at as Date | string),
      updated_at: toIso(row.updated_at as Date | string),
    });
  };

  getDeployment = async (
    workspaceId: string,
    name: string,
  ): Promise<Deployment | null> => {
    const result = await this.pool.query(
      "SELECT * FROM grad_deployments WHERE workspace_id = $1 AND name = $2 LIMIT 1",
      [workspaceId, name],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;

    return DeploymentSchema.parse({
      ...row,
      created_at: toIso(row.created_at as Date | string),
      updated_at: toIso(row.updated_at as Date | string),
    });
  };

  listDeployments = async (workspaceId: string): Promise<Deployment[]> => {
    const result = await this.pool.query(
      "SELECT * FROM grad_deployments WHERE workspace_id = $1 ORDER BY updated_at DESC",
      [workspaceId],
    );

    return result.rows.map((row: Record<string, unknown>) =>
      DeploymentSchema.parse({
        ...row,
        created_at: toIso(row.created_at as Date | string),
        updated_at: toIso(row.updated_at as Date | string),
      }),
    );
  };

  recordFeedback = async (input: {
    workspaceId: string;
    inferenceId: string | null;
    sessionId: string | null;
    deploymentName: string | null;
    idempotencyKey: string;
    score: number | null;
    expectedOutput: unknown;
    metrics: Record<string, number>;
  }): Promise<{ record: FeedbackRecord; deduplicated: boolean }> => {
    const inserted = await this.pool.query(
      `INSERT INTO grad_feedback (id, workspace_id, inference_id, session_id, deployment_name, idempotency_key, score, expected_output, metrics)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        shortId("fb"),
        input.workspaceId,
        input.inferenceId,
        input.sessionId,
        input.deploymentName,
        input.idempotencyKey,
        input.score,
        input.expectedOutput === undefined
          ? null
          : JSON.stringify(input.expectedOutput),
        JSON.stringify(input.metrics),
      ],
    );
    if (inserted.rows[0]) {
      const row = inserted.rows[0] as Record<string, unknown>;

      return {
        record: FeedbackRecordSchema.parse({
          ...row,
          created_at: toIso(row.created_at as Date | string),
        }),
        deduplicated: false,
      };
    }

    const existing = await this.pool.query(
      "SELECT * FROM grad_feedback WHERE workspace_id = $1 AND idempotency_key = $2 LIMIT 1",
      [input.workspaceId, input.idempotencyKey],
    );
    const row = existing.rows[0] as Record<string, unknown>;

    return {
      record: FeedbackRecordSchema.parse({
        ...row,
        created_at: toIso(row.created_at as Date | string),
      }),
      deduplicated: true,
    };
  };

  listFeedback = async (
    workspaceId: string,
    deploymentName?: string,
  ): Promise<FeedbackRecord[]> => {
    const result = deploymentName
      ? await this.pool.query(
          "SELECT * FROM grad_feedback WHERE workspace_id = $1 AND deployment_name = $2 ORDER BY created_at DESC LIMIT 500",
          [workspaceId, deploymentName],
        )
      : await this.pool.query(
          "SELECT * FROM grad_feedback WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 500",
          [workspaceId],
        );

    return result.rows.map((row: Record<string, unknown>) =>
      FeedbackRecordSchema.parse({
        ...row,
        created_at: toIso(row.created_at as Date | string),
      }),
    );
  };

  createEval = async (input: {
    workspaceId: string;
    name: string;
    models: string[];
    baseline: string | null;
    taskSource: Record<string, unknown>;
    rubric: EvalRubricItem[];
    samples: number;
    passThreshold: number;
    judgeModels: string[];
    summary: EvalModelSummary[];
    results: EvalTaskOutcome[];
    totalCostUsd: number;
  }): Promise<EvalRun> => {
    const result = await this.pool.query(
      `INSERT INTO grad_evals (id, workspace_id, name, status, models, baseline, task_source, rubric, samples, pass_threshold, judge_models, summary, results, total_cost_usd)
       VALUES ($1, $2, $3, 'completed', $4::jsonb, $5, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13)
       RETURNING *`,
      [
        shortId("eval"),
        input.workspaceId,
        input.name,
        JSON.stringify(input.models),
        input.baseline,
        JSON.stringify(input.taskSource),
        JSON.stringify(input.rubric),
        input.samples,
        input.passThreshold,
        JSON.stringify(input.judgeModels),
        JSON.stringify(input.summary),
        JSON.stringify(input.results),
        input.totalCostUsd,
      ],
    );
    const row = result.rows[0] as Record<string, unknown>;

    return EvalRunSchema.parse({
      ...row,
      total_cost_usd: Number(row.total_cost_usd ?? 0),
      created_at: toIso(row.created_at as Date | string),
    });
  };

  getEval = async (
    workspaceId: string,
    evalId: string,
  ): Promise<EvalRun | null> => {
    const result = await this.pool.query(
      "SELECT * FROM grad_evals WHERE workspace_id = $1 AND id = $2 LIMIT 1",
      [workspaceId, evalId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;

    return EvalRunSchema.parse({
      ...row,
      total_cost_usd: Number(row.total_cost_usd ?? 0),
      created_at: toIso(row.created_at as Date | string),
    });
  };

  listEvals = async (workspaceId: string): Promise<EvalRun[]> => {
    const result = await this.pool.query(
      "SELECT * FROM grad_evals WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200",
      [workspaceId],
    );

    return result.rows.map((row: Record<string, unknown>) =>
      EvalRunSchema.parse({
        ...row,
        total_cost_usd: Number(row.total_cost_usd ?? 0),
        created_at: toIso(row.created_at as Date | string),
      }),
    );
  };
}
