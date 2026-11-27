// AUTO-GENERATED from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.
/* eslint-disable */

export type AdapterSpec = {
  kind: "lora";
  rank?: number;
  alpha?: number;
  merge_on_export?: boolean;
} | {
  kind: "prefix_kv";
  num_tokens?: number;
} | {
  kind: "frozen_head";
};

export type ApiKey = {
  id: string;
  workspace_id: string;
  name: string;
  prefix: string;
  scopes: Array<ApiKeyScope>;
  created_at: string;
  revoked_at: string | null;
};

export type ApiKeyScope = "admin" | "datasets:read" | "datasets:write" | "runs:read" | "runs:write" | "artifacts:read" | "artifacts:write" | "deployments:write" | "feedback:write" | "env:serve";

export type Artifact = {
  id: string;
  workspace_id: string;
  name: string;
  version: string;
  run_id: string | null;
  checkpoint_id: string | null;
  base_model: string;
  recipe_kind: RecipeKind;
  format: ArtifactFormat;
  sha256: string;
  size_bytes: number;
  manifest: Record<string, unknown>;
  eval_report: Record<string, unknown> | null;
  created_at: string;
};

export type ArtifactFormat = "peft_lora" | "prefix_kv" | "cartridge" | "encoder_safetensors" | "router_bundle" | "decision_bundle" | "reference" | null;

export type BenchmarkSpec = {
  name: "ifeval" | "gsm8k" | "mmlu-pro" | "gpqa-diamond" | "humaneval" | "livecodebench";
  limit?: number;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | Array<Record<string, unknown>> | null;
  tool_calls?: Array<Record<string, unknown>>;
  tool_call_id?: string;
  name?: string;
  train?: boolean;
};

export type Checkpoint = {
  id: string;
  workspace_id: string;
  run_id: string;
  attempt: number;
  step: number;
  eval_score: number | null;
  format: ArtifactFormat;
  sha256: string;
  size_bytes: number;
  metadata: Record<string, unknown>;
  best: boolean;
  final: boolean;
  expires_at: string | null;
  created_at: string;
};

export type ClaimJobRequest = {
  worker_id: string;
  lease_seconds?: number;
  kinds?: Array<JobKind>;
  recipes?: Array<RecipeKind>;
};

export type ClaimJobResponse = {
  protocol: "grad.trainer-protocol/1";
  job: TrainerJob;
};

export type CompleteTrainerJobRequest = {
  worker_id: string;
  attempt: number;
  status: "completed" | "stopped_budget" | "failed" | "cancelled" | "abandoned";
  upload_id?: string;
  format?: ArtifactFormat;
  manifest?: Record<string, unknown>;
  eval_report?: Record<string, unknown> | null;
  tokens_processed?: number;
  error?: string;
  import_summary?: {
  dropped_count?: number;
  detected_scores?: Array<string>;
  drop_reasons?: Array<string>;
};
};

export type CompleteTrainerJobResponse = {
  job_id: string;
  kind: JobKind;
  status: string;
  run: Run & Record<string, unknown> | null;
  artifact: Artifact & Record<string, unknown> | null;
  import: ImportJob & Record<string, unknown> | null;
};

export type CreateApiKeyRequest = {
  name: string;
  scopes: Array<ApiKeyScope>;
};

export type CreateDatasetRequest = {
  name: string;
  metadata?: Record<string, unknown>;
};

export type CreateImportRequest = {
  source: ImportSource;
  connector?: "auto" | "grad_trajectories" | "openai_chat" | "gradiated" | "otel" | "langfuse" | "posthog" | "braintrust" | "langsmith";
};

export type CreateUploadRequest = {
  purpose: "dataset_import";
  filename: string;
  size_bytes: number;
  sha256: string;
};

export type CreatedApiKey = {
  key: ApiKey;
  secret: string;
};

export type Dataset = {
  id: string;
  workspace_id: string;
  name: string;
  version: number;
  record_count: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type DatasetRecord = {
  schema?: "grad.trajectory/1";
  id?: string;
  session_id?: string | null;
  group_id?: string | null;
  role?: "chosen" | "rejected" | "anchor" | "positive" | "negative" | "desirable" | "undesirable" | "rollout" | null;
  source?: string | null;
  timestamp?: string | null;
  messages?: Array<ChatMessage>;
  tools?: Array<Record<string, unknown>>;
  input?: TrajectoryInput;
  output?: TrajectoryOutput;
  prompt?: string | Array<ChatMessage>;
  completion?: string | Array<ChatMessage>;
  chosen?: string | Array<ChatMessage>;
  rejected?: string | Array<ChatMessage>;
  query?: string;
  positive?: string;
  negatives?: Array<string>;
  state?: unknown;
  questions?: Record<string, unknown>;
  expected_output?: unknown;
  scores?: Record<string, number>;
  metrics?: Record<string, number>;
  metadata?: Record<string, unknown>;
};

export type DatasetRecordsPage = {
  dataset: string;
  version: number;
  total: number;
  data: Array<DatasetRecord>;
  next_cursor: string | null;
};

export type DeployArtifactRequest = {
  artifact: string;
  name?: string;
  fallback?: string;
  explore_rate?: number;
};

export type Deployment = {
  id: string;
  workspace_id: string;
  name: string;
  model_id: string;
  active_artifact_id: string;
  previous_artifact_id: string | null;
  fallback_model: string | null;
  explore_rate: number;
  status: "active" | "disabled";
  created_at: string;
  updated_at: string;
};

export type DeploymentStatus = {
  deployment: Deployment;
  feedback_count: number;
  average_score: number | null;
};

export type EmbedRequest = {
  model: string;
  input: string | Array<string>;
};

export type EmbedResponse = {
  model: string;
  data: Array<{
  index: number;
  embedding: Array<number>;
}>;
  usage: {
  prompt_tokens: number;
  total_tokens: number;
};
};

export type EnvTaskDispatch = {
  env_name: string;
  task: Record<string, unknown>;
  model_id: string;
  system_prompt?: string;
  timeout_s?: number;
};

export type EnvTaskResult = {
  worker_id: string;
  score?: number | null;
  scores?: Record<string, number>;
  trajectory?: Record<string, unknown>;
  error?: string;
};

export type EnvWorkerRegister = {
  name: string;
  worker_id: string;
  concurrency?: number;
};

export type EvalModelSummary = {
  model: string;
  overall: number;
  ci_low: number;
  ci_high: number;
  pass_at_k: Record<string, number>;
  vs_baseline: {
  delta: number;
  ci_low: number;
  ci_high: number;
} | null;
  tasks: number;
  errors: number;
  tokens_per_task: number;
  cost_per_1k_tasks_usd: number | null;
};

export type EvalOutput = {
  id: string;
  eval_id: string;
  task_id: string;
  model: string;
  sample_index: number;
  input: Array<ChatMessage>;
  output: string | null;
  expected_output?: unknown;
  record: DatasetRecord;
  scores: Record<string, number>;
  error: string | null;
  usage: {
  prompt_tokens: number;
  completion_tokens: number;
};
};

export type EvalRubricItem = {
  name: string;
  kind: "regex" | "validator" | "code" | "judge";
  weight?: number;
  pattern?: string;
  flags?: string;
  validator?: "json" | "non_empty" | "exact_match";
  model?: string;
  prompt?: string;
  runtime?: "local";
};

export type EvalRun = {
  id: string;
  workspace_id: string;
  name: string;
  status: EvalStatus;
  models: Array<string>;
  baseline: string | null;
  task_source: {
  kind: "dataset";
  dataset: string;
  version: number;
};
  rubric: Array<EvalRubricItem>;
  samples: number;
  temperature: number;
  max_tokens: number;
  pass_threshold: number;
  judge_models: Array<string>;
  local_scorers: Array<string>;
  progress: {
  total_outputs: number;
  generated: number;
  pending_local_scores: number;
};
  summary: Array<EvalModelSummary>;
  total_cost_usd: number;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type EvalStatus = "queued" | "running" | "awaiting_scores" | "completed" | "failed" | "cancelled";

export type EvalTaskOutcome = {
  task_id: string;
  model: string;
  score: number;
  passed: boolean;
  sample_scores: Array<number>;
  judge_model: string | null;
  record: DatasetRecord;
};

export type FeedbackEventInput = {
  inference_id?: string;
  session_id?: string;
  deployment_name?: string;
  idempotency_key: string;
  score?: number;
  expected_output?: unknown;
  metrics?: Record<string, number>;
};

export type FeedbackRecord = {
  id: string;
  workspace_id: string;
  inference_id: string | null;
  session_id: string | null;
  deployment_name: string | null;
  idempotency_key: string;
  score: number | null;
  expected_output?: unknown;
  metrics: Record<string, number>;
  created_at: string;
};

export type HfColumnMapping = {
  messages?: string;
  prompt?: string;
  completion?: string;
  chosen?: string;
  rejected?: string;
  answer?: string;
  query?: string;
  positive?: string;
};

export type ImportJob = {
  id: string;
  workspace_id: string;
  dataset: string;
  status: ImportStatus;
  source: Record<string, unknown>;
  connector: "auto" | "grad_trajectories" | "openai_chat" | "gradiated" | "otel" | "langfuse" | "posthog" | "braintrust" | "langsmith";
  attempt: number;
  imported_count: number;
  dropped_count: number;
  detected_scores: Array<string>;
  drop_reasons: Array<string>;
  dataset_version: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type ImportSource = {
  kind: "upload";
  upload_id: string;
  format?: "auto" | "jsonl" | "json" | "parquet";
} | {
  kind: "hf";
  repo: string;
  split?: string;
  config?: string;
  revision?: string;
  columns?: HfColumnMapping;
  limit?: number;
};

export type ImportStatus = "queued" | "running" | "completed" | "failed";

export type JobKind = "train" | "import";

export type MetricPoint = {
  seq: number;
  attempt: number;
  step: number;
  loss: number;
  eval_loss?: number | null;
  eval_metric?: number | null;
  grad_norm?: number | null;
  lr?: number | null;
  tokens_per_sec?: number | null;
  tokens: number;
  cost_usd: number;
  timestamp: string;
} | null;

export type MetricPointInput = {
  step: number;
  loss: number;
  eval_loss?: number | null;
  eval_metric?: number | null;
  grad_norm?: number | null;
  lr?: number | null;
  tokens_per_sec?: number | null;
  tokens: number;
  cost_usd?: number;
  timestamp: string;
};

export type MetricsPage = {
  run_id: string;
  status: RunStatus;
  data: Array<MetricPoint>;
  next_cursor: string | null;
};

export type PlanEvalRequest = {
  name?: string;
  models: Array<string>;
  baseline?: string;
  dataset?: string;
  dataset_version?: number;
  env_name?: string;
  tasks?: Array<Record<string, unknown>>;
  benchmarks?: Array<BenchmarkSpec>;
  rubric?: Array<EvalRubricItem>;
  samples?: number;
  temperature?: number;
  max_tokens?: number;
  limit?: number;
  pass_threshold?: number | null;
  max_cost_usd?: number;
};

export type PlanEvalResponse = {
  task_source_kind: "dataset";
  dataset_version: number;
  estimated_tasks: number;
  estimated_model_calls: number;
  estimated_judge_calls: number;
  estimated_cost_usd: number;
  judge_models: Array<string>;
  local_scorers: Array<string>;
  pass_threshold: number;
  warnings: Array<string>;
};

export type PlanRunRequest = {
  dataset: string;
  name: string;
  recipe: RecipeSpec;
  split?: SplitSpec;
  max_cost_usd?: number;
};

export type PlanRunResponse = {
  resolved_config: ResolvedRunConfig;
  dataset_version: number;
  usable_records: number;
  total_records: number;
  estimated_steps: number;
  estimated_tokens: number;
  estimated_cost_usd: number;
  price_per_million_tokens: number;
  trained_token_fraction: number;
  warnings: Array<string>;
};

export type PostEvalScoresRequest = {
  scores: Array<{
  output_id: string;
  scorer: string;
  score: number;
}>;
};

export type PostEvalScoresResponse = {
  accepted: number;
  status: EvalStatus;
  pending_local_scores: number;
};

export type PostImportRecordsRequest = {
  worker_id: string;
  attempt: number;
  records: Array<unknown>;
};

export type PostImportRecordsResponse = {
  accepted: number;
  rejected: number;
  errors: Array<{
  index: number;
  error: string;
}>;
};

export type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  request_id: string;
};

export type PromoteCheckpointRequest = {
  name?: string;
};

export type PushDatasetRequest = {
  records: Array<DatasetRecord>;
  metadata?: Record<string, unknown>;
};

export type RecipeKind = "sft" | "dpo" | "router" | "decision" | "cartridge" | "embedding" | "distill" | "reward" | "grpo";

export type RecipeSpec = {
  kind: RecipeKind;
  model?: string;
  adapter?: AdapterSpec;
  lr?: "auto" | number;
  lr_scale?: number;
  batch_size?: number;
  epochs?: number;
  schedule?: "linear" | "cosine" | "constant";
  warmup?: number;
  train_on?: "last" | "all_assistant";
  thinking?: "auto" | "on" | "off";
  preserve_thinking?: boolean;
  reduction?: "per_example" | "per_token";
  select?: "best" | "last";
  checkpoint_ttl_days?: number;
  beta?: number;
  models?: Array<string>;
  max_quality_drop?: number;
  context_text?: string;
  context_uri?: string;
  num_tokens?: number;
  temp?: number;
  teacher?: string;
  env_name?: string;
  group_size?: number;
};

export type RecordFeedbackRequest = {
  events: Array<FeedbackEventInput>;
};

export type RecordFeedbackResponse = {
  accepted: number;
  deduplicated: number;
  records: Array<FeedbackRecord>;
};

export type RegisterTrainerCheckpointRequest = {
  worker_id: string;
  attempt: number;
  step: number;
  eval_score?: number | null;
  upload_id: string;
  format?: ArtifactFormat;
  metadata?: Record<string, unknown>;
};

export type RenderDatasetRequest = {
  model?: string;
  train_on?: "last" | "all_assistant";
  thinking?: "auto" | "on" | "off";
  preserve_thinking?: boolean;
  limit?: number;
};

export type RenderDatasetResponse = {
  dataset: string;
  model: string;
  template_revision: string;
  token_counts: "estimated";
  examples: Array<{
  record_id: string;
  template_revision: string;
  total_tokens: number;
  trained_tokens: number;
  trained_fraction: number;
  spans: Array<{
  text: string;
  trained: boolean;
  tokens: number;
}>;
}>;
};

export type ReportTrainerProgressRequest = {
  worker_id: string;
  attempt: number;
  metric: MetricPointInput;
};

export type ReportTrainerProgressResponse = {
  status: RunStatus;
  should_stop: boolean;
  stop_reason: "cancelled" | "budget" | null;
  cost_usd: number;
};

export type ResolvedRunConfig = {
  rule_version: string;
  dataset: string;
  dataset_version: number;
  name: string;
  recipe_kind: RecipeKind;
  model: string;
  template_revision: string;
  adapter: {
  kind: "lora";
  rank?: number;
  alpha?: number;
  merge_on_export?: boolean;
} | {
  kind: "prefix_kv";
  num_tokens?: number;
} | {
  kind: "frozen_head";
} | {
  kind: "encoder_full";
};
  lr: number;
  lr_source: string;
  batch_size: number;
  epochs: number;
  schedule: "linear" | "cosine" | "constant";
  warmup: number;
  train_on: "last" | "all_assistant";
  thinking: "auto" | "on" | "off";
  preserve_thinking: boolean;
  reduction: "per_example" | "per_token";
  select: "best" | "last";
  checkpoint_every_steps: number;
  checkpoint_ttl_days: number;
  split: {
  strategy: "by_session" | "by_group" | "random";
  eval_fraction: number;
  seed: number;
  train_records: number;
  eval_records: number;
};
  recipe_params: Record<string, unknown>;
};

export type ResumeRunRequest = {
  max_cost_usd?: number;
};

export type RouteRequest = {
  deployment: string;
  messages: Array<ChatMessage>;
  tools?: Array<Record<string, unknown>>;
  session_id?: string;
};

export type RouteResponse = {
  inference_id: string;
  deployment: string;
  artifact_id: string;
  model: string;
  is_exploration: boolean;
  confidence: number;
  scores: Record<string, number>;
};

export type Run = {
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
  tokens_processed: number;
  cost_usd: number;
  current_step: number;
  total_steps: number;
  attempt: number;
  max_attempts: number;
  latest_metric: MetricPoint;
  eval_report: Record<string, unknown> | null;
  artifact_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
};

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "stopped_budget";

export type SplitSpec = {
  strategy?: "by_session" | "by_group" | "random";
  eval_fraction?: number;
  seed?: number;
};

export type TrainableModel = {
  id: string;
  hf_repo: string | null;
  family: "llm" | "encoder";
  adapters: Array<"lora" | "prefix_kv" | "frozen_head" | "encoder_full">;
  recipes: Array<RecipeKind>;
  default_for: Array<RecipeKind>;
  price_per_million_tokens_usd: number;
  max_context_tokens: number;
  template_revision: string;
  calibrated_lrs: Record<string, number>;
};

export type TrainerHeartbeatRequest = {
  worker_id: string;
  attempt: number;
  lease_seconds?: number;
};

export type TrainerHeartbeatResponse = {
  status: string;
  should_stop: boolean;
  stop_reason: "cancelled" | "budget" | null;
  lease_expires_at: string;
};

export type TrainerJob = {
  id: string;
  kind: JobKind;
  attempt: number;
  lease_seconds: number;
  lease_expires_at: string;
  run: {
  id: string;
  workspace_id: string;
  name: string;
  recipe_kind: RecipeKind;
  resolved_config: ResolvedRunConfig;
  total_steps: number;
} | null;
  import: {
  id: string;
  workspace_id: string;
  dataset: string;
  source: Record<string, unknown>;
  connector: "auto" | "grad_trajectories" | "openai_chat" | "gradiated" | "otel" | "langfuse" | "posthog" | "braintrust" | "langsmith";
} | null;
  price_per_million_tokens: number | null;
  max_cost_usd: number | null;
  dataset: {
  version: number;
  record_count: number;
  download_url: string;
} | null;
  resume: {
  checkpoint_id: string;
  step: number;
  download_url: string;
} | null;
} | null;

export type TrainerQueueStats = {
  queued: number;
  running: number;
  total: number;
  by_kind: {
  train: {
  queued: number;
  running: number;
};
  import: {
  queued: number;
  running: number;
};
};
};

export type TrainerUploadRequest = {
  worker_id: string;
  attempt: number;
  kind: "checkpoint" | "artifact";
  sha256: string;
  size_bytes: number;
};

export type TrajectoryInput = {
  messages?: Array<ChatMessage>;
  tools?: Array<Record<string, unknown>>;
  media?: Array<Record<string, unknown>>;
  features?: Record<string, unknown>;
  payload?: unknown;
};

export type TrajectoryOutput = {
  turns?: Array<ChatMessage>;
  payload?: unknown;
} | null;

export type UploadTicket = {
  upload_id: string;
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expires_at: string;
};

export class GradApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly requestId: string;

  constructor(problem: {
    status: number;
    code?: string;
    title?: string;
    detail?: string;
    request_id?: string;
  }) {
    super(`[${problem.status}] ${problem.code ?? "api_error"}: ${problem.detail ?? problem.title ?? "Request failed"}`);
    this.name = "GradApiError";
    this.status = problem.status;
    this.code = problem.code ?? "api_error";
    this.title = problem.title ?? "API Error";
    this.detail = problem.detail ?? "";
    this.requestId = problem.request_id ?? "";
  }
}

export interface GeneratedClientOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class GeneratedApiClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeneratedClientOptions) {
    const parsed = new URL(options.baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Unsupported baseUrl protocol: ${parsed.protocol}`);
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  private buildUrl(
    routePath: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): string {
    const url = new URL(`${this.baseUrl}${routePath}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  private async send(
    routePath: string,
    options: {
      method: string;
      body?: Record<string, unknown> | undefined;
      query?: Record<string, string | number | boolean | undefined> | undefined;
    },
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await this.fetchImpl(this.buildUrl(routePath, options.query), {
      method: options.method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    if (!response.ok) {
      const text = await response.text();
      let problem: Record<string, unknown> = { status: response.status, detail: text };
      try {
        problem = JSON.parse(text) as Record<string, unknown>;
      } catch {
        // Non-JSON proxy/gateway error body; keep raw text fallback.
      }
      throw new GradApiError({
        status: Number(problem.status ?? response.status),
        ...(typeof problem.code === "string" ? { code: problem.code } : {}),
        ...(typeof problem.title === "string" ? { title: problem.title } : {}),
        ...(typeof problem.detail === "string" ? { detail: problem.detail } : {}),
        ...(typeof problem.request_id === "string"
          ? { request_id: problem.request_id }
          : {}),
      });
    }

    return response;
  }

  protected async requestJson(
    routePath: string,
    options: {
      method: string;
      body?: Record<string, unknown> | undefined;
      query?: Record<string, string | number | boolean | undefined> | undefined;
    },
  ): Promise<Record<string, unknown>> {
    const response = await this.send(routePath, options);
    if (response.status === 204 || response.status === 205) return {};
    const text = await response.text();
    if (!text.trim()) return {};
    return JSON.parse(text) as Record<string, unknown>;
  }

  protected async requestBytes(
    routePath: string,
    options: {
      method: string;
      body?: Record<string, unknown> | undefined;
      query?: Record<string, string | number | boolean | undefined> | undefined;
    },
  ): Promise<{ bytes: Uint8Array; headers: Headers }> {
    const response = await this.send(routePath, options);
    const buf = new Uint8Array(await response.arrayBuffer());
    return { bytes: buf, headers: response.headers };
  }

  /** Cancel a queued, running or awaiting_scores evaluation */
  cancelEval(id: string): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/evals/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }

  /** Cancel a training run (a running attempt is stopped and billed) */
  cancelRun(id: string): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }

  /** Long-poll for the next task assigned to a `grad env serve` worker */
  claimEnvTask(name: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/env-workers/${encodeURIComponent(name)}/claim`, { method: "POST", body });
  }

  /** Claim the next queued train or import job (trainer:worker) */
  claimTrainerJob(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/trainer-jobs/claim`, { method: "POST", body });
  }

  /** Submit scored trajectory output for an environment task */
  completeEnvTask(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/env-workers/tasks/${encodeURIComponent(id)}/complete`, { method: "POST", body });
  }

  /** Finish a job attempt: publish its artifact, bill it, release the lease */
  completeTrainerJob(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/trainer-jobs/${encodeURIComponent(id)}/complete`, { method: "POST", body });
  }

  /** Create a scoped workspace API key (trainer worker keys are platform config, not keys) */
  createApiKey(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/keys`, { method: "POST", body });
  }

  /** Create an empty dataset */
  createDataset(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/datasets`, { method: "POST", body });
  }

  /** Import an uploaded file or a Hugging Face dataset into a dataset (async job) */
  createDatasetImport(name: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/datasets/${encodeURIComponent(name)}/imports`, { method: "POST", body });
  }

  /** Generate embeddings from a deployed embedding artifact */
  createEmbeddings(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/embeddings`, { method: "POST", body });
  }

  /** Queue an evaluation across models on a pinned dataset version (executed by the server) */
  createEval(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/evals`, { method: "POST", body });
  }

  /** Create and enqueue a training run (pins the dataset version) */
  createRun(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/runs`, { method: "POST", body });
  }

  /** Get an upload URL for a checkpoint or artifact bundle */
  createTrainerUpload(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/trainer-jobs/${encodeURIComponent(id)}/uploads`, { method: "POST", body });
  }

  /** Get an upload URL for a file to import (PUT the bytes, then create an import) */
  createUpload(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/uploads`, { method: "POST", body });
  }

  /** Deploy or update an artifact under a stable model name */
  deployArtifact(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/deployments`, { method: "POST", body });
  }

  /** Dispatch an evaluation or rollout task to a connected `grad env serve` worker */
  dispatchEnvTask(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/env-workers/tasks`, { method: "POST", body });
  }

  /** Download an artifact bundle (.grad.tar.gz); verify X-Artifact-Sha256 */
  downloadArtifact(id: string): Promise<{ bytes: Uint8Array; headers: Headers }> {
    return this.requestBytes(`/v1/artifacts/${encodeURIComponent(id)}/download`, { method: "GET" });
  }

  /** Stream the pinned dataset version of a claimed train job as JSONL */
  downloadTrainerDataset(id: string, query?: { attempt?: string | number | boolean }): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/trainer-jobs/${encodeURIComponent(id)}/dataset`, { method: "GET", query });
  }

  /** Get an artifact by id or name@latest */
  getArtifact(id: string): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/artifacts/${encodeURIComponent(id)}`, { method: "GET" });
  }

  /** Get a dataset by name */
  getDataset(name: string): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/datasets/${encodeURIComponent(name)}`, { method: "GET" });
  }

  /** Get deployment status and feedback summary */
  getDeployment(name: string): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/deployments/${encodeURIComponent(name)}`, { method: "GET" });
  }

  /** Inspect an environment task and its result */
  getEnvTask(id: string): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/env-workers/tasks/${encodeURIComponent(id)}`, { method: "GET" });
  }

  /** Get an evaluation run by ID */
  getEval(id: string): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/evals/${encodeURIComponent(id)}`, { method: "GET" });
  }

  /** Get a dataset import job */
  getImport(id: string): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/imports/${encodeURIComponent(id)}`, { method: "GET" });
  }

  /** Get a training run */
  getRun(id: string): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/runs/${encodeURIComponent(id)}`, { method: "GET" });
  }

  /** Queue depth for autoscaling: queued plus running jobs (trainer:worker) */
  getTrainerQueueStats(): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/trainer-jobs/queue`, { method: "GET" });
  }

  /** Renew the job lease; reports whether the worker should stop */
  heartbeatTrainerJob(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/trainer-jobs/${encodeURIComponent(id)}/heartbeat`, { method: "POST", body });
  }

  /** List workspace API keys */
  listApiKeys(query?: { limit?: string | number | boolean; cursor?: string | number | boolean }): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/keys`, { method: "GET", query });
  }

  /** List immutable artifacts (newest first) */
  listArtifacts(query?: { limit?: string | number | boolean; cursor?: string | number | boolean; name?: string | number | boolean }): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/artifacts`, { method: "GET", query });
  }

  /** Read records of a dataset version */
  listDatasetRecords(name: string, query?: { version?: string | number | boolean; limit?: string | number | boolean; cursor?: string | number | boolean }): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/datasets/${encodeURIComponent(name)}/records`, { method: "GET", query });
  }

  /** List datasets (newest first) */
  listDatasets(query?: { limit?: string | number | boolean; cursor?: string | number | boolean }): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/datasets`, { method: "GET", query });
  }

  /** List deployments */
  listDeployments(query?: { limit?: string | number | boolean; cursor?: string | number | boolean }): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/deployments`, { method: "GET", query });
  }

  /** List failing task records from an evaluation run for mining */
  listEvalFailures(id: string, query?: { limit?: string | number | boolean; cursor?: string | number | boolean; model?: string | number | boolean; threshold?: string | number | boolean }): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/evals/${encodeURIComponent(id)}/failures`, { method: "GET", query });
  }

  /** Page through generated model outputs (filter by model or by a code scorer that still needs a score) */
  listEvalOutputs(id: string, query?: { limit?: string | number | boolean; cursor?: string | number | boolean; model?: string | number | boolean; missing_scorer?: string | number | boolean }): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/evals/${encodeURIComponent(id)}/outputs`, { method: "GET", query });
  }

  /** Per-task, per-model results of a completed evaluation */
  listEvalResults(id: string, query?: { limit?: string | number | boolean; cursor?: string | number | boolean; model?: string | number | boolean }): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/evals/${encodeURIComponent(id)}/results`, { method: "GET", query });
  }

  /** List evaluation runs */
  listEvals(query?: { limit?: string | number | boolean; cursor?: string | number | boolean }): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/evals`, { method: "GET", query });
  }

  /** List dataset import jobs (newest first) */
  listImports(query?: { limit?: string | number | boolean; cursor?: string | number | boolean }): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/imports`, { method: "GET", query });
  }

  /** List trainable base models (the server catalog and price source) */
  listModels(): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/models`, { method: "GET" });
  }

  /** List unexpired checkpoints of a run (best and final never expire) */
  listRunCheckpoints(id: string, query?: { limit?: string | number | boolean; cursor?: string | number | boolean }): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/runs/${encodeURIComponent(id)}/checkpoints`, { method: "GET", query });
  }

  /** Training step metrics as JSON pages, or a live SSE stream */
  listRunMetrics(id: string, query?: { cursor?: string | number | boolean; after_step?: string | number | boolean; limit?: string | number | boolean }): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/runs/${encodeURIComponent(id)}/metrics`, { method: "GET", query });
  }

  /** List training runs (newest first) */
  listRuns(query?: { limit?: string | number | boolean; cursor?: string | number | boolean }): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/runs`, { method: "GET", query });
  }

  /** Estimate tasks, model/judge calls, and cost before running an eval */
  planEval(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/evals/plan`, { method: "POST", body });
  }

  /** Dry-run a training recipe at zero cost */
  planRun(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/runs/plan`, { method: "POST", body });
  }

  /** Post scores computed by local (SDK-side) code scorers; the eval completes when none are missing */
  postEvalScores(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/evals/${encodeURIComponent(id)}/scores`, { method: "POST", body });
  }

  /** Append a batch of parsed records to an import job */
  postImportRecords(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/trainer-jobs/${encodeURIComponent(id)}/records`, { method: "POST", body });
  }

  /** Copy an exportable checkpoint into a new immutable artifact */
  promoteCheckpoint(id: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/checkpoints/${encodeURIComponent(id)}/promote`, { method: "POST", body });
  }

  /** Append records as a new dataset version (creates the dataset if needed) */
  pushDatasetRecords(name: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/datasets/${encodeURIComponent(name)}/records`, { method: "POST", body });
  }

  /** Record deduplicated outcome scores and gold corrections */
  recordFeedback(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/feedback`, { method: "POST", body });
  }

  /** Register or heartbeat an outbound `grad env serve` worker */
  registerEnvWorker(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/env-workers/register`, { method: "POST", body });
  }

  /** Register an uploaded checkpoint bundle */
  registerTrainerCheckpoint(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/trainer-jobs/${encodeURIComponent(id)}/checkpoints`, { method: "POST", body });
  }

  /** Preview chat-template rendering and loss masks (estimated token counts) */
  renderDataset(name: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/datasets/${encodeURIComponent(name)}/render`, { method: "POST", body });
  }

  /** Report one training step's metrics */
  reportTrainerProgress(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/trainer-jobs/${encodeURIComponent(id)}/progress`, { method: "POST", body });
  }

  /** Resume a stopped, failed or cancelled run from its latest checkpoint */
  resumeRun(id: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/runs/${encodeURIComponent(id)}/resume`, { method: "POST", body });
  }

  /** Revoke a workspace API key */
  revokeApiKey(id: string): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** Roll a deployment back to its previous artifact */
  rollbackDeployment(name: string): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/deployments/${encodeURIComponent(name)}/rollback`, { method: "POST" });
  }

  /** Ask a deployed model router which model to call */
  routeRequest(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/route`, { method: "POST", body });
  }
}
