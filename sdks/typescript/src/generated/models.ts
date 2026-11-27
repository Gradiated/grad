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

export type ApiKeyScope = "admin" | "datasets:read" | "datasets:write" | "runs:read" | "runs:write" | "artifacts:read" | "artifacts:write" | "deployments:write" | "feedback:write" | "env:serve";

export const ApiKeyScopeValues = ["admin", "datasets:read", "datasets:write", "runs:read", "runs:write", "artifacts:read", "artifacts:write", "deployments:write", "feedback:write", "env:serve"] as const;

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
  evalReport: Record<string, unknown> | null;
  createdAt: string;
}

/** Artifact format when this checkpoint is exportable (promotable); null for training state only. */
export type ArtifactFormat = "peft_lora" | "merged_safetensors" | "prefix_kv" | "cartridge" | "encoder_safetensors" | "router_bundle" | "decision_bundle" | "reference";

export const ArtifactFormatValues = ["peft_lora", "merged_safetensors", "prefix_kv", "cartridge", "encoder_safetensors", "router_bundle", "decision_bundle", "reference"] as const;

/** Continued training: the artifact whose adapter the run starts from (recipe.model was an artifact reference). */
export interface BaseArtifact {
  id: string;
  recipeKind: RecipeKind;
  format: "peft_lora";
  sha256: string;
}

export interface BenchmarkSpec {
  name: "ifeval" | "gsm8k" | "mmlu-pro" | "gpqa-diamond" | "humaneval" | "livecodebench";
  limit?: number | undefined;
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

export interface ClaimJobRequest {
  workerId: string;
  leaseSeconds?: number | undefined;
  kinds?: Array<JobKind> | undefined;
  /** Recipe kinds this worker can run; train jobs for other recipes are left queued. */
  recipes?: Array<RecipeKind> | undefined;
}

export interface ClaimJobResponse {
  protocol: "grad.trainer-protocol/1";
  job: TrainerJob | null;
}

export interface CompleteTrainerJobRequest {
  workerId: string;
  attempt: number;
  /** `abandoned` releases the lease (worker shutdown) and requeues the job without counting a failure. */
  status: "completed" | "stopped_budget" | "failed" | "cancelled" | "abandoned";
  uploadId?: string | undefined;
  format?: ArtifactFormat | null | undefined;
  manifest?: Record<string, unknown> | undefined;
  evalReport?: Record<string, unknown> | null | undefined;
  tokensProcessed?: number | undefined;
  error?: string | undefined;
  importSummary?: {
    droppedCount?: number | undefined;
    detectedScores?: Array<string> | undefined;
    dropReasons?: Array<string> | undefined;
  } | undefined;
}

export interface CompleteTrainerJobResponse {
  jobId: string;
  kind: JobKind;
  status: string;
  run: Run | null;
  artifact: Artifact | null;
  import: ImportJob | null;
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
  nextCursor: string | null;
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

export interface EnvTaskDispatch {
  envName: string;
  task: Record<string, unknown>;
  modelId: string;
  systemPrompt?: string | undefined;
  timeoutS?: number | undefined;
}

export interface EnvTaskResult {
  workerId: string;
  score?: number | null | undefined;
  scores?: Record<string, number> | undefined;
  trajectory?: Record<string, unknown> | undefined;
  error?: string | undefined;
}

export interface EnvWorkerRegister {
  name: string;
  workerId: string;
  concurrency?: number | undefined;
}

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

export interface EvalRubricItem {
  name: string;
  kind: "regex" | "validator" | "code" | "judge";
  weight?: number | undefined;
  pattern?: string | undefined;
  flags?: string | undefined;
  validator?: "json" | "non_empty" | "exact_match" | undefined;
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
  /** Spend cap. Generation stops once outputs cost this much and the eval ends stopped_budget with partial results. */
  maxCostUsd: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type EvalStatus = "queued" | "running" | "awaiting_scores" | "completed" | "stopped_budget" | "failed" | "cancelled";

export const EvalStatusValues = ["queued", "running", "awaiting_scores", "completed", "stopped_budget", "failed", "cancelled"] as const;

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
};

export type ImportStatus = "queued" | "running" | "completed" | "failed";

export const ImportStatusValues = ["queued", "running", "completed", "failed"] as const;

export type JobKind = "train" | "import";

export const JobKindValues = ["train", "import"] as const;

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
  evalMetric?: number | null | undefined;
  gradNorm?: number | null | undefined;
  lr?: number | null | undefined;
  tokensPerSec?: number | null | undefined;
  tokens: number;
  costUsd: number;
  timestamp: string;
  [key: string]: unknown;
}

export interface MetricPointInput {
  step: number;
  loss: number;
  evalLoss?: number | null | undefined;
  evalMetric?: number | null | undefined;
  gradNorm?: number | null | undefined;
  lr?: number | null | undefined;
  tokensPerSec?: number | null | undefined;
  tokens: number;
  costUsd?: number | undefined;
  timestamp: string;
  [key: string]: unknown;
}

export interface MetricsPage {
  runId: string;
  status: RunStatus;
  data: Array<MetricPoint | null>;
  nextCursor: string | null;
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
  dataset?: string | undefined;
  datasetVersion?: number | undefined;
  envName?: string | undefined;
  tasks?: Array<Record<string, unknown>> | undefined;
  benchmarks?: Array<BenchmarkSpec> | undefined;
  rubric?: Array<EvalRubricItem> | undefined;
  samples?: number | undefined;
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  limit?: number | undefined;
  /** Defaults to 1.0 when every rubric item is binary (regex/validator) and 0.5 otherwise. */
  passThreshold?: number | null | undefined;
  /** Spend cap: evals.create rejects plans estimated above it, and execution stops at it (status stopped_budget). */
  maxCostUsd?: number | undefined;
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
  /** Chained run (run.then(...)): starts from this run's artifact once it completes and is cancelled if it fails. Omit recipe.model. */
  dependsOn?: string | undefined;
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
  /** Router runs with a Judge/validator rubric: the labeling eval that replays prompts against the candidates (billed as an eval, included in estimated_cost_usd). */
  labeling: {
    estimatedModelCalls: number;
    estimatedJudgeCalls: number;
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

export interface PostImportRecordsRequest {
  workerId: string;
  attempt: number;
  records: Array<unknown>;
}

export interface PostImportRecordsResponse {
  accepted: number;
  rejected: number;
  errors: Array<{
    index: number;
    error: string;
  }>;
}

export interface Problem {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  requestId: string;
}

export interface PromoteCheckpointRequest {
  name?: string | undefined;
}

export interface PushDatasetRequest {
  records: Array<DatasetRecord>;
  metadata?: Record<string, unknown> | undefined;
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
  contextUri?: string | undefined;
  numTokens?: number | undefined;
  temp?: number | undefined;
  teacher?: string | undefined;
  envName?: string | undefined;
  groupSize?: number | undefined;
  optimizer?: OptimizerSpec | undefined;
  /** Optimizer steps between held-out evaluations; auto = every 10% of steps (the checkpoint interval). */
  evalEvery?: "auto" | number | undefined;
  loss?: LossSpec | undefined;
  pool?: PoolingSpec | undefined;
  /** RouterRecipe: a score name on your records (scores[rubric]), or Judge/validator items: the server then replays each prompt against recipe.models and scores the answers in a labeling eval before training. */
  rubric?: string | Array<EvalRubricItem> | undefined;
  /** RouterRecipe: USD per request for each candidate; overrides metrics.cost_usd on your records. */
  pricing?: Record<string, number> | undefined;
  /** RouterRecipe: the candidate that gets every request the router does not offload (default: the best-scoring candidate). */
  fallback?: string | undefined;
  /** CartridgeRecipe: teacher answer length per prompt during distillation (default 256). */
  maxNewTokens?: number | undefined;
  /** CartridgeRecipe: a reserved token that marks where the cartridge goes (default: the first reserved token that tokenizes atomically). */
  slotToken?: string | undefined;
}

export interface RecordFeedbackRequest {
  events: Array<FeedbackEventInput>;
}

export interface RecordFeedbackResponse {
  accepted: number;
  deduplicated: number;
  records: Array<FeedbackRecord>;
}

export interface RegisterTrainerCheckpointRequest {
  workerId: string;
  attempt: number;
  step: number;
  evalScore?: number | null | undefined;
  uploadId: string;
  format?: ArtifactFormat | null | undefined;
  metadata?: Record<string, unknown> | undefined;
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

export interface ReportTrainerProgressRequest {
  workerId: string;
  attempt: number;
  metric: MetricPointInput;
}

export interface ReportTrainerProgressResponse {
  status: RunStatus;
  shouldStop: boolean;
  stopReason: ("cancelled" | "budget") | null;
  costUsd: number;
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
  /** Router runs with a Judge/validator rubric: the labeling eval whose scored answers the router trains on. */
  labelEvalId: string | null;
  baseArtifact: BaseArtifact | null;
  recipeParams: Record<string, unknown>;
}

export interface ResumeRunRequest {
  maxCostUsd?: number | undefined;
}

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
  evalReport: Record<string, unknown> | null;
  artifactId: string | null;
  /** The run this chained run starts from; it stays queued until that run completes. */
  dependsOn: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "stopped_budget";

export const RunStatusValues = ["queued", "running", "completed", "failed", "cancelled", "stopped_budget"] as const;

export interface SplitSpec {
  strategy?: "by_session" | "by_group" | "random" | undefined;
  evalFraction?: number | undefined;
  seed?: number | undefined;
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

export interface TrainerHeartbeatRequest {
  workerId: string;
  attempt: number;
  leaseSeconds?: number | undefined;
}

export interface TrainerHeartbeatResponse {
  status: string;
  shouldStop: boolean;
  stopReason: ("cancelled" | "budget") | null;
  leaseExpiresAt: string;
}

export interface TrainerJob {
  id: string;
  kind: JobKind;
  attempt: number;
  leaseSeconds: number;
  leaseExpiresAt: string;
  run: {
    id: string;
    workspaceId: string;
    name: string;
    recipeKind: RecipeKind;
    resolvedConfig: ResolvedRunConfig;
    totalSteps: number;
  } | null;
  import: {
    id: string;
    workspaceId: string;
    dataset: string;
    source: Record<string, unknown>;
    connector: "auto" | "grad_trajectories" | "openai_chat" | "gradiated" | "otel" | "langfuse" | "posthog" | "braintrust" | "langsmith";
  } | null;
  pricePerMillionTokens: number | null;
  /** Remaining budget for this attempt (the run cap minus cost billed by earlier attempts). */
  maxCostUsd: number | null;
  dataset: {
    version: number;
    recordCount: number;
    downloadUrl: string;
  } | null;
  resume: {
    checkpointId: string;
    step: number;
    downloadUrl: string;
  } | null;
  /** Continued training: the starting artifact's bundle (a PEFT LoRA adapter) to load before training. */
  base: {
    artifactId: string;
    sha256: string;
    downloadUrl: string;
  } | null;
}

export interface TrainerQueueStats {
  queued: number;
  running: number;
  total: number;
  byKind: {
    train: {
      queued: number;
      running: number;
    };
    import: {
      queued: number;
      running: number;
    };
  };
}

export interface TrainerUploadRequest {
  workerId: string;
  attempt: number;
  kind: "checkpoint" | "artifact";
  sha256: string;
  sizeBytes: number;
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
  uploadId: string;
  method: "PUT";
  /** Absolute presigned URL, or a path relative to the API base URL (local storage). */
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}
