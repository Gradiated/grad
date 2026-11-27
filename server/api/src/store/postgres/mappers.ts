import type {
  ApiKey,
  Dataset,
  Deployment,
  FeedbackRecord,
  MetricPoint,
} from "../../contracts.js";
import type {
  ArtifactRecord,
  BillingOutboxEntry,
  CheckpointRecord,
  DatasetPart,
  DatasetVersion,
  EvalOutputRow,
  EvalRecord,
  EvalResultRow,
  EvalTaskRow,
  ImportJobRecord,
  InferenceRecord,
  RunRecord,
  UploadRecord,
} from "../types.js";
import type { Row } from "./db.js";

/** One place for pg → domain coercion (BIGINT strings, Dates, jsonb). */
const s = (v: unknown): string => String(v);
const sn = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
const n = (v: unknown): number => Number(v ?? 0);
const nn = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);
const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
const isoN = (v: unknown): string | null =>
  v === null || v === undefined ? null : iso(v);
const j = <T>(v: unknown, fallback: T): T =>
  v === null || v === undefined ? fallback : (v as T);

export const toApiKey = (r: Row): ApiKey => ({
  id: s(r.id),
  workspace_id: s(r.workspace_id),
  name: s(r.name),
  prefix: s(r.prefix),
  scopes: j(r.scopes, []),
  created_at: iso(r.created_at),
  revoked_at: isoN(r.revoked_at),
});

export const toDataset = (r: Row): Dataset => ({
  id: s(r.id),
  workspace_id: s(r.workspace_id),
  name: s(r.name),
  version: n(r.version),
  record_count: n(r.record_count),
  metadata: j(r.metadata, {}),
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
});

export const toDatasetVersion = (r: Row): DatasetVersion => ({
  dataset_id: s(r.dataset_id),
  version: n(r.version),
  parts: j<DatasetPart[]>(r.parts, []),
  record_count: n(r.record_count),
  created_at: iso(r.created_at),
});

export const toImportJob = (r: Row): ImportJobRecord => ({
  id: s(r.id),
  workspace_id: s(r.workspace_id),
  dataset_id: s(r.dataset_id),
  dataset: s(r.dataset_name),
  status: s(r.status) as ImportJobRecord["status"],
  source: j(r.source, {}),
  connector: s(r.connector) as ImportJobRecord["connector"],
  attempt: n(r.attempt),
  imported_count: n(r.imported_count),
  dropped_count: n(r.dropped_count),
  detected_scores: j(r.detected_scores, []),
  drop_reasons: j(r.drop_reasons, []),
  dataset_version: nn(r.dataset_version),
  error: sn(r.error),
  upload_key: sn(r.upload_key),
  worker_id: sn(r.worker_id),
  lease_expires_at: isoN(r.lease_expires_at),
  lease_seconds: n(r.lease_seconds),
  failed_attempts: n(r.failed_attempts),
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
});

export const toRun = (r: Row): RunRecord => ({
  id: s(r.id),
  workspace_id: s(r.workspace_id),
  name: s(r.name),
  dataset_id: s(r.dataset_id),
  dataset_name: s(r.dataset_name),
  dataset_version: n(r.dataset_version),
  recipe_kind: s(r.recipe_kind) as RunRecord["recipe_kind"],
  status: s(r.status) as RunRecord["status"],
  resolved_config: j(r.resolved_config, {} as RunRecord["resolved_config"]),
  max_cost_usd: nn(r.max_cost_usd),
  price_per_million_tokens: n(r.price_per_million_tokens),
  total_steps: n(r.total_steps),
  current_step: n(r.current_step),
  attempt: n(r.attempt),
  max_attempts: n(r.max_attempts),
  failed_attempts: n(r.failed_attempts),
  billed_tokens: n(r.billed_tokens),
  billed_cost_usd: n(r.billed_cost_usd),
  attempt_tokens: n(r.attempt_tokens),
  worker_id: sn(r.worker_id),
  lease_expires_at: isoN(r.lease_expires_at),
  lease_seconds: n(r.lease_seconds),
  latest_metric: j<MetricPoint | null>(r.latest_metric, null),
  eval_report: j<Record<string, unknown> | null>(r.eval_report, null),
  artifact_id: sn(r.artifact_id),
  depends_on: sn(r.depends_on),
  waiting_on: sn(r.waiting_on),
  error: sn(r.error),
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
  finished_at: isoN(r.finished_at),
});

export const toMetric = (r: Row): MetricPoint =>
  ({
    ...j<Record<string, unknown>>(r.point, {}),
    seq: n(r.seq),
    attempt: n(r.attempt),
  }) as MetricPoint;

export const toCheckpoint = (r: Row): CheckpointRecord => ({
  id: s(r.id),
  workspace_id: s(r.workspace_id),
  run_id: s(r.run_id),
  attempt: n(r.attempt),
  step: n(r.step),
  eval_score: nn(r.eval_score),
  format: sn(r.format) as CheckpointRecord["format"],
  storage_key: s(r.storage_key),
  sha256: s(r.sha256),
  size_bytes: n(r.size_bytes),
  metadata: j(r.metadata, {}),
  best: r.best === true,
  final: r.final === true,
  expires_at: isoN(r.expires_at),
  created_at: iso(r.created_at),
});

export const toArtifact = (r: Row): ArtifactRecord => ({
  id: s(r.id),
  workspace_id: s(r.workspace_id),
  name: s(r.name),
  version: s(r.version),
  run_id: sn(r.run_id),
  checkpoint_id: sn(r.checkpoint_id),
  base_model: s(r.base_model),
  recipe_kind: s(r.recipe_kind) as ArtifactRecord["recipe_kind"],
  format: s(r.format) as ArtifactRecord["format"],
  storage_key: s(r.storage_key),
  sha256: s(r.sha256),
  size_bytes: n(r.size_bytes),
  manifest: j(r.manifest, {}),
  eval_report: j<Record<string, unknown> | null>(r.eval_report, null),
  created_at: iso(r.created_at),
});

export const toUpload = (r: Row): UploadRecord => ({
  id: s(r.id),
  workspace_id: s(r.workspace_id),
  purpose: s(r.purpose) as UploadRecord["purpose"],
  job_id: sn(r.job_id),
  attempt: nn(r.attempt),
  storage_key: s(r.storage_key),
  sha256: s(r.sha256),
  size_bytes: n(r.size_bytes),
  status: s(r.status) as UploadRecord["status"],
  consumed_by: sn(r.consumed_by),
  created_at: iso(r.created_at),
  expires_at: iso(r.expires_at),
});

export const toDeployment = (r: Row): Deployment => ({
  id: s(r.id),
  workspace_id: s(r.workspace_id),
  name: s(r.name),
  model_id: s(r.model_id),
  active_artifact_id: s(r.active_artifact_id),
  previous_artifact_id: sn(r.previous_artifact_id),
  fallback_model: sn(r.fallback_model),
  explore_rate: n(r.explore_rate),
  status: s(r.status) as Deployment["status"],
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
});

export const toInference = (r: Row): InferenceRecord => ({
  id: s(r.id),
  workspace_id: s(r.workspace_id),
  deployment_name: s(r.deployment_name),
  artifact_id: s(r.artifact_id),
  model: s(r.model),
  created_at: iso(r.created_at),
});

export const toFeedback = (r: Row): FeedbackRecord => ({
  id: s(r.id),
  workspace_id: s(r.workspace_id),
  inference_id: sn(r.inference_id),
  session_id: sn(r.session_id),
  deployment_name: sn(r.deployment_name),
  idempotency_key: s(r.idempotency_key),
  score: nn(r.score),
  expected_output: j<unknown>(r.expected_output, null),
  metrics: j(r.metrics, {}),
  created_at: iso(r.created_at),
});

export const toEval = (r: Row): EvalRecord => ({
  id: s(r.id),
  workspace_id: s(r.workspace_id),
  name: s(r.name),
  status: s(r.status) as EvalRecord["status"],
  models: j(r.models, []),
  model_targets: j(r.model_targets, {}),
  baseline: sn(r.baseline),
  dataset_id: s(r.dataset_id),
  dataset_name: s(r.dataset_name),
  dataset_version: n(r.dataset_version),
  rubric: j(r.rubric, []),
  samples: n(r.samples),
  temperature: n(r.temperature),
  max_tokens: n(r.max_tokens),
  limit: nn(r.limit),
  pass_threshold: n(r.pass_threshold),
  judge_models: j(r.judge_models, []),
  local_scorers: j(r.local_scorers, []),
  total_outputs: n(r.total_outputs),
  generated: n(r.generated),
  summary: j(r.summary, []),
  total_cost_usd: n(r.total_cost_usd),
  error: sn(r.error),
  attempt: n(r.attempt),
  worker_id: sn(r.worker_id),
  lease_expires_at: isoN(r.lease_expires_at),
  lease_seconds: n(r.lease_seconds),
  max_cost_usd: nn(r.max_cost_usd),
  estimated_cost_usd: n(r.estimated_cost_usd),
  budget_stopped: r.budget_stopped === true,
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
  completed_at: isoN(r.completed_at),
});

export const toEvalTask = (r: Row): EvalTaskRow => ({
  eval_id: s(r.eval_id),
  task_index: n(r.task_index),
  task_id: s(r.task_id),
  record: j(r.record, {}),
});

export const toEvalOutput = (r: Row): EvalOutputRow => ({
  id: s(r.id),
  eval_id: s(r.eval_id),
  task_index: n(r.task_index),
  task_id: s(r.task_id),
  model: s(r.model),
  sample_index: n(r.sample_index),
  input: j(r.input, []),
  output: sn(r.output),
  expected_output: j<unknown>(r.expected_output, null),
  scores: j(r.scores, {}),
  error: sn(r.error),
  prompt_tokens: n(r.prompt_tokens),
  completion_tokens: n(r.completion_tokens),
  cost_usd: n(r.cost_usd),
  created_at: iso(r.created_at),
});

export const toEvalResult = (r: Row): EvalResultRow => ({
  eval_id: s(r.eval_id),
  task_index: n(r.task_index),
  task_id: s(r.task_id),
  model: s(r.model),
  score: n(r.score),
  passed: r.passed === true,
  sample_scores: j(r.sample_scores, []),
  judge_model: sn(r.judge_model),
});

export const toBilling = (r: Row): BillingOutboxEntry => ({
  id: s(r.id),
  idempotency_key: s(r.idempotency_key),
  workspace_id: s(r.workspace_id),
  kind: s(r.kind) as BillingOutboxEntry["kind"],
  run_id: s(r.run_id),
  attempt: n(r.attempt),
  tokens: n(r.tokens),
  cost_usd: n(r.cost_usd),
  status: s(r.status) as BillingOutboxEntry["status"],
  attempts: n(r.attempts),
  last_error: sn(r.last_error),
  next_attempt_at: iso(r.next_attempt_at),
  created_at: iso(r.created_at),
  sent_at: isoN(r.sent_at),
});
