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
    from .._http import AsyncResponse, Response
    from .._transport import AsyncTransport, SyncTransport

__all__ = ["AsyncGeneratedApiClient", "AsyncGeneratedInternalApiClient", "GeneratedApiClient", "GeneratedInternalApiClient", "GradApiError", "LIST_API_KEYS_LIMIT_MAX", "LIST_ARTIFACTS_LIMIT_MAX", "LIST_DATASETS_LIMIT_MAX", "LIST_DATASET_RECORDS_LIMIT_MAX", "LIST_DEPLOYMENTS_LIMIT_MAX", "LIST_EVALS_LIMIT_MAX", "LIST_EVAL_FAILURES_LIMIT_MAX", "LIST_EVAL_OUTPUTS_LIMIT_MAX", "LIST_EVAL_RESULTS_LIMIT_MAX", "LIST_IMPORTS_LIMIT_MAX", "LIST_RUNS_LIMIT_MAX", "LIST_RUN_CHECKPOINTS_LIMIT_MAX", "LIST_RUN_METRICS_LIMIT_MAX", "OPERATIONS", "SCHEMA_ENUMS", "SCHEMA_FIELDS"]

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

ApiKeyScope: TypeAlias = "Literal['admin', 'datasets:read', 'datasets:write', 'runs:read', 'runs:write', 'artifacts:read', 'artifacts:write', 'deployments:write', 'feedback:write', 'env:serve']"

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

ArtifactFormat: TypeAlias = "Literal['peft_lora', 'prefix_kv', 'cartridge', 'encoder_safetensors', 'router_bundle', 'decision_bundle', 'reference'] | None"

BenchmarkSpec = TypedDict(
    "BenchmarkSpec",
    {
        "name": "Literal['ifeval', 'gsm8k', 'mmlu-pro', 'gpqa-diamond', 'humaneval', 'livecodebench']",
        "limit": "NotRequired[int]",
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

ClaimJobRequest = TypedDict(
    "ClaimJobRequest",
    {
        "worker_id": "str",
        "lease_seconds": "NotRequired[int]",
        "kinds": "NotRequired[list[JobKind]]",
        "recipes": "NotRequired[list[RecipeKind]]",
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
        "upload_id": "NotRequired[str]",
        "format": "NotRequired[ArtifactFormat]",
        "manifest": "NotRequired[dict[str, Any]]",
        "eval_report": "NotRequired[EvalReport]",
        "tokens_processed": "NotRequired[int]",
        "error": "NotRequired[str]",
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

EnvTaskDispatch = TypedDict(
    "EnvTaskDispatch",
    {
        "env_name": "str",
        "task": "dict[str, Any]",
        "model_id": "str",
        "system_prompt": "NotRequired[str]",
        "timeout_s": "NotRequired[int]",
    },
)

EnvTaskResult = TypedDict(
    "EnvTaskResult",
    {
        "worker_id": "str",
        "score": "NotRequired[float | None]",
        "scores": "NotRequired[dict[str, float]]",
        "trajectory": "NotRequired[dict[str, Any]]",
        "error": "NotRequired[str]",
    },
)

EnvWorkerRegister = TypedDict(
    "EnvWorkerRegister",
    {
        "name": "str",
        "worker_id": "str",
        "concurrency": "NotRequired[int]",
    },
)

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
        "eval_kl": "NotRequired[float | None]",
        "no_context_kl": "NotRequired[float | None]",
        "kl_reduction": "NotRequired[float | None]",
        "num_tokens": "NotRequired[int]",
        "teacher": "NotRequired[str]",
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
        "validator": "NotRequired[Literal['json', 'non_empty', 'exact_match']]",
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

JobKind: TypeAlias = "Literal['train', 'import']"

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

PlanEvalRequest = TypedDict(
    "PlanEvalRequest",
    {
        "name": "NotRequired[str]",
        "models": "list[str]",
        "baseline": "NotRequired[str]",
        "dataset": "NotRequired[str]",
        "dataset_version": "NotRequired[int]",
        "env_name": "NotRequired[str]",
        "tasks": "NotRequired[list[dict[str, Any]]]",
        "benchmarks": "NotRequired[list[BenchmarkSpec]]",
        "rubric": "NotRequired[list[EvalRubricItem]]",
        "samples": "NotRequired[int]",
        "temperature": "NotRequired[float]",
        "max_tokens": "NotRequired[int]",
        "limit": "NotRequired[int]",
        "pass_threshold": "NotRequired[float | None]",
        "max_cost_usd": "NotRequired[float]",
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
        "price_per_million_tokens": "float",
        "trained_token_fraction": "float",
        "warnings": "list[str]",
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

PostImportRecordsRequest = TypedDict(
    "PostImportRecordsRequest",
    {
        "worker_id": "str",
        "attempt": "int",
        "records": "list[Any]",
    },
)

PostImportRecordsResponse = TypedDict(
    "PostImportRecordsResponse",
    {
        "accepted": "int",
        "rejected": "int",
        "errors": "list[dict[str, Any]]",
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
        "context_uri": "NotRequired[str]",
        "num_tokens": "NotRequired[int]",
        "temp": "NotRequired[float]",
        "teacher": "NotRequired[str]",
        "env_name": "NotRequired[str]",
        "group_size": "NotRequired[int]",
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
        "stop_reason": "Literal['cancelled', 'budget'] | None",
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
        "checkpoint_ttl_days": "int",
        "split": "dict[str, Any]",
        "recipe_params": "dict[str, Any]",
    },
)

ResumeRunRequest = TypedDict(
    "ResumeRunRequest",
    {
        "max_cost_usd": "NotRequired[float]",
    },
)

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
        "latest_metric": "MetricPoint",
        "eval_report": "EvalReport",
        "artifact_id": "str | None",
        "error": "str | None",
        "created_at": "str",
        "updated_at": "str",
        "finished_at": "str | None",
    },
)

RunStatus: TypeAlias = "Literal['queued', 'running', 'completed', 'failed', 'cancelled', 'stopped_budget']"

SplitSpec = TypedDict(
    "SplitSpec",
    {
        "strategy": "NotRequired[Literal['by_session', 'by_group', 'random']]",
        "eval_fraction": "NotRequired[float]",
        "seed": "NotRequired[int]",
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
    },
)

TrainerHeartbeatRequest = TypedDict(
    "TrainerHeartbeatRequest",
    {
        "worker_id": "str",
        "attempt": "int",
        "lease_seconds": "NotRequired[int]",
    },
)

TrainerHeartbeatResponse = TypedDict(
    "TrainerHeartbeatResponse",
    {
        "status": "str",
        "should_stop": "bool",
        "stop_reason": "Literal['cancelled', 'budget'] | None",
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
    },
)

TrainerQueueStats = TypedDict(
    "TrainerQueueStats",
    {
        "queued": "int",
        "running": "int",
        "total": "int",
        "by_kind": "dict[str, Any]",
    },
)

TrainerUploadRequest = TypedDict(
    "TrainerUploadRequest",
    {
        "worker_id": "str",
        "attempt": "int",
        "kind": "Literal['checkpoint', 'artifact']",
        "sha256": "str",
        "size_bytes": "int",
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

ListModelsResponse = TypedDict(
    "ListModelsResponse",
    {
        "data": "list[TrainableModel]",
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

ClaimEnvTaskResponse = TypedDict(
    "ClaimEnvTaskResponse",
    {
        "task": "dict[str, Any] | None",
    },
)

DispatchEnvTaskResponse = TypedDict(
    "DispatchEnvTaskResponse",
    {
        "id": "str",
        "env_name": "str",
        "status": "str",
        "active_workers": "int",
    },
)

RegisterEnvWorkerResponse = TypedDict(
    "RegisterEnvWorkerResponse",
    {
        "name": "str",
        "worker_id": "str",
        "concurrency": "int",
        "last_heartbeat_at": "str",
    },
)

SCHEMA_FIELDS: dict[str, frozenset[str]] = {
    "ApiKey": frozenset({"created_at", "id", "name", "prefix", "revoked_at", "scopes", "workspace_id"}),
    "Artifact": frozenset({"base_model", "checkpoint_id", "created_at", "eval_report", "format", "id", "manifest", "name", "recipe_kind", "run_id", "sha256", "size_bytes", "version", "workspace_id"}),
    "BenchmarkSpec": frozenset({"limit", "name"}),
    "ChatMessage": frozenset({"content", "name", "role", "tool_call_id", "tool_calls", "train"}),
    "Checkpoint": frozenset({"attempt", "best", "created_at", "eval_score", "expires_at", "final", "format", "id", "metadata", "run_id", "sha256", "size_bytes", "step", "workspace_id"}),
    "ClaimJobRequest": frozenset({"kinds", "lease_seconds", "recipes", "worker_id"}),
    "ClaimJobResponse": frozenset({"job", "protocol"}),
    "CompleteTrainerJobRequest": frozenset({"attempt", "error", "eval_report", "format", "import_summary", "manifest", "status", "tokens_processed", "upload_id", "worker_id"}),
    "CompleteTrainerJobResponse": frozenset({"artifact", "import", "job_id", "kind", "run", "status"}),
    "CreateApiKeyRequest": frozenset({"name", "scopes"}),
    "CreateDatasetRequest": frozenset({"metadata", "name"}),
    "CreateImportRequest": frozenset({"connector", "source"}),
    "CreateUploadRequest": frozenset({"filename", "purpose", "sha256", "size_bytes"}),
    "CreatedApiKey": frozenset({"key", "secret"}),
    "Dataset": frozenset({"created_at", "id", "metadata", "name", "record_count", "updated_at", "version", "workspace_id"}),
    "DatasetRecord": frozenset({"chosen", "completion", "expected_output", "group_id", "id", "input", "messages", "metadata", "metrics", "negatives", "output", "positive", "prompt", "query", "questions", "rejected", "role", "schema", "scores", "session_id", "source", "state", "timestamp", "tools"}),
    "DatasetRecordsPage": frozenset({"data", "dataset", "next_cursor", "total", "version"}),
    "DecisionHeadReport": frozenset({"accuracy", "brier", "confusion_matrix", "ece", "examples", "macro_f1", "mae", "per_option", "temperature", "type"}),
    "DeployArtifactRequest": frozenset({"artifact", "explore_rate", "fallback", "name"}),
    "Deployment": frozenset({"active_artifact_id", "created_at", "explore_rate", "fallback_model", "id", "model_id", "name", "previous_artifact_id", "status", "updated_at", "workspace_id"}),
    "DeploymentStatus": frozenset({"average_score", "deployment", "feedback_count"}),
    "EmbedRequest": frozenset({"input", "model"}),
    "EmbedResponse": frozenset({"data", "model", "usage"}),
    "EnvTaskDispatch": frozenset({"env_name", "model_id", "system_prompt", "task", "timeout_s"}),
    "EnvTaskResult": frozenset({"error", "score", "scores", "trajectory", "worker_id"}),
    "EnvWorkerRegister": frozenset({"concurrency", "name", "worker_id"}),
    "EvalModelSummary": frozenset({"ci_high", "ci_low", "cost_per_1k_tasks_usd", "errors", "model", "overall", "pass_at_k", "tasks", "tokens_per_task", "vs_baseline"}),
    "EvalOutput": frozenset({"error", "eval_id", "expected_output", "id", "input", "model", "output", "record", "sample_index", "scores", "task_id", "usage"}),
    "EvalReport": frozenset({"baseline", "best_step", "beta", "candidates", "corpus_size", "dropped_records", "ece", "eval_examples", "eval_kl", "eval_loss", "eval_pairs", "eval_records", "eval_token_accuracy", "fallback_model", "fallback_quality", "final_step", "heads", "kl_reduction", "metric_name", "mrr", "no_context_kl", "num_tokens", "pareto_summary", "preference_accuracy", "recall_at_1", "recall_at_10", "recall_at_5", "reward_margin", "routes_any_traffic", "selected_step", "selection_examples", "teacher", "train_examples", "train_pairs", "train_records", "trained_token_fraction", "truncated", "warnings"}),
    "EvalRubricItem": frozenset({"flags", "kind", "model", "name", "pattern", "prompt", "runtime", "validator", "weight"}),
    "EvalRun": frozenset({"baseline", "completed_at", "created_at", "error", "id", "judge_models", "local_scorers", "max_tokens", "models", "name", "pass_threshold", "progress", "rubric", "samples", "status", "summary", "task_source", "temperature", "total_cost_usd", "updated_at", "workspace_id"}),
    "EvalTaskOutcome": frozenset({"judge_model", "model", "passed", "record", "sample_scores", "score", "task_id"}),
    "FeedbackEventInput": frozenset({"deployment_name", "expected_output", "idempotency_key", "inference_id", "metrics", "score", "session_id"}),
    "FeedbackRecord": frozenset({"created_at", "deployment_name", "expected_output", "id", "idempotency_key", "inference_id", "metrics", "score", "session_id", "workspace_id"}),
    "HfColumnMapping": frozenset({"answer", "chosen", "completion", "messages", "positive", "prompt", "query", "rejected"}),
    "ImportJob": frozenset({"attempt", "connector", "created_at", "dataset", "dataset_version", "detected_scores", "drop_reasons", "dropped_count", "error", "id", "imported_count", "source", "status", "updated_at", "workspace_id"}),
    "MetricPoint": frozenset({"attempt", "cost_usd", "eval_loss", "eval_metrics", "grad_norm", "loss", "lr", "seq", "step", "timestamp", "tokens", "tokens_per_sec"}),
    "MetricPointInput": frozenset({"cost_usd", "eval_loss", "eval_metrics", "grad_norm", "loss", "lr", "step", "timestamp", "tokens", "tokens_per_sec"}),
    "MetricsPage": frozenset({"data", "next_cursor", "run_id", "status", "tail_cursor"}),
    "PlanEvalRequest": frozenset({"baseline", "benchmarks", "dataset", "dataset_version", "env_name", "limit", "max_cost_usd", "max_tokens", "models", "name", "pass_threshold", "rubric", "samples", "tasks", "temperature"}),
    "PlanEvalResponse": frozenset({"dataset_version", "estimated_cost_usd", "estimated_judge_calls", "estimated_model_calls", "estimated_tasks", "judge_models", "local_scorers", "pass_threshold", "task_source_kind", "warnings"}),
    "PlanRunRequest": frozenset({"dataset", "max_cost_usd", "name", "recipe", "split"}),
    "PlanRunResponse": frozenset({"dataset_version", "estimated_cost_usd", "estimated_steps", "estimated_tokens", "price_per_million_tokens", "resolved_config", "total_records", "trained_token_fraction", "usable_records", "warnings"}),
    "PostEvalScoresRequest": frozenset({"scores"}),
    "PostEvalScoresResponse": frozenset({"accepted", "pending_local_scores", "status"}),
    "PostImportRecordsRequest": frozenset({"attempt", "records", "worker_id"}),
    "PostImportRecordsResponse": frozenset({"accepted", "errors", "rejected"}),
    "Problem": frozenset({"code", "detail", "request_id", "status", "title", "type"}),
    "PromoteCheckpointRequest": frozenset({"name"}),
    "PushDatasetRequest": frozenset({"metadata", "records"}),
    "RecipeSpec": frozenset({"adapter", "batch_size", "beta", "checkpoint_ttl_days", "context_text", "context_uri", "env_name", "epochs", "group_size", "kind", "lr", "lr_scale", "max_quality_drop", "model", "models", "num_tokens", "preserve_thinking", "reduction", "schedule", "select", "teacher", "temp", "thinking", "train_on", "warmup"}),
    "RecordFeedbackRequest": frozenset({"events"}),
    "RecordFeedbackResponse": frozenset({"accepted", "deduplicated", "records"}),
    "RegisterTrainerCheckpointRequest": frozenset({"attempt", "eval_score", "format", "metadata", "step", "upload_id", "worker_id"}),
    "RenderDatasetRequest": frozenset({"limit", "model", "preserve_thinking", "thinking", "train_on"}),
    "RenderDatasetResponse": frozenset({"dataset", "examples", "model", "template_revision", "token_counts"}),
    "ReportTrainerProgressRequest": frozenset({"attempt", "metric", "worker_id"}),
    "ReportTrainerProgressResponse": frozenset({"cost_usd", "should_stop", "status", "stop_reason"}),
    "ResolvedRunConfig": frozenset({"adapter", "batch_size", "checkpoint_every_steps", "checkpoint_ttl_days", "dataset", "dataset_version", "epochs", "lr", "lr_source", "model", "name", "preserve_thinking", "recipe_kind", "recipe_params", "reduction", "rule_version", "schedule", "select", "split", "template_revision", "thinking", "train_on", "warmup"}),
    "ResumeRunRequest": frozenset({"max_cost_usd"}),
    "RouteRequest": frozenset({"deployment", "messages", "session_id", "tools"}),
    "RouteResponse": frozenset({"artifact_id", "confidence", "deployment", "inference_id", "is_exploration", "model", "scores"}),
    "RouterParetoSummary": frozenset({"cost_savings_pct", "ece", "offload_rate", "quality_drop", "quality_drop_ci95", "routed_quality", "target_max_drop", "temperature", "threshold"}),
    "Run": frozenset({"artifact_id", "attempt", "cost_usd", "created_at", "current_step", "dataset_id", "dataset_name", "dataset_version", "error", "eval_report", "finished_at", "id", "latest_metric", "max_attempts", "max_cost_usd", "name", "price_per_million_tokens", "recipe_kind", "resolved_config", "status", "tokens_processed", "total_steps", "updated_at", "workspace_id"}),
    "SplitSpec": frozenset({"eval_fraction", "seed", "strategy"}),
    "TrainableModel": frozenset({"adapters", "calibrated_lrs", "default_for", "family", "hf_repo", "id", "max_context_tokens", "price_per_million_tokens_usd", "recipes", "template_revision"}),
    "TrainerHeartbeatRequest": frozenset({"attempt", "lease_seconds", "worker_id"}),
    "TrainerHeartbeatResponse": frozenset({"lease_expires_at", "should_stop", "status", "stop_reason"}),
    "TrainerJob": frozenset({"attempt", "dataset", "id", "import", "kind", "lease_expires_at", "lease_seconds", "max_cost_usd", "price_per_million_tokens", "resume", "run"}),
    "TrainerQueueStats": frozenset({"by_kind", "queued", "running", "total"}),
    "TrainerUploadRequest": frozenset({"attempt", "kind", "sha256", "size_bytes", "worker_id"}),
    "TrajectoryInput": frozenset({"features", "media", "messages", "payload", "tools"}),
    "TrajectoryOutput": frozenset({"payload", "turns"}),
    "UploadTicket": frozenset({"expires_at", "headers", "method", "upload_id", "url"}),
}
"""Property names of every object schema (for client-side typo checks)."""

SCHEMA_ENUMS: dict[str, tuple[Any, ...]] = {
    "ApiKeyScope": ("admin", "datasets:read", "datasets:write", "runs:read", "runs:write", "artifacts:read", "artifacts:write", "deployments:write", "feedback:write", "env:serve",),
    "ArtifactFormat": ("peft_lora", "prefix_kv", "cartridge", "encoder_safetensors", "router_bundle", "decision_bundle", "reference", None,),
    "EvalStatus": ("queued", "running", "awaiting_scores", "completed", "failed", "cancelled",),
    "ImportStatus": ("queued", "running", "completed", "failed",),
    "JobKind": ("train", "import",),
    "RecipeKind": ("sft", "dpo", "router", "decision", "cartridge", "embedding", "distill", "reward", "grpo",),
    "RunStatus": ("queued", "running", "completed", "failed", "cancelled", "stopped_budget",),
}
"""Allowed values of every enum schema."""

OPERATIONS: dict[str, tuple[str, str]] = {
    "cancel_eval": ("POST", "/v1/evals/{id}/cancel"),
    "cancel_run": ("POST", "/v1/runs/{id}/cancel"),
    "create_api_key": ("POST", "/v1/keys"),
    "create_dataset": ("POST", "/v1/datasets"),
    "create_dataset_import": ("POST", "/v1/datasets/{name}/imports"),
    "create_embeddings": ("POST", "/v1/embeddings"),
    "create_eval": ("POST", "/v1/evals"),
    "create_run": ("POST", "/v1/runs"),
    "create_upload": ("POST", "/v1/uploads"),
    "deploy_artifact": ("POST", "/v1/deployments"),
    "download_artifact": ("GET", "/v1/artifacts/{id}/download"),
    "get_artifact": ("GET", "/v1/artifacts/{id}"),
    "get_dataset": ("GET", "/v1/datasets/{name}"),
    "get_deployment": ("GET", "/v1/deployments/{name}"),
    "get_eval": ("GET", "/v1/evals/{id}"),
    "get_import": ("GET", "/v1/imports/{id}"),
    "get_run": ("GET", "/v1/runs/{id}"),
    "list_api_keys": ("GET", "/v1/keys"),
    "list_artifacts": ("GET", "/v1/artifacts"),
    "list_dataset_records": ("GET", "/v1/datasets/{name}/records"),
    "list_datasets": ("GET", "/v1/datasets"),
    "list_deployments": ("GET", "/v1/deployments"),
    "list_eval_failures": ("GET", "/v1/evals/{id}/failures"),
    "list_eval_outputs": ("GET", "/v1/evals/{id}/outputs"),
    "list_eval_results": ("GET", "/v1/evals/{id}/results"),
    "list_evals": ("GET", "/v1/evals"),
    "list_imports": ("GET", "/v1/imports"),
    "list_models": ("GET", "/v1/models"),
    "list_run_checkpoints": ("GET", "/v1/runs/{id}/checkpoints"),
    "list_run_metrics": ("GET", "/v1/runs/{id}/metrics"),
    "list_runs": ("GET", "/v1/runs"),
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
LIST_RUN_METRICS_LIMIT_MAX = 5000
LIST_RUNS_LIMIT_MAX = 200


class GeneratedApiClient:
    """Blocking wire client: one method per public operation in spec/openapi.yaml."""

    def __init__(self, transport: SyncTransport) -> None:
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

    def deploy_artifact(self, body: DeployArtifactRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> Deployment:
        """Deploy or update an artifact under a stable model name."""
        return cast("Deployment", self._t.request("POST", "/v1/deployments", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    def download_artifact(self, id: str, *, timeout: float | None = None) -> Response:
        """Download an artifact bundle (.grad.tar.gz); verify X-Artifact-Sha256 (streams `application/octet-stream`; read or close the response)."""
        return self._t.stream("GET", f"/v1/artifacts/{quote_path_param(id, 'id')}/download", accept="application/octet-stream", timeout=timeout)

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

    def list_api_keys(self, *, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> ListApiKeysResponse:
        """List workspace API keys."""
        return cast("ListApiKeysResponse", self._t.request("GET", "/v1/keys", query={"limit": limit, "cursor": cursor}, timeout=timeout))

    def list_artifacts(self, *, limit: int | None = None, cursor: str | None = None, name: str | None = None, timeout: float | None = None) -> ListArtifactsResponse:
        """List immutable artifacts (newest first)."""
        return cast("ListArtifactsResponse", self._t.request("GET", "/v1/artifacts", query={"limit": limit, "cursor": cursor, "name": name}, timeout=timeout))

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

    def list_models(self, *, timeout: float | None = None) -> ListModelsResponse:
        """List trainable base models (the server catalog and price source)."""
        return cast("ListModelsResponse", self._t.request("GET", "/v1/models", timeout=timeout))

    def list_run_checkpoints(self, id: str, *, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> ListRunCheckpointsResponse:
        """List unexpired checkpoints of a run (best and final never expire)."""
        return cast("ListRunCheckpointsResponse", self._t.request("GET", f"/v1/runs/{quote_path_param(id, 'id')}/checkpoints", query={"limit": limit, "cursor": cursor}, timeout=timeout))

    def list_run_metrics(self, id: str, *, cursor: str | None = None, after_step: int | None = None, limit: int | None = None, timeout: float | None = None) -> MetricsPage:
        """Training step metrics as JSON pages, or a live SSE stream."""
        return cast("MetricsPage", self._t.request("GET", f"/v1/runs/{quote_path_param(id, 'id')}/metrics", query={"cursor": cursor, "after_step": after_step, "limit": limit}, timeout=timeout))

    def list_run_metrics_stream(self, id: str, *, cursor: str | None = None, after_step: int | None = None, limit: int | None = None, timeout: float | None = None) -> Response:
        """Training step metrics as JSON pages, or a live SSE stream (Server-Sent Events stream; read or close the response)."""
        return self._t.stream("GET", f"/v1/runs/{quote_path_param(id, 'id')}/metrics", query={"cursor": cursor, "after_step": after_step, "limit": limit}, accept="text/event-stream", timeout=timeout)

    def list_runs(self, *, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> ListRunsResponse:
        """List training runs (newest first)."""
        return cast("ListRunsResponse", self._t.request("GET", "/v1/runs", query={"limit": limit, "cursor": cursor}, timeout=timeout))

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
        """Copy an exportable checkpoint into a new immutable artifact."""
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


class AsyncGeneratedApiClient:
    """asyncio wire client: one coroutine per public operation in spec/openapi.yaml."""

    def __init__(self, transport: AsyncTransport) -> None:
        self._t = transport

    async def cancel_eval(self, id: str, *, idempotency_key: str | None = None, timeout: float | None = None) -> EvalRun:
        """Cancel a queued, running or awaiting_scores evaluation."""
        return cast("EvalRun", await self._t.request("POST", f"/v1/evals/{quote_path_param(id, 'id')}/cancel", headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    async def cancel_run(self, id: str, *, idempotency_key: str | None = None, timeout: float | None = None) -> Run:
        """Cancel a training run (a running attempt is stopped and billed)."""
        return cast("Run", await self._t.request("POST", f"/v1/runs/{quote_path_param(id, 'id')}/cancel", headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    async def create_api_key(self, body: CreateApiKeyRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> CreatedApiKey:
        """Create a scoped workspace API key (trainer worker keys are platform config, not keys)."""
        return cast("CreatedApiKey", await self._t.request("POST", "/v1/keys", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    async def create_dataset(self, body: CreateDatasetRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> Dataset:
        """Create an empty dataset."""
        return cast("Dataset", await self._t.request("POST", "/v1/datasets", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    async def create_dataset_import(self, name: str, body: CreateImportRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> ImportJob:
        """Import an uploaded file or a Hugging Face dataset into a dataset (async job)."""
        return cast("ImportJob", await self._t.request("POST", f"/v1/datasets/{quote_path_param(name, 'name')}/imports", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    async def create_embeddings(self, body: EmbedRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> EmbedResponse:
        """Generate embeddings from a deployed embedding artifact."""
        return cast("EmbedResponse", await self._t.request("POST", "/v1/embeddings", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    async def create_eval(self, body: PlanEvalRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> EvalRun:
        """Queue an evaluation across models on a pinned dataset version (executed by the server)."""
        return cast("EvalRun", await self._t.request("POST", "/v1/evals", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    async def create_run(self, body: PlanRunRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> Run:
        """Create and enqueue a training run (pins the dataset version)."""
        return cast("Run", await self._t.request("POST", "/v1/runs", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    async def create_upload(self, body: CreateUploadRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> UploadTicket:
        """Get an upload URL for a file to import (PUT the bytes, then create an import)."""
        return cast("UploadTicket", await self._t.request("POST", "/v1/uploads", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    async def deploy_artifact(self, body: DeployArtifactRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> Deployment:
        """Deploy or update an artifact under a stable model name."""
        return cast("Deployment", await self._t.request("POST", "/v1/deployments", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    async def download_artifact(self, id: str, *, timeout: float | None = None) -> AsyncResponse:
        """Download an artifact bundle (.grad.tar.gz); verify X-Artifact-Sha256 (streams `application/octet-stream`; read or close the response)."""
        return await self._t.stream("GET", f"/v1/artifacts/{quote_path_param(id, 'id')}/download", accept="application/octet-stream", timeout=timeout)

    async def get_artifact(self, id: str, *, timeout: float | None = None) -> Artifact:
        """Get an artifact by id or name@latest."""
        return cast("Artifact", await self._t.request("GET", f"/v1/artifacts/{quote_path_param(id, 'id')}", timeout=timeout))

    async def get_dataset(self, name: str, *, timeout: float | None = None) -> Dataset:
        """Get a dataset by name."""
        return cast("Dataset", await self._t.request("GET", f"/v1/datasets/{quote_path_param(name, 'name')}", timeout=timeout))

    async def get_deployment(self, name: str, *, timeout: float | None = None) -> DeploymentStatus:
        """Get deployment status and feedback summary."""
        return cast("DeploymentStatus", await self._t.request("GET", f"/v1/deployments/{quote_path_param(name, 'name')}", timeout=timeout))

    async def get_eval(self, id: str, *, timeout: float | None = None) -> EvalRun:
        """Get an evaluation run by ID."""
        return cast("EvalRun", await self._t.request("GET", f"/v1/evals/{quote_path_param(id, 'id')}", timeout=timeout))

    async def get_import(self, id: str, *, timeout: float | None = None) -> ImportJob:
        """Get a dataset import job."""
        return cast("ImportJob", await self._t.request("GET", f"/v1/imports/{quote_path_param(id, 'id')}", timeout=timeout))

    async def get_run(self, id: str, *, timeout: float | None = None) -> Run:
        """Get a training run."""
        return cast("Run", await self._t.request("GET", f"/v1/runs/{quote_path_param(id, 'id')}", timeout=timeout))

    async def list_api_keys(self, *, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> ListApiKeysResponse:
        """List workspace API keys."""
        return cast("ListApiKeysResponse", await self._t.request("GET", "/v1/keys", query={"limit": limit, "cursor": cursor}, timeout=timeout))

    async def list_artifacts(self, *, limit: int | None = None, cursor: str | None = None, name: str | None = None, timeout: float | None = None) -> ListArtifactsResponse:
        """List immutable artifacts (newest first)."""
        return cast("ListArtifactsResponse", await self._t.request("GET", "/v1/artifacts", query={"limit": limit, "cursor": cursor, "name": name}, timeout=timeout))

    async def list_dataset_records(self, name: str, *, version: int | None = None, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> DatasetRecordsPage:
        """Read records of a dataset version."""
        return cast("DatasetRecordsPage", await self._t.request("GET", f"/v1/datasets/{quote_path_param(name, 'name')}/records", query={"version": version, "limit": limit, "cursor": cursor}, timeout=timeout))

    async def list_datasets(self, *, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> ListDatasetsResponse:
        """List datasets (newest first)."""
        return cast("ListDatasetsResponse", await self._t.request("GET", "/v1/datasets", query={"limit": limit, "cursor": cursor}, timeout=timeout))

    async def list_deployments(self, *, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> ListDeploymentsResponse:
        """List deployments."""
        return cast("ListDeploymentsResponse", await self._t.request("GET", "/v1/deployments", query={"limit": limit, "cursor": cursor}, timeout=timeout))

    async def list_eval_failures(self, id: str, *, limit: int | None = None, cursor: str | None = None, model: str | None = None, threshold: float | None = None, timeout: float | None = None) -> ListEvalFailuresResponse:
        """List failing task records from an evaluation run for mining."""
        return cast("ListEvalFailuresResponse", await self._t.request("GET", f"/v1/evals/{quote_path_param(id, 'id')}/failures", query={"limit": limit, "cursor": cursor, "model": model, "threshold": threshold}, timeout=timeout))

    async def list_eval_outputs(self, id: str, *, limit: int | None = None, cursor: str | None = None, model: str | None = None, missing_scorer: str | None = None, timeout: float | None = None) -> ListEvalOutputsResponse:
        """Page through generated model outputs (filter by model or by a code scorer that still needs a score)."""
        return cast("ListEvalOutputsResponse", await self._t.request("GET", f"/v1/evals/{quote_path_param(id, 'id')}/outputs", query={"limit": limit, "cursor": cursor, "model": model, "missing_scorer": missing_scorer}, timeout=timeout))

    async def list_eval_results(self, id: str, *, limit: int | None = None, cursor: str | None = None, model: str | None = None, timeout: float | None = None) -> ListEvalResultsResponse:
        """Per-task, per-model results of a completed evaluation."""
        return cast("ListEvalResultsResponse", await self._t.request("GET", f"/v1/evals/{quote_path_param(id, 'id')}/results", query={"limit": limit, "cursor": cursor, "model": model}, timeout=timeout))

    async def list_evals(self, *, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> ListEvalsResponse:
        """List evaluation runs."""
        return cast("ListEvalsResponse", await self._t.request("GET", "/v1/evals", query={"limit": limit, "cursor": cursor}, timeout=timeout))

    async def list_imports(self, *, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> ListImportsResponse:
        """List dataset import jobs (newest first)."""
        return cast("ListImportsResponse", await self._t.request("GET", "/v1/imports", query={"limit": limit, "cursor": cursor}, timeout=timeout))

    async def list_models(self, *, timeout: float | None = None) -> ListModelsResponse:
        """List trainable base models (the server catalog and price source)."""
        return cast("ListModelsResponse", await self._t.request("GET", "/v1/models", timeout=timeout))

    async def list_run_checkpoints(self, id: str, *, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> ListRunCheckpointsResponse:
        """List unexpired checkpoints of a run (best and final never expire)."""
        return cast("ListRunCheckpointsResponse", await self._t.request("GET", f"/v1/runs/{quote_path_param(id, 'id')}/checkpoints", query={"limit": limit, "cursor": cursor}, timeout=timeout))

    async def list_run_metrics(self, id: str, *, cursor: str | None = None, after_step: int | None = None, limit: int | None = None, timeout: float | None = None) -> MetricsPage:
        """Training step metrics as JSON pages, or a live SSE stream."""
        return cast("MetricsPage", await self._t.request("GET", f"/v1/runs/{quote_path_param(id, 'id')}/metrics", query={"cursor": cursor, "after_step": after_step, "limit": limit}, timeout=timeout))

    async def list_run_metrics_stream(self, id: str, *, cursor: str | None = None, after_step: int | None = None, limit: int | None = None, timeout: float | None = None) -> AsyncResponse:
        """Training step metrics as JSON pages, or a live SSE stream (Server-Sent Events stream; read or close the response)."""
        return await self._t.stream("GET", f"/v1/runs/{quote_path_param(id, 'id')}/metrics", query={"cursor": cursor, "after_step": after_step, "limit": limit}, accept="text/event-stream", timeout=timeout)

    async def list_runs(self, *, limit: int | None = None, cursor: str | None = None, timeout: float | None = None) -> ListRunsResponse:
        """List training runs (newest first)."""
        return cast("ListRunsResponse", await self._t.request("GET", "/v1/runs", query={"limit": limit, "cursor": cursor}, timeout=timeout))

    async def plan_eval(self, body: PlanEvalRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> PlanEvalResponse:
        """Estimate tasks, model/judge calls, and cost before running an eval."""
        return cast("PlanEvalResponse", await self._t.request("POST", "/v1/evals/plan", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    async def plan_run(self, body: PlanRunRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> PlanRunResponse:
        """Dry-run a training recipe at zero cost."""
        return cast("PlanRunResponse", await self._t.request("POST", "/v1/runs/plan", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    async def post_eval_scores(self, id: str, body: PostEvalScoresRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> PostEvalScoresResponse:
        """Post scores computed by local (SDK-side) code scorers; the eval completes when none are missing."""
        return cast("PostEvalScoresResponse", await self._t.request("POST", f"/v1/evals/{quote_path_param(id, 'id')}/scores", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    async def promote_checkpoint(self, id: str, body: PromoteCheckpointRequest | Mapping[str, Any] | None = None, *, idempotency_key: str | None = None, timeout: float | None = None) -> Artifact:
        """Copy an exportable checkpoint into a new immutable artifact."""
        return cast("Artifact", await self._t.request("POST", f"/v1/checkpoints/{quote_path_param(id, 'id')}/promote", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    async def push_dataset_records(self, name: str, body: PushDatasetRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> Dataset:
        """Append records as a new dataset version (creates the dataset if needed)."""
        return cast("Dataset", await self._t.request("POST", f"/v1/datasets/{quote_path_param(name, 'name')}/records", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    async def record_feedback(self, body: RecordFeedbackRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> RecordFeedbackResponse:
        """Record deduplicated outcome scores and gold corrections."""
        return cast("RecordFeedbackResponse", await self._t.request("POST", "/v1/feedback", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    async def render_dataset(self, name: str, body: RenderDatasetRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> RenderDatasetResponse:
        """Preview chat-template rendering and loss masks (estimated token counts)."""
        return cast("RenderDatasetResponse", await self._t.request("POST", f"/v1/datasets/{quote_path_param(name, 'name')}/render", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    async def resume_run(self, id: str, body: ResumeRunRequest | Mapping[str, Any] | None = None, *, idempotency_key: str | None = None, timeout: float | None = None) -> Run:
        """Resume a stopped, failed or cancelled run from its latest checkpoint."""
        return cast("Run", await self._t.request("POST", f"/v1/runs/{quote_path_param(id, 'id')}/resume", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    async def revoke_api_key(self, id: str, *, timeout: float | None = None) -> ApiKey:
        """Revoke a workspace API key."""
        return cast("ApiKey", await self._t.request("DELETE", f"/v1/keys/{quote_path_param(id, 'id')}", timeout=timeout))

    async def rollback_deployment(self, name: str, *, idempotency_key: str | None = None, timeout: float | None = None) -> Deployment:
        """Roll a deployment back to its previous artifact."""
        return cast("Deployment", await self._t.request("POST", f"/v1/deployments/{quote_path_param(name, 'name')}/rollback", headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))

    async def route_request(self, body: RouteRequest | Mapping[str, Any], *, idempotency_key: str | None = None, timeout: float | None = None) -> RouteResponse:
        """Ask a deployed model router which model to call."""
        return cast("RouteResponse", await self._t.request("POST", "/v1/route", json_body=body, headers={"Idempotency-Key": idempotency_key or new_idempotency_key()}, timeout=timeout))


class GeneratedInternalApiClient:
    """Blocking client for the SDK's own worker protocols (x-internal operations); not a public API and may change without notice."""

    def __init__(self, transport: SyncTransport) -> None:
        self._t = transport

    def claim_env_task(self, name: str, body: Mapping[str, Any], *, timeout: float | None = None) -> ClaimEnvTaskResponse:
        """Long-poll for the next task assigned to a `grad env serve` worker."""
        return cast("ClaimEnvTaskResponse", self._t.request("POST", f"/v1/env-workers/{quote_path_param(name, 'name')}/claim", json_body=body, timeout=timeout))

    def complete_env_task(self, id: str, body: EnvTaskResult | Mapping[str, Any], *, timeout: float | None = None) -> dict[str, Any]:
        """Submit scored trajectory output for an environment task."""
        return cast("dict[str, Any]", self._t.request("POST", f"/v1/env-workers/tasks/{quote_path_param(id, 'id')}/complete", json_body=body, timeout=timeout))

    def dispatch_env_task(self, body: EnvTaskDispatch | Mapping[str, Any], *, timeout: float | None = None) -> DispatchEnvTaskResponse:
        """Dispatch an evaluation or rollout task to a connected `grad env serve` worker."""
        return cast("DispatchEnvTaskResponse", self._t.request("POST", "/v1/env-workers/tasks", json_body=body, timeout=timeout))

    def get_env_task(self, id: str, *, timeout: float | None = None) -> dict[str, Any]:
        """Inspect an environment task and its result."""
        return cast("dict[str, Any]", self._t.request("GET", f"/v1/env-workers/tasks/{quote_path_param(id, 'id')}", timeout=timeout))

    def register_env_worker(self, body: EnvWorkerRegister | Mapping[str, Any], *, timeout: float | None = None) -> RegisterEnvWorkerResponse:
        """Register or heartbeat an outbound `grad env serve` worker."""
        return cast("RegisterEnvWorkerResponse", self._t.request("POST", "/v1/env-workers/register", json_body=body, timeout=timeout))


class AsyncGeneratedInternalApiClient:
    """asyncio client for the SDK's own worker protocols (x-internal operations); not a public API and may change without notice."""

    def __init__(self, transport: AsyncTransport) -> None:
        self._t = transport

    async def claim_env_task(self, name: str, body: Mapping[str, Any], *, timeout: float | None = None) -> ClaimEnvTaskResponse:
        """Long-poll for the next task assigned to a `grad env serve` worker."""
        return cast("ClaimEnvTaskResponse", await self._t.request("POST", f"/v1/env-workers/{quote_path_param(name, 'name')}/claim", json_body=body, timeout=timeout))

    async def complete_env_task(self, id: str, body: EnvTaskResult | Mapping[str, Any], *, timeout: float | None = None) -> dict[str, Any]:
        """Submit scored trajectory output for an environment task."""
        return cast("dict[str, Any]", await self._t.request("POST", f"/v1/env-workers/tasks/{quote_path_param(id, 'id')}/complete", json_body=body, timeout=timeout))

    async def dispatch_env_task(self, body: EnvTaskDispatch | Mapping[str, Any], *, timeout: float | None = None) -> DispatchEnvTaskResponse:
        """Dispatch an evaluation or rollout task to a connected `grad env serve` worker."""
        return cast("DispatchEnvTaskResponse", await self._t.request("POST", "/v1/env-workers/tasks", json_body=body, timeout=timeout))

    async def get_env_task(self, id: str, *, timeout: float | None = None) -> dict[str, Any]:
        """Inspect an environment task and its result."""
        return cast("dict[str, Any]", await self._t.request("GET", f"/v1/env-workers/tasks/{quote_path_param(id, 'id')}", timeout=timeout))

    async def register_env_worker(self, body: EnvWorkerRegister | Mapping[str, Any], *, timeout: float | None = None) -> RegisterEnvWorkerResponse:
        """Register or heartbeat an outbound `grad env serve` worker."""
        return cast("RegisterEnvWorkerResponse", await self._t.request("POST", "/v1/env-workers/register", json_body=body, timeout=timeout))
