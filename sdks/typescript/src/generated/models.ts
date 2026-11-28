// AUTO-GENERATED from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.
/* eslint-disable */

export type AdapterSpec = {
  kind: "lora";
  rank?: number | undefined;
  alpha?: number | undefined;
  mergeOnExport?: boolean | undefined;
} | {
  kind: "prefix_kv";
  numTokens?: number | undefined;
} | {
  kind: "frozen_head";
};

export interface ApiKey {
  id: string;
  workspaceId: string;
  name: string;
  prefix: string;
  scopes: Array<ApiKeyScope>;
  createdAt: string;
  revokedAt: string | null;
}

/** `x:write` implies `x:read`; `admin` implies every workspace scope. `artifacts:pin` (pin and unpin artifacts; Gradiated Cloud's publishing calls it) is implied by `admin` only. `deployments:write`, `feedback:write` and `env:serve` are Gradiated Cloud scopes: grad-server accepts them on a key but none of its endpoints checks them. */
export type ApiKeyScope = "admin" | "datasets:read" | "datasets:write" | "runs:read" | "runs:write" | "artifacts:read" | "artifacts:write" | "artifacts:pin" | "secrets:read" | "secrets:write" | "sources:read" | "sources:write" | "deployments:write" | "feedback:write" | "env:serve";

export const ApiKeyScopeValues = ["admin", "datasets:read", "datasets:write", "runs:read", "runs:write", "artifacts:read", "artifacts:write", "artifacts:pin", "secrets:read", "secrets:write", "sources:read", "sources:write", "deployments:write", "feedback:write", "env:serve"] as const;

export interface Artifact {
  /** Artifact id: `name@version`. */
  id: string;
  workspaceId: string;
  /** Artifact name, usually the run name. */
  name: string;
  /** Version, `YYYY-MM-DD-N`: the release date and its sequence that day. */
  version: string;
  /** The run that trained it; null for uploads and imports. */
  runId: string | null;
  /** The checkpoint it was promoted from; null when it is a run's final artifact or was uploaded or imported. */
  checkpointId: string | null;
  /** The base model the weights apply to. */
  baseModel: string;
  recipeKind: RecipeKind;
  format: ArtifactFormat | null;
  /** SHA-256 of the bundle; downloads verify it. */
  sha256: string;
  /** Bundle size in bytes. */
  sizeBytes: number;
  /** The bundle's manifest.json: format, base model, adapter and training settings. */
  manifest: Record<string, unknown>;
  provenance: ArtifactProvenance;
  evalReport: EvalReport | null;
  /** Holders keeping it (a published model version, say), oldest first. A pinned artifact can't be deleted. */
  pins: Array<ArtifactPin>;
  /** When it was released. */
  createdAt: string;
}

export interface ArtifactDownloadUrl {
  /** A presigned GET of the bundle (.grad.tar.gz) straight from storage; no Authorization header. Verify its SHA-256. */
  url: string;
  expiresAt: string;
  sha256: string;
  sizeBytes: number;
  filename: string;
}

/** Artifact format when this checkpoint is exportable (promotable); null for training state only. */
export type ArtifactFormat = "peft_lora" | "merged_safetensors" | "prefix_kv" | "cartridge" | "encoder_safetensors" | "router_bundle" | "decision_bundle" | "reward_bundle" | "reference";

export const ArtifactFormatValues = ["peft_lora", "merged_safetensors", "prefix_kv", "cartridge", "encoder_safetensors", "router_bundle", "decision_bundle", "reward_bundle", "reference"] as const;

export interface ArtifactImport {
  id: string;
  workspaceId: string;
  status: ArtifactImportStatus;
  name: string;
  baseModel: string;
  format: ArtifactFormat | null;
  source: {
    kind: "upload" | "hf";
    uploadId: string | null;
    repo: string | null;
    /** HF imports: the requested revision, then the pinned commit once imported. */
    revision: string | null;
  };
  /** The artifact (name@version) once the import completed. */
  artifactId: string | null;
  /** Why it failed. Validation failures name the file and the problem (`adapter_config.json: ...`). */
  error: string | null;
  /** invalid_artifact (the files don't match the format spec or the base model), source_unavailable, or null. */
  errorCode: string | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
}

export type ArtifactImportSource = {
  kind: "upload";
  /** A tar (optionally gzip) of the artifact's files, uploaded with POST /v1/uploads. */
  uploadId: string;
} | {
  kind: "hf";
  repo: string;
  /** Branch, tag or commit (default main). The import pins the commit it resolves. */
  revision?: string | undefined;
  /** Name of a workspace secret holding a Hugging Face token, for gated or private repos. */
  secret?: string | undefined;
};

export type ArtifactImportStatus = "queued" | "running" | "completed" | "failed";

export const ArtifactImportStatusValues = ["queued", "running", "completed", "failed"] as const;

export interface ArtifactPin {
  artifactId: string;
  holder: string;
  reason: string;
  createdAt: string;
}

export interface ArtifactProvenance {
  /** run: trained by a grad run; upload: files uploaded with `grad artifacts upload`; import: pulled from the Hugging Face Hub with `grad artifacts import`. */
  source: "run" | "upload" | "import";
  /** source=run: the run that trained it. */
  runId: string | null;
  /** source=upload: the API key (principal) that uploaded it. */
  uploader: string | null;
  /** source=import: `hf://owner/name@<40-hex commit>`, the pinned revision it was imported from. */
  uri: string | null;
}

export interface AttemptEvent {
  type: "attempt";
  runId: string;
  /** Position in the run's event sequence (the SSE event id; pass it as Last-Event-ID or `cursor` to resume). `completed` repeats the last stored seq. */
  seq: number;
  attempt: number;
  timestamp: string;
  /** started: a worker claimed attempt N (resume_step: the checkpoint it resumes from). interrupted: attempt N ended without a result at `step` (resume_step: where the next attempt resumes). gave_up: no attempts left; the run failed. */
  event: "started" | "interrupted" | "gave_up";
  reason: InterruptionReason | null;
  step: number | null;
  /** Checkpoint step to resume from; null starts from scratch. */
  resumeStep: number | null;
  maxAttempts: number;
  message: string;
}

/** Continued training: the artifact whose adapter the run starts from (recipe.model was an artifact reference). */
export interface BaseArtifact {
  id: string;
  recipeKind: RecipeKind;
  format: "peft_lora";
  sha256: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: (string | Array<Record<string, unknown>>) | null | undefined;
  toolCalls?: Array<Record<string, unknown>> | undefined;
  toolCallId?: string | undefined;
  name?: string | undefined;
  train?: boolean | undefined;
  [key: string]: unknown;
}

export interface Checkpoint {
  /** Checkpoint id (`ckpt_` and 24 hex characters). */
  id: string;
  workspaceId: string;
  /** The run that saved it. */
  runId: string;
  /** The attempt that saved it. */
  attempt: number;
  /** Optimizer step it was saved at. */
  step: number;
  /** Held-out score at this step; null when it wasn't evaluated. */
  evalScore: number | null;
  format: ArtifactFormat | null;
  /** SHA-256 of the checkpoint bundle. */
  sha256: string;
  /** Bundle size in bytes. */
  sizeBytes: number;
  metadata: Record<string, unknown>;
  /** True for the checkpoint `select="best"` picks; it never expires. */
  best: boolean;
  /** True for the run's last checkpoint; it never expires. */
  final: boolean;
  /** When it expires (after `checkpoint_ttl_days`, 30 by default); null for checkpoints that never expire, such as the best and final. */
  expiresAt: string | null;
  createdAt: string;
}

export interface CheckpointEvalResult {
  name: string;
  step: number;
  checkpointId: string;
  evalId: string | null;
  dataset: string;
  datasetVersion: number;
  status: "completed" | "failed" | "cancelled";
  /** The checkpoint's overall rubric score (null unless completed). */
  score: number | null;
  costUsd: number;
  error: string | null;
}

export interface CheckpointEvent {
  type: "checkpoint";
  runId: string;
  /** Position in the run's event sequence (the SSE event id; pass it as Last-Event-ID or `cursor` to resume). `completed` repeats the last stored seq. */
  seq: number;
  attempt: number;
  timestamp: string;
  step: number;
  checkpointId: string;
  evalScore: number | null;
  format: ArtifactFormat | null;
}

export interface CompletedEvent {
  type: "completed";
  runId: string;
  /** Position in the run's event sequence (the SSE event id; pass it as Last-Event-ID or `cursor` to resume). `completed` repeats the last stored seq. */
  seq: number;
  attempt: number;
  timestamp: string;
  status: RunStatus;
  run: Run;
}

export interface CreateApiKeyRequest {
  name: string;
  scopes: Array<ApiKeyScope>;
}

export interface CreateArtifactImportRequest {
  source: ArtifactImportSource;
  /** The catalog base model (GET /v1/base-models) the files were trained on. */
  baseModel: string;
  format?: ImportableArtifactFormat | undefined;
  /** The artifact name (name@YYYY-MM-DD-n). Required for uploads; HF imports default to the repo's name. */
  name?: string | undefined;
}

export interface CreateDatasetRequest {
  name: string;
  metadata?: Record<string, unknown> | undefined;
}

export interface CreateImportRequest {
  source: ImportSource;
  connector?: "auto" | "grad_trajectories" | "openai_chat" | "gradiated" | "otel" | "langfuse" | "posthog" | "braintrust" | "langsmith" | undefined;
}

export interface CreateSourceRequest {
  provider: SourceProvider;
  /** Five-field cron in UTC (`*\/15 * * * *`); minute resolution, so it fires at most once a minute (a seconds field is rejected). Leave it out to sync only on request. */
  schedule?: string | null | undefined;
  /** The share of traces to sync, chosen by a hash of the trace id: re-syncs keep the same sample, and a trace's feedback follows it. Default 1. */
  sampleRate?: number | undefined;
  /** At most this many new traces per sync; the rest are not synced (the sync's drop reasons count them). Feedback on traces already synced always lands. Null: no cap. */
  maxRecordsPerSync?: number | null | undefined;
  /** At most this many new traces per UTC day; the rest are not synced (the sync's drop reasons count them). Feedback on traces already synced always lands. Null: no cap. */
  maxRecordsPerDay?: number | null | undefined;
  /** Seconds between the dataset versions scheduled syncs commit (default 900). A scheduled sync may fetch every minute; its parts wait, staged, until the interval has passed or enough records are waiting, so a busy source doesn't add a version a minute. 0: every sync commits. Manual and full syncs always commit. */
  versionInterval?: number | undefined;
}

export interface CreateUploadRequest {
  /** dataset_import (needs datasets:write) or artifact_import (artifacts:write). */
  purpose: "dataset_import" | "artifact_import";
  filename: string;
  sizeBytes: number;
  sha256: string;
}

export interface CreatedApiKey {
  key: ApiKey;
  secret: string;
}

export interface Dataset {
  /** Dataset id (`ds_` and 24 hex characters). */
  id: string;
  workspaceId: string;
  /** Dataset name, unique in the workspace. */
  name: string;
  /** Current version. Every push, import, score or sync that changes records adds one; runs and evals pin a version. */
  version: number;
  /** Records in the current version after merging: score updates fold into their records, and a full source sync restarts the count. A record pushed again with an id it already has counts again. */
  recordCount: number;
  /** Free-form metadata you set at creation. */
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DatasetRecord {
  schema?: "grad.trajectory/1" | undefined;
  id?: string | undefined;
  sessionId?: string | null | undefined;
  groupId?: string | null | undefined;
  role?: ("chosen" | "rejected" | "anchor" | "positive" | "negative" | "desirable" | "undesirable" | "rollout") | null | undefined;
  source?: string | null | undefined;
  timestamp?: string | null | undefined;
  messages?: Array<ChatMessage> | undefined;
  tools?: Array<Record<string, unknown>> | undefined;
  input?: TrajectoryInput | undefined;
  output?: TrajectoryOutput | null | undefined;
  prompt?: string | Array<ChatMessage> | undefined;
  completion?: string | Array<ChatMessage> | undefined;
  chosen?: string | Array<ChatMessage> | undefined;
  rejected?: string | Array<ChatMessage> | undefined;
  query?: string | undefined;
  positive?: string | undefined;
  negatives?: Array<string> | undefined;
  state?: unknown | undefined;
  questions?: Record<string, unknown> | undefined;
  expectedOutput?: unknown | undefined;
  scores?: Record<string, number> | undefined;
  metrics?: Record<string, number> | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface DatasetRecordsPage {
  dataset: string;
  version: number;
  total: number;
  data: Array<DatasetRecord>;
  /** Pass back as `cursor` for the next page; null on the last page (every list endpoint). */
  nextCursor: string | null;
}

export interface DecisionHeadReport {
  type: "choice" | "noul" | "score";
  examples: number;
  accuracy: number | null;
  ece: number | null;
  temperature: number;
  /** Written by: noul heads. */
  brier?: number | undefined;
  /** Written by: score heads. */
  mae?: number | undefined;
  macroF1?: number | null | undefined;
  perOption?: Record<string, {
    precision: number | null;
    recall: number | null;
    f1: number | null;
    support: number;
  }> | undefined;
  confusionMatrix?: {
    labels: Array<string>;
    matrix: Array<Array<number>>;
  } | undefined;
  [key: string]: unknown;
}

/** `eval` generates outputs from `models`; `score` (`dataset.score()`) grades each record's own output (model `record`) and writes the scores to the dataset's next version. */
export type EvalMode = "eval" | "score";

export const EvalModeValues = ["eval", "score"] as const;

export interface EvalModelSummary {
  model: string;
  overall: number;
  ciLow: number;
  ciHigh: number;
  passAtK: Record<string, number>;
  vsBaseline: {
    delta: number;
    ciLow: number;
    ciHigh: number;
  } | null;
  tasks: number;
  errors: number;
  tokensPerTask: number;
  costPer1kTasksUsd: number | null;
}

export interface EvalOutput {
  id: string;
  evalId: string;
  taskId: string;
  model: string;
  sampleIndex: number;
  input: Array<ChatMessage>;
  output: string | null;
  expectedOutput?: unknown | undefined;
  record: DatasetRecord;
  scores: Record<string, number>;
  error: string | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
}

export interface EvalReport {
  /** Selection metric: eval_loss (sft, router, decision, off-policy distill, pointwise-only reward), preference_accuracy (dpo, reward), eval_kl (cartridge, on-policy distill), recall_at_10 (embedding). */
  metricName: string;
  /** Direction of metric_name: min (lower is better: eval_loss, eval_kl) or max (higher is better: preference_accuracy, recall_at_10). best_step and the pinned best checkpoint follow it. */
  metricMode?: "min" | "max" | undefined;
  selectedStep: number;
  bestStep: number | null;
  finalStep: number;
  trainRecords: number;
  evalRecords: number;
  warnings: Array<string>;
  /** Written by: sft, dpo, router, decision, distill, reward. */
  evalLoss?: number | null | undefined;
  /** Written by: sft, distill. */
  evalTokenAccuracy?: number | null | undefined;
  /** Written by: sft. */
  trainedTokenFraction?: number | undefined;
  /** Written by: sft, distill. */
  trainExamples?: number | undefined;
  /** Written by: sft, router, decision, distill. */
  evalExamples?: number | undefined;
  /** Written by: router, decision. */
  selectionExamples?: number | undefined;
  /** Written by: sft, dpo. */
  truncated?: number | undefined;
  /** Share of held-out pairs whose chosen answer outscores the rejected one. Written by: dpo, reward. */
  preferenceAccuracy?: number | null | undefined;
  /** Written by: dpo, reward. */
  rewardMargin?: number | null | undefined;
  /** Written by: dpo. */
  beta?: number | undefined;
  /** Written by: dpo, embedding, reward. */
  trainPairs?: number | undefined;
  /** Written by: dpo, embedding, reward. */
  evalPairs?: number | undefined;
  /** Written by: dpo, embedding, reward. */
  droppedRecords?: number | undefined;
  /** Written by: reward (pointwise). */
  trainPoints?: number | undefined;
  /** Written by: reward (pointwise). */
  evalPoints?: number | undefined;
  /** Mean squared error of sigmoid(reward) against the held-out scores. Written by: reward (pointwise). */
  pointwiseBrier?: number | null | undefined;
  /** Written by: cartridge, distill. */
  evalKl?: number | null | undefined;
  /** Held-out KL of the untrained student to the teacher. Written by: distill (on-policy). */
  baseKl?: number | null | undefined;
  /** Written by: cartridge. */
  noContextKl?: number | null | undefined;
  /** Written by: cartridge, distill. */
  klReduction?: number | null | undefined;
  /** Written by: cartridge. */
  numTokens?: number | undefined;
  /** Written by: cartridge, distill. */
  teacher?: string | undefined;
  /** Written by: distill. */
  rollout?: "on_policy" | "off_policy" | undefined;
  /** Written by: router. */
  candidates?: Array<string> | undefined;
  /** Written by: router. */
  fallbackModel?: string | undefined;
  /** Written by: router. */
  fallbackQuality?: number | null | undefined;
  /** Written by: router. */
  routesAnyTraffic?: boolean | undefined;
  paretoSummary?: RouterParetoSummary | undefined;
  /** Written by: decision. */
  ece?: number | null | undefined;
  /** Written by: decision (one entry per question). */
  heads?: Record<string, DecisionHeadReport | null> | undefined;
  /** Written by: embedding. */
  recallAt1?: number | null | undefined;
  /** Written by: embedding. */
  recallAt5?: number | null | undefined;
  /** Written by: embedding. */
  recallAt10?: number | null | undefined;
  /** Written by: embedding. */
  mrr?: number | null | undefined;
  /** Written by: embedding. */
  corpusSize?: number | undefined;
  /** Retrieval metrics of the untrained base encoder. Written by: embedding. */
  baseline?: {
    recallAt1: number | null;
    recallAt5: number | null;
    recallAt10: number | null;
    mrr: number | null;
    [key: string]: unknown;
  } | null | undefined;
  [key: string]: unknown;
}

export interface EvalRubricItem {
  name: string;
  kind: "regex" | "validator" | "code" | "judge";
  weight?: number | undefined;
  pattern?: string | undefined;
  flags?: string | undefined;
  validator?: "json" | "non_empty" | "exact_match" | "final_number" | "choice" | undefined;
  model?: string | undefined;
  prompt?: string | undefined;
  /** Code scorers always run in the SDK process (`local`); the eval waits in `awaiting_scores` until the SDK posts their scores. */
  runtime?: "local" | undefined;
}

export interface EvalRun {
  id: string;
  workspaceId: string;
  name: string;
  status: EvalStatus;
  mode: EvalMode;
  models: Array<string>;
  baseline: string | null;
  taskSource: {
    kind: "dataset";
    dataset: string;
    version: number;
  };
  rubric: Array<EvalRubricItem>;
  samples: number;
  temperature: number;
  maxTokens: number;
  passThreshold: number;
  judgeModels: Array<string>;
  localScorers: Array<string>;
  progress: {
    totalOutputs: number;
    generated: number;
    pendingLocalScores: number;
  };
  summary: Array<EvalModelSummary>;
  totalCostUsd: number;
  /** Scoring jobs: the dataset version holding the new scores (the source version when every record was already scored); null until completed. */
  scoredDatasetVersion: number | null;
  error: string | null;
  /** While running: the eval's model calls are waiting for capacity (a serving pool at zero that has not woken yet), for a rate limit (a full eval lane), or for an inference endpoint that is down. The worker keeps its lease and retries; this is not counted as a failed attempt. null otherwise. */
  waitingReason: ("capacity_unavailable" | "rate_limited" | "inference_unavailable") | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type EvalStatus = "queued" | "running" | "awaiting_scores" | "completed" | "failed" | "cancelled";

export const EvalStatusValues = ["queued", "running", "awaiting_scores", "completed", "failed", "cancelled"] as const;

export interface EvalTaskOutcome {
  taskId: string;
  model: string;
  score: number;
  passed: boolean;
  sampleScores: Array<number>;
  judgeModel: string | null;
  record: DatasetRecord;
}

export interface FilterDatasetRequest {
  /** Conditions on stored scores, `{name: "<op><number>"}` with op one of >=, <=, >, <, ==, != (a bare number means ==). A record without the score does not match. */
  scores?: Record<string, string | number> | undefined;
  /** Exact matches on `metadata` fields. */
  metadata?: Record<string, string | number | boolean> | undefined;
  /** Records whose `timestamp` is at or after this time (a timestamp with offset, or a UTC date `YYYY-MM-DD`). */
  createdAfter?: string | string | undefined;
  /** Records whose `timestamp` is before this time. */
  createdBefore?: string | string | undefined;
  /** Keep only these record ids (what the SDKs send for a filter function they ran locally). */
  ids?: Array<string> | undefined;
  /** Source version to filter (default: the current version). */
  version?: number | undefined;
  /** Name of the view. Default: `<dataset>-f-<hash of source, version and filter>`, so the same filter returns the same view. */
  name?: string | undefined;
}

/** starting: the claiming worker's GPU (null without one, e.g. the reference backend). Never the worker id or host. */
export interface GpuInfo {
  name: string;
  memoryGb: number;
}

export interface HfColumnMapping {
  messages?: string | undefined;
  prompt?: string | undefined;
  completion?: string | undefined;
  chosen?: string | undefined;
  rejected?: string | undefined;
  answer?: string | undefined;
  query?: string | undefined;
  positive?: string | undefined;
}

export interface ImportJob {
  id: string;
  workspaceId: string;
  dataset: string;
  status: ImportStatus;
  source: Record<string, unknown>;
  connector: "auto" | "grad_trajectories" | "openai_chat" | "gradiated" | "otel" | "langfuse" | "posthog" | "braintrust" | "langsmith";
  attempt: number;
  /** Records this import added to the dataset (score updates for existing records add none). */
  importedCount: number;
  droppedCount: number;
  detectedScores: Array<string>;
  /** Why rows were dropped, one line per row (`line 12: invalid JSON`), capped at 100 entries. */
  dropReasons: Array<string>;
  datasetVersion: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ImportSource = {
  kind: "upload";
  uploadId: string;
  format?: "auto" | "jsonl" | "json" | "parquet" | undefined;
} | {
  kind: "hf";
  repo: string;
  split?: string | undefined;
  config?: string | undefined;
  revision?: string | undefined;
  columns?: HfColumnMapping | undefined;
  limit?: number | undefined;
  /** Name of a workspace secret holding a Hugging Face token, for gated or private datasets. The worker receives the token at claim time. */
  secret?: string | undefined;
} | {
  kind: "benchmark";
  /** A built-in benchmark, imported from Hugging Face at a pinned revision with fixed prompts; evals on the dataset default to its answer check. */
  benchmark: "gsm8k" | "mmlu" | "mmlu_pro" | "arc_challenge";
  /** Import the first N problems (the same ones every time). */
  limit?: number | undefined;
};

export type ImportStatus = "queued" | "running" | "completed" | "failed";

export const ImportStatusValues = ["queued", "running", "completed", "failed"] as const;

export type ImportableArtifactFormat = "peft_lora" | "merged_safetensors" | "cartridge" | "encoder_safetensors" | "router_bundle" | "decision_bundle" | "reward_bundle";

export const ImportableArtifactFormatValues = ["peft_lora", "merged_safetensors", "cartridge", "encoder_safetensors", "router_bundle", "decision_bundle", "reward_bundle"] as const;

/** Why an attempt ended without a result: lease_lost (the worker was lost: it stopped heartbeating after a crash, kill or network failure), compute_reclaimed (the GPU was reclaimed; the worker saved a checkpoint when it had time and handed the run back), worker_error (the worker hit an unexpected error and handed the run back), oom (CUDA out of memory). */
export type InterruptionReason = "lease_lost" | "compute_reclaimed" | "worker_error" | "oom";

export const InterruptionReasonValues = ["lease_lost", "compute_reclaimed", "worker_error", "oom"] as const;

export interface LogEvent {
  type: "log";
  runId: string;
  /** Position in the run's event sequence (the SSE event id; pass it as Last-Event-ID or `cursor` to resume). `completed` repeats the last stored seq. */
  seq: number;
  attempt: number;
  timestamp: string;
  step: number | null;
  message: string;
}

export type LoggerSpec = {
  kind: "wandb";
  project: string;
  entity?: string | undefined;
  /** W&B server (default https://api.wandb.ai). */
  host?: string | undefined;
  /** Workspace secret holding the W&B API key. */
  secret: string;
  /** Tracker run name (default: the grad run name). */
  runName?: string | undefined;
} | {
  kind: "mlflow";
  trackingUri: string;
  experiment?: string | undefined;
  /** Workspace secret holding a bearer token for the tracking server, if it needs one. */
  secret?: string | undefined;
  /** Tracker run name (default: the grad run name). */
  runName?: string | undefined;
};

export type LossSpec = {
  kind: "cross_entropy";
  reduction?: "per_example" | "per_token" | undefined;
} | {
  kind: "dpo";
  beta?: number | undefined;
} | {
  kind: "infonce";
  temp?: number | undefined;
} | {
  kind: "top_k_kl_distill";
  topK?: number | undefined;
};

export interface MetricEvent {
  type: "metric";
  runId: string;
  /** Position in the run's event sequence (the SSE event id; pass it as Last-Event-ID or `cursor` to resume). `completed` repeats the last stored seq. */
  seq: number;
  attempt: number;
  timestamp: string;
  step: number;
  metric: MetricPoint | null;
}

export interface MetricPoint {
  seq: number;
  attempt: number;
  step: number;
  loss: number;
  evalLoss?: number | null | undefined;
  /** Held-out metrics of an eval step by name (including the recipe's selection metric, eval_report.metric_name); absent on steps without an eval. */
  evalMetrics?: Record<string, number | null> | null | undefined;
  gradNorm?: number | null | undefined;
  lr?: number | null | undefined;
  tokensPerSec?: number | null | undefined;
  tokens: number;
  costUsd: number;
  timestamp: string;
  [key: string]: unknown;
}

export interface MetricsPage {
  runId: string;
  status: RunStatus;
  data: Array<MetricPoint | null>;
  /** Pass back as `cursor` for the next page; null on the last page (every list endpoint). */
  nextCursor: string | null;
  /** Cursor after the newest point returned so far; pass it back as `cursor` to poll for points written later (tailing a running run). */
  tailCursor: string;
}

export interface OptimizerSpec {
  kind?: "adamw" | undefined;
  betas?: Array<unknown> | undefined;
  weightDecay?: number | undefined;
  /** Max global gradient norm; 0 disables clipping. */
  gradClip?: number | undefined;
}

export interface PhaseEvent {
  type: "phase";
  runId: string;
  /** Position in the run's event sequence (the SSE event id; pass it as Last-Event-ID or `cursor` to resume). `completed` repeats the last stored seq. */
  seq: number;
  attempt: number;
  timestamp: string;
  phase: RunPhase;
  /** Training step when the phase began (0 before training; the resume step on a resumed attempt). */
  step: number;
  /** queued and waiting_for_compute: workers of this job kind holding a lease (all busy; an idle worker would have claimed the run). */
  workersOnline: number | null;
  /** queued and waiting_for_compute: true when workers scale from zero (KEDA), so one is starting rather than missing. */
  autoscaling: boolean | null;
  /** queued and waiting_for_compute: about how many runs start before this one when the phase began (fair share across workspaces). Run.queue_position is the live value. */
  queuePosition: number | null;
  /** queued and waiting_for_compute: why the run waits, ready to show ("Queued behind 3 runs", "Queued: workspace concurrency limit (8 running)", "Waiting for a GPU with ≥46 GB; online workers have 24 GB"). Null when it is next in line. */
  message: string | null;
  gpu: GpuInfo | null;
}

/** estimated_cost_usd split by what bills it; the parts sum to it (to rounding). */
export interface PlanCostBreakdown {
  /** The base model's tokens on every training step: each record (or both sides of a preference pair) once per epoch, at price_per_million_tokens. Held-out evaluation during training is not billed. */
  trainUsd: number;
  /** The teacher's tokens (on-policy distill), at its price. */
  teacherUsd: number;
  /** Evals the run starts, billed as evals: the labeling eval before training and recipe.evals on every checkpoint. */
  evalUsd: number;
}

export interface PlanEvalRequest {
  name?: string | undefined;
  models: Array<string>;
  baseline?: string | undefined;
  dataset: string;
  datasetVersion?: number | undefined;
  /** Default: the dataset's own rubric (a benchmark's answer check), else a non_empty validator. */
  rubric?: Array<EvalRubricItem> | undefined;
  samples?: number | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  limit?: number | undefined;
  /** Defaults to 1.0 when every rubric item is binary (regex/validator) and 0.5 otherwise. */
  passThreshold?: number | null | undefined;
}

export interface PlanEvalResponse {
  taskSourceKind: "dataset";
  datasetVersion: number;
  estimatedTasks: number;
  estimatedModelCalls: number;
  estimatedJudgeCalls: number;
  estimatedCostUsd: number;
  judgeModels: Array<string>;
  localScorers: Array<string>;
  passThreshold: number;
  warnings: Array<string>;
}

export interface PlanRunRequest {
  /** Dataset to train on. The run pins its current version. */
  dataset: string;
  /** Run name; the artifact it produces is released as `name@version`. */
  name: string;
  recipe: RecipeSpec;
  split?: SplitSpec | undefined;
  /** Hard spend cap in USD. The run stops with `stopped_budget` and keeps its checkpoint when it reaches the cap, and is never billed past it. Default: no cap. */
  maxCostUsd?: number | undefined;
}

export interface PlanRunResponse {
  resolvedConfig: ResolvedRunConfig;
  datasetVersion: number;
  usableRecords: number;
  totalRecords: number;
  estimatedSteps: number;
  estimatedTokens: number;
  /** Everything the run is expected to bill: training (and teacher) tokens, plus the evals it starts (labeling, recipe.evals). See cost_breakdown. */
  estimatedCostUsd: number;
  /** Wall-clock estimate in seconds on one H100 80 GB: model load and export, training at the measured tokens/s for this base and recipe, evaluations and checkpoints. Excludes queueing and any labeling eval. */
  estimatedDurationS: number;
  /** GPU memory (GB) this run needs: the base's min_gpu_memory_gb plus a teacher loaded beside it. Null when the base's requirement is unknown. */
  minGpuMemoryGb: number | null;
  pricePerMillionTokens: number;
  trainedTokenFraction: number;
  /** The labeling eval that runs before training (billed as an eval, included in estimated_cost_usd): router runs with a Judge/validator rubric replay prompts against the candidates; off-policy distill runs have the teacher answer each prompt. */
  labeling: {
    estimatedModelCalls: number;
    estimatedJudgeCalls: number;
    estimatedCostUsd: number;
  } | null;
  /** On-policy distill runs: the teacher's scoring tokens at the teacher's price (included in estimated_tokens as student-price tokens, and in estimated_cost_usd). */
  teacher: {
    model: string;
    pricePerMillionTokens: number;
    estimatedTokens: number;
    estimatedCostUsd: number;
  } | null;
  costBreakdown: PlanCostBreakdown;
  warnings: Array<string>;
}

export interface PoolingSpec {
  kind: "mean" | "cls";
}

export interface PostEvalScoresRequest {
  scores: Array<{
    outputId: string;
    scorer: string;
    score: number;
  }>;
}

export interface PostEvalScoresResponse {
  accepted: number;
  status: EvalStatus;
  pendingLocalScores: number;
}

export interface PromoteCheckpointRequest {
  name?: string | undefined;
}

export interface PushDatasetRequest {
  records: Array<DatasetRecord>;
  metadata?: Record<string, unknown> | undefined;
}

export interface RecipeEval {
  dataset: string;
  /** Dataset version (default: the current one, pinned at plan time). */
  version?: number | undefined;
  /** Judges, regexes and validators (default: the dataset's own rubric, such as a benchmark's answer check). Code scorers can't run during training. */
  rubric?: Array<EvalRubricItem> | undefined;
  /** Evaluate the first N tasks at each checkpoint. */
  limit?: number | undefined;
  /** Name of this eval in the report (default: the dataset name). */
  name?: string | undefined;
}

export type RecipeKind = "sft" | "dpo" | "router" | "decision" | "cartridge" | "embedding" | "distill" | "reward" | "grpo";

export const RecipeKindValues = ["sft", "dpo", "router", "decision", "cartridge", "embedding", "distill", "reward", "grpo"] as const;

export interface RecipeSpec {
  kind: RecipeKind;
  model?: string | undefined;
  adapter?: AdapterSpec | undefined;
  lr?: "auto" | number | undefined;
  lrScale?: number | undefined;
  batchSize?: number | undefined;
  epochs?: number | undefined;
  schedule?: "linear" | "cosine" | "constant" | undefined;
  warmup?: number | undefined;
  trainOn?: "last" | "all_assistant" | undefined;
  thinking?: "auto" | "on" | "off" | undefined;
  preserveThinking?: boolean | undefined;
  /** Default per_example. */
  reduction?: "per_example" | "per_token" | undefined;
  select?: "best" | "last" | undefined;
  checkpointTtlDays?: number | undefined;
  beta?: number | undefined;
  models?: Array<string> | undefined;
  maxQualityDrop?: number | undefined;
  contextText?: string | undefined;
  numTokens?: number | undefined;
  temp?: number | undefined;
  /** CartridgeRecipe and DistillRecipe: the model to learn from. DistillRecipe also takes an artifact (name@version) with rollout off_policy. */
  teacher?: string | undefined;
  rollout?: RolloutSpec | undefined;
  optimizer?: OptimizerSpec | undefined;
  /** Optimizer steps between held-out evaluations; auto = every 25% of the run, at most every 20 steps; each eval step is also a checkpoint. */
  evalEvery?: "auto" | number | undefined;
  loss?: LossSpec | undefined;
  pool?: PoolingSpec | undefined;
  /** RouterRecipe: a score name on your records (scores[rubric]), or Judge/validator items: the server then replays each prompt against recipe.models and scores the answers in a labeling eval before training. RewardModelRecipe: a score name in [0, 1] on records ending in an assistant turn, trained pointwise next to the chosen/rejected pairs. */
  rubric?: string | Array<EvalRubricItem> | undefined;
  /** RouterRecipe: USD per request for each candidate; overrides metrics.cost_usd on your records. */
  pricing?: Record<string, number> | undefined;
  /** RouterRecipe: the candidate that gets every request the router does not offload (default: the best-scoring candidate). */
  fallback?: string | undefined;
  /** CartridgeRecipe: teacher answer length per prompt during distillation (default 256). */
  maxNewTokens?: number | undefined;
  /** CartridgeRecipe: a reserved token that marks where the cartridge goes (default: the first reserved token that tokenizes atomically). */
  slotToken?: string | undefined;
  /** Extra evals on each checkpoint during training (the eval executor, billed like any eval). Results are in run.checkpoint_evals, the run's checkpoint_eval events and eval_report.checkpoint_evals. */
  evals?: Array<RecipeEval> | undefined;
  /** Experiment trackers that receive the run's metrics. A tracker that fails is reported and dropped; it never fails the run. */
  loggers?: Array<LoggerSpec> | undefined;
}

export interface RenderDatasetRequest {
  model?: string | undefined;
  trainOn?: "last" | "all_assistant" | undefined;
  thinking?: "auto" | "on" | "off" | undefined;
  preserveThinking?: boolean | undefined;
  limit?: number | undefined;
}

export interface RenderDatasetResponse {
  dataset: string;
  model: string;
  templateRevision: string;
  /** Token counts (total, trained and per span) are estimates (about 4 characters per token); the trainer tokenizes with the model's pinned tokenizer, and the run's metrics report the exact tokens. */
  tokenCounts: "estimated";
  examples: Array<{
    recordId: string;
    templateRevision: string;
    totalTokens: number;
    trainedTokens: number;
    trainedFraction: number;
    spans: Array<{
      text: string;
      trained: boolean;
      tokens: number;
    }>;
  }>;
}

export interface ResolvedRunConfig {
  ruleVersion: string;
  dataset: string;
  datasetVersion: number;
  name: string;
  recipeKind: RecipeKind;
  model: string;
  templateRevision: string;
  adapter: {
    kind: "lora";
    rank?: number | undefined;
    alpha?: number | undefined;
    mergeOnExport?: boolean | undefined;
  } | {
    kind: "prefix_kv";
    numTokens?: number | undefined;
  } | {
    kind: "frozen_head";
  } | {
    kind: "encoder_full";
  };
  lr: number;
  lrSource: string;
  batchSize: number;
  epochs: number;
  schedule: "linear" | "cosine" | "constant";
  warmup: number;
  trainOn: "last" | "all_assistant";
  thinking: "auto" | "on" | "off";
  preserveThinking: boolean;
  reduction: "per_example" | "per_token";
  select: "best" | "last";
  checkpointEverySteps: number;
  evalEverySteps: number;
  optimizer: OptimizerSpec;
  checkpointTtlDays: number;
  split: {
    strategy: "by_session" | "by_group" | "random";
    evalFraction: number;
    seed: number;
    trainRecords: number;
    evalRecords: number;
  };
  /** The labeling eval whose answers the run trains on: router runs with a Judge/validator rubric, and off-policy distill runs (the teacher's answers). */
  labelEvalId: string | null;
  baseArtifact: BaseArtifact | null;
  recipeParams: Record<string, unknown>;
  /** recipe.evals, with the dataset version and rubric pinned. */
  checkpointEvals?: Array<{
    name: string;
    dataset: string;
    datasetVersion: number;
    rubric: Array<EvalRubricItem>;
    limit: number | null;
  }> | undefined;
  loggers?: Array<LoggerSpec> | undefined;
}

export interface ResumeRunRequest {
  maxCostUsd?: number | undefined;
}

/** DistillRecipe: on_policy (default) samples answers from the student and the trainer scores them with the teacher's top-k logits; off_policy has the teacher answer each prompt once through the inference endpoint and trains the student on those answers. */
export type RolloutSpec = {
  kind: "on_policy";
  /** Length of each student answer; auto (default) sizes it from the assistant turns in your records (256 without any). */
  maxNewTokens?: "auto" | number | undefined;
} | {
  kind: "off_policy";
  maxNewTokens?: number | undefined;
};

/** Router quality vs. cost on the held-out report fold, against the fallback model. Values are null when no report prompt was scored for every candidate. */
export interface RouterParetoSummary {
  targetMaxDrop: number;
  routedQuality: number | null;
  qualityDrop: number | null;
  /** 95% bootstrap interval [low, high]. */
  qualityDropCi95: Array<number> | null;
  offloadRate: number | null;
  costSavingsPct: number | null;
  ece: number | null;
  threshold: number | null;
  temperature: number;
  [key: string]: unknown;
}

export interface Run {
  /** Run id (`run_` and 24 hex characters). */
  id: string;
  workspaceId: string;
  /** Run name; its artifact is released as `name@version`. */
  name: string;
  /** Id of the dataset trained on. */
  datasetId: string;
  /** Name of the dataset trained on. */
  datasetName: string;
  /** The dataset version the run pinned when it was created. */
  datasetVersion: number;
  recipeKind: RecipeKind;
  status: RunStatus;
  resolvedConfig: ResolvedRunConfig;
  /** Hard spend cap in USD (null: none). The run is never billed past it. */
  maxCostUsd: number | null;
  /** USD per million tokens processed, fixed when the run was created. */
  pricePerMillionTokens: number;
  /** Training tokens processed so far, over every attempt. */
  tokensProcessed: number;
  /** Cost of the tokens processed so far, in USD. It counts the whole step that crossed max_cost_usd; billing stops at the cap. */
  costUsd: number;
  /** Last optimizer step reported. */
  currentStep: number;
  /** Planned optimizer steps. */
  totalSteps: number;
  /** Attempts started so far (every start on a worker counts, including ones whose GPU was reclaimed). */
  attempt: number;
  /** The run fails once this many attempts end without a result (lost worker, worker error, OOM). Attempts whose GPU was reclaimed don't count toward it. */
  maxAttempts: number;
  /** What the run is doing now while it is queued or running. */
  phase: ("queued" | "waiting_for_compute" | "starting" | "loading_model" | "training" | "evaluating" | "checkpointing" | "uploading" | "completing") | null;
  /** When the run entered its phase. */
  phaseSince: string | null;
  lastInterruption: RunInterruption | null;
  /** While queued: workers of this kind holding a lease (all busy). Null otherwise. */
  workersOnline: number | null;
  /** While queued: true when workers scale from zero (KEDA), so a worker is starting. Null otherwise. */
  autoscaling: boolean | null;
  /** While queued for a worker: about how many runs start before this one. Claims are fair across workspaces (the workspace with the fewest running runs goes next), so this counts other workspaces' runs too. Approximate; null otherwise. */
  queuePosition: number | null;
  /** While queued for a worker: why it waits, ready to show: "Queued behind 3 runs", "Queued: workspace concurrency limit (8 running)" (the workspace runs as many as it may at once), or "Waiting for a GPU with ≥46 GB; online workers have 24 GB". Null when it is next in line, and once it is claimed. */
  queueMessage: string | null;
  /** GPU memory (GB) the run needs (its plan's min_gpu_memory_gb): only workers with at least this much claim it. Null when unknown. */
  minGpuMemoryGb: number | null;
  latestMetric: MetricPoint | null;
  evalReport: EvalReport | null;
  /** recipe.evals results, one per finished eval: a checkpoint (step) on a dataset. */
  checkpointEvals: Array<CheckpointEvalResult>;
  /** The released artifact (`name@version`) once the run completes; null before. */
  artifactId: string | null;
  /** Why the run failed or stopped; null otherwise. */
  error: string | null;
  /** When the run was created. */
  createdAt: string;
  /** When the run last changed. */
  updatedAt: string;
  /** When the run reached a final status; null while it is queued or running. */
  finishedAt: string | null;
  /** Only on the response that created the run (POST /v1/runs): the plan's warnings, such as another queued or running run with the same name. They're also the run's first warning events. */
  warnings?: Array<string> | undefined;
}

/** One event of a run's lifecycle, discriminated by `type`. `completed` is always last. */
export type RunEvent = PhaseEvent | MetricEvent | CheckpointEvent | AttemptEvent | WarningEvent | LogEvent | CompletedEvent;

export interface RunEventsPage {
  runId: string;
  status: RunStatus;
  data: Array<RunEvent>;
  /** Pass back as `cursor` for the next page; null on the last page (every list endpoint). */
  nextCursor: string | null;
  /** Cursor after the newest event returned so far; pass it back as `cursor` to poll for later events. */
  tailCursor: string;
}

export interface RunInterruption {
  attempt: number;
  reason: InterruptionReason;
  step: number;
  resumeStep: number | null;
  at: string;
  message: string;
}

/** Where a run is in its lifecycle (on a Run: the latest phase; once the run is terminal, status is authoritative and phase is the last one reached). queued, waiting_for_compute (queued for longer than the server's threshold with no worker claiming it) and starting (a worker claimed it) come from the server; the worker reports the rest. training, evaluating and checkpointing repeat. */
export type RunPhase = "queued" | "waiting_for_compute" | "starting" | "loading_model" | "training" | "evaluating" | "checkpointing" | "uploading" | "completing";

export const RunPhaseValues = ["queued", "waiting_for_compute", "starting", "loading_model", "training", "evaluating", "checkpointing", "uploading", "completing"] as const;

/** stopped_budget: the run reached its max_cost_usd (resume with a higher cap). stopped_balance: the workspace ran out of balance on Cloud (top up, then resume; the cap is unchanged). Both keep their checkpoints. */
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "stopped_budget" | "stopped_balance";

export const RunStatusValues = ["queued", "running", "completed", "failed", "cancelled", "stopped_budget", "stopped_balance"] as const;

export interface ScoreDatasetRequest {
  rubric: Array<EvalRubricItem>;
  /** Dataset version to score (default: the current version). */
  version?: number | undefined;
  /** Name of the scoring job (default `<dataset>-score`). */
  name?: string | undefined;
  limit?: number | undefined;
}

/** A workspace secret's metadata. The value is never returned. */
export interface Secret {
  /** Lowercase letters, digits, '.', '_' and '-'; unique per workspace. */
  name: string;
  workspaceId: string;
  /** The hosts this secret may be sent to. */
  allowedHosts: Array<string>;
  createdAt: string;
  updatedAt: string;
}

export interface SetSecretRequest {
  /** Lowercase letters, digits, '.', '_' and '-'; unique per workspace. */
  name: string;
  /** Write-only: stored encrypted and never returned by any endpoint. */
  value: string;
  /** Hosts (`host[:port]`, or URLs) this secret may be sent to: a source's host, huggingface.co for HF imports, a logger's host. Default: the public hosts of the supported providers (cloud.langfuse.com, us.cloud.langfuse.com, api.smith.langchain.com, eu.api.smith.langchain.com, api.braintrust.dev, us.posthog.com, eu.posthog.com, app.phoenix.arize.com, huggingface.co, api.wandb.ai). A secret for a self-hosted tool must name its host. Replacing a secret replaces its hosts. */
  allowedHosts?: Array<string> | undefined;
}

/** An observability provider synced into one dataset. A source feeds exactly one dataset; a dataset can have several sources. Deleting the dataset deletes its sources; removing a source keeps the dataset. */
export interface Source {
  id: string;
  workspaceId: string;
  dataset: string;
  provider: {
    kind: "langfuse" | "langsmith" | "braintrust" | "posthog" | "phoenix" | "gradiated";
    host: string | null;
    secret: string | null;
    project: string | null;
    /** The effective filters: validated, with single values as lists. */
    filters: Record<string, unknown>;
  };
  schedule: string | null;
  /** The share of traces synced (1: all). */
  sampleRate: number;
  maxRecordsPerSync: number | null;
  maxRecordsPerDay: number | null;
  /** New traces synced so far this UTC day (what max_records_per_day counts). */
  recordsToday: number;
  /** Seconds between the dataset versions scheduled syncs commit (0: every sync). */
  versionInterval: number;
  /** Records scheduled syncs fetched that wait for the next dataset version. */
  pendingRecords: number;
  /** When the schedule fires next (null without a schedule or while paused). After a failed sync the schedule backs off: twice its interval per consecutive failure, at most an hour. */
  nextSyncAt: string | null;
  /** `paused` after 10 consecutive failed syncs: the schedule stops firing. A manual sync, or setting a new value for the source's secret, resumes it. */
  status: "active" | "paused";
  /** Why the source is paused (null while active). */
  pausedReason: string | null;
  /** The error of the last failed sync (provider keys redacted); cleared by a successful sync. */
  lastError: string | null;
  lastErrorAt: string | null;
  /** Failed syncs since the last successful one. */
  consecutiveFailures: number;
  /** A full sync was requested while another sync ran; it is queued as soon as that one ends. */
  pendingFull: boolean;
  /** When the last successful sync finished. */
  lastSyncedAt: string | null;
  lastSync: SourceSync | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceProvider {
  /** One of langfuse, langsmith, braintrust, posthog, phoenix, gradiated; anything else is 422 source_provider_unsupported. */
  kind: string;
  /** The provider's API host (https). Optional for providers with one public host; not used by 'gradiated'. */
  host?: string | null | undefined;
  /** Name of the workspace secret holding the provider key. Not used by 'gradiated'. */
  secret?: string | null | undefined;
  /** The provider project to read. Required for braintrust (project id or name) and posthog (numeric project id); optional elsewhere (LangSmith project, Phoenix project). */
  project?: string | null | undefined;
  /** Which traces to sync; a trace must match every key. Values are a string or a list (any of which matches) unless noted: `tags` (list: every tag), `environment`, `model`, `version`, `release`, `name` (trace name or route), `user_id`, `session_id`, `metadata` (`{key: value}`, each equal), `from`/`to` (ISO 8601: the trace started in [from, to)), `has_feedback` (true: a score or a correction) and `min_score` (a number every score must reach, or `{name: number}`). Score filters are judged on the merged dataset, so feedback that arrives later still counts. LangSmith also takes `filter` (a LangSmith filter expression, AND-ed); gradiated takes `models`, `tasks` and `versions`. Any other key is 422 source_filter_unsupported. The response holds the effective filters (single values as lists). */
  filters?: Record<string, unknown> | undefined;
}

/** The most recent sync, running or finished. */
export interface SourceSync {
  importId: string;
  status: "queued" | "running" | "completed" | "failed";
  full: boolean;
  datasetVersion: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface SplitSpec {
  strategy?: "by_session" | "by_group" | "random" | undefined;
  evalFraction?: number | undefined;
  seed?: number | undefined;
}

export interface SyncSourceRequest {
  /** Rebuild the dataset from the provider as a new version (ignores the stored watermark). */
  full?: boolean | undefined;
}

export interface TrainableModel {
  id: string;
  hfRepo: string | null;
  family: "llm" | "encoder";
  adapters: Array<"lora" | "prefix_kv" | "frozen_head" | "encoder_full">;
  recipes: Array<RecipeKind>;
  defaultFor: Array<RecipeKind>;
  pricePerMillionTokensUsd: number;
  maxContextTokens: number;
  templateRevision: string;
  calibratedLrs: Record<string, number>;
  /** GPU memory (GB) training this base needs at the recipe defaults, measured on an H100 80 GB. v0 trains on one GPU, and runs.plan refuses (422 model_exceeds_gpu_memory) a run that needs more than 80 GB. Null when unknown. */
  minGpuMemoryGb: number | null;
}

export interface TrajectoryInput {
  messages?: Array<ChatMessage> | undefined;
  tools?: Array<Record<string, unknown>> | undefined;
  media?: Array<Record<string, unknown>> | undefined;
  features?: Record<string, unknown> | undefined;
  payload?: unknown | undefined;
  [key: string]: unknown;
}

export interface TrajectoryOutput {
  turns?: Array<ChatMessage> | undefined;
  payload?: unknown | undefined;
  [key: string]: unknown;
}

/** Fields left out keep their value. Changes apply from the next sync; traces already synced stay (a full sync rebuilds the dataset with the new settings). */
export interface UpdateSourceRequest {
  /** Replaces the source's filters ({} clears them). Which traces to sync; a trace must match every key. Values are a string or a list (any of which matches) unless noted: `tags` (list: every tag), `environment`, `model`, `version`, `release`, `name` (trace name or route), `user_id`, `session_id`, `metadata` (`{key: value}`, each equal), `from`/`to` (ISO 8601: the trace started in [from, to)), `has_feedback` (true: a score or a correction) and `min_score` (a number every score must reach, or `{name: number}`). Score filters are judged on the merged dataset, so feedback that arrives later still counts. LangSmith also takes `filter` (a LangSmith filter expression, AND-ed); gradiated takes `models`, `tasks` and `versions`. Any other key is 422 source_filter_unsupported. The response holds the effective filters (single values as lists). */
  filters?: Record<string, unknown> | undefined;
  /** Five-field cron in UTC (`*\/15 * * * *`); minute resolution, so it fires at most once a minute (a seconds field is rejected). Leave it out to sync only on request. */
  schedule?: string | null | undefined;
  /** The share of traces to sync, chosen by a hash of the trace id: re-syncs keep the same sample, and a trace's feedback follows it. Default 1. */
  sampleRate?: number | undefined;
  /** At most this many new traces per sync; the rest are not synced (the sync's drop reasons count them). Feedback on traces already synced always lands. Null: no cap. */
  maxRecordsPerSync?: number | null | undefined;
  /** At most this many new traces per UTC day; the rest are not synced (the sync's drop reasons count them). Feedback on traces already synced always lands. Null: no cap. */
  maxRecordsPerDay?: number | null | undefined;
  /** Seconds between the dataset versions scheduled syncs commit (default 900). A scheduled sync may fetch every minute; its parts wait, staged, until the interval has passed or enough records are waiting, so a busy source doesn't add a version a minute. 0: every sync commits. Manual and full syncs always commit. */
  versionInterval?: number | undefined;
}

export interface UploadTicket {
  /** The file's sha256: uploads are content-addressed, so re-uploading the same bytes is harmless. */
  uploadId: string;
  method: "PUT";
  /** Presigned S3 PUT URL; send exactly `headers` (they bind the length and sha256). */
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface UsageGroup {
  /** The group: a UTC day or week start (YYYY-MM-DD), a month (YYYY-MM), a model, a recipe or a kind. Null for usage with no recipe (plain evals, scoring). */
  key: string | null;
  costUsd: number;
  tokens: number;
  records: number;
}

export type UsageGroupBy = "day" | "week" | "month" | "model" | "recipe" | "kind";

export const UsageGroupByValues = ["day", "week", "month", "model", "recipe", "kind"] as const;

/** What the tokens paid for: `training` (a run's attempts), `eval` (evals, including a run's checkpoint evals), `scoring` (dataset.score), `labeling` (a router run's labeling eval) or `teacher` (an off-policy distill run's teacher answers). */
export type UsageKind = "training" | "eval" | "scoring" | "labeling" | "teacher";

export const UsageKindValues = ["training", "eval", "scoring", "labeling", "teacher"] as const;

export interface UsageKindTotal {
  kind: UsageKind;
  costUsd: number;
  tokens: number;
  records: number;
}

export interface UsageRecord {
  id: string;
  kind: UsageKind;
  /** The run (kind `training`) or eval this usage belongs to. */
  refId: string;
  refName: string | null;
  /** The run the usage was billed for: the run itself, or the run whose labeling, teacher or checkpoint eval it is. */
  runId: string | null;
  attempt: number;
  /** The attempt's tokens this row starts after (usage is billed in increments while an attempt runs). */
  tokensFrom: number;
  tokensThrough: number;
  tokens: number;
  costUsd: number;
  priceVersion: string;
  /** Who bills this usage: `grad` (training, and evals on a self-hosted server) or `gateway` (on Gradiated Cloud, eval model and judge tokens are billed once by the inference gateway; shown here, not charged twice). */
  billedBy: "grad" | "gateway";
  idempotencyKey: string;
  createdAt: string;
}

export interface UsageRefTotal {
  id: string;
  name: string | null;
  kind: UsageKind;
  costUsd: number;
  tokens: number;
}

export interface UsageSummary {
  /** Start of the period (inclusive). */
  from: string;
  /** End of the period (exclusive). */
  to: string;
  costUsd: number;
  tokens: number;
  records: number;
  /** One entry per kind with usage, costliest first. */
  byKind: Array<UsageKindTotal>;
  /** The costliest runs' training in the period (up to 5). */
  topRuns: Array<UsageRefTotal>;
  /** The costliest evals, scoring, labeling and teacher jobs in the period (up to 5). */
  topEvals: Array<UsageRefTotal>;
  groupBy: UsageGroupBy | null;
  /** With group_by: one entry per group with usage, oldest first for time groups and costliest first otherwise. */
  groups: Array<UsageGroup>;
}

export interface WarningEvent {
  type: "warning";
  runId: string;
  /** Position in the run's event sequence (the SSE event id; pass it as Last-Event-ID or `cursor` to resume). `completed` repeats the last stored seq. */
  seq: number;
  attempt: number;
  timestamp: string;
  step: number | null;
  message: string;
}
