import type {
  ApiKey,
  ApiKeyScope,
  Artifact,
  ArtifactFormat,
  ChatMessage,
  Checkpoint,
  Dataset,
  DatasetRecord,
  Deployment,
  EvalModelSummary,
  EvalReport,
  EvalRubricItem,
  EvalStatus,
  FeedbackRecord,
  ImportJob,
  ImportStatus,
  MetricPoint,
  MetricPointInput,
  RecipeKind,
  ResolvedRunConfig,
  RunStatus,
} from "../contracts.js";

export interface PageRequest {
  limit: number;
  cursor?: string | undefined;
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

// --- API keys ----------------------------------------------------------------

export interface KeyLookupResult {
  id: string;
  workspace_id: string;
  name: string;
  scopes: ApiKeyScope[];
}

export interface ApiKeyRepository {
  create(input: {
    workspaceId: string;
    name: string;
    scopes: ApiKeyScope[];
  }): Promise<{ key: ApiKey; secret: string }>;
  list(workspaceId: string, page: PageRequest): Promise<Page<ApiKey>>;
  revoke(workspaceId: string, id: string): Promise<ApiKey | null>;
  findActiveByHash(keyHash: string): Promise<KeyLookupResult | null>;
}

// --- Datasets ----------------------------------------------------------------

/** One immutable, append-only JSONL object holding `count` records. */
export interface DatasetPart {
  key: string;
  count: number;
  sha256: string;
  bytes: number;
}

export interface DatasetVersion {
  dataset_id: string;
  version: number;
  parts: DatasetPart[];
  record_count: number;
  created_at: string;
}

export interface DatasetRepository {
  /** Returns null when a dataset with that name already exists. */
  create(input: {
    workspaceId: string;
    name: string;
    metadata: Record<string, unknown>;
  }): Promise<Dataset | null>;
  getOrCreate(input: {
    workspaceId: string;
    name: string;
    metadata: Record<string, unknown>;
  }): Promise<Dataset>;
  get(workspaceId: string, name: string): Promise<Dataset | null>;
  getById(workspaceId: string, id: string): Promise<Dataset | null>;
  list(workspaceId: string, page: PageRequest): Promise<Page<Dataset>>;
  /**
   * Atomically bumps the dataset version and records a new version whose
   * parts are the previous version's parts followed by `parts`. Safe under
   * concurrent appends from multiple API replicas (row lock / serialization).
   */
  appendVersion(input: {
    datasetId: string;
    parts: DatasetPart[];
    metadata?: Record<string, unknown>;
  }): Promise<{ dataset: Dataset; version: DatasetVersion }>;
  /** Version 0 is the empty dataset and always exists after create. */
  getVersion(
    datasetId: string,
    version: number,
  ): Promise<DatasetVersion | null>;
}

// --- Import jobs -------------------------------------------------------------

export interface ImportJobRecord extends ImportJob {
  dataset_id: string;
  upload_key: string | null;
  worker_id: string | null;
  lease_expires_at: string | null;
  lease_seconds: number;
  failed_attempts: number;
}

export type ImportJobPatch = Partial<
  Pick<
    ImportJobRecord,
    | "status"
    | "attempt"
    | "imported_count"
    | "dropped_count"
    | "detected_scores"
    | "drop_reasons"
    | "dataset_version"
    | "error"
    | "worker_id"
    | "lease_expires_at"
    | "lease_seconds"
    | "failed_attempts"
    | "updated_at"
  >
>;

export interface JobExpectation<S extends string> {
  /** Only a lease that expired before this instant (the reaper's re-check). */
  leaseExpiredBefore?: string;
  status?: readonly S[];
  workerId?: string | null;
  attempt?: number;
}

export interface ClaimInput {
  workerId: string;
  leaseSeconds: number;
  now: Date;
  /** Restrict to one workspace (workspace-scoped worker keys). */
  workspaceId?: string | undefined;
}

export interface ImportJobRepository {
  create(input: {
    workspaceId: string;
    datasetId: string;
    datasetName: string;
    source: Record<string, unknown>;
    connector: ImportJob["connector"];
    uploadKey: string | null;
  }): Promise<ImportJobRecord>;
  get(workspaceId: string, id: string): Promise<ImportJobRecord | null>;
  getById(id: string): Promise<ImportJobRecord | null>;
  list(workspaceId: string, page: PageRequest): Promise<Page<ImportJobRecord>>;
  /** Conditional update; returns null when the expectation does not hold. */
  update(
    id: string,
    patch: ImportJobPatch,
    expect?: JobExpectation<ImportStatus>,
  ): Promise<ImportJobRecord | null>;
  /** Oldest queued job → running, attempt + 1, lease set (SKIP LOCKED). */
  claimNext(input: ClaimInput): Promise<ImportJobRecord | null>;
  /** The job `workerId` holds a lease on, if any (a claim retried after a lost response). */
  heldBy(workerId: string): Promise<ImportJobRecord | null>;
  listExpiredLeases(now: Date, limit: number): Promise<ImportJobRecord[]>;
  /**
   * Records batch `batch` of an attempt once: false when (import, attempt,
   * batch) already exists (a worker retry). `part` is null when every record
   * of the batch was dropped.
   */
  addPart(input: {
    importId: string;
    attempt: number;
    batch: number;
    part: DatasetPart | null;
    dropped: number;
  }): Promise<boolean>;
  /** An attempt's parts in batch order, and the records its batches dropped. */
  listParts(
    importId: string,
    attempt: number,
  ): Promise<{ parts: DatasetPart[]; dropped: number }>;
}

// --- Runs --------------------------------------------------------------------

export interface RunRecord {
  id: string;
  workspace_id: string;
  name: string;
  dataset_id: string;
  dataset_name: string;
  dataset_version: number;
  recipe_kind: RecipeKind;
  status: RunStatus;
  resolved_config: ResolvedRunConfig;
  max_cost_usd: number | null;
  price_per_million_tokens: number;
  total_steps: number;
  current_step: number;
  /** Total attempts ever started (monotonic; used in billing keys). */
  attempt: number;
  max_attempts: number;
  /**
   * Attempts that ended without a result (lease expired or abandoned by a
   * preempted worker) since creation or the last resume; at max_attempts the
   * run fails.
   */
  failed_attempts: number;
  /** Tokens of closed (billed) attempts; their cost is derived from them. */
  billed_tokens: number;
  /** Latest tokens reported by the open attempt (0 when none is open). */
  attempt_tokens: number;
  worker_id: string | null;
  lease_expires_at: string | null;
  lease_seconds: number;
  latest_metric: MetricPoint | null;
  eval_report: EvalReport | null;
  artifact_id: string | null;
  /**
   * The labeling eval this queued router run waits for; it is not claimable
   * until the eval completes and this is set to null.
   */
  waiting_on: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export type RunPatch = Partial<
  Omit<
    RunRecord,
    | "id"
    | "workspace_id"
    | "name"
    | "dataset_id"
    | "dataset_name"
    | "dataset_version"
    | "recipe_kind"
    | "resolved_config"
    | "price_per_million_tokens"
    | "created_at"
  >
>;

export interface RunRepository {
  create(input: {
    workspaceId: string;
    name: string;
    datasetId: string;
    datasetName: string;
    datasetVersion: number;
    recipeKind: RecipeKind;
    resolvedConfig: ResolvedRunConfig;
    maxCostUsd: number | null;
    pricePerMillionTokens: number;
    totalSteps: number;
    maxAttempts: number;
    /** The labeling eval this run waits on (not claimable until released). */
    waitingOn?: string | null | undefined;
  }): Promise<RunRecord>;
  get(workspaceId: string, id: string): Promise<RunRecord | null>;
  getById(id: string): Promise<RunRecord | null>;
  list(workspaceId: string, page: PageRequest): Promise<Page<RunRecord>>;
  /** Queued runs waiting on the labeling eval `evalId`. */
  listWaitingOn(evalId: string): Promise<RunRecord[]>;
  update(
    id: string,
    patch: RunPatch,
    expect?: JobExpectation<RunStatus>,
  ): Promise<RunRecord | null>;
  /**
   * Oldest queued run (optionally restricted to `recipes`) → running with
   * attempt + 1, `attempt_tokens = 0`, worker and lease set. SKIP LOCKED.
   */
  claimNext(
    input: ClaimInput & { recipes?: readonly RecipeKind[] | undefined },
  ): Promise<RunRecord | null>;
  /** Runs with an open attempt (worker set) whose lease has expired. */
  /** The run `workerId` holds a lease on, if any (a claim retried after a lost response). */
  heldBy(workerId: string): Promise<RunRecord | null>;
  listExpiredLeases(now: Date, limit: number): Promise<RunRecord[]>;
  /** Queue depth for autoscaling: queued + running (open attempts). */
}

export interface MetricsRepository {
  /** Idempotent on (run, attempt, step): a replay returns the stored point. */
  append(
    runId: string,
    attempt: number,
    point: MetricPointInput & { cost_usd: number },
  ): Promise<MetricPoint>;
  /** Points with seq > afterSeq, ascending by seq. */
  list(runId: string, afterSeq: number, limit: number): Promise<MetricPoint[]>;
}

// --- Checkpoints ---------------------------------------------------------------

export interface CheckpointRecord extends Checkpoint {
  storage_key: string;
}

export interface CheckpointRepository {
  /**
   * Inserts unless a checkpoint for (run_id, attempt, step) exists, in which
   * case the existing row is returned with `created: false`.
   */
  insert(input: {
    workspaceId: string;
    runId: string;
    attempt: number;
    step: number;
    evalScore: number | null;
    format: ArtifactFormat | null;
    storageKey: string;
    sha256: string;
    sizeBytes: number;
    metadata: Record<string, unknown>;
    expiresAt: string | null;
  }): Promise<{ checkpoint: CheckpointRecord; created: boolean }>;
  get(workspaceId: string, id: string): Promise<CheckpointRecord | null>;
  /** Unexpired checkpoints, ordered by (step, attempt, id) ascending. */
  listByRun(
    workspaceId: string,
    runId: string,
    page: PageRequest,
    now: Date,
  ): Promise<Page<CheckpointRecord>>;
  /** Unexpired checkpoint with the highest step (ties → highest attempt). */
  latestForRun(runId: string, now: Date): Promise<CheckpointRecord | null>;
  /** Unexpired checkpoints of a run, for best/final selection. */
  listAllForRun(runId: string, now: Date): Promise<CheckpointRecord[]>;
  /** Marks best/final (they never expire: `expires_at = null`). */
  pinRetention(
    runId: string,
    input: { bestId: string | null; finalId: string | null },
  ): Promise<void>;
  listExpired(now: Date, limit: number): Promise<CheckpointRecord[]>;
  delete(id: string): Promise<void>;
}

// --- Artifacts -------------------------------------------------------------------

export interface ArtifactRecord extends Artifact {
  storage_key: string;
}

export interface ArtifactRepository {
  /** Allocates `name@YYYY-MM-DD-n` (UTC day of `now`) atomically. */
  create(input: {
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
    evalReport: EvalReport | null;
  }): Promise<ArtifactRecord>;
  /** `reference` is an artifact id or `name@latest`. */
  get(workspaceId: string, reference: string): Promise<ArtifactRecord | null>;
  list(
    workspaceId: string,
    filter: { name?: string | undefined },
    page: PageRequest,
  ): Promise<Page<ArtifactRecord>>;
}

// --- Uploads -----------------------------------------------------------------------

export type UploadPurpose = "checkpoint" | "artifact" | "dataset_import";

export interface UploadRecord {
  id: string;
  workspace_id: string;
  purpose: UploadPurpose;
  job_id: string | null;
  attempt: number | null;
  storage_key: string;
  sha256: string;
  size_bytes: number;
  status: "pending" | "uploaded" | "consumed";
  consumed_by: string | null;
  created_at: string;
  expires_at: string;
}

export interface UploadRepository {
  create(input: {
    id: string;
    workspaceId: string;
    purpose: UploadPurpose;
    jobId: string | null;
    attempt: number | null;
    storageKey: string;
    sha256: string;
    sizeBytes: number;
    expiresAt: string;
  }): Promise<UploadRecord>;
  get(id: string): Promise<UploadRecord | null>;
  /** pending → uploaded; null when not pending. */
  markUploaded(id: string): Promise<UploadRecord | null>;
  /** pending|uploaded → consumed; null when already consumed or missing. */
  consume(id: string, consumedBy: string): Promise<UploadRecord | null>;
  /** Unconsumed uploads past `expires_at`, for garbage collection. */
  listExpired(now: Date, limit: number): Promise<UploadRecord[]>;
  delete(id: string): Promise<void>;
}

// --- Deployments, inferences, feedback ------------------------------------------

export interface DeploymentRepository {
  get(workspaceId: string, name: string): Promise<Deployment | null>;
  list(workspaceId: string, page: PageRequest): Promise<Page<Deployment>>;
  /** Sets previous_artifact_id to the old active artifact when it changes. */
  upsert(input: {
    workspaceId: string;
    name: string;
    modelId: string;
    activeArtifactId: string;
    fallbackModel: string | null;
    exploreRate: number;
  }): Promise<Deployment>;
  /**
   * Serializes deploys of one (workspace, name) for the rest of the current
   * transaction (advisory transaction lock).
   */
  lock(workspaceId: string, name: string): Promise<void>;
}

export interface InferenceRecord {
  id: string;
  workspace_id: string;
  deployment_name: string;
  artifact_id: string;
  model: string;
  created_at: string;
}

export interface InferenceRepository {
  create(input: Omit<InferenceRecord, "created_at">): Promise<InferenceRecord>;
  getMany(
    workspaceId: string,
    ids: readonly string[],
  ): Promise<InferenceRecord[]>;
}

export interface FeedbackInsert {
  workspaceId: string;
  inferenceId: string | null;
  sessionId: string | null;
  deploymentName: string | null;
  idempotencyKey: string;
  score: number | null;
  expectedOutput: unknown;
  metrics: Record<string, number>;
}

export interface FeedbackRepository {
  /** Idempotent on (workspace, idempotency_key); preserves input order. */
  insertMany(
    events: readonly FeedbackInsert[],
  ): Promise<Array<{ record: FeedbackRecord; deduplicated: boolean }>>;
  stats(
    workspaceId: string,
    deploymentName: string,
  ): Promise<{ count: number; average_score: number | null }>;
}

// --- Evals -----------------------------------------------------------------------

export interface EvalRecord {
  id: string;
  workspace_id: string;
  name: string;
  status: EvalStatus;
  models: string[];
  /** model ref → inference model name and price (resolved at create). */
  model_targets: Record<
    string,
    { inference_model: string; price_per_million_tokens: number | null }
  >;
  baseline: string | null;
  dataset_id: string;
  dataset_name: string;
  dataset_version: number;
  rubric: EvalRubricItem[];
  samples: number;
  temperature: number;
  max_tokens: number;
  limit: number | null;
  pass_threshold: number;
  judge_models: string[];
  local_scorers: string[];
  total_outputs: number;
  generated: number;
  summary: EvalModelSummary[];
  total_cost_usd: number;
  error: string | null;
  attempt: number;
  worker_id: string | null;
  lease_expires_at: string | null;
  lease_seconds: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type EvalPatch = Partial<
  Pick<
    EvalRecord,
    | "status"
    | "total_outputs"
    | "generated"
    | "summary"
    | "total_cost_usd"
    | "error"
    | "attempt"
    | "worker_id"
    | "lease_expires_at"
    | "lease_seconds"
    | "updated_at"
    | "completed_at"
  >
>;

export interface EvalTaskRow {
  eval_id: string;
  task_index: number;
  task_id: string;
  record: DatasetRecord;
}

export interface EvalOutputRow {
  id: string;
  eval_id: string;
  task_index: number;
  task_id: string;
  model: string;
  sample_index: number;
  input: ChatMessage[];
  output: string | null;
  expected_output: unknown;
  scores: Record<string, number>;
  error: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  cost_usd: number;
  created_at: string;
}

export interface EvalResultRow {
  eval_id: string;
  task_index: number;
  task_id: string;
  model: string;
  score: number;
  passed: boolean;
  sample_scores: number[];
  judge_model: string | null;
}

export interface EvalRepository {
  create(
    input: Omit<
      EvalRecord,
      | "id"
      | "status"
      | "total_outputs"
      | "generated"
      | "summary"
      | "total_cost_usd"
      | "error"
      | "attempt"
      | "worker_id"
      | "lease_expires_at"
      | "lease_seconds"
      | "created_at"
      | "updated_at"
      | "completed_at"
    >,
  ): Promise<EvalRecord>;
  get(workspaceId: string, id: string): Promise<EvalRecord | null>;
  getById(id: string): Promise<EvalRecord | null>;
  list(workspaceId: string, page: PageRequest): Promise<Page<EvalRecord>>;
  update(
    id: string,
    patch: EvalPatch,
    expect?: JobExpectation<EvalStatus>,
  ): Promise<EvalRecord | null>;
  claimNext(input: ClaimInput): Promise<EvalRecord | null>;
  listExpiredLeases(now: Date, limit: number): Promise<EvalRecord[]>;
  /** Evals waiting for SDK-posted scores, least recently touched first. */
  listAwaitingScores(limit: number): Promise<EvalRecord[]>;

  insertTasks(evalId: string, tasks: readonly EvalTaskRow[]): Promise<void>;
  /** Tasks with task_index > afterIndex, ascending. */
  listTasks(
    evalId: string,
    afterIndex: number,
    limit: number,
  ): Promise<EvalTaskRow[]>;

  /** Insert or replace by (eval_id, model, task_index, sample_index). */
  upsertOutput(output: EvalOutputRow): Promise<void>;
  /** Keys `${model}\u0000${task_index}\u0000${sample_index}` already generated. */
  listOutputKeys(evalId: string): Promise<Set<string>>;
  /** Ordered by (task_index, model, sample_index); joins the task record. */
  listOutputs(
    evalId: string,
    filter: { model?: string | undefined; missingScorer?: string | undefined },
    page: PageRequest,
  ): Promise<Page<EvalOutputRow & { record: DatasetRecord }>>;
  /** Merges `scorer: score` into outputs of this eval; returns accepted count. */
  setScores(
    evalId: string,
    entries: ReadonlyArray<{
      output_id: string;
      scorer: string;
      score: number;
    }>,
  ): Promise<number>;
  /** Outputs missing at least one of `scorers` (outputs with an error excluded). */
  countMissingScores(
    evalId: string,
    scorers: readonly string[],
  ): Promise<number>;

  replaceResults(evalId: string, rows: readonly EvalResultRow[]): Promise<void>;
  /** Ordered by (task_index, model). `maxScore` keeps rows with score < maxScore. */
  listResults(
    evalId: string,
    filter: { model?: string | undefined; maxScore?: number | undefined },
    page: PageRequest,
  ): Promise<Page<EvalResultRow & { record: DatasetRecord }>>;
}

// --- Billing outbox ----------------------------------------------------------------

/** What a usage record bills: a training run attempt or an eval. */
export type UsageKind = "run" | "eval";

export interface BillingOutboxEntry {
  id: string;
  idempotency_key: string;
  workspace_id: string;
  kind: UsageKind;
  /** The run id (kind run) or eval id (kind eval). */
  run_id: string;
  attempt: number;
  tokens: number;
  cost_usd: number;
  status: "pending" | "sent";
  attempts: number;
  last_error: string | null;
  next_attempt_at: string;
  created_at: string;
  sent_at: string | null;
}

export interface BillingOutboxRepository {
  /** Idempotent on idempotency_key; returns the stored entry. */
  enqueue(input: {
    idempotencyKey: string;
    workspaceId: string;
    kind: UsageKind;
    runId: string;
    attempt: number;
    tokens: number;
    costUsd: number;
  }): Promise<BillingOutboxEntry>;
  /**
   * Pending entries with next_attempt_at <= now; pushes their
   * next_attempt_at to now + lockSeconds so concurrent drainers skip them.
   */
  claimDue(
    now: Date,
    limit: number,
    lockSeconds: number,
  ): Promise<BillingOutboxEntry[]>;
  markSent(id: string): Promise<void>;
  markFailed(id: string, error: string, nextAttemptAt: Date): Promise<void>;
  listByRun(runId: string): Promise<BillingOutboxEntry[]>;
}

// --- Idempotency keys ---------------------------------------------------------------

/** One `Idempotency-Key` namespace: a key is unique per caller, method and path. */
export interface IdempotencyScope {
  workspaceId: string;
  principal: string;
  method: string;
  path: string;
  key: string;
}

export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type IdempotencyClaim =
  | { outcome: "claimed"; claimId: string }
  | { outcome: "in_progress" }
  | { outcome: "mismatch" }
  | { outcome: "completed"; response: StoredResponse };

export interface IdempotencyRepository {
  /**
   * Atomically claims `scope` for a request whose body hashes to
   * `requestHash`. A row created before `expiredBefore`, or still in progress
   * since before `abandonedBefore`, is taken over; any other existing row is
   * reported (completed, in progress, or a different request body).
   */
  claim(
    scope: IdempotencyScope,
    requestHash: string,
    at: { now: Date; expiredBefore: Date; abandonedBefore: Date },
    options?: {
      /**
       * Inside a transaction: how long to wait for a concurrent transaction
       * holding the same key before reporting it in progress (Postgres).
       */
      waitMs?: number;
    },
  ): Promise<IdempotencyClaim>;
  /** Stores the response of the request holding `claimId`. */
  complete(
    scope: IdempotencyScope,
    claimId: string,
    response: StoredResponse,
    now: Date,
  ): Promise<void>;
  /** Drops the claim so the same key can be retried (5xx, thrown errors). */
  release(scope: IdempotencyScope, claimId: string): Promise<void>;
  /** Deletes every row created before `before`; returns how many. */
  deleteExpired(before: Date): Promise<number>;
}

// --- Composition ----------------------------------------------------------------------

export interface Repositories {
  apiKeys: ApiKeyRepository;
  datasets: DatasetRepository;
  imports: ImportJobRepository;
  runs: RunRepository;
  metrics: MetricsRepository;
  checkpoints: CheckpointRepository;
  artifacts: ArtifactRepository;
  uploads: UploadRepository;
  deployments: DeploymentRepository;
  inferences: InferenceRepository;
  feedback: FeedbackRepository;
  evals: EvalRepository;
  billing: BillingOutboxRepository;
  idempotency: IdempotencyRepository;
}

export interface Store extends Repositories {
  /**
   * Runs `fn` atomically: one transaction on one connection. Nested calls
   * join the outer transaction; an error thrown inside a nested call rolls
   * back only that call (savepoint).
   */
  transaction<T>(fn: (tx: Repositories) => Promise<T>): Promise<T>;
  migrate(): Promise<void>;
  ping(): Promise<boolean>;
  /** The database clock (`SELECT now()`). */
  dbNow(): Promise<Date>;
  close(): Promise<void>;
}
