import type {
  ApiKey,
  CheckpointEvalResult,
  ApiKeyScope,
  Artifact,
  ArtifactFormat,
  ChatMessage,
  Checkpoint,
  Dataset,
  DatasetRecord,
  EvalMode,
  EvalModelSummary,
  EvalReport,
  EvalRubricItem,
  EvalStatus,
  ImportJob,
  ImportStatus,
  MetricPoint,
  RecipeKind,
  ResolvedRunConfig,
  RunStatus,
  Secret,
  SourceProviderKind,
  UsageRecord,
} from "../contracts.js";

export interface PageRequest {
  limit: number;
  cursor?: string | undefined;
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

/**
 * A create request's Idempotency-Key and the hash of its body, stored on the
 * row it creates (unique per workspace, or per dataset for pushes).
 */
export interface IdempotencyInput {
  key: string;
  hash: string;
}

/** The row an Idempotency-Key already created, and the request that did. */
export interface IdempotentHit {
  id: string;
  request_hash: string;
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
    idempotency?: IdempotencyInput | undefined;
  }): Promise<{ key: ApiKey; secret: string }>;
  list(workspaceId: string, page: PageRequest): Promise<Page<ApiKey>>;
  revoke(workspaceId: string, id: string): Promise<ApiKey | null>;
  findActiveByHash(keyHash: string): Promise<KeyLookupResult | null>;
  findIdempotent(
    workspaceId: string,
    key: string,
  ): Promise<IdempotentHit | null>;
}

// --- Datasets ----------------------------------------------------------------

/** One immutable gzip-compressed JSONL object. */
export interface DatasetPart {
  key: string;
  /**
   * The distinct records it adds to the merged dataset: score updates and a
   * full sync's reset marker add none.
   */
  count: number;
  /** It starts with a reset marker: the version's count restarts here. */
  resets: boolean;
  /** Of the uncompressed JSONL. */
  sha256: string;
  /** Stored (compressed) size. */
  bytes: number;
}

/** A pinned version: every part with version <= `version`, in order. */
export interface DatasetVersion {
  dataset_id: string;
  version: number;
  parts: DatasetPart[];
  record_count: number;
}

export interface DatasetRepository {
  /** Returns null when a dataset with that name already exists. */
  create(input: {
    workspaceId: string;
    name: string;
    metadata: Record<string, unknown>;
    idempotency?: IdempotencyInput | undefined;
  }): Promise<Dataset | null>;
  getOrCreate(input: {
    workspaceId: string;
    name: string;
    metadata: Record<string, unknown>;
  }): Promise<Dataset>;
  get(workspaceId: string, name: string): Promise<Dataset | null>;
  getById(workspaceId: string, id: string): Promise<Dataset | null>;
  list(workspaceId: string, page: PageRequest): Promise<Page<Dataset>>;
  findIdempotent(
    workspaceId: string,
    key: string,
  ): Promise<IdempotentHit | null>;
  /**
   * Appends `parts` as the next version (row lock on the dataset, so
   * concurrent appends from several replicas serialize).
   */
  appendVersion(input: {
    datasetId: string;
    parts: DatasetPart[];
    metadata?: Record<string, unknown>;
    idempotency?: IdempotencyInput | undefined;
  }): Promise<Dataset>;
  /**
   * Appends a pushed part as the next version, or returns null (and changes
   * nothing) when the dataset already holds a push with the same content.
   */
  appendPush(input: {
    datasetId: string;
    part: DatasetPart;
    metadata?: Record<string, unknown>;
    idempotency?: IdempotencyInput | undefined;
  }): Promise<Dataset | null>;
  /**
   * Sets the merged record count while `version` is still current; null
   * when a newer version superseded it (its writer settles its own count).
   */
  setRecordCount(
    datasetId: string,
    version: number,
    count: number,
  ): Promise<Dataset | null>;
  /** The push an Idempotency-Key already appended to this dataset. */
  findIdempotentPush(
    datasetId: string,
    key: string,
  ): Promise<IdempotentHit | null>;
  /** Version 0 is the empty dataset; null past the current version. */
  getVersion(
    datasetId: string,
    version: number,
  ): Promise<DatasetVersion | null>;
  /**
   * Stages batch `batch` of an import attempt once: false when (job,
   * attempt, batch) already exists (a worker retry). `part` is null when
   * every record of the batch was dropped.
   */
  stagePart(input: {
    datasetId: string;
    jobId: string;
    attempt: number;
    batch: number;
    part: DatasetPart | null;
    dropped: number;
  }): Promise<boolean>;
  /** An attempt's staged parts (batch order) and the records they dropped. */
  listStaged(
    jobId: string,
    attempt: number,
  ): Promise<{ parts: DatasetPart[]; dropped: number; count: number }>;
  /**
   * Makes an attempt's staged parts the dataset's next version and deletes
   * the staged rows of every other attempt of the job, returning their keys
   * so the caller can delete the objects.
   */
  commitStaged(input: {
    datasetId: string;
    jobId: string;
    attempt: number;
    metadata?: Record<string, unknown>;
    /** Nothing staged: keep the current version instead of an empty new one (source syncs). */
    keepVersionIfEmpty?: boolean;
  }): Promise<{ dataset: Dataset; orphanKeys: string[] }>;
  /** Deletes every staged part of a job (it failed); returns their keys. */
  discardStaged(jobId: string): Promise<string[]>;
}

// --- Jobs (the one queue) -----------------------------------------------------

export type JobKind = "train" | "import" | "eval";
export type JobStatus = RunStatus | EvalStatus | ImportStatus;

/** The queue columns every job has. */
export interface JobFields<S extends string = JobStatus> {
  id: string;
  workspace_id: string;
  kind: JobKind;
  status: S;
  /** Every claim bumps it: the fencing token, and part of billing keys. */
  attempt: number;
  /** Attempts that ended without a result since creation or the last resume. */
  failed_attempts: number;
  /** Preempted attempts since creation or the last resume (a separate cap). */
  preemptions: number;
  max_attempts: number;
  worker_id: string | null;
  /** The claiming key's identity (`workerKeyOf`), set with worker_id. */
  worker_key: string | null;
  lease_expires_at: string | null;
  lease_seconds: number;
  /** Not claimable until this job finishes (a router run's labeling eval). */
  waiting_on: string | null;
  /** Tokens and cost the open attempt already billed, and when it last did. */
  billed_through: number;
  billed_cost: number;
  billed_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  /** W3C traceparent of the request that created the job (tracing on). */
  traceparent: string | null;
  /** `source`: an import a source sync started. */
  origin: "api" | "source";
}

export type JobRow = JobFields;

export type JobPatch<S extends string = JobStatus> = Partial<
  Omit<
    JobFields<S>,
    | "id"
    | "workspace_id"
    | "kind"
    | "created_at"
    | "billed_through"
    | "billed_cost"
    | "billed_at"
    | "traceparent"
    | "origin"
  >
>;

export interface JobExpectation<S extends string = JobStatus> {
  /** Only a lease that expired before this instant (the reaper's re-check). */
  leaseExpiredBefore?: string;
  status?: readonly S[];
  workerId?: string | null;
  attempt?: number;
}

export interface ClaimInput {
  workerId: string;
  /** The claiming key's identity (`workerKeyOf`), stored on the lease. */
  workerKey: string;
  leaseSeconds: number;
  now: Date;
  kinds: readonly JobKind[];
  /** Restrict train jobs to these recipes. */
  recipes?: readonly RecipeKind[] | undefined;
  /** Restrict to one workspace (workspace-scoped worker keys). */
  workspaceId?: string | undefined;
}

export interface JobEvent {
  seq: number;
  attempt: number;
  type: string;
  step: number;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface JobRepository {
  getById(id: string): Promise<JobRow | null>;
  /** Conditional update; null when the expectation does not hold. */
  update(
    id: string,
    patch: JobPatch,
    expect?: JobExpectation,
  ): Promise<JobRow | null>;
  /**
   * Oldest claimable job of `kinds` → running, attempt + 1, lease set
   * (FOR UPDATE SKIP LOCKED, one query for every kind).
   */
  claimNext(input: ClaimInput): Promise<JobRow | null>;
  /**
   * The job `workerId` holds a lease on under the same key, if any (a claim
   * retried after a lost response). Scoped like a claim: kinds and workspace.
   */
  heldBy(input: {
    workerId: string;
    workerKey: string;
    kinds: readonly JobKind[];
    workspaceId?: string | undefined;
  }): Promise<JobRow | null>;
  /** Jobs with an open attempt whose lease expired more than lease/3 ago. */
  listExpiredLeases(now: Date, limit: number): Promise<JobRow[]>;
  /**
   * Advances the open attempt's billed mark from `from` to `through` (CAS on
   * attempt and `from`): true when this caller may write that usage row.
   */
  advanceBilling(input: {
    id: string;
    attempt: number;
    from: number;
    through: number;
    cost: number;
    at: Date;
  }): Promise<boolean>;
  /** Queued jobs waiting on `jobId`. */
  listWaitingOn(jobId: string): Promise<JobRow[]>;
  /** Stores the stats an attempt's last heartbeat carried (payload.worker_stats). */
  recordWorkerStats(
    id: string,
    attempt: number,
    stats: Record<string, unknown>,
  ): Promise<void>;
  findIdempotent(
    workspaceId: string,
    key: string,
  ): Promise<IdempotentHit | null>;
  /**
   * Appends an event once per (job, attempt, type, key), key defaulting to
   * the step: a replay returns the stored event.
   */
  appendEvent(input: {
    jobId: string;
    attempt: number;
    type: string;
    step: number;
    key?: string | undefined;
    payload: Record<string, unknown>;
  }): Promise<JobEvent>;
  /** Events of these types with seq > afterSeq, ascending. */
  listEvents(
    jobId: string,
    types: string | readonly string[],
    afterSeq: number,
    limit: number,
  ): Promise<JobEvent[]>;
  /** Distinct workers holding an unexpired lease on a job of `kind`. */
  countLeasedWorkers(kind: JobKind, now: Date): Promise<number>;
  /**
   * Claimable queued jobs of `kind` whose latest `phase` event is `queued`
   * and older than `before` (nobody claimed them in time).
   */
  listUnclaimedSince(
    kind: JobKind,
    before: Date,
    limit: number,
  ): Promise<JobRow[]>;
  /** Retention: deletes up to `limit` events created before `before`. */
  deleteEventsBefore(before: Date, limit: number): Promise<number>;
}

/** Fields a job-backed create shares. */
interface JobCreate {
  workspaceId: string;
  maxAttempts: number;
  waitingOn?: string | null | undefined;
  idempotency?: IdempotencyInput | undefined;
}

// --- Imports (a job and its payload) -------------------------------------------

/** The fields an import keeps in its job's payload. */
export interface ImportPayload {
  dataset_id: string;
  dataset: string;
  source: Record<string, unknown>;
  connector: ImportJob["connector"];
  upload_key: string | null;
  imported_count: number;
  dropped_count: number;
  detected_scores: string[];
  drop_reasons: string[];
  dataset_version: number | null;
}

export type ImportJobRecord = JobFields<ImportStatus> & ImportPayload;

export type ImportJobPatch = JobPatch & Partial<ImportPayload>;

export interface ImportJobRepository {
  create(
    input: JobCreate & {
      datasetId: string;
      datasetName: string;
      source: Record<string, unknown>;
      connector: ImportJob["connector"];
      uploadKey: string | null;
    },
  ): Promise<ImportJobRecord>;
  get(workspaceId: string, id: string): Promise<ImportJobRecord | null>;
  getById(id: string): Promise<ImportJobRecord | null>;
  /** The import of the uploaded file `sha256` into `datasetId`, if any. */
  findByUpload(
    datasetId: string,
    sha256: string,
  ): Promise<ImportJobRecord | null>;
  list(workspaceId: string, page: PageRequest): Promise<Page<ImportJobRecord>>;
  update(
    id: string,
    patch: ImportJobPatch,
    expect?: JobExpectation,
  ): Promise<ImportJobRecord | null>;
}

// --- Runs ------------------------------------------------------------------------

export interface RunDomain {
  name: string;
  dataset_id: string;
  dataset_name: string;
  dataset_version: number;
  recipe_kind: RecipeKind;
  resolved_config: ResolvedRunConfig;
  max_cost_usd: number | null;
  price_per_million_tokens: number;
  total_steps: number;
  current_step: number;
  /** Tokens of closed (billed) attempts; their cost is derived from them. */
  billed_tokens: number;
  /** Latest tokens reported by the open attempt (0 when none is open). */
  attempt_tokens: number;
  latest_metric: MetricPoint | null;
  eval_report: EvalReport | null;
  checkpoint_evals: CheckpointEvalResult[];
  artifact_id: string | null;
}

/** Read-only lifecycle view of a run, from its latest phase and interruption events. */
export interface RunEventsView {
  phase_event: JobEvent | null;
  interruption_event: JobEvent | null;
}

export type RunRecord = JobFields<RunStatus> & RunDomain & RunEventsView;

export type RunPatch = JobPatch &
  Partial<
    Omit<
      RunDomain,
      | "name"
      | "dataset_id"
      | "dataset_name"
      | "dataset_version"
      | "recipe_kind"
      | "resolved_config"
      | "price_per_million_tokens"
    >
  >;

export interface RunRepository {
  create(
    input: JobCreate & {
      name: string;
      datasetId: string;
      datasetName: string;
      datasetVersion: number;
      recipeKind: RecipeKind;
      resolvedConfig: ResolvedRunConfig;
      maxCostUsd: number | null;
      pricePerMillionTokens: number;
      totalSteps: number;
    },
  ): Promise<RunRecord>;
  get(workspaceId: string, id: string): Promise<RunRecord | null>;
  getById(id: string): Promise<RunRecord | null>;
  list(workspaceId: string, page: PageRequest): Promise<Page<RunRecord>>;
  /** Queued and running runs with this name, newest first (at most `limit`). */
  listActiveByName(
    workspaceId: string,
    name: string,
    limit: number,
  ): Promise<RunRecord[]>;
  update(
    id: string,
    patch: RunPatch,
    expect?: JobExpectation,
  ): Promise<RunRecord | null>;
  /** Appends a checkpoint eval result once per eval_id (a replay is a no-op). */
  appendCheckpointEval(id: string, result: CheckpointEvalResult): Promise<void>;
}

// --- Artifacts: checkpoints and releases --------------------------------------

export interface CheckpointRecord extends Checkpoint {
  storage_key: string;
}

export interface ArtifactRecord extends Artifact {
  storage_key: string;
}

export interface ArtifactRepository {
  /**
   * Inserts a checkpoint unless one exists for (run, attempt, step); then the
   * existing row is returned with `created: false`.
   */
  insertCheckpoint(input: {
    workspaceId: string;
    runId: string;
    attempt: number;
    step: number;
    evalScore: number | null;
    format: ArtifactFormat | null;
    baseModel: string;
    recipeKind: RecipeKind;
    storageKey: string;
    sha256: string;
    sizeBytes: number;
    metadata: Record<string, unknown>;
    expiresAt: string | null;
  }): Promise<{ checkpoint: CheckpointRecord; created: boolean }>;
  getCheckpoint(
    workspaceId: string,
    id: string,
  ): Promise<CheckpointRecord | null>;
  /** Unexpired checkpoints, ordered by (step, attempt, id) ascending. */
  listCheckpoints(
    workspaceId: string,
    runId: string,
    page: PageRequest,
    now: Date,
  ): Promise<Page<CheckpointRecord>>;
  /** Unexpired checkpoints of a run, ordered by (step, attempt). */
  allCheckpoints(runId: string, now: Date): Promise<CheckpointRecord[]>;
  /**
   * Expires the given checkpoints of a run at `at` (retention), except pinned
   * best/final ones; the expired-checkpoint GC then deletes them.
   */
  expireCheckpoints(runId: string, ids: string[], at: Date): Promise<void>;
  /** Marks best/final (they never expire: `expires_at = null`). */
  pinCheckpoints(
    runId: string,
    input: { bestId: string | null; finalId: string | null },
  ): Promise<void>;
  /**
   * Deletes up to `limit` checkpoints past their expiry; returns the storage
   * keys no remaining row references (the caller deletes those objects).
   */
  deleteExpiredCheckpoints(now: Date, limit: number): Promise<string[]>;

  /** Allocates `name@YYYY-MM-DD-n` (UTC day of `now`) atomically. */
  createRelease(input: {
    workspaceId: string;
    name: string;
    runId: string | null;
    sourceId: string | null;
    baseModel: string;
    recipeKind: RecipeKind;
    format: ArtifactFormat;
    storageKey: string;
    sha256: string;
    sizeBytes: number;
    manifest: Record<string, unknown>;
    evalReport: EvalReport | null;
  }): Promise<ArtifactRecord>;
  /** `reference` is a release id or `name@latest`. */
  get(workspaceId: string, reference: string): Promise<ArtifactRecord | null>;
  list(
    workspaceId: string,
    filter: { name?: string | undefined },
    page: PageRequest,
  ): Promise<Page<ArtifactRecord>>;
}

// --- Evals -----------------------------------------------------------------------

export interface EvalDomain {
  name: string;
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
  /** `score`: `dataset.score()` grades the records' own outputs (model `record`). */
  mode: EvalMode;
  /** The dataset version a completed scoring job wrote its scores to. */
  scored_dataset_version: number | null;
  /** recipe.evals: the run and checkpoint step this eval scores. */
  run_id: string | null;
  run_step: number | null;
  samples: number;
  temperature: number;
  max_tokens: number;
  limit: number | null;
  pass_threshold: number;
  judge_models: string[];
  /** judge ref → inference model name and price (resolved at create; always priced). */
  judge_targets: Record<
    string,
    { inference_model: string; price_per_million_tokens: number }
  >;
  local_scorers: string[];
  total_outputs: number;
  generated: number;
  summary: EvalModelSummary[];
  total_cost_usd: number;
}

export type EvalRecord = JobFields<EvalStatus> & EvalDomain;

export type EvalPatch = JobPatch &
  Partial<
    Pick<
      EvalDomain,
      | "total_outputs"
      | "generated"
      | "summary"
      | "total_cost_usd"
      | "scored_dataset_version"
    >
  >;

/** One eval task: a usable record of the pinned dataset version. */
export interface EvalTask {
  task_index: number;
  task_id: string;
  record: DatasetRecord;
}

export interface EvalOutputRow {
  id: string;
  eval_id: string;
  attempt: number;
  task_index: number;
  task_id: string;
  model: string;
  sample_index: number;
  record: DatasetRecord;
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

/** Per-(task, model) result, aggregated from the outputs' combined scores. */
export interface EvalResultRow {
  task_index: number;
  task_id: string;
  model: string;
  score: number;
  passed: boolean;
  sample_scores: number[];
  record: DatasetRecord;
}

export interface EvalRepository {
  create(
    input: JobCreate &
      Omit<
        EvalDomain,
        | "total_outputs"
        | "generated"
        | "summary"
        | "total_cost_usd"
        | "scored_dataset_version"
      > & {
        totalOutputs: number;
      },
  ): Promise<EvalRecord>;
  get(workspaceId: string, id: string): Promise<EvalRecord | null>;
  getById(id: string): Promise<EvalRecord | null>;
  list(workspaceId: string, page: PageRequest): Promise<Page<EvalRecord>>;
  update(
    id: string,
    patch: EvalPatch,
    expect?: JobExpectation,
  ): Promise<EvalRecord | null>;
  /** Evals waiting for SDK-posted scores, least recently touched first. */
  listAwaitingScores(limit: number): Promise<EvalRecord[]>;

  /** First write wins on (eval, model, task, sample): a replay is a no-op. */
  insertOutput(output: EvalOutputRow): Promise<void>;
  /** Keys `${model}\u0000${task_index}\u0000${sample_index}` already generated. */
  listOutputKeys(evalId: string): Promise<Set<string>>;
  /** Ordered by (task_index, model, sample_index). */
  listOutputs(
    evalId: string,
    filter: { model?: string | undefined; missingScorer?: string | undefined },
    page: PageRequest,
  ): Promise<Page<EvalOutputRow>>;
  /** Tokens and cost of the outputs an attempt generated. */
  attemptUsage(
    evalId: string,
    attempt: number,
  ): Promise<{ tokens: number; cost_usd: number }>;
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
  /** Stores each output's combined rubric score (at completion). */
  setCombinedScores(
    evalId: string,
    scores: ReadonlyArray<{ id: string; score: number }>,
  ): Promise<void>;
  /**
   * Per-(task, model) results ordered by (task_index, model);
   * `maxScore` keeps results scoring below it.
   */
  listResults(
    evalId: string,
    filter: {
      model?: string | undefined;
      maxScore?: number | undefined;
      passThreshold: number;
    },
    page: PageRequest,
  ): Promise<Page<EvalResultRow>>;
}

// --- Usage ledger ----------------------------------------------------------------

export interface UsageRepository {
  /** Idempotent on idempotency_key; returns the stored row. */
  record(input: {
    idempotencyKey: string;
    workspaceId: string;
    kind: UsageRecord["kind"];
    refId: string;
    attempt: number;
    tokensFrom: number;
    tokensThrough: number;
    costUsd: number;
    priceVersion: string;
  }): Promise<UsageRecord>;
  list(workspaceId: string, page: PageRequest): Promise<Page<UsageRecord>>;
  /** Every workspace's rows with seq > afterSeq created at or before `before`, ascending. */
  listAfter(
    afterSeq: number,
    before: Date,
    limit: number,
  ): Promise<Array<UsageRecord & { seq: number; workspace_id: string }>>;
  listByRef(refId: string): Promise<UsageRecord[]>;
}

// --- Secrets and sources --------------------------------------------------------

export interface SealedSecretRow {
  keyId: string;
  nonce: Buffer;
  ciphertext: Buffer;
}

export interface SecretRepository {
  /** Creates or replaces the value of (workspace, name). */
  put(input: {
    workspaceId: string;
    name: string;
    sealed: SealedSecretRow;
    /** Normalised hosts the value may be sent to (secret-hosts.ts). */
    allowedHosts: readonly string[];
  }): Promise<Secret>;
  get(workspaceId: string, name: string): Promise<Secret | null>;
  getSealed(workspaceId: string, name: string): Promise<SealedSecretRow | null>;
  list(workspaceId: string, page: PageRequest): Promise<Page<Secret>>;
  delete(workspaceId: string, name: string): Promise<boolean>;
}

export interface SourceRecord {
  id: string;
  workspace_id: string;
  dataset_id: string;
  dataset: string;
  provider: SourceProviderKind;
  host: string | null;
  secret_name: string | null;
  project: string | null;
  filters: Record<string, unknown>;
  schedule: string | null;
  next_sync_at: string | null;
  watermark: Record<string, unknown> | null;
  sync_job_id: string | null;
  last_synced_at: string | null;
  /** A full sync asked for while another ran: queued when that one ends. */
  pending_full: boolean;
  status: SourceStatus;
  paused_reason: string | null;
  last_error: string | null;
  last_error_at: string | null;
  consecutive_failures: number;
  created_at: string;
  updated_at: string;
}

export type SourceStatus = "active" | "paused";

export type SourcePatch = Partial<
  Pick<
    SourceRecord,
    | "next_sync_at"
    | "watermark"
    | "sync_job_id"
    | "last_synced_at"
    | "pending_full"
    | "status"
    | "paused_reason"
    | "last_error"
    | "last_error_at"
    | "consecutive_failures"
  >
>;

export interface SourceRepository {
  create(input: {
    workspaceId: string;
    datasetId: string;
    provider: SourceProviderKind;
    host: string | null;
    secretName: string | null;
    project: string | null;
    filters: Record<string, unknown>;
    schedule: string | null;
    nextSyncAt: string | null;
    idempotency?: IdempotencyInput | undefined;
  }): Promise<SourceRecord>;
  get(workspaceId: string, id: string): Promise<SourceRecord | null>;
  getById(id: string): Promise<SourceRecord | null>;
  /** Locks the row for the enclosing transaction (one sync enqueue at a time). */
  lock(workspaceId: string, id: string): Promise<SourceRecord | null>;
  list(
    workspaceId: string,
    filter: { datasetId?: string | undefined },
    page: PageRequest,
  ): Promise<Page<SourceRecord>>;
  delete(workspaceId: string, id: string): Promise<boolean>;
  findIdempotent(
    workspaceId: string,
    key: string,
  ): Promise<IdempotentHit | null>;
  /**
   * Active scheduled sources due at `now`, locked FOR UPDATE SKIP LOCKED so
   * each replica's tick takes different ones (call inside a transaction).
   */
  lockDue(now: string, limit: number): Promise<SourceRecord[]>;
  /** `expectJobId`: only while that job is still the source's latest sync. */
  update(
    id: string,
    patch: SourcePatch,
    expectJobId?: string | undefined,
  ): Promise<SourceRecord | null>;
  /** Ids of sources that read `secretName`. */
  usingSecret(workspaceId: string, secretName: string): Promise<string[]>;
}

// --- Composition ----------------------------------------------------------------------

export interface Repositories {
  apiKeys: ApiKeyRepository;
  datasets: DatasetRepository;
  jobs: JobRepository;
  imports: ImportJobRepository;
  runs: RunRepository;
  artifacts: ArtifactRepository;
  evals: EvalRepository;
  usage: UsageRepository;
  secrets: SecretRepository;
  sources: SourceRepository;
}

// --- Telemetry -------------------------------------------------------------------

/** Aggregates behind the queue and worker gauges (one maintenance tick's read). */
export interface TelemetrySnapshot {
  jobs: Array<{
    /** train, import, sync (an import a source started) or eval. */
    kind: string;
    /** queued, blocked, waiting_for_compute, running, awaiting_scores, or a leased terminal status. */
    state: string;
    /** Only with `byWorkspace`. */
    workspace_id: string | null;
    count: number;
    /** Claimable queued or leased (what KEDA scales on). */
    open: number;
    oldest_queued_seconds: number | null;
  }>;
  workers: Array<{
    kind: string;
    online: number;
    tokens_per_second: number;
    gpu_memory_used_bytes: number;
    gpu_utilization: number | null;
    flush_lag_seconds: number | null;
  }>;
  phases: Array<{ kind: string; phase: string; count: number }>;
  sources: Array<{
    provider: string;
    count: number;
    paused: number;
    max_consecutive_failures: number;
  }>;
}

export interface TelemetryRepository {
  snapshot(
    now: Date,
    options: { byWorkspace: boolean },
  ): Promise<TelemetrySnapshot>;
}

export interface Store extends Repositories {
  telemetry: TelemetryRepository;
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
  /** The storage keys no artifact or dataset part references. */
  unreferencedKeys(keys: readonly string[]): Promise<string[]>;
  close(): Promise<void>;
}
