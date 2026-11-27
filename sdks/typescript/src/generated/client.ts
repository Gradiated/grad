// AUTO-GENERATED from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.
/* eslint-disable */
import {
  convertKeys,
  encodePathParam,
  type CodecTable,
  type RawResponse,
  type RequestOptions,
  type ServerSentEvent,
  type SSEOptions,
  type StreamOptions,
  type TransportLike,
} from "./transport.js";
import type {
  ApiKey,
  Artifact,
  Checkpoint,
  ClaimJobRequest,
  ClaimJobResponse,
  CompleteTrainerJobRequest,
  CompleteTrainerJobResponse,
  CreateApiKeyRequest,
  CreateDatasetRequest,
  CreateImportRequest,
  CreateUploadRequest,
  CreatedApiKey,
  Dataset,
  DatasetRecordsPage,
  DeployArtifactRequest,
  Deployment,
  DeploymentStatus,
  EmbedRequest,
  EmbedResponse,
  EnvTaskDispatch,
  EnvTaskResult,
  EnvWorkerRegister,
  EvalOutput,
  EvalRun,
  EvalTaskOutcome,
  ImportJob,
  MetricsPage,
  PlanEvalRequest,
  PlanEvalResponse,
  PlanRunRequest,
  PlanRunResponse,
  PostEvalScoresRequest,
  PostEvalScoresResponse,
  PostImportRecordsRequest,
  PostImportRecordsResponse,
  PromoteCheckpointRequest,
  PushDatasetRequest,
  RecordFeedbackRequest,
  RecordFeedbackResponse,
  RegisterTrainerCheckpointRequest,
  RenderDatasetRequest,
  RenderDatasetResponse,
  ReportTrainerProgressRequest,
  ReportTrainerProgressResponse,
  ResumeRunRequest,
  RouteRequest,
  RouteResponse,
  Run,
  TrainableModel,
  TrainerHeartbeatRequest,
  TrainerHeartbeatResponse,
  TrainerQueueStats,
  TrainerUploadRequest,
  UploadTicket,
} from "./models.js";

/** Which wire keys are renamed to camelCase, per schema (user-keyed maps are left verbatim). */
export const CODEC: CodecTable = {
  "AdapterSpec": { u: { o: { o: [["mergeOnExport", "merge_on_export", 0], ["numTokens", "num_tokens", 0]] } } },
  "ApiKey": { o: [["workspaceId", "workspace_id", 0], ["createdAt", "created_at", 0], ["revokedAt", "revoked_at", 0]] },
  "Artifact": { o: [["workspaceId", "workspace_id", 0], ["runId", "run_id", 0], ["checkpointId", "checkpoint_id", 0], ["baseModel", "base_model", 0], ["recipeKind", "recipe_kind", 0], ["sizeBytes", "size_bytes", 0], ["evalReport", "eval_report", 0], ["createdAt", "created_at", 0]] },
  "BaseArtifact": { o: [["recipeKind", "recipe_kind", 0]] },
  "ChatMessage": { o: [["toolCalls", "tool_calls", 0], ["toolCallId", "tool_call_id", 0]] },
  "Checkpoint": { o: [["workspaceId", "workspace_id", 0], ["runId", "run_id", 0], ["evalScore", "eval_score", 0], ["sizeBytes", "size_bytes", 0], ["expiresAt", "expires_at", 0], ["createdAt", "created_at", 0]] },
  "ClaimJobRequest": { o: [["workerId", "worker_id", 0], ["leaseSeconds", "lease_seconds", 0]] },
  "ClaimJobResponse": { o: [["job", "job", "TrainerJob"]] },
  "CompleteTrainerJobRequest": { o: [["workerId", "worker_id", 0], ["uploadId", "upload_id", 0], ["evalReport", "eval_report", 0], ["tokensProcessed", "tokens_processed", 0], ["importSummary", "import_summary", { o: [["droppedCount", "dropped_count", 0], ["detectedScores", "detected_scores", 0], ["dropReasons", "drop_reasons", 0]] }]] },
  "CompleteTrainerJobResponse": { o: [["jobId", "job_id", 0], ["run", "run", "Run"], ["artifact", "artifact", "Artifact"], ["import", "import", "ImportJob"]] },
  "CreateImportRequest": { o: [["source", "source", "ImportSource"]] },
  "CreateUploadRequest": { o: [["sizeBytes", "size_bytes", 0]] },
  "CreatedApiKey": { o: [["key", "key", "ApiKey"]] },
  "Dataset": { o: [["workspaceId", "workspace_id", 0], ["recordCount", "record_count", 0], ["createdAt", "created_at", 0], ["updatedAt", "updated_at", 0]] },
  "DatasetRecord": { o: [["sessionId", "session_id", 0], ["groupId", "group_id", 0], ["messages", "messages", { a: "ChatMessage" }], ["input", "input", "TrajectoryInput"], ["output", "output", "TrajectoryOutput"], ["prompt", "prompt", { u: { a: { a: "ChatMessage" } } }], ["completion", "completion", { u: { a: { a: "ChatMessage" } } }], ["chosen", "chosen", { u: { a: { a: "ChatMessage" } } }], ["rejected", "rejected", { u: { a: { a: "ChatMessage" } } }], ["expectedOutput", "expected_output", 0]] },
  "DatasetRecordsPage": { o: [["data", "data", { a: "DatasetRecord" }], ["nextCursor", "next_cursor", 0]] },
  "DeployArtifactRequest": { o: [["exploreRate", "explore_rate", 0]] },
  "Deployment": { o: [["workspaceId", "workspace_id", 0], ["modelId", "model_id", 0], ["activeArtifactId", "active_artifact_id", 0], ["previousArtifactId", "previous_artifact_id", 0], ["fallbackModel", "fallback_model", 0], ["exploreRate", "explore_rate", 0], ["createdAt", "created_at", 0], ["updatedAt", "updated_at", 0]] },
  "DeploymentStatus": { o: [["deployment", "deployment", "Deployment"], ["feedbackCount", "feedback_count", 0], ["averageScore", "average_score", 0]] },
  "EmbedResponse": { o: [["usage", "usage", { o: [["promptTokens", "prompt_tokens", 0], ["totalTokens", "total_tokens", 0]] }]] },
  "EnvTaskDispatch": { o: [["envName", "env_name", 0], ["modelId", "model_id", 0], ["systemPrompt", "system_prompt", 0], ["timeoutS", "timeout_s", 0]] },
  "EnvTaskResult": { o: [["workerId", "worker_id", 0]] },
  "EnvWorkerRegister": { o: [["workerId", "worker_id", 0]] },
  "EvalModelSummary": { o: [["ciLow", "ci_low", 0], ["ciHigh", "ci_high", 0], ["passAtK", "pass_at_k", 0], ["vsBaseline", "vs_baseline", { o: [["ciLow", "ci_low", 0], ["ciHigh", "ci_high", 0]] }], ["tokensPerTask", "tokens_per_task", 0], ["costPer1kTasksUsd", "cost_per_1k_tasks_usd", 0]] },
  "EvalOutput": { o: [["evalId", "eval_id", 0], ["taskId", "task_id", 0], ["sampleIndex", "sample_index", 0], ["input", "input", { a: "ChatMessage" }], ["expectedOutput", "expected_output", 0], ["record", "record", "DatasetRecord"], ["usage", "usage", { o: [["promptTokens", "prompt_tokens", 0], ["completionTokens", "completion_tokens", 0]] }]] },
  "EvalRun": { o: [["workspaceId", "workspace_id", 0], ["taskSource", "task_source", 0], ["maxTokens", "max_tokens", 0], ["passThreshold", "pass_threshold", 0], ["judgeModels", "judge_models", 0], ["localScorers", "local_scorers", 0], ["progress", "progress", { o: [["totalOutputs", "total_outputs", 0], ["pendingLocalScores", "pending_local_scores", 0]] }], ["summary", "summary", { a: "EvalModelSummary" }], ["totalCostUsd", "total_cost_usd", 0], ["createdAt", "created_at", 0], ["updatedAt", "updated_at", 0], ["completedAt", "completed_at", 0]] },
  "EvalTaskOutcome": { o: [["taskId", "task_id", 0], ["sampleScores", "sample_scores", 0], ["judgeModel", "judge_model", 0], ["record", "record", "DatasetRecord"]] },
  "FeedbackEventInput": { o: [["inferenceId", "inference_id", 0], ["sessionId", "session_id", 0], ["deploymentName", "deployment_name", 0], ["idempotencyKey", "idempotency_key", 0], ["expectedOutput", "expected_output", 0]] },
  "FeedbackRecord": { o: [["workspaceId", "workspace_id", 0], ["inferenceId", "inference_id", 0], ["sessionId", "session_id", 0], ["deploymentName", "deployment_name", 0], ["idempotencyKey", "idempotency_key", 0], ["expectedOutput", "expected_output", 0], ["createdAt", "created_at", 0]] },
  "ImportJob": { o: [["workspaceId", "workspace_id", 0], ["importedCount", "imported_count", 0], ["droppedCount", "dropped_count", 0], ["detectedScores", "detected_scores", 0], ["dropReasons", "drop_reasons", 0], ["datasetVersion", "dataset_version", 0], ["createdAt", "created_at", 0], ["updatedAt", "updated_at", 0]] },
  "ImportSource": { u: { o: { o: [["uploadId", "upload_id", 0]] } } },
  "LossSpec": { u: { o: { o: [["topK", "top_k", 0]] } } },
  "MetricPoint": { o: [["evalLoss", "eval_loss", 0], ["evalMetric", "eval_metric", 0], ["gradNorm", "grad_norm", 0], ["tokensPerSec", "tokens_per_sec", 0], ["costUsd", "cost_usd", 0]] },
  "MetricPointInput": { o: [["evalLoss", "eval_loss", 0], ["evalMetric", "eval_metric", 0], ["gradNorm", "grad_norm", 0], ["tokensPerSec", "tokens_per_sec", 0], ["costUsd", "cost_usd", 0]] },
  "MetricsPage": { o: [["runId", "run_id", 0], ["data", "data", { a: "MetricPoint" }], ["nextCursor", "next_cursor", 0]] },
  "OptimizerSpec": { o: [["weightDecay", "weight_decay", 0], ["gradClip", "grad_clip", 0]] },
  "PlanEvalRequest": { o: [["datasetVersion", "dataset_version", 0], ["envName", "env_name", 0], ["maxTokens", "max_tokens", 0], ["passThreshold", "pass_threshold", 0], ["maxCostUsd", "max_cost_usd", 0]] },
  "PlanEvalResponse": { o: [["taskSourceKind", "task_source_kind", 0], ["datasetVersion", "dataset_version", 0], ["estimatedTasks", "estimated_tasks", 0], ["estimatedModelCalls", "estimated_model_calls", 0], ["estimatedJudgeCalls", "estimated_judge_calls", 0], ["estimatedCostUsd", "estimated_cost_usd", 0], ["judgeModels", "judge_models", 0], ["localScorers", "local_scorers", 0], ["passThreshold", "pass_threshold", 0]] },
  "PlanRunRequest": { o: [["recipe", "recipe", "RecipeSpec"], ["split", "split", "SplitSpec"], ["maxCostUsd", "max_cost_usd", 0], ["dependsOn", "depends_on", 0]] },
  "PlanRunResponse": { o: [["resolvedConfig", "resolved_config", "ResolvedRunConfig"], ["datasetVersion", "dataset_version", 0], ["usableRecords", "usable_records", 0], ["totalRecords", "total_records", 0], ["estimatedSteps", "estimated_steps", 0], ["estimatedTokens", "estimated_tokens", 0], ["estimatedCostUsd", "estimated_cost_usd", 0], ["pricePerMillionTokens", "price_per_million_tokens", 0], ["trainedTokenFraction", "trained_token_fraction", 0]] },
  "PostEvalScoresRequest": { o: [["scores", "scores", { a: { o: [["outputId", "output_id", 0]] } }]] },
  "PostEvalScoresResponse": { o: [["pendingLocalScores", "pending_local_scores", 0]] },
  "PostImportRecordsRequest": { o: [["workerId", "worker_id", 0]] },
  "Problem": { o: [["requestId", "request_id", 0]] },
  "PushDatasetRequest": { o: [["records", "records", { a: "DatasetRecord" }]] },
  "RecipeSpec": { o: [["adapter", "adapter", "AdapterSpec"], ["lrScale", "lr_scale", 0], ["batchSize", "batch_size", 0], ["trainOn", "train_on", 0], ["preserveThinking", "preserve_thinking", 0], ["checkpointTtlDays", "checkpoint_ttl_days", 0], ["maxQualityDrop", "max_quality_drop", 0], ["contextText", "context_text", 0], ["contextUri", "context_uri", 0], ["numTokens", "num_tokens", 0], ["envName", "env_name", 0], ["groupSize", "group_size", 0], ["optimizer", "optimizer", "OptimizerSpec"], ["evalEvery", "eval_every", 0], ["loss", "loss", "LossSpec"], ["maxNewTokens", "max_new_tokens", 0], ["slotToken", "slot_token", 0]] },
  "RecordFeedbackRequest": { o: [["events", "events", { a: "FeedbackEventInput" }]] },
  "RecordFeedbackResponse": { o: [["records", "records", { a: "FeedbackRecord" }]] },
  "RegisterTrainerCheckpointRequest": { o: [["workerId", "worker_id", 0], ["evalScore", "eval_score", 0], ["uploadId", "upload_id", 0]] },
  "RenderDatasetRequest": { o: [["trainOn", "train_on", 0], ["preserveThinking", "preserve_thinking", 0]] },
  "RenderDatasetResponse": { o: [["templateRevision", "template_revision", 0], ["tokenCounts", "token_counts", 0], ["examples", "examples", { a: { o: [["recordId", "record_id", 0], ["templateRevision", "template_revision", 0], ["totalTokens", "total_tokens", 0], ["trainedTokens", "trained_tokens", 0], ["trainedFraction", "trained_fraction", 0]] } }]] },
  "ReportTrainerProgressRequest": { o: [["workerId", "worker_id", 0], ["metric", "metric", "MetricPointInput"]] },
  "ReportTrainerProgressResponse": { o: [["shouldStop", "should_stop", 0], ["stopReason", "stop_reason", 0], ["costUsd", "cost_usd", 0]] },
  "ResolvedRunConfig": { o: [["ruleVersion", "rule_version", 0], ["datasetVersion", "dataset_version", 0], ["recipeKind", "recipe_kind", 0], ["templateRevision", "template_revision", 0], ["adapter", "adapter", { u: { o: { o: [["mergeOnExport", "merge_on_export", 0], ["numTokens", "num_tokens", 0]] } } }], ["lrSource", "lr_source", 0], ["batchSize", "batch_size", 0], ["trainOn", "train_on", 0], ["preserveThinking", "preserve_thinking", 0], ["checkpointEverySteps", "checkpoint_every_steps", 0], ["evalEverySteps", "eval_every_steps", 0], ["optimizer", "optimizer", "OptimizerSpec"], ["checkpointTtlDays", "checkpoint_ttl_days", 0], ["split", "split", { o: [["evalFraction", "eval_fraction", 0], ["trainRecords", "train_records", 0], ["evalRecords", "eval_records", 0]] }], ["baseArtifact", "base_artifact", "BaseArtifact"], ["recipeParams", "recipe_params", 0]] },
  "ResumeRunRequest": { o: [["maxCostUsd", "max_cost_usd", 0]] },
  "RouteRequest": { o: [["messages", "messages", { a: "ChatMessage" }], ["sessionId", "session_id", 0]] },
  "RouteResponse": { o: [["inferenceId", "inference_id", 0], ["artifactId", "artifact_id", 0], ["isExploration", "is_exploration", 0]] },
  "Run": { o: [["workspaceId", "workspace_id", 0], ["datasetId", "dataset_id", 0], ["datasetName", "dataset_name", 0], ["datasetVersion", "dataset_version", 0], ["recipeKind", "recipe_kind", 0], ["resolvedConfig", "resolved_config", "ResolvedRunConfig"], ["maxCostUsd", "max_cost_usd", 0], ["pricePerMillionTokens", "price_per_million_tokens", 0], ["tokensProcessed", "tokens_processed", 0], ["costUsd", "cost_usd", 0], ["currentStep", "current_step", 0], ["totalSteps", "total_steps", 0], ["maxAttempts", "max_attempts", 0], ["latestMetric", "latest_metric", "MetricPoint"], ["evalReport", "eval_report", 0], ["artifactId", "artifact_id", 0], ["dependsOn", "depends_on", 0], ["createdAt", "created_at", 0], ["updatedAt", "updated_at", 0], ["finishedAt", "finished_at", 0]] },
  "SplitSpec": { o: [["evalFraction", "eval_fraction", 0]] },
  "TrainableModel": { o: [["hfRepo", "hf_repo", 0], ["defaultFor", "default_for", 0], ["pricePerMillionTokensUsd", "price_per_million_tokens_usd", 0], ["maxContextTokens", "max_context_tokens", 0], ["templateRevision", "template_revision", 0], ["calibratedLrs", "calibrated_lrs", 0]] },
  "TrainerHeartbeatRequest": { o: [["workerId", "worker_id", 0], ["leaseSeconds", "lease_seconds", 0]] },
  "TrainerHeartbeatResponse": { o: [["shouldStop", "should_stop", 0], ["stopReason", "stop_reason", 0], ["leaseExpiresAt", "lease_expires_at", 0]] },
  "TrainerJob": { o: [["leaseSeconds", "lease_seconds", 0], ["leaseExpiresAt", "lease_expires_at", 0], ["run", "run", { o: [["workspaceId", "workspace_id", 0], ["recipeKind", "recipe_kind", 0], ["resolvedConfig", "resolved_config", "ResolvedRunConfig"], ["totalSteps", "total_steps", 0]] }], ["import", "import", { o: [["workspaceId", "workspace_id", 0]] }], ["pricePerMillionTokens", "price_per_million_tokens", 0], ["maxCostUsd", "max_cost_usd", 0], ["dataset", "dataset", { o: [["recordCount", "record_count", 0], ["downloadUrl", "download_url", 0]] }], ["resume", "resume", { o: [["checkpointId", "checkpoint_id", 0], ["downloadUrl", "download_url", 0]] }], ["base", "base", { o: [["artifactId", "artifact_id", 0], ["downloadUrl", "download_url", 0]] }]] },
  "TrainerQueueStats": { o: [["byKind", "by_kind", 0]] },
  "TrainerUploadRequest": { o: [["workerId", "worker_id", 0], ["sizeBytes", "size_bytes", 0]] },
  "TrajectoryInput": { o: [["messages", "messages", { a: "ChatMessage" }]] },
  "TrajectoryOutput": { o: [["turns", "turns", { a: "ChatMessage" }]] },
  "UploadTicket": { o: [["uploadId", "upload_id", 0], ["expiresAt", "expires_at", 0]] },
};

export type ClaimEnvTaskRequest = {
  workerId: string;
  waitMs?: number | undefined;
};

export type ClaimEnvTaskResponse = {
  task: Record<string, unknown> | null;
};

export type CompleteEnvTaskResponse = Record<string, unknown>;

export type DispatchEnvTaskResponse = {
  id: string;
  envName: string;
  status: string;
  activeWorkers: number;
};

export interface DownloadTrainerDatasetParams {
  attempt: number;
}

export type GetEnvTaskResponse = Record<string, unknown>;

export interface ListApiKeysParams {
  limit?: number | undefined;
  cursor?: string | undefined;
}

export type ListApiKeysResponse = {
  data: Array<ApiKey>;
  nextCursor: string | null;
};

export interface ListArtifactsParams {
  limit?: number | undefined;
  cursor?: string | undefined;
  name?: string | undefined;
}

export type ListArtifactsResponse = {
  data: Array<Artifact>;
  nextCursor: string | null;
};

export interface ListDatasetRecordsParams {
  version?: number | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface ListDatasetsParams {
  limit?: number | undefined;
  cursor?: string | undefined;
}

export type ListDatasetsResponse = {
  data: Array<Dataset>;
  nextCursor: string | null;
};

export interface ListDeploymentsParams {
  limit?: number | undefined;
  cursor?: string | undefined;
}

export type ListDeploymentsResponse = {
  data: Array<Deployment>;
  nextCursor: string | null;
};

export interface ListEvalFailuresParams {
  limit?: number | undefined;
  cursor?: string | undefined;
  model?: string | undefined;
  threshold?: number | undefined;
}

export type ListEvalFailuresResponse = {
  evalId: string;
  data: Array<EvalTaskOutcome>;
  nextCursor: string | null;
};

export interface ListEvalOutputsParams {
  limit?: number | undefined;
  cursor?: string | undefined;
  model?: string | undefined;
  missingScorer?: string | undefined;
}

export type ListEvalOutputsResponse = {
  data: Array<EvalOutput>;
  nextCursor: string | null;
};

export interface ListEvalResultsParams {
  limit?: number | undefined;
  cursor?: string | undefined;
  model?: string | undefined;
}

export type ListEvalResultsResponse = {
  data: Array<EvalTaskOutcome>;
  nextCursor: string | null;
};

export interface ListEvalsParams {
  limit?: number | undefined;
  cursor?: string | undefined;
}

export type ListEvalsResponse = {
  data: Array<EvalRun>;
  nextCursor: string | null;
};

export interface ListImportsParams {
  limit?: number | undefined;
  cursor?: string | undefined;
}

export type ListImportsResponse = {
  data: Array<ImportJob>;
  nextCursor: string | null;
};

export type ListModelsResponse = {
  data: Array<TrainableModel>;
};

export interface ListRunCheckpointsParams {
  limit?: number | undefined;
  cursor?: string | undefined;
}

export type ListRunCheckpointsResponse = {
  data: Array<Checkpoint>;
  nextCursor: string | null;
};

export interface ListRunMetricsParams {
  cursor?: string | undefined;
  afterStep?: number | undefined;
  limit?: number | undefined;
}

export interface ListRunsParams {
  limit?: number | undefined;
  cursor?: string | undefined;
}

export type ListRunsResponse = {
  data: Array<Run>;
  nextCursor: string | null;
};

export type RegisterEnvWorkerResponse = {
  name: string;
  workerId: string;
  concurrency: number;
  lastHeartbeatAt: string;
};

/** Low-level client: one typed method per OpenAPI operation. */
export class ApiClient {
  constructor(readonly transport: TransportLike) {}

  /**
   * Cancel a queued, running or awaiting_scores evaluation
   *
   * `POST /v1/evals/{id}/cancel`
   */
  async cancelEval(id: string, options?: RequestOptions): Promise<EvalRun> {
    const data = await this.transport.json({ method: "POST", path: `/v1/evals/${encodePathParam(id, "id")}/cancel` }, options);
    return convertKeys(CODEC, "EvalRun", data, "decode") as EvalRun;
  }

  /**
   * Cancel a training run (a running attempt is stopped and billed)
   *
   * `POST /v1/runs/{id}/cancel`
   */
  async cancelRun(id: string, options?: RequestOptions): Promise<Run> {
    const data = await this.transport.json({ method: "POST", path: `/v1/runs/${encodePathParam(id, "id")}/cancel` }, options);
    return convertKeys(CODEC, "Run", data, "decode") as Run;
  }

  /**
   * Long-poll for the next task assigned to a `grad env serve` worker
   *
   * `POST /v1/env-workers/{name}/claim`
   */
  async claimEnvTask(name: string, body: ClaimEnvTaskRequest, options?: RequestOptions): Promise<ClaimEnvTaskResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/env-workers/${encodePathParam(name, "name")}/claim`, json: convertKeys(CODEC, { o: [["workerId", "worker_id", 0], ["waitMs", "wait_ms", 0]] }, body, "encode") }, options);
    return data as ClaimEnvTaskResponse;
  }

  /**
   * Claim the next queued train or import job (trainer:worker)
   *
   * `POST /v1/trainer-jobs/claim`
   */
  async claimTrainerJob(body: ClaimJobRequest, options?: RequestOptions): Promise<ClaimJobResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/trainer-jobs/claim`, json: convertKeys(CODEC, "ClaimJobRequest", body, "encode") }, options);
    return convertKeys(CODEC, "ClaimJobResponse", data, "decode") as ClaimJobResponse;
  }

  /**
   * Submit scored trajectory output for an environment task
   *
   * `POST /v1/env-workers/tasks/{id}/complete`
   */
  async completeEnvTask(id: string, body: EnvTaskResult, options?: RequestOptions): Promise<CompleteEnvTaskResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/env-workers/tasks/${encodePathParam(id, "id")}/complete`, json: convertKeys(CODEC, "EnvTaskResult", body, "encode") }, options);
    return data as CompleteEnvTaskResponse;
  }

  /**
   * Finish a job attempt: publish its artifact, bill it, release the lease
   *
   * `POST /v1/trainer-jobs/{id}/complete`
   */
  async completeTrainerJob(id: string, body: CompleteTrainerJobRequest, options?: RequestOptions): Promise<CompleteTrainerJobResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/trainer-jobs/${encodePathParam(id, "id")}/complete`, json: convertKeys(CODEC, "CompleteTrainerJobRequest", body, "encode") }, options);
    return convertKeys(CODEC, "CompleteTrainerJobResponse", data, "decode") as CompleteTrainerJobResponse;
  }

  /**
   * Create a scoped workspace API key (trainer worker keys are platform config, not keys)
   *
   * `POST /v1/keys`
   */
  async createApiKey(body: CreateApiKeyRequest, options?: RequestOptions): Promise<CreatedApiKey> {
    const data = await this.transport.json({ method: "POST", path: `/v1/keys`, json: body }, options);
    return convertKeys(CODEC, "CreatedApiKey", data, "decode") as CreatedApiKey;
  }

  /**
   * Create an empty dataset
   *
   * `POST /v1/datasets`
   */
  async createDataset(body: CreateDatasetRequest, options?: RequestOptions): Promise<Dataset> {
    const data = await this.transport.json({ method: "POST", path: `/v1/datasets`, json: body }, options);
    return convertKeys(CODEC, "Dataset", data, "decode") as Dataset;
  }

  /**
   * Import an uploaded file or a Hugging Face dataset into a dataset (async job)
   *
   * `POST /v1/datasets/{name}/imports`
   */
  async createDatasetImport(name: string, body: CreateImportRequest, options?: RequestOptions): Promise<ImportJob> {
    const data = await this.transport.json({ method: "POST", path: `/v1/datasets/${encodePathParam(name, "name")}/imports`, json: convertKeys(CODEC, "CreateImportRequest", body, "encode") }, options);
    return convertKeys(CODEC, "ImportJob", data, "decode") as ImportJob;
  }

  /**
   * Generate embeddings from a deployed embedding artifact
   *
   * `POST /v1/embeddings`
   */
  async createEmbeddings(body: EmbedRequest, options?: RequestOptions): Promise<EmbedResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/embeddings`, json: body }, options);
    return convertKeys(CODEC, "EmbedResponse", data, "decode") as EmbedResponse;
  }

  /**
   * Queue an evaluation across models on a pinned dataset version (executed by the server)
   *
   * `POST /v1/evals`
   */
  async createEval(body: PlanEvalRequest, options?: RequestOptions): Promise<EvalRun> {
    const data = await this.transport.json({ method: "POST", path: `/v1/evals`, json: convertKeys(CODEC, "PlanEvalRequest", body, "encode") }, options);
    return convertKeys(CODEC, "EvalRun", data, "decode") as EvalRun;
  }

  /**
   * Create and enqueue a training run (pins the dataset version)
   *
   * `POST /v1/runs`
   */
  async createRun(body: PlanRunRequest, options?: RequestOptions): Promise<Run> {
    const data = await this.transport.json({ method: "POST", path: `/v1/runs`, json: convertKeys(CODEC, "PlanRunRequest", body, "encode") }, options);
    return convertKeys(CODEC, "Run", data, "decode") as Run;
  }

  /**
   * Get an upload URL for a checkpoint or artifact bundle
   *
   * `POST /v1/trainer-jobs/{id}/uploads`
   */
  async createTrainerUpload(id: string, body: TrainerUploadRequest, options?: RequestOptions): Promise<UploadTicket> {
    const data = await this.transport.json({ method: "POST", path: `/v1/trainer-jobs/${encodePathParam(id, "id")}/uploads`, json: convertKeys(CODEC, "TrainerUploadRequest", body, "encode") }, options);
    return convertKeys(CODEC, "UploadTicket", data, "decode") as UploadTicket;
  }

  /**
   * Get an upload URL for a file to import (PUT the bytes, then create an import)
   *
   * `POST /v1/uploads`
   */
  async createUpload(body: CreateUploadRequest, options?: RequestOptions): Promise<UploadTicket> {
    const data = await this.transport.json({ method: "POST", path: `/v1/uploads`, json: convertKeys(CODEC, "CreateUploadRequest", body, "encode") }, options);
    return convertKeys(CODEC, "UploadTicket", data, "decode") as UploadTicket;
  }

  /**
   * Deploy or update an artifact under a stable model name
   *
   * `POST /v1/deployments`
   */
  async deployArtifact(body: DeployArtifactRequest, options?: RequestOptions): Promise<Deployment> {
    const data = await this.transport.json({ method: "POST", path: `/v1/deployments`, json: convertKeys(CODEC, "DeployArtifactRequest", body, "encode") }, options);
    return convertKeys(CODEC, "Deployment", data, "decode") as Deployment;
  }

  /**
   * Dispatch an evaluation or rollout task to a connected `grad env serve` worker
   *
   * `POST /v1/env-workers/tasks`
   */
  async dispatchEnvTask(body: EnvTaskDispatch, options?: RequestOptions): Promise<DispatchEnvTaskResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/env-workers/tasks`, json: convertKeys(CODEC, "EnvTaskDispatch", body, "encode") }, options);
    return convertKeys(CODEC, { o: [["envName", "env_name", 0], ["activeWorkers", "active_workers", 0]] }, data, "decode") as DispatchEnvTaskResponse;
  }

  /**
   * Download an artifact bundle (.grad.tar.gz); verify X-Artifact-Sha256
   *
   * `GET /v1/artifacts/{id}/download`
   */
  downloadArtifact(id: string, options?: StreamOptions): Promise<RawResponse> {
    return this.transport.raw({ method: "GET", path: `/v1/artifacts/${encodePathParam(id, "id")}/download`, accept: "application/octet-stream" }, options);
  }

  /**
   * Stream the pinned dataset version of a claimed train job as JSONL
   *
   * `GET /v1/trainer-jobs/{id}/dataset`
   */
  downloadTrainerDataset(id: string, params: DownloadTrainerDatasetParams, options?: StreamOptions): Promise<RawResponse> {
    return this.transport.raw({ method: "GET", path: `/v1/trainer-jobs/${encodePathParam(id, "id")}/dataset`, query: [["attempt", params.attempt]], accept: "application/x-ndjson" }, options);
  }

  /**
   * Get an artifact by id or name@latest
   *
   * `GET /v1/artifacts/{id}`
   */
  async getArtifact(id: string, options?: RequestOptions): Promise<Artifact> {
    const data = await this.transport.json({ method: "GET", path: `/v1/artifacts/${encodePathParam(id, "id")}` }, options);
    return convertKeys(CODEC, "Artifact", data, "decode") as Artifact;
  }

  /**
   * Get a dataset by name
   *
   * `GET /v1/datasets/{name}`
   */
  async getDataset(name: string, options?: RequestOptions): Promise<Dataset> {
    const data = await this.transport.json({ method: "GET", path: `/v1/datasets/${encodePathParam(name, "name")}` }, options);
    return convertKeys(CODEC, "Dataset", data, "decode") as Dataset;
  }

  /**
   * Get deployment status and feedback summary
   *
   * `GET /v1/deployments/{name}`
   */
  async getDeployment(name: string, options?: RequestOptions): Promise<DeploymentStatus> {
    const data = await this.transport.json({ method: "GET", path: `/v1/deployments/${encodePathParam(name, "name")}` }, options);
    return convertKeys(CODEC, "DeploymentStatus", data, "decode") as DeploymentStatus;
  }

  /**
   * Inspect an environment task and its result
   *
   * `GET /v1/env-workers/tasks/{id}`
   */
  async getEnvTask(id: string, options?: RequestOptions): Promise<GetEnvTaskResponse> {
    const data = await this.transport.json({ method: "GET", path: `/v1/env-workers/tasks/${encodePathParam(id, "id")}` }, options);
    return data as GetEnvTaskResponse;
  }

  /**
   * Get an evaluation run by ID
   *
   * `GET /v1/evals/{id}`
   */
  async getEval(id: string, options?: RequestOptions): Promise<EvalRun> {
    const data = await this.transport.json({ method: "GET", path: `/v1/evals/${encodePathParam(id, "id")}` }, options);
    return convertKeys(CODEC, "EvalRun", data, "decode") as EvalRun;
  }

  /**
   * Get a dataset import job
   *
   * `GET /v1/imports/{id}`
   */
  async getImport(id: string, options?: RequestOptions): Promise<ImportJob> {
    const data = await this.transport.json({ method: "GET", path: `/v1/imports/${encodePathParam(id, "id")}` }, options);
    return convertKeys(CODEC, "ImportJob", data, "decode") as ImportJob;
  }

  /**
   * Get a training run
   *
   * `GET /v1/runs/{id}`
   */
  async getRun(id: string, options?: RequestOptions): Promise<Run> {
    const data = await this.transport.json({ method: "GET", path: `/v1/runs/${encodePathParam(id, "id")}` }, options);
    return convertKeys(CODEC, "Run", data, "decode") as Run;
  }

  /**
   * Queue depth for autoscaling: queued plus running jobs (trainer:worker)
   *
   * `GET /v1/trainer-jobs/queue`
   */
  async getTrainerQueueStats(options?: RequestOptions): Promise<TrainerQueueStats> {
    const data = await this.transport.json({ method: "GET", path: `/v1/trainer-jobs/queue` }, options);
    return convertKeys(CODEC, "TrainerQueueStats", data, "decode") as TrainerQueueStats;
  }

  /**
   * Renew the job lease; reports whether the worker should stop
   *
   * `POST /v1/trainer-jobs/{id}/heartbeat`
   */
  async heartbeatTrainerJob(id: string, body: TrainerHeartbeatRequest, options?: RequestOptions): Promise<TrainerHeartbeatResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/trainer-jobs/${encodePathParam(id, "id")}/heartbeat`, json: convertKeys(CODEC, "TrainerHeartbeatRequest", body, "encode") }, options);
    return convertKeys(CODEC, "TrainerHeartbeatResponse", data, "decode") as TrainerHeartbeatResponse;
  }

  /**
   * List workspace API keys
   *
   * `GET /v1/keys`
   */
  async listApiKeys(params?: ListApiKeysParams, options?: RequestOptions): Promise<ListApiKeysResponse> {
    const data = await this.transport.json({ method: "GET", path: `/v1/keys`, query: [["limit", params?.limit], ["cursor", params?.cursor]] }, options);
    return convertKeys(CODEC, { o: [["data", "data", { a: "ApiKey" }], ["nextCursor", "next_cursor", 0]] }, data, "decode") as ListApiKeysResponse;
  }

  /**
   * List immutable artifacts (newest first)
   *
   * `GET /v1/artifacts`
   */
  async listArtifacts(params?: ListArtifactsParams, options?: RequestOptions): Promise<ListArtifactsResponse> {
    const data = await this.transport.json({ method: "GET", path: `/v1/artifacts`, query: [["limit", params?.limit], ["cursor", params?.cursor], ["name", params?.name]] }, options);
    return convertKeys(CODEC, { o: [["data", "data", { a: "Artifact" }], ["nextCursor", "next_cursor", 0]] }, data, "decode") as ListArtifactsResponse;
  }

  /**
   * Read records of a dataset version
   *
   * `GET /v1/datasets/{name}/records`
   */
  async listDatasetRecords(name: string, params?: ListDatasetRecordsParams, options?: RequestOptions): Promise<DatasetRecordsPage> {
    const data = await this.transport.json({ method: "GET", path: `/v1/datasets/${encodePathParam(name, "name")}/records`, query: [["version", params?.version], ["limit", params?.limit], ["cursor", params?.cursor]] }, options);
    return convertKeys(CODEC, "DatasetRecordsPage", data, "decode") as DatasetRecordsPage;
  }

  /**
   * List datasets (newest first)
   *
   * `GET /v1/datasets`
   */
  async listDatasets(params?: ListDatasetsParams, options?: RequestOptions): Promise<ListDatasetsResponse> {
    const data = await this.transport.json({ method: "GET", path: `/v1/datasets`, query: [["limit", params?.limit], ["cursor", params?.cursor]] }, options);
    return convertKeys(CODEC, { o: [["data", "data", { a: "Dataset" }], ["nextCursor", "next_cursor", 0]] }, data, "decode") as ListDatasetsResponse;
  }

  /**
   * List deployments
   *
   * `GET /v1/deployments`
   */
  async listDeployments(params?: ListDeploymentsParams, options?: RequestOptions): Promise<ListDeploymentsResponse> {
    const data = await this.transport.json({ method: "GET", path: `/v1/deployments`, query: [["limit", params?.limit], ["cursor", params?.cursor]] }, options);
    return convertKeys(CODEC, { o: [["data", "data", { a: "Deployment" }], ["nextCursor", "next_cursor", 0]] }, data, "decode") as ListDeploymentsResponse;
  }

  /**
   * List failing task records from an evaluation run for mining
   *
   * `GET /v1/evals/{id}/failures`
   */
  async listEvalFailures(id: string, params?: ListEvalFailuresParams, options?: RequestOptions): Promise<ListEvalFailuresResponse> {
    const data = await this.transport.json({ method: "GET", path: `/v1/evals/${encodePathParam(id, "id")}/failures`, query: [["limit", params?.limit], ["cursor", params?.cursor], ["model", params?.model], ["threshold", params?.threshold]] }, options);
    return convertKeys(CODEC, { o: [["evalId", "eval_id", 0], ["data", "data", { a: "EvalTaskOutcome" }], ["nextCursor", "next_cursor", 0]] }, data, "decode") as ListEvalFailuresResponse;
  }

  /**
   * Page through generated model outputs (filter by model or by a code scorer that still needs a score)
   *
   * `GET /v1/evals/{id}/outputs`
   */
  async listEvalOutputs(id: string, params?: ListEvalOutputsParams, options?: RequestOptions): Promise<ListEvalOutputsResponse> {
    const data = await this.transport.json({ method: "GET", path: `/v1/evals/${encodePathParam(id, "id")}/outputs`, query: [["limit", params?.limit], ["cursor", params?.cursor], ["model", params?.model], ["missing_scorer", params?.missingScorer]] }, options);
    return convertKeys(CODEC, { o: [["data", "data", { a: "EvalOutput" }], ["nextCursor", "next_cursor", 0]] }, data, "decode") as ListEvalOutputsResponse;
  }

  /**
   * Per-task, per-model results of a completed evaluation
   *
   * `GET /v1/evals/{id}/results`
   */
  async listEvalResults(id: string, params?: ListEvalResultsParams, options?: RequestOptions): Promise<ListEvalResultsResponse> {
    const data = await this.transport.json({ method: "GET", path: `/v1/evals/${encodePathParam(id, "id")}/results`, query: [["limit", params?.limit], ["cursor", params?.cursor], ["model", params?.model]] }, options);
    return convertKeys(CODEC, { o: [["data", "data", { a: "EvalTaskOutcome" }], ["nextCursor", "next_cursor", 0]] }, data, "decode") as ListEvalResultsResponse;
  }

  /**
   * List evaluation runs
   *
   * `GET /v1/evals`
   */
  async listEvals(params?: ListEvalsParams, options?: RequestOptions): Promise<ListEvalsResponse> {
    const data = await this.transport.json({ method: "GET", path: `/v1/evals`, query: [["limit", params?.limit], ["cursor", params?.cursor]] }, options);
    return convertKeys(CODEC, { o: [["data", "data", { a: "EvalRun" }], ["nextCursor", "next_cursor", 0]] }, data, "decode") as ListEvalsResponse;
  }

  /**
   * List dataset import jobs (newest first)
   *
   * `GET /v1/imports`
   */
  async listImports(params?: ListImportsParams, options?: RequestOptions): Promise<ListImportsResponse> {
    const data = await this.transport.json({ method: "GET", path: `/v1/imports`, query: [["limit", params?.limit], ["cursor", params?.cursor]] }, options);
    return convertKeys(CODEC, { o: [["data", "data", { a: "ImportJob" }], ["nextCursor", "next_cursor", 0]] }, data, "decode") as ListImportsResponse;
  }

  /**
   * List trainable base models (the server catalog and price source)
   *
   * `GET /v1/models`
   */
  async listModels(options?: RequestOptions): Promise<ListModelsResponse> {
    const data = await this.transport.json({ method: "GET", path: `/v1/models` }, options);
    return convertKeys(CODEC, { o: [["data", "data", { a: "TrainableModel" }]] }, data, "decode") as ListModelsResponse;
  }

  /**
   * List unexpired checkpoints of a run (best and final never expire)
   *
   * `GET /v1/runs/{id}/checkpoints`
   */
  async listRunCheckpoints(id: string, params?: ListRunCheckpointsParams, options?: RequestOptions): Promise<ListRunCheckpointsResponse> {
    const data = await this.transport.json({ method: "GET", path: `/v1/runs/${encodePathParam(id, "id")}/checkpoints`, query: [["limit", params?.limit], ["cursor", params?.cursor]] }, options);
    return convertKeys(CODEC, { o: [["data", "data", { a: "Checkpoint" }], ["nextCursor", "next_cursor", 0]] }, data, "decode") as ListRunCheckpointsResponse;
  }

  /**
   * Training step metrics as JSON pages, or a live SSE stream
   *
   * `GET /v1/runs/{id}/metrics`
   */
  async listRunMetrics(id: string, params?: ListRunMetricsParams, options?: RequestOptions): Promise<MetricsPage> {
    const data = await this.transport.json({ method: "GET", path: `/v1/runs/${encodePathParam(id, "id")}/metrics`, query: [["cursor", params?.cursor], ["after_step", params?.afterStep], ["limit", params?.limit]] }, options);
    return convertKeys(CODEC, "MetricsPage", data, "decode") as MetricsPage;
  }

  /**
   * Training step metrics as JSON pages, or a live SSE stream (Server-Sent Events; one connection, resume with `lastEventId`)
   */
  listRunMetricsStream(id: string, params?: ListRunMetricsParams, options?: SSEOptions): AsyncGenerator<ServerSentEvent, void, undefined> {
    return this.transport.sse({ method: "GET", path: `/v1/runs/${encodePathParam(id, "id")}/metrics`, query: [["cursor", params?.cursor], ["after_step", params?.afterStep], ["limit", params?.limit]] }, options);
  }

  /**
   * List training runs (newest first)
   *
   * `GET /v1/runs`
   */
  async listRuns(params?: ListRunsParams, options?: RequestOptions): Promise<ListRunsResponse> {
    const data = await this.transport.json({ method: "GET", path: `/v1/runs`, query: [["limit", params?.limit], ["cursor", params?.cursor]] }, options);
    return convertKeys(CODEC, { o: [["data", "data", { a: "Run" }], ["nextCursor", "next_cursor", 0]] }, data, "decode") as ListRunsResponse;
  }

  /**
   * Estimate tasks, model/judge calls, and cost before running an eval
   *
   * `POST /v1/evals/plan`
   */
  async planEval(body: PlanEvalRequest, options?: RequestOptions): Promise<PlanEvalResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/evals/plan`, json: convertKeys(CODEC, "PlanEvalRequest", body, "encode") }, options);
    return convertKeys(CODEC, "PlanEvalResponse", data, "decode") as PlanEvalResponse;
  }

  /**
   * Dry-run a training recipe at zero cost
   *
   * `POST /v1/runs/plan`
   */
  async planRun(body: PlanRunRequest, options?: RequestOptions): Promise<PlanRunResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/runs/plan`, json: convertKeys(CODEC, "PlanRunRequest", body, "encode") }, options);
    return convertKeys(CODEC, "PlanRunResponse", data, "decode") as PlanRunResponse;
  }

  /**
   * Post scores computed by local (SDK-side) code scorers; the eval completes when none are missing
   *
   * `POST /v1/evals/{id}/scores`
   */
  async postEvalScores(id: string, body: PostEvalScoresRequest, options?: RequestOptions): Promise<PostEvalScoresResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/evals/${encodePathParam(id, "id")}/scores`, json: convertKeys(CODEC, "PostEvalScoresRequest", body, "encode") }, options);
    return convertKeys(CODEC, "PostEvalScoresResponse", data, "decode") as PostEvalScoresResponse;
  }

  /**
   * Append a batch of parsed records to an import job
   *
   * `POST /v1/trainer-jobs/{id}/records`
   */
  async postImportRecords(id: string, body: PostImportRecordsRequest, options?: RequestOptions): Promise<PostImportRecordsResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/trainer-jobs/${encodePathParam(id, "id")}/records`, json: convertKeys(CODEC, "PostImportRecordsRequest", body, "encode") }, options);
    return data as PostImportRecordsResponse;
  }

  /**
   * Copy an exportable checkpoint into a new immutable artifact
   *
   * `POST /v1/checkpoints/{id}/promote`
   */
  async promoteCheckpoint(id: string, body?: PromoteCheckpointRequest, options?: RequestOptions): Promise<Artifact> {
    const data = await this.transport.json({ method: "POST", path: `/v1/checkpoints/${encodePathParam(id, "id")}/promote`, json: body }, options);
    return convertKeys(CODEC, "Artifact", data, "decode") as Artifact;
  }

  /**
   * Append records as a new dataset version (creates the dataset if needed)
   *
   * `POST /v1/datasets/{name}/records`
   */
  async pushDatasetRecords(name: string, body: PushDatasetRequest, options?: RequestOptions): Promise<Dataset> {
    const data = await this.transport.json({ method: "POST", path: `/v1/datasets/${encodePathParam(name, "name")}/records`, json: convertKeys(CODEC, "PushDatasetRequest", body, "encode") }, options);
    return convertKeys(CODEC, "Dataset", data, "decode") as Dataset;
  }

  /**
   * Record deduplicated outcome scores and gold corrections
   *
   * `POST /v1/feedback`
   */
  async recordFeedback(body: RecordFeedbackRequest, options?: RequestOptions): Promise<RecordFeedbackResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/feedback`, json: convertKeys(CODEC, "RecordFeedbackRequest", body, "encode") }, options);
    return convertKeys(CODEC, "RecordFeedbackResponse", data, "decode") as RecordFeedbackResponse;
  }

  /**
   * Register or heartbeat an outbound `grad env serve` worker
   *
   * `POST /v1/env-workers/register`
   */
  async registerEnvWorker(body: EnvWorkerRegister, options?: RequestOptions): Promise<RegisterEnvWorkerResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/env-workers/register`, json: convertKeys(CODEC, "EnvWorkerRegister", body, "encode") }, options);
    return convertKeys(CODEC, { o: [["workerId", "worker_id", 0], ["lastHeartbeatAt", "last_heartbeat_at", 0]] }, data, "decode") as RegisterEnvWorkerResponse;
  }

  /**
   * Register an uploaded checkpoint bundle
   *
   * `POST /v1/trainer-jobs/{id}/checkpoints`
   */
  async registerTrainerCheckpoint(id: string, body: RegisterTrainerCheckpointRequest, options?: RequestOptions): Promise<Checkpoint> {
    const data = await this.transport.json({ method: "POST", path: `/v1/trainer-jobs/${encodePathParam(id, "id")}/checkpoints`, json: convertKeys(CODEC, "RegisterTrainerCheckpointRequest", body, "encode") }, options);
    return convertKeys(CODEC, "Checkpoint", data, "decode") as Checkpoint;
  }

  /**
   * Preview chat-template rendering and loss masks (estimated token counts)
   *
   * `POST /v1/datasets/{name}/render`
   */
  async renderDataset(name: string, body: RenderDatasetRequest, options?: RequestOptions): Promise<RenderDatasetResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/datasets/${encodePathParam(name, "name")}/render`, json: convertKeys(CODEC, "RenderDatasetRequest", body, "encode") }, options);
    return convertKeys(CODEC, "RenderDatasetResponse", data, "decode") as RenderDatasetResponse;
  }

  /**
   * Report one training step's metrics
   *
   * `POST /v1/trainer-jobs/{id}/progress`
   */
  async reportTrainerProgress(id: string, body: ReportTrainerProgressRequest, options?: RequestOptions): Promise<ReportTrainerProgressResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/trainer-jobs/${encodePathParam(id, "id")}/progress`, json: convertKeys(CODEC, "ReportTrainerProgressRequest", body, "encode") }, options);
    return convertKeys(CODEC, "ReportTrainerProgressResponse", data, "decode") as ReportTrainerProgressResponse;
  }

  /**
   * Resume a stopped, failed or cancelled run from its latest checkpoint
   *
   * `POST /v1/runs/{id}/resume`
   */
  async resumeRun(id: string, body?: ResumeRunRequest, options?: RequestOptions): Promise<Run> {
    const data = await this.transport.json({ method: "POST", path: `/v1/runs/${encodePathParam(id, "id")}/resume`, json: convertKeys(CODEC, "ResumeRunRequest", body, "encode") }, options);
    return convertKeys(CODEC, "Run", data, "decode") as Run;
  }

  /**
   * Revoke a workspace API key
   *
   * `DELETE /v1/keys/{id}`
   */
  async revokeApiKey(id: string, options?: RequestOptions): Promise<ApiKey> {
    const data = await this.transport.json({ method: "DELETE", path: `/v1/keys/${encodePathParam(id, "id")}` }, options);
    return convertKeys(CODEC, "ApiKey", data, "decode") as ApiKey;
  }

  /**
   * Roll a deployment back to its previous artifact
   *
   * `POST /v1/deployments/{name}/rollback`
   */
  async rollbackDeployment(name: string, options?: RequestOptions): Promise<Deployment> {
    const data = await this.transport.json({ method: "POST", path: `/v1/deployments/${encodePathParam(name, "name")}/rollback` }, options);
    return convertKeys(CODEC, "Deployment", data, "decode") as Deployment;
  }

  /**
   * Ask a deployed model router which model to call
   *
   * `POST /v1/route`
   */
  async routeRequest(body: RouteRequest, options?: RequestOptions): Promise<RouteResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/route`, json: convertKeys(CODEC, "RouteRequest", body, "encode") }, options);
    return convertKeys(CODEC, "RouteResponse", data, "decode") as RouteResponse;
  }
}
