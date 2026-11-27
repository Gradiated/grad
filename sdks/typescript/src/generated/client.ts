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

export type ApiKeyScope = "admin" | "datasets:read" | "datasets:write" | "runs:read" | "runs:write" | "artifacts:read" | "artifacts:write" | "deployments:write" | "feedback:write" | "env:serve" | "trainer:worker";

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
  storage_key: string;
  sha256: string;
  size_bytes: number;
  manifest: Record<string, unknown>;
  eval_report: Record<string, unknown> | null;
  created_at: string;
};

export type ArtifactFormat = "peft_lora" | "cartridge" | "encoder_safetensors" | "router_bundle" | "decision_bundle";

export type BenchmarkSpec = {
  name: "ifeval" | "gsm8k" | "mmlu-pro" | "gpqa-diamond" | "humaneval" | "livecodebench";
  limit?: number;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<Record<string, unknown>>;
  tool_call_id?: string;
  name?: string;
  train?: boolean;
};

export type Checkpoint = {
  id: string;
  workspace_id: string;
  run_id: string;
  step: number;
  eval_score: number | null;
  storage_key: string;
  sha256: string;
  size_bytes: number;
  metadata: Record<string, unknown>;
  expires_at: string | null;
  created_at: string;
};

export type ClaimJobRequest = {
  worker_id: string;
  lease_seconds?: number;
};

export type CompleteRunRequest = {
  worker_id: string;
  status: "completed" | "failed" | "stopped_budget";
  format?: ArtifactFormat;
  artifact_base64?: string;
  manifest?: Record<string, unknown>;
  eval_report?: Record<string, unknown>;
  tokens_processed?: number;
  cost_usd?: number;
  error?: string;
};

export type CreateApiKeyRequest = {
  name: string;
  scopes: Array<ApiKeyScope>;
};

export type Dataset = {
  id: string;
  workspace_id: string;
  name: string;
  record_count: number;
  storage_key: string;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type DatasetRecord = {
  id?: string;
  session_id?: string;
  group_id?: string;
  messages?: Array<ChatMessage>;
  tools?: Array<Record<string, unknown>>;
  prompt?: string | Array<ChatMessage>;
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
  tokens_per_task: number;
  cost_per_1k_tasks_usd: number;
};

export type EvalRubricItem = {
  name: string;
  kind: "regex" | "validator" | "code" | "judge";
  weight?: number;
  pattern?: string;
  validator?: "json" | "non_empty" | "exact_match";
  model?: string;
  prompt?: string;
};

export type EvalRun = {
  id: string;
  workspace_id: string;
  name: string;
  status: "completed" | "failed";
  models: Array<string>;
  baseline: string | null;
  task_source: Record<string, unknown>;
  rubric: Array<EvalRubricItem>;
  samples: number;
  pass_threshold: number;
  judge_models: Array<string>;
  summary: Array<EvalModelSummary>;
  results: Array<EvalTaskOutcome>;
  total_cost_usd: number;
  created_at: string;
};

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

export type MetricPoint = {
  step: number;
  loss: number;
  eval_loss?: number;
  eval_metric?: number;
  grad_norm?: number;
  lr?: number;
  tokens_per_sec?: number;
  tokens: number;
  cost_usd: number;
  timestamp: string;
};

export type PlanEvalRequest = {
  name?: string;
  models: Array<string>;
  baseline?: string;
  dataset?: string;
  env_name?: string;
  tasks?: Array<Record<string, unknown>>;
  benchmarks?: Array<BenchmarkSpec>;
  rubric?: Array<EvalRubricItem>;
  samples?: number;
  pass_threshold?: number;
  max_cost_usd?: number;
};

export type PlanEvalResponse = {
  task_source_kind: "dataset" | "env" | "benchmarks";
  estimated_tasks: number;
  estimated_model_calls: number;
  estimated_judge_calls: number;
  estimated_cost_usd: number;
  judge_models: Array<string>;
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
  estimated_steps: number;
  estimated_tokens: number;
  estimated_cost_usd: number;
  trained_token_fraction: number;
  warnings: Array<string>;
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

export type RegisterCheckpointRequest = {
  worker_id: string;
  step: number;
  eval_score?: number | null;
  payload_base64: string;
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

export type ReportRunProgress = {
  worker_id: string;
  metric: MetricPoint;
  lease_seconds?: number;
};

export type ResolvedRunConfig = {
  rule_version: string;
  dataset: string;
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
  recipe_kind: RecipeKind;
  status: RunStatus;
  resolved_config: ResolvedRunConfig;
  max_cost_usd: number | null;
  tokens_processed: number;
  cost_usd: number;
  current_step: number;
  total_steps: number;
  metrics_history: Array<MetricPoint>;
  eval_report: Record<string, unknown> | null;
  artifact_id: string | null;
  error: string | null;
  worker_id: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export type RunStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled" | "stopped_budget";

export type SplitSpec = {
  strategy?: "by_session" | "by_group" | "random";
  eval_fraction?: number;
  seed?: number;
};

export type TrainableModel = {
  id: string;
  adapters: Array<string>;
  default_for: Array<RecipeKind>;
  price_per_million_tokens_usd: number;
  max_context_tokens: number;
  template_revision: string;
  calibrated_lrs: Record<string, number>;
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

  /** Cancel a training run */
  cancelRun(id: string): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
  }

  /** Long-poll for the next task assigned to a `grad env serve` worker */
  claimEnvTask(name: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/env-workers/${encodeURIComponent(name)}/claim`, { method: "POST", body });
  }

  /** Claim the next queued training run for execution */
  claimTrainerJob(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/trainer-jobs/claim`, { method: "POST", body });
  }

  /** Submit scored trajectory output for an environment task */
  completeEnvTask(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/env-workers/tasks/${encodeURIComponent(id)}/complete`, { method: "POST", body });
  }

  /** Finish a training run and publish its immutable artifact */
  completeTrainerJob(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/trainer-jobs/${encodeURIComponent(id)}/complete`, { method: "POST", body });
  }

  /** Create a scoped API key */
  createApiKey(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/keys`, { method: "POST", body });
  }

  /** Generate embeddings from a deployed embedding artifact */
  createEmbeddings(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/embeddings`, { method: "POST", body });
  }

  /** Run a standalone evaluation across models, tasks, and a rubric */
  createEval(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/evals`, { method: "POST", body });
  }

  /** Create and enqueue a training run */
  createRun(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/runs`, { method: "POST", body });
  }

  /** Deploy or update an artifact under a stable model name */
  deployArtifact(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/deployments`, { method: "POST", body });
  }

  /** Dispatch an evaluation or rollout task to a connected `grad env serve` worker */
  dispatchEnvTask(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/env-workers/tasks`, { method: "POST", body });
  }

  /** Download an artifact archive */
  downloadArtifact(id: string): Promise<{ bytes: Uint8Array; headers: Headers }> {
    return this.requestBytes(`/v1/artifacts/${encodeURIComponent(id)}/download`, { method: "GET" });
  }

  /** Get an artifact by ID or name@latest */
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

  /** Get a training run */
  getRun(id: string): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/runs/${encodeURIComponent(id)}`, { method: "GET" });
  }

  /** List scoped API keys */
  listApiKeys(): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/keys`, { method: "GET" });
  }

  /** List immutable artifacts */
  listArtifacts(query?: { name?: string | number | boolean }): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/artifacts`, { method: "GET", query });
  }

  /** Read records from a dataset */
  listDatasetRecords(name: string, query?: { limit?: string | number | boolean; offset?: string | number | boolean }): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/datasets/${encodeURIComponent(name)}/records`, { method: "GET", query });
  }

  /** List datasets */
  listDatasets(): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/datasets`, { method: "GET" });
  }

  /** List active deployments */
  listDeployments(): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/deployments`, { method: "GET" });
  }

  /** List failing task records from an evaluation run for mining */
  listEvalFailures(id: string, query?: { model?: string | number | boolean; threshold?: string | number | boolean }): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/evals/${encodeURIComponent(id)}/failures`, { method: "GET", query });
  }

  /** List evaluation runs */
  listEvals(): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/evals`, { method: "GET" });
  }

  /** List trainable base models */
  listModels(): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/models`, { method: "GET" });
  }

  /** List checkpoints saved during a run */
  listRunCheckpoints(id: string): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/runs/${encodeURIComponent(id)}/checkpoints`, { method: "GET" });
  }

  /** Fetch training step metrics for a run */
  listRunMetrics(id: string, query?: { after_step?: string | number | boolean }): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/runs/${encodeURIComponent(id)}/metrics`, { method: "GET", query });
  }

  /** List training runs */
  listRuns(): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/runs`, { method: "GET" });
  }

  /** Estimate tasks, model/judge calls, and cost before running an eval */
  planEval(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/evals/plan`, { method: "POST", body });
  }

  /** Dry-run a training recipe at zero cost */
  planRun(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/runs/plan`, { method: "POST", body });
  }

  /** Promote an intermediate checkpoint into a permanent artifact */
  promoteCheckpoint(id: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/checkpoints/${encodeURIComponent(id)}/promote`, { method: "POST", body });
  }

  /** Create or append records to a dataset */
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

  /** Upload and register an intermediate checkpoint */
  registerTrainerCheckpoint(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/trainer-jobs/${encodeURIComponent(id)}/checkpoints`, { method: "POST", body });
  }

  /** Preview chat template rendering and loss masks */
  renderDataset(name: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/datasets/${encodeURIComponent(name)}/render`, { method: "POST", body });
  }

  /** Report training step metrics and renew worker lease */
  reportTrainerProgress(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/trainer-jobs/${encodeURIComponent(id)}/progress`, { method: "POST", body });
  }

  /** Resume a stopped or failed training run */
  resumeRun(id: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/runs/${encodeURIComponent(id)}/resume`, { method: "POST", body });
  }

  /** Revoke a scoped API key */
  revokeApiKey(id: string): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** Ask a deployed model router which model to call */
  routeRequest(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.requestJson(`/v1/route`, { method: "POST", body });
  }
}
