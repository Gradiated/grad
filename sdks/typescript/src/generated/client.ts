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
} from "../transport.js";
import type {
  ApiKey,
  Artifact,
  ArtifactImport,
  Checkpoint,
  CreateApiKeyRequest,
  CreateArtifactImportRequest,
  CreateDatasetRequest,
  CreateImportRequest,
  CreateSourceRequest,
  CreateUploadRequest,
  CreatedApiKey,
  Dataset,
  DatasetRecordsPage,
  EvalOutput,
  EvalRun,
  EvalTaskOutcome,
  FilterDatasetRequest,
  ImportJob,
  MetricsPage,
  PlanEvalRequest,
  PlanEvalResponse,
  PlanRunRequest,
  PlanRunResponse,
  PostEvalScoresRequest,
  PostEvalScoresResponse,
  PromoteCheckpointRequest,
  PushDatasetRequest,
  RenderDatasetRequest,
  RenderDatasetResponse,
  ResumeRunRequest,
  Run,
  RunEventsPage,
  ScoreDatasetRequest,
  Secret,
  SetSecretRequest,
  Source,
  SyncSourceRequest,
  TrainableModel,
  UpdateSourceRequest,
  UploadTicket,
  UsageRecord,
  UsageSummary,
} from "./models.js";

/** Which wire keys are renamed to camelCase, per schema (user-keyed maps are left verbatim). */
export const CODEC: CodecTable = {
  "AdapterSpec": { u: { o: { o: [["mergeOnExport", "merge_on_export", 0], ["numTokens", "num_tokens", 0]] } } },
  "ApiKey": { o: [["workspaceId", "workspace_id", 0], ["createdAt", "created_at", 0], ["revokedAt", "revoked_at", 0]] },
  "Artifact": { o: [["workspaceId", "workspace_id", 0], ["runId", "run_id", 0], ["checkpointId", "checkpoint_id", 0], ["baseModel", "base_model", 0], ["recipeKind", "recipe_kind", 0], ["sizeBytes", "size_bytes", 0], ["provenance", "provenance", "ArtifactProvenance"], ["evalReport", "eval_report", "EvalReport"], ["createdAt", "created_at", 0]] },
  "ArtifactImport": { o: [["workspaceId", "workspace_id", 0], ["baseModel", "base_model", 0], ["source", "source", { o: [["uploadId", "upload_id", 0]] }], ["artifactId", "artifact_id", 0], ["errorCode", "error_code", 0], ["createdAt", "created_at", 0], ["updatedAt", "updated_at", 0]] },
  "ArtifactImportSource": { u: { o: { o: [["uploadId", "upload_id", 0]] } } },
  "ArtifactProvenance": { o: [["runId", "run_id", 0]] },
  "AttemptEvent": { o: [["runId", "run_id", 0], ["resumeStep", "resume_step", 0], ["maxAttempts", "max_attempts", 0]] },
  "BaseArtifact": { o: [["recipeKind", "recipe_kind", 0]] },
  "ChatMessage": { o: [["toolCalls", "tool_calls", 0], ["toolCallId", "tool_call_id", 0]] },
  "Checkpoint": { o: [["workspaceId", "workspace_id", 0], ["runId", "run_id", 0], ["evalScore", "eval_score", 0], ["sizeBytes", "size_bytes", 0], ["expiresAt", "expires_at", 0], ["createdAt", "created_at", 0]] },
  "CheckpointEvalResult": { o: [["checkpointId", "checkpoint_id", 0], ["evalId", "eval_id", 0], ["datasetVersion", "dataset_version", 0], ["costUsd", "cost_usd", 0]] },
  "CheckpointEvent": { o: [["runId", "run_id", 0], ["checkpointId", "checkpoint_id", 0], ["evalScore", "eval_score", 0]] },
  "CompletedEvent": { o: [["runId", "run_id", 0], ["run", "run", "Run"]] },
  "CreateArtifactImportRequest": { o: [["source", "source", "ArtifactImportSource"], ["baseModel", "base_model", 0]] },
  "CreateImportRequest": { o: [["source", "source", "ImportSource"]] },
  "CreateSourceRequest": { o: [["sampleRate", "sample_rate", 0], ["maxRecordsPerSync", "max_records_per_sync", 0], ["maxRecordsPerDay", "max_records_per_day", 0], ["versionInterval", "version_interval", 0]] },
  "CreateUploadRequest": { o: [["sizeBytes", "size_bytes", 0]] },
  "CreatedApiKey": { o: [["key", "key", "ApiKey"]] },
  "Dataset": { o: [["workspaceId", "workspace_id", 0], ["recordCount", "record_count", 0], ["createdAt", "created_at", 0], ["updatedAt", "updated_at", 0]] },
  "DatasetRecord": { o: [["sessionId", "session_id", 0], ["groupId", "group_id", 0], ["messages", "messages", { a: "ChatMessage" }], ["input", "input", "TrajectoryInput"], ["output", "output", "TrajectoryOutput"], ["prompt", "prompt", { u: { a: { a: "ChatMessage" } } }], ["completion", "completion", { u: { a: { a: "ChatMessage" } } }], ["chosen", "chosen", { u: { a: { a: "ChatMessage" } } }], ["rejected", "rejected", { u: { a: { a: "ChatMessage" } } }], ["expectedOutput", "expected_output", 0]] },
  "DatasetRecordsPage": { o: [["data", "data", { a: "DatasetRecord" }], ["nextCursor", "next_cursor", 0]] },
  "DecisionHeadReport": { o: [["macroF1", "macro_f1", 0], ["perOption", "per_option", 0], ["confusionMatrix", "confusion_matrix", 0]] },
  "EvalModelSummary": { o: [["ciLow", "ci_low", 0], ["ciHigh", "ci_high", 0], ["passAtK", "pass_at_k", 0], ["vsBaseline", "vs_baseline", { o: [["ciLow", "ci_low", 0], ["ciHigh", "ci_high", 0]] }], ["tokensPerTask", "tokens_per_task", 0], ["costPer1kTasksUsd", "cost_per_1k_tasks_usd", 0]] },
  "EvalOutput": { o: [["evalId", "eval_id", 0], ["taskId", "task_id", 0], ["sampleIndex", "sample_index", 0], ["input", "input", { a: "ChatMessage" }], ["expectedOutput", "expected_output", 0], ["record", "record", "DatasetRecord"], ["usage", "usage", { o: [["promptTokens", "prompt_tokens", 0], ["completionTokens", "completion_tokens", 0]] }]] },
  "EvalReport": { o: [["metricName", "metric_name", 0], ["metricMode", "metric_mode", 0], ["selectedStep", "selected_step", 0], ["bestStep", "best_step", 0], ["finalStep", "final_step", 0], ["trainRecords", "train_records", 0], ["evalRecords", "eval_records", 0], ["evalLoss", "eval_loss", 0], ["evalTokenAccuracy", "eval_token_accuracy", 0], ["trainedTokenFraction", "trained_token_fraction", 0], ["trainExamples", "train_examples", 0], ["evalExamples", "eval_examples", 0], ["selectionExamples", "selection_examples", 0], ["preferenceAccuracy", "preference_accuracy", 0], ["rewardMargin", "reward_margin", 0], ["trainPairs", "train_pairs", 0], ["evalPairs", "eval_pairs", 0], ["droppedRecords", "dropped_records", 0], ["trainPoints", "train_points", 0], ["evalPoints", "eval_points", 0], ["pointwiseBrier", "pointwise_brier", 0], ["evalKl", "eval_kl", 0], ["baseKl", "base_kl", 0], ["noContextKl", "no_context_kl", 0], ["klReduction", "kl_reduction", 0], ["numTokens", "num_tokens", 0], ["fallbackModel", "fallback_model", 0], ["fallbackQuality", "fallback_quality", 0], ["routesAnyTraffic", "routes_any_traffic", 0], ["paretoSummary", "pareto_summary", "RouterParetoSummary"], ["heads", "heads", { m: "DecisionHeadReport" }], ["recallAt1", "recall_at_1", 0], ["recallAt5", "recall_at_5", 0], ["recallAt10", "recall_at_10", 0], ["corpusSize", "corpus_size", 0], ["baseline", "baseline", { o: [["recallAt1", "recall_at_1", 0], ["recallAt5", "recall_at_5", 0], ["recallAt10", "recall_at_10", 0]] }]] },
  "EvalRun": { o: [["workspaceId", "workspace_id", 0], ["taskSource", "task_source", 0], ["maxTokens", "max_tokens", 0], ["passThreshold", "pass_threshold", 0], ["judgeModels", "judge_models", 0], ["localScorers", "local_scorers", 0], ["progress", "progress", { o: [["totalOutputs", "total_outputs", 0], ["pendingLocalScores", "pending_local_scores", 0]] }], ["summary", "summary", { a: "EvalModelSummary" }], ["totalCostUsd", "total_cost_usd", 0], ["scoredDatasetVersion", "scored_dataset_version", 0], ["createdAt", "created_at", 0], ["updatedAt", "updated_at", 0], ["completedAt", "completed_at", 0]] },
  "EvalTaskOutcome": { o: [["taskId", "task_id", 0], ["sampleScores", "sample_scores", 0], ["judgeModel", "judge_model", 0], ["record", "record", "DatasetRecord"]] },
  "FilterDatasetRequest": { o: [["createdAfter", "created_after", 0], ["createdBefore", "created_before", 0]] },
  "GpuInfo": { o: [["memoryGb", "memory_gb", 0]] },
  "ImportJob": { o: [["workspaceId", "workspace_id", 0], ["importedCount", "imported_count", 0], ["droppedCount", "dropped_count", 0], ["detectedScores", "detected_scores", 0], ["dropReasons", "drop_reasons", 0], ["datasetVersion", "dataset_version", 0], ["createdAt", "created_at", 0], ["updatedAt", "updated_at", 0]] },
  "ImportSource": { u: { o: { o: [["uploadId", "upload_id", 0]] } } },
  "LogEvent": { o: [["runId", "run_id", 0]] },
  "LoggerSpec": { u: { o: { o: [["runName", "run_name", 0], ["trackingUri", "tracking_uri", 0]] } } },
  "LossSpec": { u: { o: { o: [["topK", "top_k", 0]] } } },
  "MetricEvent": { o: [["runId", "run_id", 0], ["metric", "metric", "MetricPoint"]] },
  "MetricPoint": { o: [["evalLoss", "eval_loss", 0], ["evalMetrics", "eval_metrics", 0], ["gradNorm", "grad_norm", 0], ["tokensPerSec", "tokens_per_sec", 0], ["costUsd", "cost_usd", 0]] },
  "MetricsPage": { o: [["runId", "run_id", 0], ["data", "data", { a: "MetricPoint" }], ["nextCursor", "next_cursor", 0], ["tailCursor", "tail_cursor", 0]] },
  "OptimizerSpec": { o: [["weightDecay", "weight_decay", 0], ["gradClip", "grad_clip", 0]] },
  "PhaseEvent": { o: [["runId", "run_id", 0], ["workersOnline", "workers_online", 0], ["queuePosition", "queue_position", 0], ["gpu", "gpu", "GpuInfo"]] },
  "PlanCostBreakdown": { o: [["trainUsd", "train_usd", 0], ["teacherUsd", "teacher_usd", 0], ["evalUsd", "eval_usd", 0]] },
  "PlanEvalRequest": { o: [["datasetVersion", "dataset_version", 0], ["maxTokens", "max_tokens", 0], ["passThreshold", "pass_threshold", 0]] },
  "PlanEvalResponse": { o: [["taskSourceKind", "task_source_kind", 0], ["datasetVersion", "dataset_version", 0], ["estimatedTasks", "estimated_tasks", 0], ["estimatedModelCalls", "estimated_model_calls", 0], ["estimatedJudgeCalls", "estimated_judge_calls", 0], ["estimatedCostUsd", "estimated_cost_usd", 0], ["judgeModels", "judge_models", 0], ["localScorers", "local_scorers", 0], ["passThreshold", "pass_threshold", 0]] },
  "PlanRunRequest": { o: [["recipe", "recipe", "RecipeSpec"], ["split", "split", "SplitSpec"], ["maxCostUsd", "max_cost_usd", 0]] },
  "PlanRunResponse": { o: [["resolvedConfig", "resolved_config", "ResolvedRunConfig"], ["datasetVersion", "dataset_version", 0], ["usableRecords", "usable_records", 0], ["totalRecords", "total_records", 0], ["estimatedSteps", "estimated_steps", 0], ["estimatedTokens", "estimated_tokens", 0], ["estimatedCostUsd", "estimated_cost_usd", 0], ["estimatedDurationS", "estimated_duration_s", 0], ["minGpuMemoryGb", "min_gpu_memory_gb", 0], ["pricePerMillionTokens", "price_per_million_tokens", 0], ["trainedTokenFraction", "trained_token_fraction", 0], ["labeling", "labeling", { o: [["estimatedModelCalls", "estimated_model_calls", 0], ["estimatedJudgeCalls", "estimated_judge_calls", 0], ["estimatedCostUsd", "estimated_cost_usd", 0]] }], ["teacher", "teacher", { o: [["pricePerMillionTokens", "price_per_million_tokens", 0], ["estimatedTokens", "estimated_tokens", 0], ["estimatedCostUsd", "estimated_cost_usd", 0]] }], ["costBreakdown", "cost_breakdown", "PlanCostBreakdown"]] },
  "PostEvalScoresRequest": { o: [["scores", "scores", { a: { o: [["outputId", "output_id", 0]] } }]] },
  "PostEvalScoresResponse": { o: [["pendingLocalScores", "pending_local_scores", 0]] },
  "PushDatasetRequest": { o: [["records", "records", { a: "DatasetRecord" }]] },
  "RecipeSpec": { o: [["adapter", "adapter", "AdapterSpec"], ["lrScale", "lr_scale", 0], ["batchSize", "batch_size", 0], ["trainOn", "train_on", 0], ["preserveThinking", "preserve_thinking", 0], ["checkpointTtlDays", "checkpoint_ttl_days", 0], ["maxQualityDrop", "max_quality_drop", 0], ["contextText", "context_text", 0], ["numTokens", "num_tokens", 0], ["rollout", "rollout", "RolloutSpec"], ["optimizer", "optimizer", "OptimizerSpec"], ["evalEvery", "eval_every", 0], ["loss", "loss", "LossSpec"], ["maxNewTokens", "max_new_tokens", 0], ["slotToken", "slot_token", 0], ["loggers", "loggers", { a: "LoggerSpec" }]] },
  "RenderDatasetRequest": { o: [["trainOn", "train_on", 0], ["preserveThinking", "preserve_thinking", 0]] },
  "RenderDatasetResponse": { o: [["templateRevision", "template_revision", 0], ["tokenCounts", "token_counts", 0], ["examples", "examples", { a: { o: [["recordId", "record_id", 0], ["templateRevision", "template_revision", 0], ["totalTokens", "total_tokens", 0], ["trainedTokens", "trained_tokens", 0], ["trainedFraction", "trained_fraction", 0]] } }]] },
  "ResolvedRunConfig": { o: [["ruleVersion", "rule_version", 0], ["datasetVersion", "dataset_version", 0], ["recipeKind", "recipe_kind", 0], ["templateRevision", "template_revision", 0], ["adapter", "adapter", { u: { o: { o: [["mergeOnExport", "merge_on_export", 0], ["numTokens", "num_tokens", 0]] } } }], ["lrSource", "lr_source", 0], ["batchSize", "batch_size", 0], ["trainOn", "train_on", 0], ["preserveThinking", "preserve_thinking", 0], ["checkpointEverySteps", "checkpoint_every_steps", 0], ["evalEverySteps", "eval_every_steps", 0], ["optimizer", "optimizer", "OptimizerSpec"], ["checkpointTtlDays", "checkpoint_ttl_days", 0], ["split", "split", { o: [["evalFraction", "eval_fraction", 0], ["trainRecords", "train_records", 0], ["evalRecords", "eval_records", 0]] }], ["labelEvalId", "label_eval_id", 0], ["baseArtifact", "base_artifact", "BaseArtifact"], ["recipeParams", "recipe_params", 0], ["checkpointEvals", "checkpoint_evals", { a: { o: [["datasetVersion", "dataset_version", 0]] } }], ["loggers", "loggers", { a: "LoggerSpec" }]] },
  "ResumeRunRequest": { o: [["maxCostUsd", "max_cost_usd", 0]] },
  "RolloutSpec": { u: { o: { o: [["maxNewTokens", "max_new_tokens", 0]] } } },
  "RouterParetoSummary": { o: [["targetMaxDrop", "target_max_drop", 0], ["routedQuality", "routed_quality", 0], ["qualityDrop", "quality_drop", 0], ["qualityDropCi95", "quality_drop_ci95", 0], ["offloadRate", "offload_rate", 0], ["costSavingsPct", "cost_savings_pct", 0]] },
  "Run": { o: [["workspaceId", "workspace_id", 0], ["datasetId", "dataset_id", 0], ["datasetName", "dataset_name", 0], ["datasetVersion", "dataset_version", 0], ["recipeKind", "recipe_kind", 0], ["resolvedConfig", "resolved_config", "ResolvedRunConfig"], ["maxCostUsd", "max_cost_usd", 0], ["pricePerMillionTokens", "price_per_million_tokens", 0], ["tokensProcessed", "tokens_processed", 0], ["costUsd", "cost_usd", 0], ["currentStep", "current_step", 0], ["totalSteps", "total_steps", 0], ["maxAttempts", "max_attempts", 0], ["phaseSince", "phase_since", 0], ["lastInterruption", "last_interruption", "RunInterruption"], ["workersOnline", "workers_online", 0], ["queuePosition", "queue_position", 0], ["queueMessage", "queue_message", 0], ["minGpuMemoryGb", "min_gpu_memory_gb", 0], ["latestMetric", "latest_metric", "MetricPoint"], ["evalReport", "eval_report", "EvalReport"], ["checkpointEvals", "checkpoint_evals", { a: "CheckpointEvalResult" }], ["artifactId", "artifact_id", 0], ["createdAt", "created_at", 0], ["updatedAt", "updated_at", 0], ["finishedAt", "finished_at", 0]] },
  "RunEvent": { d: ["type", { "phase": "PhaseEvent", "metric": "MetricEvent", "checkpoint": "CheckpointEvent", "attempt": "AttemptEvent", "warning": "WarningEvent", "log": "LogEvent", "completed": "CompletedEvent" }] },
  "RunEventsPage": { o: [["runId", "run_id", 0], ["data", "data", { a: "RunEvent" }], ["nextCursor", "next_cursor", 0], ["tailCursor", "tail_cursor", 0]] },
  "RunInterruption": { o: [["resumeStep", "resume_step", 0]] },
  "Secret": { o: [["workspaceId", "workspace_id", 0], ["allowedHosts", "allowed_hosts", 0], ["createdAt", "created_at", 0], ["updatedAt", "updated_at", 0]] },
  "SetSecretRequest": { o: [["allowedHosts", "allowed_hosts", 0]] },
  "Source": { o: [["workspaceId", "workspace_id", 0], ["sampleRate", "sample_rate", 0], ["maxRecordsPerSync", "max_records_per_sync", 0], ["maxRecordsPerDay", "max_records_per_day", 0], ["recordsToday", "records_today", 0], ["versionInterval", "version_interval", 0], ["pendingRecords", "pending_records", 0], ["nextSyncAt", "next_sync_at", 0], ["pausedReason", "paused_reason", 0], ["lastError", "last_error", 0], ["lastErrorAt", "last_error_at", 0], ["consecutiveFailures", "consecutive_failures", 0], ["pendingFull", "pending_full", 0], ["lastSyncedAt", "last_synced_at", 0], ["lastSync", "last_sync", "SourceSync"], ["createdAt", "created_at", 0], ["updatedAt", "updated_at", 0]] },
  "SourceSync": { o: [["importId", "import_id", 0], ["datasetVersion", "dataset_version", 0], ["createdAt", "created_at", 0], ["finishedAt", "finished_at", 0]] },
  "SplitSpec": { o: [["evalFraction", "eval_fraction", 0]] },
  "TrainableModel": { o: [["hfRepo", "hf_repo", 0], ["defaultFor", "default_for", 0], ["pricePerMillionTokensUsd", "price_per_million_tokens_usd", 0], ["maxContextTokens", "max_context_tokens", 0], ["templateRevision", "template_revision", 0], ["calibratedLrs", "calibrated_lrs", 0], ["minGpuMemoryGb", "min_gpu_memory_gb", 0]] },
  "TrajectoryInput": { o: [["messages", "messages", { a: "ChatMessage" }]] },
  "TrajectoryOutput": { o: [["turns", "turns", { a: "ChatMessage" }]] },
  "UpdateSourceRequest": { o: [["sampleRate", "sample_rate", 0], ["maxRecordsPerSync", "max_records_per_sync", 0], ["maxRecordsPerDay", "max_records_per_day", 0], ["versionInterval", "version_interval", 0]] },
  "UploadTicket": { o: [["uploadId", "upload_id", 0], ["expiresAt", "expires_at", 0]] },
  "UsageGroup": { o: [["costUsd", "cost_usd", 0]] },
  "UsageKindTotal": { o: [["costUsd", "cost_usd", 0]] },
  "UsageRecord": { o: [["refId", "ref_id", 0], ["refName", "ref_name", 0], ["runId", "run_id", 0], ["tokensFrom", "tokens_from", 0], ["tokensThrough", "tokens_through", 0], ["costUsd", "cost_usd", 0], ["priceVersion", "price_version", 0], ["idempotencyKey", "idempotency_key", 0], ["createdAt", "created_at", 0]] },
  "UsageRefTotal": { o: [["costUsd", "cost_usd", 0]] },
  "UsageSummary": { o: [["costUsd", "cost_usd", 0], ["byKind", "by_kind", { a: "UsageKindTotal" }], ["topRuns", "top_runs", { a: "UsageRefTotal" }], ["topEvals", "top_evals", { a: "UsageRefTotal" }], ["groupBy", "group_by", 0], ["groups", "groups", { a: "UsageGroup" }]] },
  "WarningEvent": { o: [["runId", "run_id", 0]] },
};

export interface GetUsageSummaryParams {
  /** Start of the period (inclusive): YYYY-MM-DD (UTC) or an ISO 8601 timestamp. */
  from?: string | undefined;
  /** End of the period: a date YYYY-MM-DD covers that whole UTC day; a timestamp is exclusive. */
  to?: string | undefined;
  groupBy?: "day" | "week" | "month" | "model" | "recipe" | "kind" | undefined;
}

export interface ListApiKeysParams {
  /** Page size (default 50). Values above 200 are clamped to 200. */
  limit?: number | undefined;
  cursor?: string | undefined;
}

export type ListApiKeysResponse = {
  data: Array<ApiKey>;
  /** Pass back as `cursor` for the next page; null on the last page (every list endpoint). */
  nextCursor: string | null;
};

export interface ListArtifactsParams {
  /** Page size (default 50). Values above 200 are clamped to 200. */
  limit?: number | undefined;
  cursor?: string | undefined;
  name?: string | undefined;
}

export type ListArtifactsResponse = {
  data: Array<Artifact>;
  /** Pass back as `cursor` for the next page; null on the last page (every list endpoint). */
  nextCursor: string | null;
};

export type ListBaseModelsResponse = {
  data: Array<TrainableModel>;
};

export interface ListDatasetRecordsParams {
  version?: number | undefined;
  /** Page size (default 100). Values above 1000 are clamped to 1000. */
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface ListDatasetsParams {
  /** Page size (default 50). Values above 200 are clamped to 200. */
  limit?: number | undefined;
  cursor?: string | undefined;
}

export type ListDatasetsResponse = {
  data: Array<Dataset>;
  /** Pass back as `cursor` for the next page; null on the last page (every list endpoint). */
  nextCursor: string | null;
};

export interface ListEvalFailuresParams {
  /** Page size (default 50). Values above 200 are clamped to 200. */
  limit?: number | undefined;
  cursor?: string | undefined;
  model?: string | undefined;
  threshold?: number | undefined;
}

export type ListEvalFailuresResponse = {
  evalId: string;
  data: Array<EvalTaskOutcome>;
  /** Pass back as `cursor` for the next page; null on the last page (every list endpoint). */
  nextCursor: string | null;
};

export interface ListEvalOutputsParams {
  /** Page size (default 50). Values above 200 are clamped to 200. */
  limit?: number | undefined;
  cursor?: string | undefined;
  model?: string | undefined;
  missingScorer?: string | undefined;
}

export type ListEvalOutputsResponse = {
  data: Array<EvalOutput>;
  /** Pass back as `cursor` for the next page; null on the last page (every list endpoint). */
  nextCursor: string | null;
};

export interface ListEvalResultsParams {
  /** Page size (default 50). Values above 200 are clamped to 200. */
  limit?: number | undefined;
  cursor?: string | undefined;
  model?: string | undefined;
}

export type ListEvalResultsResponse = {
  data: Array<EvalTaskOutcome>;
  /** Pass back as `cursor` for the next page; null on the last page (every list endpoint). */
  nextCursor: string | null;
};

export interface ListEvalsParams {
  /** Page size (default 50). Values above 200 are clamped to 200. */
  limit?: number | undefined;
  cursor?: string | undefined;
}

export type ListEvalsResponse = {
  data: Array<EvalRun>;
  /** Pass back as `cursor` for the next page; null on the last page (every list endpoint). */
  nextCursor: string | null;
};

export interface ListImportsParams {
  /** Page size (default 50). Values above 200 are clamped to 200. */
  limit?: number | undefined;
  cursor?: string | undefined;
}

export type ListImportsResponse = {
  data: Array<ImportJob>;
  /** Pass back as `cursor` for the next page; null on the last page (every list endpoint). */
  nextCursor: string | null;
};

export interface ListRunCheckpointsParams {
  /** Page size (default 50). Values above 200 are clamped to 200. */
  limit?: number | undefined;
  cursor?: string | undefined;
}

export type ListRunCheckpointsResponse = {
  data: Array<Checkpoint>;
  /** Pass back as `cursor` for the next page; null on the last page (every list endpoint). */
  nextCursor: string | null;
};

export interface ListRunEventsParams {
  cursor?: string | undefined;
  /** Page size (default 1000). Values above 5000 are clamped to 5000. */
  limit?: number | undefined;
}

export interface ListRunMetricsParams {
  cursor?: string | undefined;
  afterStep?: number | undefined;
  /** Page size (default 1000). Values above 5000 are clamped to 5000. */
  limit?: number | undefined;
}

export interface ListRunsParams {
  /** Page size (default 50). Values above 200 are clamped to 200. */
  limit?: number | undefined;
  cursor?: string | undefined;
}

export type ListRunsResponse = {
  data: Array<Run>;
  /** Pass back as `cursor` for the next page; null on the last page (every list endpoint). */
  nextCursor: string | null;
};

export interface ListSecretsParams {
  /** Page size (default 50). Values above 200 are clamped to 200. */
  limit?: number | undefined;
  cursor?: string | undefined;
}

export type ListSecretsResponse = {
  data: Array<Secret>;
  /** Pass back as `cursor` for the next page; null on the last page (every list endpoint). */
  nextCursor: string | null;
};

export interface ListSourcesParams {
  /** Page size (default 50). Values above 200 are clamped to 200. */
  limit?: number | undefined;
  cursor?: string | undefined;
  dataset?: string | undefined;
}

export type ListSourcesResponse = {
  data: Array<Source>;
  /** Pass back as `cursor` for the next page; null on the last page (every list endpoint). */
  nextCursor: string | null;
};

export interface ListUsageParams {
  /** Page size (default 50). Values above 200 are clamped to 200. */
  limit?: number | undefined;
  cursor?: string | undefined;
  /** Start of the period (inclusive): YYYY-MM-DD (UTC) or an ISO 8601 timestamp. */
  from?: string | undefined;
  /** End of the period: a date YYYY-MM-DD covers that whole UTC day; a timestamp is exclusive. */
  to?: string | undefined;
  /** Only usage billed for this run: its training and the evals it started (labeling, teacher answers, checkpoint evals). */
  runId?: string | undefined;
  evalId?: string | undefined;
  kind?: "training" | "eval" | "scoring" | "labeling" | "teacher" | undefined;
}

export type ListUsageResponse = {
  data: Array<UsageRecord>;
  /** Pass back as `cursor` for the next page; null on the last page (every list endpoint). */
  nextCursor: string | null;
};

/** Largest `limit` accepted by `listApiKeys` (the server clamps larger values). */
export const LIST_API_KEYS_LIMIT_MAX = 200;
/** Largest `limit` accepted by `listArtifacts` (the server clamps larger values). */
export const LIST_ARTIFACTS_LIMIT_MAX = 200;
/** Largest `limit` accepted by `listDatasetRecords` (the server clamps larger values). */
export const LIST_DATASET_RECORDS_LIMIT_MAX = 1000;
/** Largest `limit` accepted by `listDatasets` (the server clamps larger values). */
export const LIST_DATASETS_LIMIT_MAX = 200;
/** Largest `limit` accepted by `listEvalFailures` (the server clamps larger values). */
export const LIST_EVAL_FAILURES_LIMIT_MAX = 200;
/** Largest `limit` accepted by `listEvalOutputs` (the server clamps larger values). */
export const LIST_EVAL_OUTPUTS_LIMIT_MAX = 200;
/** Largest `limit` accepted by `listEvalResults` (the server clamps larger values). */
export const LIST_EVAL_RESULTS_LIMIT_MAX = 200;
/** Largest `limit` accepted by `listEvals` (the server clamps larger values). */
export const LIST_EVALS_LIMIT_MAX = 200;
/** Largest `limit` accepted by `listImports` (the server clamps larger values). */
export const LIST_IMPORTS_LIMIT_MAX = 200;
/** Largest `limit` accepted by `listRunCheckpoints` (the server clamps larger values). */
export const LIST_RUN_CHECKPOINTS_LIMIT_MAX = 200;
/** Largest `limit` accepted by `listRunEvents` (the server clamps larger values). */
export const LIST_RUN_EVENTS_LIMIT_MAX = 5000;
/** Largest `limit` accepted by `listRunMetrics` (the server clamps larger values). */
export const LIST_RUN_METRICS_LIMIT_MAX = 5000;
/** Largest `limit` accepted by `listRuns` (the server clamps larger values). */
export const LIST_RUNS_LIMIT_MAX = 200;
/** Largest `limit` accepted by `listSecrets` (the server clamps larger values). */
export const LIST_SECRETS_LIMIT_MAX = 200;
/** Largest `limit` accepted by `listSources` (the server clamps larger values). */
export const LIST_SOURCES_LIMIT_MAX = 200;
/** Largest `limit` accepted by `listUsage` (the server clamps larger values). */
export const LIST_USAGE_LIMIT_MAX = 200;

/** Low-level client: one typed method per OpenAPI operation. */
export class ApiClient {
  constructor(readonly transport: TransportLike) {}

  /**
   * Cancel a queued, running or awaiting_scores evaluation
   *
   * `POST /v1/evals/{id}/cancel`
   */
  async cancelEval(id: string, options?: RequestOptions): Promise<EvalRun> {
    const data = await this.transport.json({ method: "POST", path: `/v1/evals/${encodePathParam(id, "id")}/cancel`, idempotent: true }, options);
    return convertKeys(CODEC, "EvalRun", data, "decode") as EvalRun;
  }

  /**
   * Cancel a training run (a running attempt is stopped and billed)
   *
   * `POST /v1/runs/{id}/cancel`
   */
  async cancelRun(id: string, options?: RequestOptions): Promise<Run> {
    const data = await this.transport.json({ method: "POST", path: `/v1/runs/${encodePathParam(id, "id")}/cancel`, idempotent: true }, options);
    return convertKeys(CODEC, "Run", data, "decode") as Run;
  }

  /**
   * Create a scoped workspace API key (trainer worker keys are platform config, not keys)
   *
   * `POST /v1/keys`
   */
  async createApiKey(body: CreateApiKeyRequest, options?: RequestOptions): Promise<CreatedApiKey> {
    const data = await this.transport.json({ method: "POST", path: `/v1/keys`, json: body, idempotent: true }, options);
    return convertKeys(CODEC, "CreatedApiKey", data, "decode") as CreatedApiKey;
  }

  /**
   * Register uploaded files or a Hugging Face repo as an artifact (async import job)
   *
   * `POST /v1/artifact-imports`
   */
  async createArtifactImport(body: CreateArtifactImportRequest, options?: RequestOptions): Promise<ArtifactImport> {
    const data = await this.transport.json({ method: "POST", path: `/v1/artifact-imports`, json: convertKeys(CODEC, "CreateArtifactImportRequest", body, "encode"), idempotent: true }, options);
    return convertKeys(CODEC, "ArtifactImport", data, "decode") as ArtifactImport;
  }

  /**
   * Create an empty dataset
   *
   * `POST /v1/datasets`
   */
  async createDataset(body: CreateDatasetRequest, options?: RequestOptions): Promise<Dataset> {
    const data = await this.transport.json({ method: "POST", path: `/v1/datasets`, json: body, idempotent: true }, options);
    return convertKeys(CODEC, "Dataset", data, "decode") as Dataset;
  }

  /**
   * Import an uploaded file or a Hugging Face dataset into a dataset (async job)
   *
   * `POST /v1/datasets/{name}/imports`
   */
  async createDatasetImport(name: string, body: CreateImportRequest, options?: RequestOptions): Promise<ImportJob> {
    const data = await this.transport.json({ method: "POST", path: `/v1/datasets/${encodePathParam(name, "name")}/imports`, json: convertKeys(CODEC, "CreateImportRequest", body, "encode"), idempotent: true }, options);
    return convertKeys(CODEC, "ImportJob", data, "decode") as ImportJob;
  }

  /**
   * Connect an observability provider to a dataset
   *
   * `POST /v1/datasets/{name}/sources`
   */
  async createDatasetSource(name: string, body: CreateSourceRequest, options?: RequestOptions): Promise<Source> {
    const data = await this.transport.json({ method: "POST", path: `/v1/datasets/${encodePathParam(name, "name")}/sources`, json: convertKeys(CODEC, "CreateSourceRequest", body, "encode"), idempotent: true }, options);
    return convertKeys(CODEC, "Source", data, "decode") as Source;
  }

  /**
   * Queue an evaluation across models on a pinned dataset version (executed by the server)
   *
   * `POST /v1/evals`
   */
  async createEval(body: PlanEvalRequest, options?: RequestOptions): Promise<EvalRun> {
    const data = await this.transport.json({ method: "POST", path: `/v1/evals`, json: convertKeys(CODEC, "PlanEvalRequest", body, "encode"), idempotent: true }, options);
    return convertKeys(CODEC, "EvalRun", data, "decode") as EvalRun;
  }

  /**
   * Create and enqueue a training run (pins the dataset version)
   *
   * `POST /v1/runs`
   */
  async createRun(body: PlanRunRequest, options?: RequestOptions): Promise<Run> {
    const data = await this.transport.json({ method: "POST", path: `/v1/runs`, json: convertKeys(CODEC, "PlanRunRequest", body, "encode"), idempotent: true }, options);
    return convertKeys(CODEC, "Run", data, "decode") as Run;
  }

  /**
   * Get an upload URL for a file to import (PUT the bytes, then create a dataset or artifact import)
   *
   * `POST /v1/uploads`
   */
  async createUpload(body: CreateUploadRequest, options?: RequestOptions): Promise<UploadTicket> {
    const data = await this.transport.json({ method: "POST", path: `/v1/uploads`, json: convertKeys(CODEC, "CreateUploadRequest", body, "encode"), idempotent: true }, options);
    return convertKeys(CODEC, "UploadTicket", data, "decode") as UploadTicket;
  }

  /**
   * Delete a released artifact and its bundle (409 artifact_pinned while a holder pins it)
   *
   * `DELETE /v1/artifacts/{id}`
   */
  async deleteArtifact(id: string, options?: RequestOptions): Promise<void> {
    await this.transport.json({ method: "DELETE", path: `/v1/artifacts/${encodePathParam(id, "id")}` }, options);
  }

  /**
   * Delete a secret (409 while a source uses it)
   *
   * `DELETE /v1/secrets/{name}`
   */
  async deleteSecret(name: string, options?: RequestOptions): Promise<void> {
    await this.transport.json({ method: "DELETE", path: `/v1/secrets/${encodePathParam(name, "name")}` }, options);
  }

  /**
   * Remove a source (its dataset and versions stay)
   *
   * `DELETE /v1/sources/{id}`
   */
  async deleteSource(id: string, options?: RequestOptions): Promise<void> {
    await this.transport.json({ method: "DELETE", path: `/v1/sources/${encodePathParam(id, "id")}` }, options);
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
   * Save a filtered view of a dataset version
   *
   * `POST /v1/datasets/{name}/filter`
   */
  async filterDataset(name: string, body: FilterDatasetRequest, options?: RequestOptions): Promise<Dataset> {
    const data = await this.transport.json({ method: "POST", path: `/v1/datasets/${encodePathParam(name, "name")}/filter`, json: convertKeys(CODEC, "FilterDatasetRequest", body, "encode"), idempotent: true }, options);
    return convertKeys(CODEC, "Dataset", data, "decode") as Dataset;
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
   * Get an artifact import
   *
   * `GET /v1/artifact-imports/{id}`
   */
  async getArtifactImport(id: string, options?: RequestOptions): Promise<ArtifactImport> {
    const data = await this.transport.json({ method: "GET", path: `/v1/artifact-imports/${encodePathParam(id, "id")}` }, options);
    return convertKeys(CODEC, "ArtifactImport", data, "decode") as ArtifactImport;
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
   * Get a secret's metadata (never the value)
   *
   * `GET /v1/secrets/{name}`
   */
  async getSecret(name: string, options?: RequestOptions): Promise<Secret> {
    const data = await this.transport.json({ method: "GET", path: `/v1/secrets/${encodePathParam(name, "name")}` }, options);
    return convertKeys(CODEC, "Secret", data, "decode") as Secret;
  }

  /**
   * Get a source and its latest sync
   *
   * `GET /v1/sources/{id}`
   */
  async getSource(id: string, options?: RequestOptions): Promise<Source> {
    const data = await this.transport.json({ method: "GET", path: `/v1/sources/${encodePathParam(id, "id")}` }, options);
    return convertKeys(CODEC, "Source", data, "decode") as Source;
  }

  /**
   * Total cost and tokens over a period (default: this UTC month), by kind, the top runs and evals, and optional groups
   *
   * `GET /v1/usage/summary`
   */
  async getUsageSummary(params?: GetUsageSummaryParams, options?: RequestOptions): Promise<UsageSummary> {
    const data = await this.transport.json({ method: "GET", path: `/v1/usage/summary`, query: [["from", params?.from], ["to", params?.to], ["group_by", params?.groupBy]] }, options);
    return convertKeys(CODEC, "UsageSummary", data, "decode") as UsageSummary;
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
   * List trainable base models (the server catalog and price source)
   *
   * `GET /v1/base-models`
   */
  async listBaseModels(options?: RequestOptions): Promise<ListBaseModelsResponse> {
    const data = await this.transport.json({ method: "GET", path: `/v1/base-models` }, options);
    return convertKeys(CODEC, { o: [["data", "data", { a: "TrainableModel" }]] }, data, "decode") as ListBaseModelsResponse;
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
   * List unexpired checkpoints of a run (best and final never expire)
   *
   * `GET /v1/runs/{id}/checkpoints`
   */
  async listRunCheckpoints(id: string, params?: ListRunCheckpointsParams, options?: RequestOptions): Promise<ListRunCheckpointsResponse> {
    const data = await this.transport.json({ method: "GET", path: `/v1/runs/${encodePathParam(id, "id")}/checkpoints`, query: [["limit", params?.limit], ["cursor", params?.cursor]] }, options);
    return convertKeys(CODEC, { o: [["data", "data", { a: "Checkpoint" }], ["nextCursor", "next_cursor", 0]] }, data, "decode") as ListRunCheckpointsResponse;
  }

  /**
   * A run's lifecycle events (phases, metrics, checkpoints, attempts, warnings, logs)
   *
   * `GET /v1/runs/{id}/events`
   */
  async listRunEvents(id: string, params?: ListRunEventsParams, options?: RequestOptions): Promise<RunEventsPage> {
    const data = await this.transport.json({ method: "GET", path: `/v1/runs/${encodePathParam(id, "id")}/events`, query: [["cursor", params?.cursor], ["limit", params?.limit]] }, options);
    return convertKeys(CODEC, "RunEventsPage", data, "decode") as RunEventsPage;
  }

  /**
   * A run's lifecycle events (phases, metrics, checkpoints, attempts, warnings, logs) (Server-Sent Events; one connection, resume with `lastEventId`)
   */
  listRunEventsStream(id: string, params?: ListRunEventsParams, options?: SSEOptions): AsyncGenerator<ServerSentEvent, void, undefined> {
    return this.transport.sse({ method: "GET", path: `/v1/runs/${encodePathParam(id, "id")}/events`, query: [["cursor", params?.cursor], ["limit", params?.limit]] }, options);
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
   * List workspace secrets (names and metadata only)
   *
   * `GET /v1/secrets`
   */
  async listSecrets(params?: ListSecretsParams, options?: RequestOptions): Promise<ListSecretsResponse> {
    const data = await this.transport.json({ method: "GET", path: `/v1/secrets`, query: [["limit", params?.limit], ["cursor", params?.cursor]] }, options);
    return convertKeys(CODEC, { o: [["data", "data", { a: "Secret" }], ["nextCursor", "next_cursor", 0]] }, data, "decode") as ListSecretsResponse;
  }

  /**
   * List sources (newest first), optionally for one dataset
   *
   * `GET /v1/sources`
   */
  async listSources(params?: ListSourcesParams, options?: RequestOptions): Promise<ListSourcesResponse> {
    const data = await this.transport.json({ method: "GET", path: `/v1/sources`, query: [["limit", params?.limit], ["cursor", params?.cursor], ["dataset", params?.dataset]] }, options);
    return convertKeys(CODEC, { o: [["data", "data", { a: "Source" }], ["nextCursor", "next_cursor", 0]] }, data, "decode") as ListSourcesResponse;
  }

  /**
   * List billed usage, newest first (filter by period, run, eval or kind): one record per billed increment of a run or eval attempt
   *
   * `GET /v1/usage`
   */
  async listUsage(params?: ListUsageParams, options?: RequestOptions): Promise<ListUsageResponse> {
    const data = await this.transport.json({ method: "GET", path: `/v1/usage`, query: [["limit", params?.limit], ["cursor", params?.cursor], ["from", params?.from], ["to", params?.to], ["run_id", params?.runId], ["eval_id", params?.evalId], ["kind", params?.kind]] }, options);
    return convertKeys(CODEC, { o: [["data", "data", { a: "UsageRecord" }], ["nextCursor", "next_cursor", 0]] }, data, "decode") as ListUsageResponse;
  }

  /**
   * Estimate tasks, model/judge calls, and cost before running an eval
   *
   * `POST /v1/evals/plan`
   */
  async planEval(body: PlanEvalRequest, options?: RequestOptions): Promise<PlanEvalResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/evals/plan`, json: convertKeys(CODEC, "PlanEvalRequest", body, "encode"), idempotent: true }, options);
    return convertKeys(CODEC, "PlanEvalResponse", data, "decode") as PlanEvalResponse;
  }

  /**
   * Dry-run a training recipe at zero cost
   *
   * `POST /v1/runs/plan`
   */
  async planRun(body: PlanRunRequest, options?: RequestOptions): Promise<PlanRunResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/runs/plan`, json: convertKeys(CODEC, "PlanRunRequest", body, "encode"), idempotent: true }, options);
    return convertKeys(CODEC, "PlanRunResponse", data, "decode") as PlanRunResponse;
  }

  /**
   * Post scores computed by local (SDK-side) code scorers; the eval completes when none are missing
   *
   * `POST /v1/evals/{id}/scores`
   */
  async postEvalScores(id: string, body: PostEvalScoresRequest, options?: RequestOptions): Promise<PostEvalScoresResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/evals/${encodePathParam(id, "id")}/scores`, json: convertKeys(CODEC, "PostEvalScoresRequest", body, "encode"), idempotent: true }, options);
    return convertKeys(CODEC, "PostEvalScoresResponse", data, "decode") as PostEvalScoresResponse;
  }

  /**
   * Release an exportable checkpoint as a named, versioned artifact (promoting it again under the same name returns that release)
   *
   * `POST /v1/checkpoints/{id}/promote`
   */
  async promoteCheckpoint(id: string, body?: PromoteCheckpointRequest, options?: RequestOptions): Promise<Artifact> {
    const data = await this.transport.json({ method: "POST", path: `/v1/checkpoints/${encodePathParam(id, "id")}/promote`, json: body, idempotent: true }, options);
    return convertKeys(CODEC, "Artifact", data, "decode") as Artifact;
  }

  /**
   * Append records as a new dataset version (creates the dataset if needed)
   *
   * `POST /v1/datasets/{name}/records`
   */
  async pushDatasetRecords(name: string, body: PushDatasetRequest, options?: RequestOptions): Promise<Dataset> {
    const data = await this.transport.json({ method: "POST", path: `/v1/datasets/${encodePathParam(name, "name")}/records`, json: convertKeys(CODEC, "PushDatasetRequest", body, "encode"), idempotent: true }, options);
    return convertKeys(CODEC, "Dataset", data, "decode") as Dataset;
  }

  /**
   * Preview chat-template rendering and loss masks (estimated token counts)
   *
   * `POST /v1/datasets/{name}/render`
   */
  async renderDataset(name: string, body: RenderDatasetRequest, options?: RequestOptions): Promise<RenderDatasetResponse> {
    const data = await this.transport.json({ method: "POST", path: `/v1/datasets/${encodePathParam(name, "name")}/render`, json: convertKeys(CODEC, "RenderDatasetRequest", body, "encode"), idempotent: true }, options);
    return convertKeys(CODEC, "RenderDatasetResponse", data, "decode") as RenderDatasetResponse;
  }

  /**
   * Resume a stopped, failed or cancelled run from its latest checkpoint
   *
   * `POST /v1/runs/{id}/resume`
   */
  async resumeRun(id: string, body?: ResumeRunRequest, options?: RequestOptions): Promise<Run> {
    const data = await this.transport.json({ method: "POST", path: `/v1/runs/${encodePathParam(id, "id")}/resume`, json: convertKeys(CODEC, "ResumeRunRequest", body, "encode"), idempotent: true }, options);
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
   * Score a dataset's records with a rubric (async; the scores become the next version)
   *
   * `POST /v1/datasets/{name}/score`
   */
  async scoreDataset(name: string, body: ScoreDatasetRequest, options?: RequestOptions): Promise<EvalRun> {
    const data = await this.transport.json({ method: "POST", path: `/v1/datasets/${encodePathParam(name, "name")}/score`, json: body, idempotent: true }, options);
    return convertKeys(CODEC, "EvalRun", data, "decode") as EvalRun;
  }

  /**
   * Create or replace a workspace secret (the value is write-only)
   *
   * `POST /v1/secrets`
   */
  async setSecret(body: SetSecretRequest, options?: RequestOptions): Promise<Secret> {
    const data = await this.transport.json({ method: "POST", path: `/v1/secrets`, json: convertKeys(CODEC, "SetSecretRequest", body, "encode"), idempotent: true }, options);
    return convertKeys(CODEC, "Secret", data, "decode") as Secret;
  }

  /**
   * Sync now: queue an import of new traces and scores (returns the running one if a sync is in progress)
   *
   * `POST /v1/sources/{id}/sync`
   */
  async syncSource(id: string, body?: SyncSourceRequest, options?: RequestOptions): Promise<ImportJob> {
    const data = await this.transport.json({ method: "POST", path: `/v1/sources/${encodePathParam(id, "id")}/sync`, json: body, idempotent: true }, options);
    return convertKeys(CODEC, "ImportJob", data, "decode") as ImportJob;
  }

  /**
   * Change a source's filters, sampling, record caps or schedule (from its next sync)
   *
   * `PATCH /v1/sources/{id}`
   */
  async updateSource(id: string, body: UpdateSourceRequest, options?: RequestOptions): Promise<Source> {
    const data = await this.transport.json({ method: "PATCH", path: `/v1/sources/${encodePathParam(id, "id")}`, json: convertKeys(CODEC, "UpdateSourceRequest", body, "encode") }, options);
    return convertKeys(CODEC, "Source", data, "decode") as Source;
  }
}
