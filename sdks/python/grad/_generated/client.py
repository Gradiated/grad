# AUTO-GENERATED from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.
"""Generated wire layer for the Gradiated Training & Serving API.

One method per OpenAPI operation, typed with a ``TypedDict`` per schema. The
request policy (auth, retries, redirects, typed errors) lives in ``grad._transport``.
Prefer the resource objects on ``grad.Grad``; this layer is the escape hatch
(``client.wire``) for anything the façade does not wrap.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal, Mapping, NotRequired, TypeAlias, TypedDict, cast

from .._errors import GradAPIError as GradApiError
from .._transport import new_idempotency_key, quote_path_param

if TYPE_CHECKING:
    from httpx import Response

    from .._transport import Transport

__all__ = ["GeneratedApiClient", "GradApiError", "LIST_API_KEYS_LIMIT_MAX", "LIST_ARTIFACTS_LIMIT_MAX", "LIST_DATASETS_LIMIT_MAX", "LIST_DATASET_RECORDS_LIMIT_MAX", "LIST_DEPLOYMENTS_LIMIT_MAX", "LIST_EVALS_LIMIT_MAX", "LIST_EVAL_FAILURES_LIMIT_MAX", "LIST_EVAL_OUTPUTS_LIMIT_MAX", "LIST_EVAL_RESULTS_LIMIT_MAX", "LIST_IMPORTS_LIMIT_MAX", "LIST_RUNS_LIMIT_MAX", "LIST_RUN_CHECKPOINTS_LIMIT_MAX", "LIST_RUN_EVENTS_LIMIT_MAX", "LIST_RUN_METRICS_LIMIT_MAX", "LIST_SECRETS_LIMIT_MAX", "LIST_SOURCES_LIMIT_MAX", "LIST_USAGE_LIMIT_MAX", "OPERATIONS", "SCHEMA_ENUMS", "SCHEMA_FIELDS"]

AdapterSpec: TypeAlias = "dict[str, Any]"

ApiKey = TypedDict(
    "ApiKey",
    {
        "id": "str",
        "workspace_id": "str",
        "name": "str",
        "prefix": "str",
        "scopes": "list[ApiKeyScope]",
        "created_at": "str",
        "revoked_at": "str | None",
    },
)

ApiKeyScope: TypeAlias = "Literal['admin', 'datasets:read', 'datasets:write', 'runs:read', 'runs:write', 'artifacts:read', 'artifacts:write', 'secrets:read', 'secrets:write', 'sources:read', 'sources:write', 'deployments:write', 'feedback:write', 'env:serve']"

Artifact = TypedDict(
    "Artifact",
    {
        "id": "str",
        "workspace_id": "str",
        "name": "str",
        "version": "str",
        "run_id": "str | None",
        "checkpoint_id": "str | None",
        "base_model": "str",
        "recipe_kind": "RecipeKind",
        "format": "ArtifactFormat",
        "sha256": "str",
        "size_bytes": "int",
        "manifest": "dict[str, Any]",
        "eval_report": "EvalReport",
        "created_at": "str",
    },
)

ArtifactFormat: TypeAlias = "Literal['peft_lora', 'merged_safetensors', 'prefix_kv', 'cartridge', 'encoder_safetensors', 'router_bundle', 'decision_bundle', 'reward_bundle', 'reference'] | None"

AttemptEvent = TypedDict(
    "AttemptEvent",
    {
        "type": "Literal['attempt']",
        "run_id": "str",
        "seq": "int",
        "attempt": "int",
        "timestamp": "str",
        "event": "Literal['started', 'interrupted', 'gave_up']",
        "reason": "InterruptionReason",
        "step": "int | None",
        "resume_step": "int | None",
        "max_attempts": "int",
        "message": "str",
    },
)

BaseArtifact = TypedDict(
    "BaseArtifact",
    {
        "id": "str",
        "recipe_kind": "RecipeKind",
        "format": "Literal['peft_lora']",
        "sha256": "str",
    },
)

ChatMessage = TypedDict(
    "ChatMessage",
    {
        "role": "Literal['system', 'user', 'assistant', 'tool']",
        "content": "NotRequired[str | list[dict[str, Any]] | None]",
        "tool_calls": "NotRequired[list[dict[str, Any]]]",
        "tool_call_id": "NotRequired[str]",
        "name": "NotRequired[str]",
        "train": "NotRequired[bool]",
    },
)

Checkpoint = TypedDict(
    "Checkpoint",
    {
        "id": "str",
        "workspace_id": "str",
        "run_id": "str",
        "attempt": "int",
        "step": "int",
        "eval_score": "float | None",
        "format": "ArtifactFormat",
        "sha256": "str",
        "size_bytes": "int",
        "metadata": "dict[str, Any]",
        "best": "bool",
        "final": "bool",
        "expires_at": "str | None",
        "created_at": "str",
    },
)

CheckpointEvalResult = TypedDict(
    "CheckpointEvalResult",
    {
        "name": "str",
        "step": "int",
        "checkpoint_id": "str",
        "eval_id": "str | None",
        "dataset": "str",
        "dataset_version": "int",
        "status": "Literal['completed', 'failed', 'cancelled']",
        "score": "float | None",
        "cost_usd": "float",
        "error": "str | None",
    },
)

CheckpointEvent = TypedDict(
    "CheckpointEvent",
    {
        "type": "Literal['checkpoint']",
        "run_id": "str",
        "seq": "int",
        "attempt": "int",
        "timestamp": "str",
        "step": "int",
        "checkpoint_id": "str",
        "eval_score": "float | None",
        "format": "ArtifactFormat",
    },
)

ClaimJobRequest = TypedDict(
    "ClaimJobRequest",
    {
        "worker_id": "str",
        "lease_seconds": "NotRequired[int]",
        "kinds": "NotRequired[list[JobKind]]",
        "recipes": "NotRequired[list[RecipeKind]]",
        "gpu": "NotRequired[dict[str, Any] | None]",
        "device": "NotRequired[Literal['cpu', 'gpu']]",
    },
)

ClaimJobResponse = TypedDict(
    "ClaimJobResponse",
    {
        "protocol": "Literal['grad.trainer-protocol/1']",
        "job": "TrainerJob",
    },
)

CompleteTrainerJobRequest = TypedDict(
    "CompleteTrainerJobRequest",
    {
        "worker_id": "str",
        "attempt": "int",
        "status": "Literal['completed', 'stopped_budget', 'failed', 'cancelled', 'abandoned']",
        "reason": "NotRequired[Literal['compute_reclaimed', 'worker_error', 'oom']]",
        "upload_id": "NotRequired[str]",
        "format": "NotRequired[ArtifactFormat]",
        "manifest": "NotRequired[dict[str, Any]]",
        "eval_report": "NotRequired[EvalReport]",
        "tokens_processed": "NotRequired[int]",
        "error": "NotRequired[str]",
        "stop_reason": "NotRequired[Literal['budget', 'insufficient_balance']]",
        "import_summary": "NotRequired[dict[str, Any]]",
    },
)

CompleteTrainerJobResponse = TypedDict(
    "CompleteTrainerJobResponse",
    {
        "job_id": "str",
        "kind": "JobKind",
        "status": "str",
        "run": "Run",
        "artifact": "Artifact",
        "import": "ImportJob",
    },
)

CompletedEvent = TypedDict(
    "CompletedEvent",
    {
        "type": "Literal['completed']",
        "run_id": "str",
        "seq": "int",
        "attempt": "int",
        "timestamp": "str",
        "status": "RunStatus",
        "run": "Run",
    },
)

CreateApiKeyRequest = TypedDict(
    "CreateApiKeyRequest",
    {
        "name": "str",
        "scopes": "list[ApiKeyScope]",
    },
)

CreateDatasetRequest = TypedDict(
    "CreateDatasetRequest",
    {
        "name": "str",
        "metadata": "NotRequired[dict[str, Any]]",
    },
)

CreateImportRequest = TypedDict(
    "CreateImportRequest",
    {
        "source": "ImportSource",
        "connector": "NotRequired[Literal['auto', 'grad_trajectories', 'openai_chat', 'gradiated', 'otel', 'langfuse', 'posthog', 'braintrust', 'langsmith']]",
    },
)

CreateSourceRequest = TypedDict(
    "CreateSourceRequest",
    {
        "provider": "SourceProvider",
        "schedule": "NotRequired[str | None]",
        "sample_rate": "NotRequired[float]",
        "max_records_per_sync": "NotRequired[int | None]",
        "max_records_per_day": "NotRequired[int | None]",
        "version_interval": "NotRequired[int]",
    },
)

CreateUploadRequest = TypedDict(
    "CreateUploadRequest",
    {
        "purpose": "Literal['dataset_import']",
        "filename": "str",
        "size_bytes": "int",
        "sha256": "str",
    },
)

CreatedApiKey = TypedDict(
    "CreatedApiKey",
    {
        "key": "ApiKey",
        "secret": "str",
    },
)

Dataset = TypedDict(
    "Dataset",
    {
        "id": "str",
        "workspace_id": "str",
        "name": "str",
        "version": "int",
        "record_count": "int",
        "metadata": "dict[str, Any]",
        "created_at": "str",
        "updated_at": "str",
    },
)

DatasetFilter = TypedDict(
    "DatasetFilter",
    {
        "scores": "NotRequired[dict[str, str | float]]",
        "metadata": "NotRequired[dict[str, str | float | bool]]",
        "created_after": "NotRequired[str]",
        "created_before": "NotRequired[str]",
        "ids": "NotRequired[list[str]]",
    },
)

DatasetRecord = TypedDict(
    "DatasetRecord",
    {
        "schema": "NotRequired[Literal['grad.trajectory/1']]",
        "id": "NotRequired[str]",
        "session_id": "NotRequired[str | None]",
        "group_id": "NotRequired[str | None]",
        "role": "NotRequired[Literal['chosen', 'rejected', 'anchor', 'positive', 'negative', 'desirable', 'undesirable', 'rollout'] | None]",
        "source": "NotRequired[str | None]",
        "timestamp": "NotRequired[str | None]",
        "messages": "NotRequired[list[ChatMessage]]",
        "tools": "NotRequired[list[dict[str, Any]]]",
        "input": "NotRequired[TrajectoryInput]",
        "output": "NotRequired[TrajectoryOutput]",
        "prompt": "NotRequired[str | list[ChatMessage]]",
        "completion": "NotRequired[str | list[ChatMessage]]",
        "chosen": "NotRequired[str | list[ChatMessage]]",
        "rejected": "NotRequired[str | list[ChatMessage]]",
        "query": "NotRequired[str]",
        "positive": "NotRequired[str]",
        "negatives": "NotRequired[list[str]]",
        "state": "NotRequired[Any]",
        "questions": "NotRequired[dict[str, Any]]",
        "expected_output": "NotRequired[Any]",
        "scores": "NotRequired[dict[str, float]]",
        "metrics": "NotRequired[dict[str, float]]",
        "metadata": "NotRequired[dict[str, Any]]",
    },
)

DatasetRecordsPage = TypedDict(
    "DatasetRecordsPage",
    {
        "dataset": "str",
        "version": "int",
        "total": "int",
        "data": "list[DatasetRecord]",
        "next_cursor": "str | None",
    },
)

DecisionHeadReport = TypedDict(
    "DecisionHeadReport",
    {
        "type": "Literal['choice', 'noul', 'score']",
        "examples": "int",
        "accuracy": "float | None",
        "ece": "float | None",
        "temperature": "float",
        "brier": "NotRequired[float]",
        "mae": "NotRequired[float]",
        "macro_f1": "NotRequired[float | None]",
        "per_option": "NotRequired[dict[str, dict[str, Any]]]",
        "confusion_matrix": "NotRequired[dict[str, Any]]",
    },
)

DeployArtifactRequest = TypedDict(
    "DeployArtifactRequest",
    {
        "artifact": "str",
        "name": "NotRequired[str]",
        "fallback": "NotRequired[str]",
        "explore_rate": "NotRequired[float]",
    },
)

Deployment = TypedDict(
    "Deployment",
    {
        "id": "str",
        "workspace_id": "str",
        "name": "str",
        "model_id": "str",
        "active_artifact_id": "str",
        "previous_artifact_id": "str | None",
        "fallback_model": "str | None",
        "explore_rate": "float",
        "status": "Literal['active', 'disabled']",
        "created_at": "str",
        "updated_at": "str",
    },
)

DeploymentStatus = TypedDict(
    "DeploymentStatus",
    {
        "deployment": "Deployment",
        "feedback_count": "int",
        "average_score": "float | None",
    },
)

EmbedRequest = TypedDict(
    "EmbedRequest",
    {
        "model": "str",
        "input": "str | list[str]",
    },
)

EmbedResponse = TypedDict(
    "EmbedResponse",
    {
        "model": "str",
        "data": "list[dict[str, Any]]",
        "usage": "dict[str, Any]",
    },
)

EvalMode: TypeAlias = "Literal['eval', 'score']"

EvalModelSummary = TypedDict(
    "EvalModelSummary",
    {
        "model": "str",
        "overall": "float",
        "ci_low": "float",
        "ci_high": "float",
        "pass_at_k": "dict[str, float]",
        "vs_baseline": "dict[str, Any] | None",
        "tasks": "int",
        "errors": "int",
        "tokens_per_task": "float",
        "cost_per_1k_tasks_usd": "float | None",
    },
)

EvalOutput = TypedDict(
    "EvalOutput",
    {
        "id": "str",
        "eval_id": "str",
        "task_id": "str",
        "model": "str",
        "sample_index": "int",
        "input": "list[ChatMessage]",
        "output": "str | None",
        "expected_output": "NotRequired[Any]",
        "record": "DatasetRecord",
        "scores": "dict[str, float]",
        "error": "str | None",
        "usage": "dict[str, Any]",
    },
)

EvalReport = TypedDict(
    "EvalReport",
    {
        "metric_name": "str",
        "metric_mode": "NotRequired[Literal['min', 'max']]",
        "selected_step": "int",
        "best_step": "int | None",
        "final_step": "int",
        "train_records": "int",
        "eval_records": "int",
        "warnings": "list[str]",
        "eval_loss": "NotRequired[float | None]",
        "eval_token_accuracy": "NotRequired[float | None]",
        "trained_token_fraction": "NotRequired[float]",
        "train_examples": "NotRequired[int]",
        "eval_examples": "NotRequired[int]",
        "selection_examples": "NotRequired[int]",
        "truncated": "NotRequired[int]",
        "preference_accuracy": "NotRequired[float | None]",
        "reward_margin": "NotRequired[float | None]",
        "beta": "NotRequired[float]",
        "train_pairs": "NotRequired[int]",
        "eval_pairs": "NotRequired[int]",
        "dropped_records": "NotRequired[int]",
        "train_points": "NotRequired[int]",
        "eval_points": "NotRequired[int]",
        "pointwise_brier": "NotRequired[float | None]",
        "eval_kl": "NotRequired[float | None]",
        "base_kl": "NotRequired[float | None]",
        "no_context_kl": "NotRequired[float | None]",
        "kl_reduction": "NotRequired[float | None]",
        "num_tokens": "NotRequired[int]",
        "teacher": "NotRequired[str]",
        "rollout": "NotRequired[Literal['on_policy', 'off_policy']]",
        "candidates": "NotRequired[list[str]]",
        "fallback_model": "NotRequired[str]",
        "fallback_quality": "NotRequired[float | None]",
        "routes_any_traffic": "NotRequired[bool]",
        "pareto_summary": "NotRequired[RouterParetoSummary]",
        "ece": "NotRequired[float | None]",
        "heads": "NotRequired[dict[str, DecisionHeadReport]]",
        "recall_at_1": "NotRequired[float | None]",
        "recall_at_5": "NotRequired[float | None]",
        "recall_at_10": "NotRequired[float | None]",
        "mrr": "NotRequired[float | None]",
        "corpus_size": "NotRequired[int]",
        "baseline": "NotRequired[dict[str, Any] | None]",
    },
)

EvalRubricItem = TypedDict(
    "EvalRubricItem",
    {
        "name": "str",
        "kind": "Literal['regex', 'validator', 'code', 'judge']",
        "weight": "NotRequired[float]",
        "pattern": "NotRequired[str]",
        "flags": "NotRequired[str]",
        "validator": "NotRequired[Literal['json', 'non_empty', 'exact_match', 'final_number', 'choice']]",
        "model": "NotRequired[str]",
        "prompt": "NotRequired[str]",
        "runtime": "NotRequired[Literal['local']]",
    },
)

EvalRun = TypedDict(
    "EvalRun",
    {
        "id": "str",
        "workspace_id": "str",
        "name": "str",
        "status": "EvalStatus",
        "mode": "EvalMode",
        "models": "list[str]",
        "baseline": "str | None",
        "task_source": "dict[str, Any]",
        "rubric": "list[EvalRubricItem]",
        "samples": "int",
        "temperature": "float",
        "max_tokens": "int",
        "pass_threshold": "float",
        "judge_models": "list[str]",
        "local_scorers": "list[str]",
        "progress": "dict[str, Any]",
        "summary": "list[EvalModelSummary]",
        "total_cost_usd": "float",
        "scored_dataset_version": "int | None",
        "error": "str | None",
        "created_at": "str",
        "updated_at": "str",
        "completed_at": "str | None",
    },
)

EvalStatus: TypeAlias = "Literal['queued', 'running', 'awaiting_scores', 'completed', 'failed', 'cancelled']"

EvalTaskOutcome = TypedDict(
    "EvalTaskOutcome",
    {
        "task_id": "str",
        "model": "str",
        "score": "float",
        "passed": "bool",
        "sample_scores": "list[float]",
        "judge_model": "str | None",
        "record": "DatasetRecord",
    },
)

FeedbackEventInput = TypedDict(
    "FeedbackEventInput",
    {
        "inference_id": "NotRequired[str]",
        "session_id": "NotRequired[str]",
        "deployment_name": "NotRequired[str]",
        "idempotency_key": "str",
        "score": "NotRequired[float]",
        "expected_output": "NotRequired[Any]",
        "metrics": "NotRequired[dict[str, float]]",
    },
)

FeedbackRecord = TypedDict(
    "FeedbackRecord",
    {
        "id": "str",
        "workspace_id": "str",
        "inference_id": "str | None",
        "session_id": "str | None",
        "deployment_name": "str | None",
        "idempotency_key": "str",
        "score": "float | None",
        "expected_output": "NotRequired[Any]",
        "metrics": "dict[str, float]",
        "created_at": "str",
    },
)

FilterDatasetRequest: TypeAlias = "DatasetFilter"

GpuInfo = TypedDict(
    "GpuInfo",
    {
        "name": "str",
        "memory_gb": "float",
    },
)

HfColumnMapping = TypedDict(
    "HfColumnMapping",
    {
        "messages": "NotRequired[str]",
        "prompt": "NotRequired[str]",
        "completion": "NotRequired[str]",
        "chosen": "NotRequired[str]",
        "rejected": "NotRequired[str]",
        "answer": "NotRequired[str]",
        "query": "NotRequired[str]",
        "positive": "NotRequired[str]",
    },
)

IdempotencyKey: TypeAlias = "str"

ImportJob = TypedDict(
    "ImportJob",
    {
        "id": "str",
        "workspace_id": "str",
        "dataset": "str",
        "status": "ImportStatus",
        "source": "dict[str, Any]",
        "connector": "Literal['auto', 'grad_trajectories', 'openai_chat', 'gradiated', 'otel', 'langfuse', 'posthog', 'braintrust', 'langsmith']",
        "attempt": "int",
        "imported_count": "int",
        "dropped_count": "int",
        "detected_scores": "list[str]",
        "drop_reasons": "list[str]",
        "dataset_version": "int | None",
        "error": "str | None",
        "created_at": "str",
        "updated_at": "str",
    },
)

ImportSource: TypeAlias = "dict[str, Any]"

ImportStatus: TypeAlias = "Literal['queued', 'running', 'completed', 'failed']"

InterruptionReason: TypeAlias = "Literal['lease_lost', 'compute_reclaimed', 'worker_error', 'oom']"

JobKind: TypeAlias = "Literal['train', 'import']"

LogEvent = TypedDict(
    "LogEvent",
    {
        "type": "Literal['log']",
        "run_id": "str",
        "seq": "int",
        "attempt": "int",
        "timestamp": "str",
        "step": "int | None",
        "message": "str",
    },
)

LoggerSpec: TypeAlias = "dict[str, Any]"

LossSpec: TypeAlias = "dict[str, Any]"

MetricEvent = TypedDict(
    "MetricEvent",
    {
        "type": "Literal['metric']",
        "run_id": "str",
        "seq": "int",
        "attempt": "int",
        "timestamp": "str",
        "step": "int",
        "metric": "MetricPoint",
    },
)

MetricPoint = TypedDict(
    "MetricPoint",
    {
        "seq": "int",
        "attempt": "int",
        "step": "int",
        "loss": "float",
        "eval_loss": "NotRequired[float | None]",
        "eval_metrics": "NotRequired[dict[str, float | None] | None]",
        "grad_norm": "NotRequired[float | None]",
        "lr": "NotRequired[float | None]",
        "tokens_per_sec": "NotRequired[float | None]",
        "tokens": "int",
        "cost_usd": "float",
        "timestamp": "str",
    },
)

MetricPointInput = TypedDict(
    "MetricPointInput",
    {
        "step": "int",
        "loss": "float",
        "eval_loss": "NotRequired[float | None]",
        "eval_metrics": "NotRequired[dict[str, float | None] | None]",
        "grad_norm": "NotRequired[float | None]",
        "lr": "NotRequired[float | None]",
        "tokens_per_sec": "NotRequired[float | None]",
        "tokens": "int",
        "cost_usd": "NotRequired[float]",
        "timestamp": "str",
    },
)

MetricsPage = TypedDict(
    "MetricsPage",
    {
        "run_id": "str",
        "status": "RunStatus",
        "data": "list[MetricPoint]",
        "next_cursor": "str | None",
        "tail_cursor": "str",
    },
)

OptimizerSpec = TypedDict(
    "OptimizerSpec",
    {
        "kind": "NotRequired[Literal['adamw']]",
        "betas": "NotRequired[list[Any]]",
        "weight_decay": "NotRequired[float]",
        "grad_clip": "NotRequired[float]",
    },
)

PhaseEvent = TypedDict(
    "PhaseEvent",
    {
        "type": "Literal['phase']",
        "run_id": "str",
        "seq": "int",
        "attempt": "int",
        "timestamp": "str",
        "phase": "RunPhase",
        "step": "int",
        "workers_online": "int | None",
        "autoscaling": "bool | None",
        "queue_position": "int | None",
        "message": "str | None",
        "gpu": "GpuInfo",
    },
)

PlanCostBreakdown = TypedDict(
    "PlanCostBreakdown",
    {
        "train_usd": "float",
        "teacher_usd": "float",
        "eval_usd": "float",
    },
)

PlanEvalRequest = TypedDict(
    "PlanEvalRequest",
    {
        "name": "NotRequired[str]",
        "models": "list[str]",
        "baseline": "NotRequired[str]",
        "dataset": "str",
        "dataset_version": "NotRequired[int]",
        "rubric": "NotRequired[list[EvalRubricItem]]",
        "samples": "NotRequired[int]",
        "temperature": "NotRequired[float]",
        "max_tokens": "NotRequired[int]",
        "limit": "NotRequired[int]",
        "pass_threshold": "NotRequired[float | None]",
    },
)

PlanEvalResponse = TypedDict(
    "PlanEvalResponse",
    {
        "task_source_kind": "Literal['dataset']",
        "dataset_version": "int",
        "estimated_tasks": "int",
        "estimated_model_calls": "int",
        "estimated_judge_calls": "int",
        "estimated_cost_usd": "float",
        "judge_models": "list[str]",
        "local_scorers": "list[str]",
        "pass_threshold": "float",
        "warnings": "list[str]",
    },
)

PlanRunRequest = TypedDict(
    "PlanRunRequest",
    {
        "dataset": "str",
        "name": "str",
        "recipe": "RecipeSpec",
        "split": "NotRequired[SplitSpec]",
        "max_cost_usd": "NotRequired[float]",
    },
)

PlanRunResponse = TypedDict(
    "PlanRunResponse",
    {
        "resolved_config": "ResolvedRunConfig",
        "dataset_version": "int",
        "usable_records": "int",
        "total_records": "int",
        "estimated_steps": "int",
        "estimated_tokens": "int",
        "estimated_cost_usd": "float",
        "estimated_duration_s": "int",
        "min_gpu_memory_gb": "float | None",
        "price_per_million_tokens": "float",
        "trained_token_fraction": "float",
        "labeling": "dict[str, Any] | None",
        "teacher": "dict[str, Any] | None",
        "cost_breakdown": "PlanCostBreakdown",
        "warnings": "list[str]",
    },
)

PoolingSpec = TypedDict(
    "PoolingSpec",
    {
        "kind": "Literal['mean', 'cls']",
    },
)

PostEvalScoresRequest = TypedDict(
    "PostEvalScoresRequest",
    {
        "scores": "list[dict[str, Any]]",
    },
)

PostEvalScoresResponse = TypedDict(
    "PostEvalScoresResponse",
    {
        "accepted": "int",
        "status": "EvalStatus",
        "pending_local_scores": "int",
    },
)

Problem = TypedDict(
    "Problem",
    {
        "type": "str",
        "title": "str",
        "status": "int",
        "detail": "str",
        "code": "str",
        "request_id": "str",
    },
)

PromoteCheckpointRequest = TypedDict(
    "PromoteCheckpointRequest",
    {
        "name": "NotRequired[str]",
    },
)

PushDatasetRequest = TypedDict(
    "PushDatasetRequest",
    {
        "records": "list[DatasetRecord]",
        "metadata": "NotRequired[dict[str, Any]]",
    },
)

RecipeEval = TypedDict(
    "RecipeEval",
    {
        "dataset": "str",
        "version": "NotRequired[int]",
        "rubric": "NotRequired[list[EvalRubricItem]]",
        "limit": "NotRequired[int]",
        "name": "NotRequired[str]",
    },
)

RecipeKind: TypeAlias = "Literal['sft', 'dpo', 'router', 'decision', 'cartridge', 'embedding', 'distill', 'reward', 'grpo']"

RecipeSpec = TypedDict(
    "RecipeSpec",
    {
        "kind": "RecipeKind",
        "model": "NotRequired[str]",
        "adapter": "NotRequired[AdapterSpec]",
        "lr": "NotRequired[Literal['auto'] | float]",
        "lr_scale": "NotRequired[float]",
        "batch_size": "NotRequired[int]",
        "epochs": "NotRequired[int]",
        "schedule": "NotRequired[Literal['linear', 'cosine', 'constant']]",
        "warmup": "NotRequired[float]",
        "train_on": "NotRequired[Literal['last', 'all_assistant']]",
        "thinking": "NotRequired[Literal['auto', 'on', 'off']]",
        "preserve_thinking": "NotRequired[bool]",
        "reduction": "NotRequired[Literal['per_example', 'per_token']]",
        "select": "NotRequired[Literal['best', 'last']]",
        "checkpoint_ttl_days": "NotRequired[int]",
        "beta": "NotRequired[float]",
        "models": "NotRequired[list[str]]",
        "max_quality_drop": "NotRequired[float]",
        "context_text": "NotRequired[str]",
        "num_tokens": "NotRequired[int]",
        "temp": "NotRequired[float]",
        "teacher": "NotRequired[str]",
        "rollout": "NotRequired[RolloutSpec]",
        "optimizer": "NotRequired[OptimizerSpec]",
        "eval_every": "NotRequired[Literal['auto'] | int]",
        "loss": "NotRequired[LossSpec]",
        "pool": "NotRequired[PoolingSpec]",
        "rubric": "NotRequired[str | list[EvalRubricItem]]",
        "pricing": "NotRequired[dict[str, float]]",
        "fallback": "NotRequired[str]",
        "max_new_tokens": "NotRequired[int]",
        "slot_token": "NotRequired[str]",
        "evals": "NotRequired[list[RecipeEval]]",
        "loggers": "NotRequired[list[LoggerSpec]]",
    },
)

RecordFeedbackRequest = TypedDict(
    "RecordFeedbackRequest",
    {
        "events": "list[FeedbackEventInput]",
    },
)

RecordFeedbackResponse = TypedDict(
    "RecordFeedbackResponse",
    {
        "accepted": "int",
        "deduplicated": "int",
        "records": "list[FeedbackRecord]",
    },
)

RegisterImportPartRequest = TypedDict(
    "RegisterImportPartRequest",
    {
        "worker_id": "str",
        "attempt": "int",
        "seq": "int",
        "upload_id": "str",
        "sha256": "str",
        "count": "int",
        "resets": "NotRequired[bool]",
        "records": "int",
        "score_updates": "NotRequired[int]",
        "detected_scores": "NotRequired[list[str]]",
    },
)

RegisterImportPartResponse = TypedDict(
    "RegisterImportPartResponse",
    {
        "staged": "bool",
    },
)

RegisterTrainerCheckpointRequest = TypedDict(
    "RegisterTrainerCheckpointRequest",
    {
        "worker_id": "str",
        "attempt": "int",
        "step": "int",
        "eval_score": "NotRequired[float | None]",
        "upload_id": "str",
        "format": "NotRequired[ArtifactFormat]",
        "metadata": "NotRequired[dict[str, Any]]",
    },
)

RenderDatasetRequest = TypedDict(
    "RenderDatasetRequest",
    {
        "model": "NotRequired[str]",
        "train_on": "NotRequired[Literal['last', 'all_assistant']]",
        "thinking": "NotRequired[Literal['auto', 'on', 'off']]",
        "preserve_thinking": "NotRequired[bool]",
        "limit": "NotRequired[int]",
    },
)

RenderDatasetResponse = TypedDict(
    "RenderDatasetResponse",
    {
        "dataset": "str",
        "model": "str",
        "template_revision": "str",
        "token_counts": "Literal['estimated']",
        "examples": "list[dict[str, Any]]",
    },
)

ReportTrainerEventRequest: TypeAlias = "dict[str, Any]"

ReportTrainerProgressRequest = TypedDict(
    "ReportTrainerProgressRequest",
    {
        "worker_id": "str",
        "attempt": "int",
        "metric": "MetricPointInput",
    },
)

ReportTrainerProgressResponse = TypedDict(
    "ReportTrainerProgressResponse",
    {
        "status": "RunStatus",
        "should_stop": "bool",
        "stop_reason": "Literal['cancelled', 'budget', 'insufficient_balance'] | None",
        "cost_usd": "float",
    },
)

ResolvedRunConfig = TypedDict(
    "ResolvedRunConfig",
    {
        "rule_version": "str",
        "dataset": "str",
        "dataset_version": "int",
        "name": "str",
        "recipe_kind": "RecipeKind",
        "model": "str",
        "template_revision": "str",
        "adapter": "dict[str, Any]",
        "lr": "float",
        "lr_source": "str",
        "batch_size": "int",
        "epochs": "int",
        "schedule": "Literal['linear', 'cosine', 'constant']",
        "warmup": "float",
        "train_on": "Literal['last', 'all_assistant']",
        "thinking": "Literal['auto', 'on', 'off']",
        "preserve_thinking": "bool",
        "reduction": "Literal['per_example', 'per_token']",
        "select": "Literal['best', 'last']",
        "checkpoint_every_steps": "int",
        "eval_every_steps": "int",
        "optimizer": "OptimizerSpec",
        "checkpoint_ttl_days": "int",
        "split": "dict[str, Any]",
        "label_eval_id": "str | None",
        "base_artifact": "BaseArtifact",
        "recipe_params": "dict[str, Any]",
        "checkpoint_evals": "NotRequired[list[dict[str, Any]]]",
        "loggers": "NotRequired[list[LoggerSpec]]",
    },
)

ResumeRunRequest = TypedDict(
    "ResumeRunRequest",
    {
        "max_cost_usd": "NotRequired[float]",
    },
)

RolloutSpec: TypeAlias = "dict[str, Any]"

RouteRequest = TypedDict(
    "RouteRequest",
    {
        "deployment": "str",
        "messages": "list[ChatMessage]",
        "tools": "NotRequired[list[dict[str, Any]]]",
        "session_id": "NotRequired[str]",
    },
)

RouteResponse = TypedDict(
    "RouteResponse",
    {
        "inference_id": "str",
        "deployment": "str",
        "artifact_id": "str",
        "model": "str",
        "is_exploration": "bool",
        "confidence": "float",
        "scores": "dict[str, float]",
    },
)

RouterParetoSummary = TypedDict(
    "RouterParetoSummary",
    {
        "target_max_drop": "float",
        "routed_quality": "float | None",
        "quality_drop": "float | None",
        "quality_drop_ci95": "list[float] | None",
        "offload_rate": "float | None",
        "cost_savings_pct": "float | None",
        "ece": "float | None",
        "threshold": "float | None",
        "temperature": "float",
    },
)

Run = TypedDict(
    "Run",
    {
        "id": "str",
        "workspace_id": "str",
        "name": "str",
        "dataset_id": "str",
        "dataset_name": "str",
        "dataset_version": "int",
        "recipe_kind": "RecipeKind",
        "status": "RunStatus",
        "resolved_config": "ResolvedRunConfig",
        "max_cost_usd": "float | None",
        "price_per_million_tokens": "float",
        "tokens_processed": "int",
        "cost_usd": "float",
        "current_step": "int",
        "total_steps": "int",
        "attempt": "int",
        "max_attempts": "int",
        "phase": "Literal['queued', 'waiting_for_compute', 'starting', 'loading_model', 'training', 'evaluating', 'checkpointing', 'uploading', 'completing'] | None",
        "phase_since": "str | None",
        "last_interruption": "RunInterruption",
        "workers_online": "int | None",
        "autoscaling": "bool | None",
        "queue_position": "int | None",
        "queue_message": "str | None",
        "min_gpu_memory_gb": "float | None",
        "latest_metric": "MetricPoint",
        "eval_report": "EvalReport",
        "checkpoint_evals": "list[CheckpointEvalResult]",
        "artifact_id": "str | None",
        "error": "str | None",
        "created_at": "str",
        "updated_at": "str",
        "finished_at": "str | None",
        "warnings": "NotRequired[list[str]]",
    },
)

RunEvent: TypeAlias = "PhaseEvent | MetricEvent | CheckpointEvent | AttemptEvent | WarningEvent | LogEvent | CompletedEvent"

RunEventsPage = TypedDict(
    "RunEventsPage",
    {
        "run_id": "str",
        "status": "RunStatus",
        "data": "list[RunEvent]",
        "next_cursor": "str | None",
        "tail_cursor": "str",
    },
)

RunInterruption = TypedDict(
    "RunInterruption",
    {
        "attempt": "int",
        "reason": "InterruptionReason",
        "step": "int",
        "resume_step": "int | None",
        "at": "str",
        "message": "str",
    },
)

RunPhase: TypeAlias = "Literal['queued', 'waiting_for_compute', 'starting', 'loading_model', 'training', 'evaluating', 'checkpointing', 'uploading', 'completing']"

RunStatus: TypeAlias = "Literal['queued', 'running', 'completed', 'failed', 'cancelled', 'stopped_budget', 'stopped_balance']"

ScoreDatasetRequest = TypedDict(
    "ScoreDatasetRequest",
    {
        "rubric": "list[EvalRubricItem]",
        "version": "NotRequired[int]",
        "name": "NotRequired[str]",
        "limit": "NotRequired[int]",
    },
)

Secret = TypedDict(
    "Secret",
    {
        "name": "str",
        "workspace_id": "str",
        "allowed_hosts": "list[str]",
        "created_at": "str",
        "updated_at": "str",
    },
)

SetSecretRequest = TypedDict(
    "SetSecretRequest",
    {
        "name": "str",
        "value": "str",
        "allowed_hosts": "NotRequired[list[str]]",
    },
)

Source = TypedDict(
    "Source",
    {
        "id": "str",
        "workspace_id": "str",
        "dataset": "str",
        "provider": "dict[str, Any]",
        "schedule": "str | None",
        "sample_rate": "float",
        "max_records_per_sync": "int | None",
        "max_records_per_day": "int | None",
        "records_today": "int",
        "version_interval": "int",
        "pending_records": "int",
        "next_sync_at": "str | None",
        "status": "Literal['active', 'paused']",
        "paused_reason": "str | None",
        "last_error": "str | None",
        "last_error_at": "str | None",
        "consecutive_failures": "int",
        "pending_full": "bool",
        "last_synced_at": "str | None",
        "last_sync": "SourceSync",
        "created_at": "str",
        "updated_at": "str",
    },
)

SourcePageRequest = TypedDict(
    "SourcePageRequest",
    {
        "worker_id": "str",
        "attempt": "int",
        "cursor": "NotRequired[str | None]",
    },
)

SourcePageResponse = TypedDict(
    "SourcePageResponse",
    {
        "records": "list[dict[str, Any]]",
        "cursor": "str | None",
        "has_more": "bool",
    },
)

SourceProvider = TypedDict(
    "SourceProvider",
    {
        "kind": "str",
        "host": "NotRequired[str | None]",
        "secret": "NotRequired[str | None]",
        "project": "NotRequired[str | None]",
        "filters": "NotRequired[dict[str, Any]]",
    },
)

SourceSync = TypedDict(
    "SourceSync",
    {
        "import_id": "str",
        "status": "Literal['queued', 'running', 'completed', 'failed']",
        "full": "bool",
        "dataset_version": "int | None",
        "error": "str | None",
        "created_at": "str",
        "finished_at": "str | None",
    },
)

SplitSpec = TypedDict(
    "SplitSpec",
    {
        "strategy": "NotRequired[Literal['by_session', 'by_group', 'random']]",
        "eval_fraction": "NotRequired[float]",
        "seed": "NotRequired[int]",
    },
)

SyncSourceRequest = TypedDict(
    "SyncSourceRequest",
    {
        "full": "NotRequired[bool]",
    },
)

TrainableModel = TypedDict(
    "TrainableModel",
    {
        "id": "str",
        "hf_repo": "str | None",
        "family": "Literal['llm', 'encoder']",
        "adapters": "list[Literal['lora', 'prefix_kv', 'frozen_head', 'encoder_full']]",
        "recipes": "list[RecipeKind]",
        "default_for": "list[RecipeKind]",
        "price_per_million_tokens_usd": "float",
        "max_context_tokens": "int",
        "template_revision": "str",
        "calibrated_lrs": "dict[str, float]",
        "min_gpu_memory_gb": "float | None",
    },
)

TrainerHeartbeatRequest = TypedDict(
    "TrainerHeartbeatRequest",
    {
        "worker_id": "str",
        "attempt": "int",
        "lease_seconds": "NotRequired[int]",
        "stats": "NotRequired[TrainerWorkerStats]",
    },
)

TrainerHeartbeatResponse = TypedDict(
    "TrainerHeartbeatResponse",
    {
        "status": "str",
        "should_stop": "bool",
        "stop_reason": "Literal['cancelled', 'budget', 'insufficient_balance'] | None",
        "lease_expires_at": "str",
    },
)

TrainerJob = TypedDict(
    "TrainerJob",
    {
        "id": "str",
        "kind": "JobKind",
        "attempt": "int",
        "lease_seconds": "int",
        "lease_expires_at": "str",
        "run": "dict[str, Any] | None",
        "import": "dict[str, Any] | None",
        "price_per_million_tokens": "float | None",
        "max_cost_usd": "float | None",
        "dataset": "dict[str, Any] | None",
        "resume": "dict[str, Any] | None",
        "loggers": "NotRequired[list[dict[str, Any]]]",
        "base": "dict[str, Any] | None",
        "traceparent": "NotRequired[str | None]",
    },
)

TrainerUploadRequest = TypedDict(
    "TrainerUploadRequest",
    {
        "worker_id": "str",
        "attempt": "int",
        "kind": "Literal['checkpoint', 'artifact', 'records']",
        "sha256": "str",
        "size_bytes": "int",
    },
)

TrainerWorkerStats = TypedDict(
    "TrainerWorkerStats",
    {
        "phase": "NotRequired[str]",
        "tokens_per_second": "NotRequired[float]",
        "gpu_memory_used_bytes": "NotRequired[float]",
        "gpu_utilization": "NotRequired[float]",
    },
)

TrajectoryInput = TypedDict(
    "TrajectoryInput",
    {
        "messages": "NotRequired[list[ChatMessage]]",
        "tools": "NotRequired[list[dict[str, Any]]]",
        "media": "NotRequired[list[dict[str, Any]]]",
        "features": "NotRequired[dict[str, Any]]",
        "payload": "NotRequired[Any]",
    },
)

TrajectoryOutput = TypedDict(
    "TrajectoryOutput",
    {
        "turns": "NotRequired[list[ChatMessage]]",
        "payload": "NotRequired[Any]",
    },
)

UpdateSourceRequest = TypedDict(
    "UpdateSourceRequest",
    {
        "filters": "NotRequired[dict[str, Any]]",
        "schedule": "NotRequired[str | None]",
        "sample_rate": "NotRequired[float]",
        "max_records_per_sync": "NotRequired[int | None]",
        "max_records_per_day": "NotRequired[int | None]",
        "version_interval": "NotRequired[int]",
    },
)

UploadTicket = TypedDict(
    "UploadTicket",
    {
        "upload_id": "str",
        "method": "Literal['PUT']",
        "url": "str",
        "headers": "dict[str, str]",
        "expires_at": "str",
    },
)

UsageGroup = TypedDict(
    "UsageGroup",
    {
        "key": "str | None",
        "cost_usd": "float",
        "tokens": "int",
        "records": "int",
    },
)

UsageGroupBy: TypeAlias = "Literal['day', 'week', 'month', 'model', 'recipe', 'kind'] | None"

UsageKind: TypeAlias = "Literal['training', 'eval', 'scoring', 'labeling', 'teacher']"

UsageKindTotal = TypedDict(
    "UsageKindTotal",
    {
        "kind": "UsageKind",
        "cost_usd": "float",
        "tokens": "int",
        "records": "int",
    },
)

UsageRecord = TypedDict(
    "UsageRecord",
    {
        "id": "str",
        "kind": "UsageKind",
        "ref_id": "str",
        "ref_name": "str | None",
        "run_id": "str | None",
        "attempt": "int",
        "tokens_from": "int",
        "tokens_through": "int",
        "tokens": "int",
        "cost_usd": "float",
        "price_version": "str",
        "idempotency_key": "str",
        "created_at": "str",
    },
)

UsageRefTotal = TypedDict(
    "UsageRefTotal",
    {
        "id": "str",
        "name": "str | None",
        "kind": "UsageKind",
        "cost_usd": "float",
        "tokens": "int",
    },
)

UsageSummary = TypedDict(
    "UsageSummary",
    {
        "from": "str",
        "to": "str",
        "cost_usd": "float",
        "tokens": "int",
        "records": "int",
        "by_kind": "list[UsageKindTotal]",
        "top_runs": "list[UsageRefTotal]",
        "top_evals": "list[UsageRefTotal]",
        "group_by": "UsageGroupBy",
        "groups": "list[UsageGroup]",
    },
)

WarningEvent = TypedDict(
    "WarningEvent",
    {
        "type": "Literal['warning']",
        "run_id": "str",
        "seq": "int",
        "attempt": "int",
        "timestamp": "str",
        "step": "int | None",
        "message": "str",
    },
)

ListApiKeysResponse = TypedDict(
    "ListApiKeysResponse",
    {
        "data": "list[ApiKey]",
        "next_cursor": "str | None",
    },
)

ListArtifactsResponse = TypedDict(
    "ListArtifactsResponse",
    {
        "data": "list[Artifact]",
        "next_cursor": "str | None",
    },
)

ListBaseModelsResponse = TypedDict(
    "ListBaseModelsResponse",
    {
        "data": "list[TrainableModel]",
    },
)

ListDatasetsResponse = TypedDict(
    "ListDatasetsResponse",
    {
        "data": "list[Dataset]",
        "next_cursor": "str | None",
    },
)

ListDeploymentsResponse = TypedDict(
    "ListDeploymentsResponse",
    {
        "data": "list[Deployment]",
        "next_cursor": "str | None",
    },
)

ListEvalFailuresResponse = TypedDict(
    "ListEvalFailuresResponse",
    {
        "eval_id": "str",
        "data": "list[EvalTaskOutcome]",
        "next_cursor": "str | None",
    },
)

ListEvalOutputsResponse = TypedDict(
    "ListEvalOutputsResponse",
    {
        "data": "list[EvalOutput]",
        "next_cursor": "str | None",
    },
)

ListEvalResultsResponse = TypedDict(
    "ListEvalResultsResponse",
    {
        "data": "list[EvalTaskOutcome]",
        "next_cursor": "str | None",
    },
)

ListEvalsResponse = TypedDict(
    "ListEvalsResponse",
    {
        "data": "list[EvalRun]",
        "next_cursor": "str | None",
    },
)

ListImportsResponse = TypedDict(
    "ListImportsResponse",
    {
        "data": "list[ImportJob]",
        "next_cursor": "str | None",
    },
)

ListRunCheckpointsResponse = TypedDict(
    "ListRunCheckpointsResponse",
    {
        "data": "list[Checkpoint]",
        "next_cursor": "str | None",
    },
)

ListRunsResponse = TypedDict(
    "ListRunsResponse",
    {
        "data": "list[Run]",
        "next_cursor": "str | None",
    },
)

ListSecretsResponse = TypedDict(
    "ListSecretsResponse",
    {
        "data": "list[Secret]",
        "next_cursor": "str | None",
    },
)

ListSourcesResponse = TypedDict(
    "ListSourcesResponse",
    {
        "data": "list[Source]",
        "next_cursor": "str | None",
    },
)

ListUsageResponse = TypedDict(
    "ListUsageResponse",
    {
        "data": "list[UsageRecord]",
        "next_cursor": "str | None",
    },
)

SCHEMA_FIELDS: dict[str, frozenset[str]] = {
    "ApiKey": frozenset({"created_at", "id", "name", "prefix", "revoked_at", "scopes", "workspace_id"}),
    "Artifact": frozenset({"base_model", "checkpoint_id", "created_at", "eval_report", "format", "id", "manifest", "name", "recipe_kind", "run_id", "sha256", "size_bytes", "version", "workspace_id"}),
    "AttemptEvent": frozenset({"attempt", "event", "max_attempts", "message", "reason", "resume_step", "run_id", "seq", "step", "timestamp", "type"}),
    "BaseArtifact": frozenset({"format", "id", "recipe_kind", "sha256"}),
    "ChatMessage": frozenset({"content", "name", "role", "tool_call_id", "tool_calls", "train"}),
    "Checkpoint": frozenset({"attempt", "best", "created_at", "eval_score", "expires_at", "final", "format", "id", "metadata", "run_id", "sha256", "size_bytes", "step", "workspace_id"}),
    "CheckpointEvalResult": frozenset({"checkpoint_id", "cost_usd", "dataset", "dataset_version", "error", "eval_id", "name", "score", "status", "step"}),
    "CheckpointEvent": frozenset({"attempt", "checkpoint_id", "eval_score", "format", "run_id", "seq", "step", "timestamp", "type"}),
    "ClaimJobRequest": frozenset({"device", "gpu", "kinds", "lease_seconds", "recipes", "worker_id"}),
    "ClaimJobResponse": frozenset({"job", "protocol"}),
    "CompleteTrainerJobRequest": frozenset({"attempt", "error", "eval_report", "format", "import_summary", "manifest", "reason", "status", "stop_reason", "tokens_processed", "upload_id", "worker_id"}),
    "CompleteTrainerJobResponse": frozenset({"artifact", "import", "job_id", "kind", "run", "status"}),
    "CompletedEvent": frozenset({"attempt", "run", "run_id", "seq", "status", "timestamp", "type"}),
    "CreateApiKeyRequest": frozenset({"name", "scopes"}),
    "CreateDatasetRequest": frozenset({"metadata", "name"}),
    "CreateImportRequest": frozenset({"connector", "source"}),
    "CreateSourceRequest": frozenset({"max_records_per_day", "max_records_per_sync", "provider", "sample_rate", "schedule", "version_interval"}),
    "CreateUploadRequest": frozenset({"filename", "purpose", "sha256", "size_bytes"}),
    "CreatedApiKey": frozenset({"key", "secret"}),
    "Dataset": frozenset({"created_at", "id", "metadata", "name", "record_count", "updated_at", "version", "workspace_id"}),
    "DatasetFilter": frozenset({"created_after", "created_before", "ids", "metadata", "scores"}),
    "DatasetRecord": frozenset({"chosen", "completion", "expected_output", "group_id", "id", "input", "messages", "metadata", "metrics", "negatives", "output", "positive", "prompt", "query", "questions", "rejected", "role", "schema", "scores", "session_id", "source", "state", "timestamp", "tools"}),
    "DatasetRecordsPage": frozenset({"data", "dataset", "next_cursor", "total", "version"}),
    "DecisionHeadReport": frozenset({"accuracy", "brier", "confusion_matrix", "ece", "examples", "macro_f1", "mae", "per_option", "temperature", "type"}),
    "DeployArtifactRequest": frozenset({"artifact", "explore_rate", "fallback", "name"}),
    "Deployment": frozenset({"active_artifact_id", "created_at", "explore_rate", "fallback_model", "id", "model_id", "name", "previous_artifact_id", "status", "updated_at", "workspace_id"}),
    "DeploymentStatus": frozenset({"average_score", "deployment", "feedback_count"}),
    "EmbedRequest": frozenset({"input", "model"}),
    "EmbedResponse": frozenset({"data", "model", "usage"}),
    "EvalModelSummary": frozenset({"ci_high", "ci_low", "cost_per_1k_tasks_usd", "errors", "model", "overall", "pass_at_k", "tasks", "tokens_per_task", "vs_baseline"}),
    "EvalOutput": frozenset({"error", "eval_id", "expected_output", "id", "input", "model", "output", "record", "sample_index", "scores", "task_id", "usage"}),
    "EvalReport": frozenset({"base_kl", "baseline", "best_step", "beta", "candidates", "corpus_size", "dropped_records", "ece", "eval_examples", "eval_kl", "eval_loss", "eval_pairs", "eval_points", "eval_records", "eval_token_accuracy", "fallback_model", "fallback_quality", "final_step", "heads", "kl_reduction", "metric_mode", "metric_name", "mrr", "no_context_kl", "num_tokens", "pareto_summary", "pointwise_brier", "preference_accuracy", "recall_at_1", "recall_at_10", "recall_at_5", "reward_margin", "rollout", "routes_any_traffic", "selected_step", "selection_examples", "teacher", "train_examples", "train_pairs", "train_points", "train_records", "trained_token_fraction", "truncated", "warnings"}),
    "EvalRubricItem": frozenset({"flags", "kind", "model", "name", "pattern", "prompt", "runtime", "validator", "weight"}),
    "EvalRun": frozenset({"baseline", "completed_at", "created_at", "error", "id", "judge_models", "local_scorers", "max_tokens", "mode", "models", "name", "pass_threshold", "progress", "rubric", "samples", "scored_dataset_version", "status", "summary", "task_source", "temperature", "total_cost_usd", "updated_at", "workspace_id"}),
    "EvalTaskOutcome": frozenset({"judge_model", "model", "passed", "record", "sample_scores", "score", "task_id"}),
    "FeedbackEventInput": frozenset({"deployment_name", "expected_output", "idempotency_key", "inference_id", "metrics", "score", "session_id"}),
    "FeedbackRecord": frozenset({"created_at", "deployment_name", "expected_output", "id", "idempotency_key", "inference_id", "metrics", "score", "session_id", "workspace_id"}),
    "GpuInfo": frozenset({"memory_gb", "name"}),
    "HfColumnMapping": frozenset({"answer", "chosen", "completion", "messages", "positive", "prompt", "query", "rejected"}),
    "ImportJob": frozenset({"attempt", "connector", "created_at", "dataset", "dataset_version", "detected_scores", "drop_reasons", "dropped_count", "error", "id", "imported_count", "source", "status", "updated_at", "workspace_id"}),
    "LogEvent": frozenset({"attempt", "message", "run_id", "seq", "step", "timestamp", "type"}),
    "MetricEvent": frozenset({"attempt", "metric", "run_id", "seq", "step", "timestamp", "type"}),
    "MetricPoint": frozenset({"attempt", "cost_usd", "eval_loss", "eval_metrics", "grad_norm", "loss", "lr", "seq", "step", "timestamp", "tokens", "tokens_per_sec"}),
    "MetricPointInput": frozenset({"cost_usd", "eval_loss", "eval_metrics", "grad_norm", "loss", "lr", "step", "timestamp", "tokens", "tokens_per_sec"}),
    "MetricsPage": frozenset({"data", "next_cursor", "run_id", "status", "tail_cursor"}),
    "OptimizerSpec": frozenset({"betas", "grad_clip", "kind", "weight_decay"}),
    "PhaseEvent": frozenset({"attempt", "autoscaling", "gpu", "message", "phase", "queue_position", "run_id", "seq", "step", "timestamp", "type", "workers_online"}),
    "PlanCostBreakdown": frozenset({"eval_usd", "teacher_usd", "train_usd"}),
    "PlanEvalRequest": frozenset({"baseline", "dataset", "dataset_version", "limit", "max_tokens", "models", "name", "pass_threshold", "rubric", "samples", "temperature"}),
    "PlanEvalResponse": frozenset({"dataset_version", "estimated_cost_usd", "estimated_judge_calls", "estimated_model_calls", "estimated_tasks", "judge_models", "local_scorers", "pass_threshold", "task_source_kind", "warnings"}),
    "PlanRunRequest": frozenset({"dataset", "max_cost_usd", "name", "recipe", "split"}),
    "PlanRunResponse": frozenset({"cost_breakdown", "dataset_version", "estimated_cost_usd", "estimated_duration_s", "estimated_steps", "estimated_tokens", "labeling", "min_gpu_memory_gb", "price_per_million_tokens", "resolved_config", "teacher", "total_records", "trained_token_fraction", "usable_records", "warnings"}),
    "PoolingSpec": frozenset({"kind"}),
    "PostEvalScoresRequest": frozenset({"scores"}),
    "PostEvalScoresResponse": frozenset({"accepted", "pending_local_scores", "status"}),
    "Problem": frozenset({"code", "detail", "request_id", "status", "title", "type"}),
    "PromoteCheckpointRequest": frozenset({"name"}),
    "PushDatasetRequest": frozenset({"metadata", "records"}),
    "RecipeEval": frozenset({"dataset", "limit", "name", "rubric", "version"}),
    "RecipeSpec": frozenset({"adapter", "batch_size", "beta", "checkpoint_ttl_days", "context_text", "epochs", "eval_every", "evals", "fallback", "kind", "loggers", "loss", "lr", "lr_scale", "max_new_tokens", "max_quality_drop", "model", "models", "num_tokens", "optimizer", "pool", "preserve_thinking", "pricing", "reduction", "rollout", "rubric", "schedule", "select", "slot_token", "teacher", "temp", "thinking", "train_on", "warmup"}),
    "RecordFeedbackRequest": frozenset({"events"}),
    "RecordFeedbackResponse": frozenset({"accepted", "deduplicated", "records"}),
    "RegisterImportPartRequest": frozenset({"attempt", "count", "detected_scores", "records", "resets", "score_updates", "seq", "sha256", "upload_id", "worker_id"}),
    "RegisterImportPartResponse": frozenset({"staged"}),
    "RegisterTrainerCheckpointRequest": frozenset({"attempt", "eval_score", "format", "metadata", "step", "upload_id", "worker_id"}),
    "RenderDatasetRequest": frozenset({"limit", "model", "preserve_thinking", "thinking", "train_on"}),
    "RenderDatasetResponse": frozenset({"dataset", "examples", "model", "template_revision", "token_counts"}),
    "ReportTrainerProgressRequest": frozenset({"attempt", "metric", "worker_id"}),
    "ReportTrainerProgressResponse": frozenset({"cost_usd", "should_stop", "status", "stop_reason"}),
    "ResolvedRunConfig": frozenset({"adapter", "base_artifact", "batch_size", "checkpoint_evals", "checkpoint_every_steps", "checkpoint_ttl_days", "dataset", "dataset_version", "epochs", "eval_every_steps", "label_eval_id", "loggers", "lr", "lr_source", "model", "name", "optimizer", "preserve_thinking", "recipe_kind", "recipe_params", "reduction", "rule_version", "schedule", "select", "split", "template_revision", "thinking", "train_on", "warmup"}),
    "ResumeRunRequest": frozenset({"max_cost_usd"}),
    "RouteRequest": frozenset({"deployment", "messages", "session_id", "tools"}),
    "RouteResponse": frozenset({"artifact_id", "confidence", "deployment", "inference_id", "is_exploration", "model", "scores"}),
    "RouterParetoSummary": frozenset({"cost_savings_pct", "ece", "offload_rate", "quality_drop", "quality_drop_ci95", "routed_quality", "target_max_drop", "temperature", "threshold"}),
    "Run": frozenset({"artifact_id", "attempt", "autoscaling", "checkpoint_evals", "cost_usd", "created_at", "current_step", "dataset_id", "dataset_name", "dataset_version", "error", "eval_report", "finished_at", "id", "last_interruption", "latest_metric", "max_attempts", "max_cost_usd", "min_gpu_memory_gb", "name", "phase", "phase_since", "price_per_million_tokens", "queue_message", "queue_position", "recipe_kind", "resolved_config", "status", "tokens_processed", "total_steps", "updated_at", "warnings", "workers_online", "workspace_id"}),
    "RunEventsPage": frozenset({"data", "next_cursor", "run_id", "status", "tail_cursor"}),
    "RunInterruption": frozenset({"at", "attempt", "message", "reason", "resume_step", "step"}),
    "ScoreDatasetRequest": frozenset({"limit", "name", "rubric", "version"}),
    "Secret": frozenset({"allowed_hosts", "created_at", "name", "updated_at", "workspace_id"}),
    "SetSecretRequest": frozenset({"allowed_hosts", "name", "value"}),
    "Source": frozenset({"consecutive_failures", "created_at", "dataset", "id", "last_error", "last_error_at", "last_sync", "last_synced_at", "max_records_per_day", "max_records_per_sync", "next_sync_at", "paused_reason", "pending_full", "pending_records", "provider", "records_today", "sample_rate", "schedule", "status", "updated_at", "version_interval", "workspace_id"}),
    "SourcePageRequest": frozenset({"attempt", "cursor", "worker_id"}),
    "SourcePageResponse": frozenset({"cursor", "has_more", "records"}),
    "SourceProvider": frozenset({"filters", "host", "kind", "project", "secret"}),
    "SourceSync": frozenset({"created_at", "dataset_version", "error", "finished_at", "full", "import_id", "status"}),
    "SplitSpec": frozenset({"eval_fraction", "seed", "strategy"}),
    "SyncSourceRequest": frozenset({"full"}),
    "TrainableModel": frozenset({"adapters", "calibrated_lrs", "default_for", "family", "hf_repo", "id", "max_context_tokens", "min_gpu_memory_gb", "price_per_million_tokens_usd", "recipes", "template_revision"}),
    "TrainerHeartbeatRequest": frozenset({"attempt", "lease_seconds", "stats", "worker_id"}),
    "TrainerHeartbeatResponse": frozenset({"lease_expires_at", "should_stop", "status", "stop_reason"}),
    "TrainerJob": frozenset({"attempt", "base", "dataset", "id", "import", "kind", "lease_expires_at", "lease_seconds", "loggers", "max_cost_usd", "price_per_million_tokens", "resume", "run", "traceparent"}),
    "TrainerUploadRequest": frozenset({"attempt", "kind", "sha256", "size_bytes", "worker_id"}),
    "TrainerWorkerStats": frozenset({"gpu_memory_used_bytes", "gpu_utilization", "phase", "tokens_per_second"}),
    "TrajectoryInput": frozenset({"features", "media", "messages", "payload", "tools"}),
    "TrajectoryOutput": frozenset({"payload", "turns"}),
    "UpdateSourceRequest": frozenset({"filters", "max_records_per_day", "max_records_per_sync", "sample_rate", "schedule", "version_interval"}),
    "UploadTicket": frozenset({"expires_at", "headers", "method", "upload_id", "url"}),
    "UsageGroup": frozenset({"cost_usd", "key", "records", "tokens"}),
    "UsageKindTotal": frozenset({"cost_usd", "kind", "records", "tokens"}),
    "UsageRecord": frozenset({"attempt", "cost_usd", "created_at", "id", "idempotency_key", "kind", "price_version", "ref_id", "ref_name", "run_id", "tokens", "tokens_from", "tokens_through"}),
    "UsageRefTotal": frozenset({"cost_usd", "id", "kind", "name", "tokens"}),
    "UsageSummary": frozenset({"by_kind", "cost_usd", "from", "group_by", "groups", "records", "to", "tokens", "top_evals", "top_runs"}),
    "WarningEvent": frozenset({"attempt", "message", "run_id", "seq", "step", "timestamp", "type"}),
}
"""Property names of every object schema (for client-side typo checks)."""

SCHEMA_ENUMS: dict[str, tuple[Any, ...]] = {
    "ApiKeyScope": ("admin", "datasets:read", "datasets:write", "runs:read", "runs:write", "artifacts:read", "artifacts:write", "secrets:read", "secrets:write", "sources:read", "sources:write", "deployments:write", "feedback:write", "env:serve",),
    "ArtifactFormat": ("peft_lora", "merged_safetensors", "prefix_kv", "cartridge", "encoder_safetensors", "router_bundle", "decision_bundle", "reward_bundle", "reference", None,),
    "EvalMode": ("eval", "score",),
    "EvalStatus": ("queued", "running", "awaiting_scores", "completed", "failed", "cancelled",),
    "ImportStatus": ("queued", "running", "completed", "failed",),
    "InterruptionReason": ("lease_lost", "compute_reclaimed", "worker_error", "oom",),
    "JobKind": ("train", "import",),
    "RecipeKind": ("sft", "dpo", "router", "decision", "cartridge", "embedding", "distill", "reward", "grpo",),
    "RunPhase": ("queued", "waiting_for_compute", "starting", "loading_model", "training", "evaluating", "checkpointing", "uploading", "completing",),
    "RunStatus": ("queued", "running", "completed", "failed", "cancelled", "stopped_budget", "stopped_balance",),
    "UsageGroupBy": ("day", "week", "month", "model", "recipe", "kind", None,),
    "UsageKind": ("training", "eval", "scoring", "labeling", "teacher",),
}
"""Allowed values of every enum schema."""

OPERATIONS: dict[str, tuple[str, str]] = {
    "cancel_eval": ("POST", "/v1/evals/{id}/cancel"),
    "cancel_run": ("POST", "/v1/runs/{id}/cancel"),
    "create_api_key": ("POST", "/v1/keys"),
    "create_dataset": ("POST", "/v1/datasets"),
    "create_dataset_import": ("POST", "/v1/datasets/{name}/imports"),
    "create_dataset_source": ("POST", "/v1/datasets/{name}/sources"),
    "create_embeddings": ("POST", "/v1/embeddings"),
    "create_eval": ("POST", "/v1/evals"),
    "create_run": ("POST", "/v1/runs"),
    "create_upload": ("POST", "/v1/uploads"),
    "delete_secret": ("DELETE", "/v1/secrets/{name}"),
    "delete_source": ("DELETE", "/v1/sources/{id}"),
    "deploy_artifact": ("POST", "/v1/deployments"),
    "download_artifact": ("GET", "/v1/artifacts/{id}/download"),
    "filter_dataset": ("POST", "/v1/datasets/{name}/filter"),
    "get_artifact": ("GET", "/v1/artifacts/{id}"),
    "get_dataset": ("GET", "/v1/datasets/{name}"),
    "get_deployment": ("GET", "/v1/deployments/{name}"),
    "get_eval": ("GET", "/v1/evals/{id}"),
    "get_import": ("GET", "/v1/imports/{id}"),
    "get_run": ("GET", "/v1/runs/{id}"),
    "get_secret": ("GET", "/v1/secrets/{name}"),
    "get_source": ("GET", "/v1/sources/{id}"),
    "get_usage_summary": ("GET", "/v1/usage/summary"),
    "list_api_keys": ("GET", "/v1/keys"),
    "list_artifacts": ("GET", "/v1/artifacts"),
    "list_base_models": ("GET", "/v1/base-models"),
    "list_dataset_records": ("GET", "/v1/datasets/{name}/records"),
    "list_datasets": ("GET", "/v1/datasets"),
    "list_deployments": ("GET", "/v1/deployments"),
    "list_eval_failures": ("GET", "/v1/evals/{id}/failures"),
    "list_eval_outputs": ("GET", "/v1/evals/{id}/outputs"),
    "list_eval_results": ("GET", "/v1/evals/{id}/results"),
    "list_evals": ("GET", "/v1/evals"),
    "list_imports": ("GET", "/v1/imports"),
    "list_run_checkpoints": ("GET", "/v1/runs/{id}/checkpoints"),
    "list_run_events": ("GET", "/v1/runs/{id}/events"),
    "list_run_metrics": ("GET", "/v1/runs/{id}/metrics"),
    "list_runs": ("GET", "/v1/runs"),
    "list_secrets": ("GET", "/v1/secrets"),
    "list_sources": ("GET", "/v1/sources"),
    "list_usage": ("GET", "/v1/usage"),
    "plan_eval": ("POST", "/v1/evals/plan"),
    "plan_run": ("POST", "/v1/runs/plan"),
    "post_eval_scores": ("POST", "/v1/evals/{id}/scores"),
    "promote_checkpoint": ("POST", "/v1/checkpoints/{id}/promote"),
    "push_dataset_records": ("POST", "/v1/datasets/{name}/records"),
    "record_feedback": ("POST", "/v1/feedback"),
    "render_dataset": ("POST", "/v1/datasets/{name}/render"),
    "resume_run": ("POST", "/v1/runs/{id}/resume"),
    "revoke_api_key": ("DELETE", "/v1/keys/{id}"),
    "rollback_deployment": ("POST", "/v1/deployments/{name}/rollback"),
    "route_request": ("POST", "/v1/route"),
    "score_dataset": ("POST", "/v1/datasets/{name}/score"),
    "set_secret": ("POST", "/v1/secrets"),
    "sync_source": ("POST", "/v1/sources/{id}/sync"),
    "update_source": ("PATCH", "/v1/sources/{id}"),
}
"""Public operationId (snake_case) -> (HTTP method, path template)."""

# Page-size maxima from spec/openapi.yaml (the server clamps larger values).
LIST_API_KEYS_LIMIT_MAX = 200
LIST_ARTIFACTS_LIMIT_MAX = 200
LIST_DATASET_RECORDS_LIMIT_MAX = 1000
LIST_DATASETS_LIMIT_MAX = 200
LIST_DEPLOYMENTS_LIMIT_MAX = 200
LIST_EVAL_FAILURES_LIMIT_MAX = 200
LIST_EVAL_OUTPUTS_LIMIT_MAX = 200
LIST_EVAL_RESULTS_LIMIT_MAX = 200
LIST_EVALS_LIMIT_MAX = 200
LIST_IMPORTS_LIMIT_MAX = 200
LIST_RUN_CHECKPOINTS_LIMIT_MAX = 200
LIST_RUN_EVENTS_LIMIT_MAX = 5000
LIST_RUN_METRICS_LIMIT_MAX = 5000
LIST_RUNS_LIMIT_MAX = 200
LIST_SECRETS_LIMIT_MAX = 200
LIST_SOURCES_LIMIT_MAX = 200
LIST_USAGE_LIMIT_MAX = 200


class GeneratedApiClient:
    """Wire client: one method per public operation in spec/openapi.yaml."""

    def __init__(self, transport: Transport) -> None:
        self._t = transport

    def cancel_eval(self, id: str, *, idempotency_key: str | None = None, timeout: float | None = None) -> EvalRun:
        """Cancel a queued, running or awaiting_scores evaluation."""
        return cast("EvalRun", self._t.request("POST", f"/v1/evals/{quote_path_param(id, 'id')}/cancel", headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def cancel_run(self, id: str, *, idempotency_key: str | None = None, timeout: float | None = None) -> Run:
        """Cancel a training run (a running attempt is stopped and billed)."""
        return cast("Run", self._t.request("POST", f"/v1/runs/{quote_path_param(id, 'id')}/cancel", headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def create_api_key(self, body: CreateApiKeyRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> CreatedApiKey:
        """Create a scoped workspace API key (trainer worker keys are platform config, not keys)."""
        return cast("CreatedApiKey", self._t.request("POST", "/v1/keys", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def create_dataset(self, body: CreateDatasetRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> Dataset:
        """Create an empty dataset."""
        return cast("Dataset", self._t.request("POST", "/v1/datasets", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def create_dataset_import(self, name: str, body: CreateImportRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> ImportJob:
        """Import an uploaded file or a Hugging Face dataset into a dataset (async job)."""
        return cast("ImportJob", self._t.request("POST", f"/v1/datasets/{quote_path_param(name, 'name')}/imports", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def create_dataset_source(self, name: str, body: CreateSourceRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> Source:
        """Connect an observability provider to a dataset."""
        return cast("Source", self._t.request("POST", f"/v1/datasets/{quote_path_param(name, 'name')}/sources", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def create_embeddings(self, body: EmbedRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> EmbedResponse:
        """Generate embeddings from a deployed embedding artifact."""
        return cast("EmbedResponse", self._t.request("POST", "/v1/embeddings", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def create_eval(self, body: PlanEvalRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> EvalRun:
        """Queue an evaluation across models on a pinned dataset version (executed by the server)."""
        return cast("EvalRun", self._t.request("POST", "/v1/evals", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def create_run(self, body: PlanRunRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> Run:
        """Create and enqueue a training run (pins the dataset version)."""
        return cast("Run", self._t.request("POST", "/v1/runs", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def create_upload(self, body: CreateUploadRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> UploadTicket:
        """Get an upload URL for a file to import (PUT the bytes, then create an import)."""
        return cast("UploadTicket", self._t.request("POST", "/v1/uploads", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def delete_secret(self, name: str, *, timeout: float | None = None) -> Any:
        """Delete a secret (409 while a source uses it)."""
        return self._t.request("DELETE", f"/v1/secrets/{quote_path_param(name, 'name')}", timeout=timeout)

    def delete_source(self, id: str, *, timeout: float | None = None) -> Any:
        """Remove a source (its dataset and versions stay)."""
        return self._t.request("DELETE", f"/v1/sources/{quote_path_param(id, 'id')}", timeout=timeout)

    def deploy_artifact(self, body: DeployArtifactRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> Deployment:
        """Deploy or update an artifact under a stable model name."""
        return cast("Deployment", self._t.request("POST", "/v1/deployments", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def download_artifact(self, id: str, *, timeout: float | None = None) -> Response:
        """Download an artifact bundle (.grad.tar.gz); verify X-Artifact-Sha256 (streams `application/octet-stream`; read or close the response)."""
        return self._t.stream("GET", f"/v1/artifacts/{quote_path_param(id, 'id')}/download", accept="application/octet-stream", timeout=timeout)

    def filter_dataset(self, name: str, body: FilterDatasetRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> Dataset:
        """Save a filtered view of a dataset version."""
        return cast("Dataset", self._t.request("POST", f"/v1/datasets/{quote_path_param(name, 'name')}/filter", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def get_artifact(self, id: str, *, timeout: float | None = None) -> Artifact:
        """Get an artifact by id or name@latest."""
        return cast("Artifact", self._t.request("GET", f"/v1/artifacts/{quote_path_param(id, 'id')}", timeout=timeout))

    def get_dataset(self, name: str, *, timeout: float | None = None) -> Dataset:
        """Get a dataset by name."""
        return cast("Dataset", self._t.request("GET", f"/v1/datasets/{quote_path_param(name, 'name')}", timeout=timeout))

    def get_deployment(self, name: str, *, timeout: float | None = None) -> DeploymentStatus:
        """Get deployment status and feedback summary."""
        return cast("DeploymentStatus", self._t.request("GET", f"/v1/deployments/{quote_path_param(name, 'name')}", timeout=timeout))

    def get_eval(self, id: str, *, timeout: float | None = None) -> EvalRun:
        """Get an evaluation run by ID."""
        return cast("EvalRun", self._t.request("GET", f"/v1/evals/{quote_path_param(id, 'id')}", timeout=timeout))

    def get_import(self, id: str, *, timeout: float | None = None) -> ImportJob:
        """Get a dataset import job."""
        return cast("ImportJob", self._t.request("GET", f"/v1/imports/{quote_path_param(id, 'id')}", timeout=timeout))

    def get_run(self, id: str, *, timeout: float | None = None) -> Run:
        """Get a training run."""
        return cast("Run", self._t.request("GET", f"/v1/runs/{quote_path_param(id, 'id')}", timeout=timeout))

    def get_secret(self, name: str, *, timeout: float | None = None) -> Secret:
        """Get a secret's metadata (never the value)."""
        return cast("Secret", self._t.request("GET", f"/v1/secrets/{quote_path_param(name, 'name')}", timeout=timeout))

    def get_source(self, id: str, *, timeout: float | None = None) -> Source:
        """Get a source and its latest sync."""
        return cast("Source", self._t.request("GET", f"/v1/sources/{quote_path_param(id, 'id')}", timeout=timeout))

    def get_usage_summary(self, *, from_: str | None = None, to: str | None = None, group_by: Literal['day', 'week', 'month', 'model', 'recipe', 'kind'] | None = None, timeout: float | None = None) -> UsageSummary:
        """Total cost and tokens over a period (default: this UTC month), by kind, the top runs and evals, and optional groups."""
        return cast("UsageSummary", self._t.request("GET", "/v1/usage/summary", query={"from": from_, "to": to, "group_by": group_by}, timeout=timeout))

    def list_api_keys(self, *, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> ListApiKeysResponse:
        """List workspace API keys."""
        return cast("ListApiKeysResponse", self._t.request("GET", "/v1/keys", query={"limit": limit, "cursor": cursor}, timeout=timeout))

    def list_artifacts(self, *, limit: int | None = None, cursor: str | None = None, name: str | None = None, timeout: float | None = None) -> ListArtifactsResponse:
        """List immutable artifacts (newest first)."""
        return cast("ListArtifactsResponse", self._t.request("GET", "/v1/artifacts", query={"limit": limit, "cursor": cursor, "name": name}, timeout=timeout))

    def list_base_models(self, *, timeout: float | None = None) -> ListBaseModelsResponse:
        """List trainable base models (the server catalog and price source)."""
        return cast("ListBaseModelsResponse", self._t.request("GET", "/v1/base-models", timeout=timeout))

    def list_dataset_records(self, name: str, *, version: int | None = None, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> DatasetRecordsPage:
        """Read records of a dataset version."""
        return cast("DatasetRecordsPage", self._t.request("GET", f"/v1/datasets/{quote_path_param(name, 'name')}/records", query={"version": version, "limit": limit, "cursor": cursor}, timeout=timeout))

    def list_datasets(self, *, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> ListDatasetsResponse:
        """List datasets (newest first)."""
        return cast("ListDatasetsResponse", self._t.request("GET", "/v1/datasets", query={"limit": limit, "cursor": cursor}, timeout=timeout))

    def list_deployments(self, *, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> ListDeploymentsResponse:
        """List deployments."""
        return cast("ListDeploymentsResponse", self._t.request("GET", "/v1/deployments", query={"limit": limit, "cursor": cursor}, timeout=timeout))

    def list_eval_failures(self, id: str, *, limit: int | None = None, cursor: str | None = None, model: str | None = None, threshold: float | None = None, timeout: float | None = None) -> ListEvalFailuresResponse:
        """List failing task records from an evaluation run for mining."""
        return cast("ListEvalFailuresResponse", self._t.request("GET", f"/v1/evals/{quote_path_param(id, 'id')}/failures", query={"limit": limit, "cursor": cursor, "model": model, "threshold": threshold}, timeout=timeout))

    def list_eval_outputs(self, id: str, *, limit: int | None = None, cursor: str | None = None, model: str | None = None, missing_scorer: str | None = None, timeout: float | None = None) -> ListEvalOutputsResponse:
        """Page through generated model outputs (filter by model or by a code scorer that still needs a score)."""
        return cast("ListEvalOutputsResponse", self._t.request("GET", f"/v1/evals/{quote_path_param(id, 'id')}/outputs", query={"limit": limit, "cursor": cursor, "model": model, "missing_scorer": missing_scorer}, timeout=timeout))

    def list_eval_results(self, id: str, *, limit: int | None = None, cursor: str | None = None, model: str | None = None, timeout: float | None = None) -> ListEvalResultsResponse:
        """Per-task, per-model results of a completed evaluation."""
        return cast("ListEvalResultsResponse", self._t.request("GET", f"/v1/evals/{quote_path_param(id, 'id')}/results", query={"limit": limit, "cursor": cursor, "model": model}, timeout=timeout))

    def list_evals(self, *, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> ListEvalsResponse:
        """List evaluation runs."""
        return cast("ListEvalsResponse", self._t.request("GET", "/v1/evals", query={"limit": limit, "cursor": cursor}, timeout=timeout))

    def list_imports(self, *, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> ListImportsResponse:
        """List dataset import jobs (newest first)."""
        return cast("ListImportsResponse", self._t.request("GET", "/v1/imports", query={"limit": limit, "cursor": cursor}, timeout=timeout))

    def list_run_checkpoints(self, id: str, *, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> ListRunCheckpointsResponse:
        """List unexpired checkpoints of a run (best and final never expire)."""
        return cast("ListRunCheckpointsResponse", self._t.request("GET", f"/v1/runs/{quote_path_param(id, 'id')}/checkpoints", query={"limit": limit, "cursor": cursor}, timeout=timeout))

    def list_run_events(self, id: str, *, cursor: str | None = None, limit: int | None = None, timeout: float | None = None) -> RunEventsPage:
        """A run's lifecycle events (phases, metrics, checkpoints, attempts, warnings, logs)."""
        return cast("RunEventsPage", self._t.request("GET", f"/v1/runs/{quote_path_param(id, 'id')}/events", query={"cursor": cursor, "limit": limit}, timeout=timeout))

    def list_run_events_stream(self, id: str, *, cursor: str | None = None, limit: int | None = None, timeout: float | None = None) -> Response:
        """A run's lifecycle events (phases, metrics, checkpoints, attempts, warnings, logs) (Server-Sent Events stream; read or close the response)."""
        return self._t.stream("GET", f"/v1/runs/{quote_path_param(id, 'id')}/events", query={"cursor": cursor, "limit": limit}, accept="text/event-stream", timeout=timeout)

    def list_run_metrics(self, id: str, *, cursor: str | None = None, after_step: int | None = None, limit: int | None = None, timeout: float | None = None) -> MetricsPage:
        """Training step metrics as JSON pages, or a live SSE stream."""
        return cast("MetricsPage", self._t.request("GET", f"/v1/runs/{quote_path_param(id, 'id')}/metrics", query={"cursor": cursor, "after_step": after_step, "limit": limit}, timeout=timeout))

    def list_run_metrics_stream(self, id: str, *, cursor: str | None = None, after_step: int | None = None, limit: int | None = None, timeout: float | None = None) -> Response:
        """Training step metrics as JSON pages, or a live SSE stream (Server-Sent Events stream; read or close the response)."""
        return self._t.stream("GET", f"/v1/runs/{quote_path_param(id, 'id')}/metrics", query={"cursor": cursor, "after_step": after_step, "limit": limit}, accept="text/event-stream", timeout=timeout)

    def list_runs(self, *, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> ListRunsResponse:
        """List training runs (newest first)."""
        return cast("ListRunsResponse", self._t.request("GET", "/v1/runs", query={"limit": limit, "cursor": cursor}, timeout=timeout))

    def list_secrets(self, *, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> ListSecretsResponse:
        """List workspace secrets (names and metadata only)."""
        return cast("ListSecretsResponse", self._t.request("GET", "/v1/secrets", query={"limit": limit, "cursor": cursor}, timeout=timeout))

    def list_sources(self, *, limit: int | None = None, cursor: str | None = None, dataset: str | None = None, timeout: float | None = None) -> ListSourcesResponse:
        """List sources (newest first), optionally for one dataset."""
        return cast("ListSourcesResponse", self._t.request("GET", "/v1/sources", query={"limit": limit, "cursor": cursor, "dataset": dataset}, timeout=timeout))

    def list_usage(self, *, limit: int | None = None, cursor: str | None = None, from_: str | None = None, to: str | None = None, run_id: str | None = None, eval_id: str | None = None, kind: Literal['training', 'eval', 'scoring', 'labeling', 'teacher'] | None = None, timeout: float | None = None) -> ListUsageResponse:
        """List billed usage, newest first (filter by period, run, eval or kind): one record per billed increment of a run or eval attempt."""
        return cast("ListUsageResponse", self._t.request("GET", "/v1/usage", query={"limit": limit, "cursor": cursor, "from": from_, "to": to, "run_id": run_id, "eval_id": eval_id, "kind": kind}, timeout=timeout))

    def plan_eval(self, body: PlanEvalRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> PlanEvalResponse:
        """Estimate tasks, model/judge calls, and cost before running an eval."""
        return cast("PlanEvalResponse", self._t.request("POST", "/v1/evals/plan", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def plan_run(self, body: PlanRunRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> PlanRunResponse:
        """Dry-run a training recipe at zero cost."""
        return cast("PlanRunResponse", self._t.request("POST", "/v1/runs/plan", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def post_eval_scores(self, id: str, body: PostEvalScoresRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> PostEvalScoresResponse:
        """Post scores computed by local (SDK-side) code scorers; the eval completes when none are missing."""
        return cast("PostEvalScoresResponse", self._t.request("POST", f"/v1/evals/{quote_path_param(id, 'id')}/scores", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def promote_checkpoint(self, id: str, body: PromoteCheckpointRequest | Mapping[str, Any] | None = None, *, idempotency_key: str | None = None, timeout: float | None = None) -> Artifact:
        """Release an exportable checkpoint as a named, versioned artifact (promoting it again under the same name returns that release)."""
        return cast("Artifact", self._t.request("POST", f"/v1/checkpoints/{quote_path_param(id, 'id')}/promote", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def push_dataset_records(self, name: str, body: PushDatasetRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> Dataset:
        """Append records as a new dataset version (creates the dataset if needed)."""
        return cast("Dataset", self._t.request("POST", f"/v1/datasets/{quote_path_param(name, 'name')}/records", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def record_feedback(self, body: RecordFeedbackRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> RecordFeedbackResponse:
        """Record deduplicated outcome scores and gold corrections."""
        return cast("RecordFeedbackResponse", self._t.request("POST", "/v1/feedback", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def render_dataset(self, name: str, body: RenderDatasetRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> RenderDatasetResponse:
        """Preview chat-template rendering and loss masks (estimated token counts)."""
        return cast("RenderDatasetResponse", self._t.request("POST", f"/v1/datasets/{quote_path_param(name, 'name')}/render", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def resume_run(self, id: str, body: ResumeRunRequest | Mapping[str, Any] | None = None, *, idempotency_key: str | None = None, timeout: float | None = None) -> Run:
        """Resume a stopped, failed or cancelled run from its latest checkpoint."""
        return cast("Run", self._t.request("POST", f"/v1/runs/{quote_path_param(id, 'id')}/resume", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def revoke_api_key(self, id: str, *, timeout: float | None = None) -> ApiKey:
        """Revoke a workspace API key."""
        return cast("ApiKey", self._t.request("DELETE", f"/v1/keys/{quote_path_param(id, 'id')}", timeout=timeout))

    def rollback_deployment(self, name: str, *, idempotency_key: str | None = None, timeout: float | None = None) -> Deployment:
        """Roll a deployment back to its previous artifact."""
        return cast("Deployment", self._t.request("POST", f"/v1/deployments/{quote_path_param(name, 'name')}/rollback", headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def route_request(self, body: RouteRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> RouteResponse:
        """Ask a deployed model router which model to call."""
        return cast("RouteResponse", self._t.request("POST", "/v1/route", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def score_dataset(self, name: str, body: ScoreDatasetRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> EvalRun:
        """Score a dataset's records with a rubric (async; the scores become the next version)."""
        return cast("EvalRun", self._t.request("POST", f"/v1/datasets/{quote_path_param(name, 'name')}/score", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def set_secret(self, body: SetSecretRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> Secret:
        """Create or replace a workspace secret (the value is write-only)."""
        return cast("Secret", self._t.request("POST", "/v1/secrets", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def sync_source(self, id: str, body: SyncSourceRequest | Mapping[str, Any] | None = None, *, idempotency_key: str | None = None, timeout: float | None = None) -> ImportJob:
        """Sync now: queue an import of new traces and scores (returns the running one if a sync is in progress)."""
        return cast("ImportJob", self._t.request("POST", f"/v1/sources/{quote_path_param(id, 'id')}/sync", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def update_source(self, id: str, body: UpdateSourceRequest | Mapping[str, Any], *, timeout: float | None = None) -> Source:
        """Change a source's filters, sampling, record caps or schedule (from its next sync)."""
        return cast("Source", self._t.request("PATCH", f"/v1/sources/{quote_path_param(id, 'id')}", json_body=body, timeout=timeout))
