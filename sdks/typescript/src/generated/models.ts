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

export type ApiKeyScope = "admin" | "datasets:read" | "datasets:write" | "runs:read" | "runs:write" | "artifacts:read" | "artifacts:write" | "secrets:read" | "secrets:write" | "sources:read" | "sources:write" | "deployments:write" | "feedback:write" | "env:serve";

export const ApiKeyScopeValues = ["admin", "datasets:read", "datasets:write", "runs:read", "runs:write", "artifacts:read", "artifacts:write", "secrets:read", "secrets:write", "sources:read", "sources:write", "deployments:write", "feedback:write", "env:serve"] as const;

export interface Artifact {
  id: string;
  workspaceId: string;
  name: string;
  version: string;
  runId: string | null;
  checkpointId: string | null;
  baseModel: string;
  recipeKind: RecipeKind;
  format: ArtifactFormat | null;
  sha256: string;
  sizeBytes: number;
  manifest: Record<string, unknown>;
  evalReport: EvalReport | null;
  createdAt: string;
}

/** Artifact format when this checkpoint is exportable (promotable); null for training state only. */
export type ArtifactFormat = "peft_lora" | "merged_safetensors" | "prefix_kv" | "cartridge" | "encoder_safetensors" | "router_bundle" | "decision_bundle" | "reward_bundle" | "reference";

export const ArtifactFormatValues = ["peft_lora", "merged_safetensors", "prefix_kv", "cartridge", "encoder_safetensors", "router_bundle", "decision_bundle", "reward_bundle", "reference"] as const;

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
  id: string;
  workspaceId: string;
  runId: string;
  attempt: number;
  step: number;
  evalScore: number | null;
  format: ArtifactFormat | null;
  sha256: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  best: boolean;
  final: boolean;
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

export interface CreateApiKeyRequest {
  name: string;
  scopes: Array<ApiKeyScope>;
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
  /** Five-field cron in UTC (`*\/15 * * * *`). Leave it out to sync only on request. */
  schedule?: string | null | undefined;
}

export interface CreateUploadRequest {
  purpose: "dataset_import";
  filename: string;
  sizeBytes: number;
  sha256: string;
}

export interface CreatedApiKey {
  key: ApiKey;
  secret: string;
}

export interface Dataset {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  /** Records in the current version after merging: score updates fold into their records, and a full source sync restarts the count. A record pushed again with an id it already has counts again. */
  recordCount: number;
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

export interface DeployArtifactRequest {
  artifact: string;
  name?: string | undefined;
  fallback?: string | undefined;
  exploreRate?: number | undefined;
}

export interface Deployment {
  id: string;
  workspaceId: string;
  name: string;
  modelId: string;
  activeArtifactId: string;
  previousArtifactId: string | null;
  fallbackModel: string | null;
  exploreRate: number;
  status: "active" | "disabled";
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentStatus {
  deployment: Deployment;
  feedbackCount: number;
  averageScore: number | null;
}

export interface EmbedRequest {
  /** Name of a deployed embedding artifact. */
  model: string;
  input: string | Array<string>;
}

export interface EmbedResponse {
  model: string;
  data: Array<{
    index: number;
    embedding: Array<number>;
  }>;
  usage: {
    promptTokens: number;
    totalTokens: number;
  };
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

export interface FeedbackEventInput {
  inferenceId?: string | undefined;
  sessionId?: string | undefined;
  deploymentName?: string | undefined;
  idempotencyKey: string;
  score?: number | undefined;
  expectedOutput?: unknown | undefined;
  metrics?: Record<string, number> | undefined;
}

export interface FeedbackRecord {
  id: string;
  workspaceId: string;
  inferenceId: string | null;
  sessionId: string | null;
  deploymentName: string | null;
  idempotencyKey: string;
  score: number | null;
  expectedOutput?: unknown | undefined;
  metrics: Record<string, number>;
  createdAt: string;
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
  dataset: string;
  name: string;
  recipe: RecipeSpec;
  split?: SplitSpec | undefined;
  maxCostUsd?: number | undefined;
}

export interface PlanRunResponse {
  resolvedConfig: ResolvedRunConfig;
  datasetVersion: number;
  usableRecords: number;
  totalRecords: number;
  estimatedSteps: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
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
  /** Optimizer steps between held-out evaluations; auto = every 10% of steps (the checkpoint interval). */
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

export interface RecordFeedbackRequest {
  events: Array<FeedbackEventInput>;
}

export interface RecordFeedbackResponse {
  accepted: number;
  deduplicated: number;
  records: Array<FeedbackRecord>;
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

export interface RouteRequest {
  deployment: string;
  messages: Array<ChatMessage>;
  tools?: Array<Record<string, unknown>> | undefined;
  sessionId?: string | undefined;
}

export interface RouteResponse {
  inferenceId: string;
  deployment: string;
  artifactId: string;
  model: string;
  isExploration: boolean;
  confidence: number;
  scores: Record<string, number>;
}

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
  id: string;
  workspaceId: string;
  name: string;
  datasetId: string;
  datasetName: string;
  datasetVersion: number;
  recipeKind: RecipeKind;
  status: RunStatus;
  resolvedConfig: ResolvedRunConfig;
  maxCostUsd: number | null;
  pricePerMillionTokens: number;
  tokensProcessed: number;
  costUsd: number;
  currentStep: number;
  totalSteps: number;
  attempt: number;
  maxAttempts: number;
  latestMetric: MetricPoint | null;
  evalReport: EvalReport | null;
  /** recipe.evals results, one per finished eval: a checkpoint (step) on a dataset. */
  checkpointEvals: Array<CheckpointEvalResult>;
  artifactId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "stopped_budget";

export const RunStatusValues = ["queued", "running", "completed", "failed", "cancelled", "stopped_budget"] as const;

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
  createdAt: string;
  updatedAt: string;
}

export interface SetSecretRequest {
  /** Lowercase letters, digits, '.', '_' and '-'; unique per workspace. */
  name: string;
  /** Write-only: stored encrypted and never returned by any endpoint. */
  value: string;
}

export interface Source {
  id: string;
  workspaceId: string;
  dataset: string;
  provider: {
    kind: "langfuse" | "langsmith" | "braintrust" | "posthog" | "phoenix" | "gradiated";
    host: string | null;
    secret: string | null;
    project: string | null;
    filters: Record<string, unknown>;
  };
  schedule: string | null;
  nextSyncAt: string | null;
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
  /** Provider-specific filters passed to the fetcher, for example `{"tags": ["prod"]}` or, for 'gradiated', `{"models": [...], "tasks": [...]}`. */
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

export interface UploadTicket {
  /** The file's sha256: uploads are content-addressed, so re-uploading the same bytes is harmless. */
  uploadId: string;
  method: "PUT";
  /** Absolute presigned URL, or a path relative to the API base URL (local storage). */
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface UsageRecord {
  id: string;
  kind: "run" | "eval";
  /** The run or eval this usage belongs to. */
  refId: string;
  attempt: number;
  /** The attempt's tokens this row starts after (usage is billed in increments while an attempt runs). */
  tokensFrom: number;
  tokensThrough: number;
  tokens: number;
  costUsd: number;
  priceVersion: string;
  idempotencyKey: string;
  createdAt: string;
}
