import type {
  ApiKey,
  Dataset,
  EvalReport,
  MetricPoint,
  UsageKind,
  UsageRecord,
} from "../../contracts.js";
import type {
  ArtifactRecord,
  CheckpointRecord,
  DatasetPart,
  EvalDomain,
  EvalOutputRow,
  ImportPayload,
  JobEvent,
  JobFields,
  LedgerRow,
  RunDomain,
  RunEventsView,
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

export const toPart = (r: Row): DatasetPart => ({
  key: s(r.key),
  count: n(r.count),
  resets: r.resets === true,
  sha256: s(r.sha256),
  bytes: n(r.bytes),
});

export const toJob = <S extends string>(r: Row): JobFields<S> => ({
  id: s(r.id),
  workspace_id: s(r.workspace_id),
  kind: s(r.kind) as JobFields["kind"],
  status: s(r.status) as S,
  attempt: n(r.attempt),
  failed_attempts: n(r.failed_attempts),
  preemptions: n(r.preemptions),
  max_attempts: n(r.max_attempts),
  worker_id: sn(r.worker_id),
  worker_key: sn(r.worker_key),
  lease_expires_at: isoN(r.lease_expires_at),
  lease_seconds: n(r.lease_seconds),
  waiting_on: sn(r.waiting_on),
  billed_through: n(r.billed_through),
  billed_cost: n(r.billed_cost),
  billed_at: isoN(r.billed_at),
  error: sn(r.last_error),
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
  finished_at: isoN(r.finished_at),
  min_gpu_memory_gb: nn(r.min_gpu_memory_gb),
  ...jobTelemetry(r),
});

/** The telemetry fields a job keeps in its payload. */
export const jobTelemetry = (
  r: Row,
): { traceparent: string | null; origin: "api" | "source" } => {
  const p = j<Record<string, unknown>>(r.payload, {});
  const source = j<Record<string, unknown>>(p.source, {});

  return {
    traceparent: typeof p.traceparent === "string" ? p.traceparent : null,
    origin: typeof source.source_id === "string" ? "source" : "api",
  };
};

export const toImportPayload = (r: Row): ImportPayload => {
  const p = j<Record<string, unknown>>(r.payload, {});

  return {
    dataset_id: s(p.dataset_id),
    dataset: s(p.dataset),
    source: j(p.source, {}),
    connector: s(p.connector) as ImportPayload["connector"],
    upload_key: sn(p.upload_key),
    imported_count: n(p.imported_count),
    dropped_count: n(p.dropped_count),
    detected_scores: j(p.detected_scores, []),
    drop_reasons: j(p.drop_reasons, []),
    dataset_version: nn(p.dataset_version),
  };
};

export const toRunDomain = (r: Row): RunDomain => ({
  name: s(r.name),
  dataset_id: s(r.dataset_id),
  dataset_name: s(r.dataset_name),
  dataset_version: n(r.dataset_version),
  recipe_kind: s(r.recipe_kind) as RunDomain["recipe_kind"],
  resolved_config: j(r.resolved_config, {} as RunDomain["resolved_config"]),
  max_cost_usd: nn(r.max_cost_usd),
  price_per_million_tokens: n(r.price_per_million_tokens),
  total_steps: n(r.total_steps),
  current_step: n(r.current_step),
  billed_tokens: n(r.billed_tokens),
  attempt_tokens: n(r.attempt_tokens),
  latest_metric: j<MetricPoint | null>(r.latest_metric, null),
  eval_report: j<EvalReport | null>(r.eval_report, null),
  checkpoint_evals: j(r.checkpoint_evals, []),
  artifact_id: sn(r.artifact_id),
});

export const toEvalDomain = (r: Row): EvalDomain => ({
  name: s(r.name),
  models: j(r.models, []),
  model_targets: j(r.model_targets, {}),
  baseline: sn(r.baseline),
  dataset_id: s(r.dataset_id),
  dataset_name: s(r.dataset_name),
  dataset_version: n(r.dataset_version),
  rubric: j(r.rubric, []),
  mode: (sn(r.mode) ?? "eval") as EvalDomain["mode"],
  scored_dataset_version: nn(r.scored_dataset_version),
  run_id: sn(r.run_id),
  run_step: nn(r.run_step),
  samples: n(r.samples),
  temperature: n(r.temperature),
  max_tokens: n(r.max_tokens),
  limit: nn(r.limit),
  pass_threshold: n(r.pass_threshold),
  judge_models: j(r.judge_models, []),
  judge_targets: j(r.judge_targets, {}),
  local_scorers: j(r.local_scorers, []),
  total_outputs: n(r.total_outputs),
  generated: n(r.generated),
  summary: j(r.summary, []),
  total_cost_usd: n(r.total_cost_usd),
});

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
  metadata: j(r.manifest, {}),
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
  checkpoint_id: sn(r.source_id),
  base_model: s(r.base_model),
  recipe_kind: s(r.recipe_kind) as ArtifactRecord["recipe_kind"],
  format: s(r.format) as ArtifactRecord["format"],
  storage_key: s(r.storage_key),
  sha256: s(r.sha256),
  size_bytes: n(r.size_bytes),
  manifest: j(r.manifest, {}),
  eval_report: j<EvalReport | null>(r.eval_report, null),
  created_at: iso(r.created_at),
});

export const toEvalOutput = (r: Row): EvalOutputRow => ({
  id: s(r.id),
  eval_id: s(r.eval_id),
  attempt: n(r.attempt),
  task_index: n(r.task_index),
  task_id: s(r.task_id),
  model: s(r.model),
  sample_index: n(r.sample_index),
  record: j(r.record, {}),
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

export const toLedgerRow = (r: Row): LedgerRow => ({
  id: `use_${s(r.seq)}`,
  kind: s(r.kind) as LedgerRow["kind"],
  ref_id: s(r.ref_id),
  attempt: n(r.attempt),
  tokens_from: n(r.tokens_from),
  tokens_through: n(r.tokens_through),
  tokens: n(r.tokens),
  cost_usd: n(r.cost_usd),
  price_version: s(r.price_version),
  idempotency_key: s(r.idempotency_key),
  created_at: iso(r.created_at),
});

/** A ledger row joined with what it paid for (store/postgres/usage.ts). */
export const toUsage = (r: Row): UsageRecord => ({
  ...toLedgerRow(r),
  kind: s(r.usage_kind) as UsageKind,
  ref_name: sn(r.ref_name),
  run_id: sn(r.run_id),
});

export const toEvent = (r: Row): JobEvent => ({
  seq: n(r.seq),
  attempt: n(r.attempt),
  type: s(r.type),
  step: n(r.step),
  payload: j<Record<string, unknown>>(r.payload, {}),
  created_at: iso(r.created_at),
});

/** The run lateral columns (see the runs repository) → its lifecycle view. */
export const toRunEventsView = (r: Row): RunEventsView => {
  const event = (prefix: string): JobEvent | null =>
    r[`${prefix}_seq`] === null || r[`${prefix}_seq`] === undefined
      ? null
      : toEvent({
          seq: r[`${prefix}_seq`],
          attempt: r[`${prefix}_attempt`],
          type: r[`${prefix}_type`],
          step: r[`${prefix}_step`],
          payload: r[`${prefix}_payload`],
          created_at: r[`${prefix}_at`],
        });

  return { phase_event: event("ph"), interruption_event: event("it") };
};
