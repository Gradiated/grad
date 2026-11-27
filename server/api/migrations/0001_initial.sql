-- grad control plane schema v1. Applied once by src/store/migrate.ts
-- (tracked in grad_schema_migrations, serialized with an advisory lock).
-- All timestamps are written by the application clock (millisecond ISO).

CREATE TABLE grad_api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX grad_api_keys_workspace_idx
  ON grad_api_keys (workspace_id, created_at DESC, id COLLATE "C" DESC);

CREATE TABLE grad_datasets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  record_count BIGINT NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE INDEX grad_datasets_workspace_idx
  ON grad_datasets (workspace_id, created_at DESC, id COLLATE "C" DESC);

CREATE TABLE grad_dataset_versions (
  dataset_id TEXT NOT NULL REFERENCES grad_datasets (id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 0),
  parts JSONB NOT NULL DEFAULT '[]'::jsonb,
  record_count BIGINT NOT NULL CHECK (record_count >= 0),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (dataset_id, version)
);

CREATE TABLE grad_import_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  dataset_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  source JSONB NOT NULL,
  connector TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  imported_count BIGINT NOT NULL DEFAULT 0,
  dropped_count BIGINT NOT NULL DEFAULT 0,
  detected_scores JSONB NOT NULL DEFAULT '[]'::jsonb,
  dataset_version INTEGER,
  error TEXT,
  upload_key TEXT,
  worker_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  lease_seconds INTEGER NOT NULL DEFAULT 0,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX grad_import_jobs_workspace_idx
  ON grad_import_jobs (workspace_id, created_at DESC, id COLLATE "C" DESC);
CREATE INDEX grad_import_jobs_queued_idx
  ON grad_import_jobs (created_at, id COLLATE "C") WHERE status = 'queued';
CREATE INDEX grad_import_jobs_lease_idx
  ON grad_import_jobs (lease_expires_at) WHERE worker_id IS NOT NULL;

CREATE TABLE grad_import_parts (
  seq BIGSERIAL PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES grad_import_jobs (id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  part JSONB NOT NULL
);

CREATE INDEX grad_import_parts_idx ON grad_import_parts (import_id, attempt, seq);

CREATE TABLE grad_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  dataset_name TEXT NOT NULL,
  dataset_version INTEGER NOT NULL,
  recipe_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'stopped_budget')),
  resolved_config JSONB NOT NULL,
  max_cost_usd DOUBLE PRECISION CHECK (max_cost_usd IS NULL OR max_cost_usd > 0),
  price_per_million_tokens DOUBLE PRECISION NOT NULL,
  total_steps INTEGER NOT NULL DEFAULT 0,
  current_step INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  billed_tokens BIGINT NOT NULL DEFAULT 0 CHECK (billed_tokens >= 0),
  billed_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (billed_cost_usd >= 0),
  attempt_tokens BIGINT NOT NULL DEFAULT 0 CHECK (attempt_tokens >= 0),
  worker_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  lease_seconds INTEGER NOT NULL DEFAULT 0,
  latest_metric JSONB,
  eval_report JSONB,
  artifact_id TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ
);

CREATE INDEX grad_runs_workspace_idx
  ON grad_runs (workspace_id, created_at DESC, id COLLATE "C" DESC);
CREATE INDEX grad_runs_queued_idx
  ON grad_runs (created_at, id COLLATE "C") WHERE status = 'queued';
CREATE INDEX grad_runs_lease_idx
  ON grad_runs (lease_expires_at) WHERE worker_id IS NOT NULL;

CREATE TABLE grad_run_metrics (
  seq BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES grad_runs (id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  point JSONB NOT NULL
);

CREATE INDEX grad_run_metrics_run_idx ON grad_run_metrics (run_id, seq);

CREATE TABLE grad_checkpoints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  step INTEGER NOT NULL CHECK (step >= 0),
  eval_score DOUBLE PRECISION,
  format TEXT,
  storage_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  best BOOLEAN NOT NULL DEFAULT FALSE,
  final BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (run_id, attempt, step)
);

CREATE INDEX grad_checkpoints_run_idx
  ON grad_checkpoints (run_id, step, attempt, id COLLATE "C");
CREATE INDEX grad_checkpoints_expiry_idx
  ON grad_checkpoints (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE grad_artifacts (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  version_day TEXT NOT NULL,
  version_seq INTEGER NOT NULL,
  run_id TEXT,
  checkpoint_id TEXT,
  base_model TEXT NOT NULL,
  recipe_kind TEXT NOT NULL,
  format TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  manifest JSONB NOT NULL,
  eval_report JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, name, version_day, version_seq)
);

CREATE INDEX grad_artifacts_workspace_idx
  ON grad_artifacts (workspace_id, created_at DESC, id COLLATE "C" DESC);
CREATE INDEX grad_artifacts_latest_idx
  ON grad_artifacts (workspace_id, name, version_day DESC, version_seq DESC);

CREATE TABLE grad_uploads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('checkpoint', 'artifact', 'dataset_import')),
  job_id TEXT,
  attempt INTEGER,
  storage_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'uploaded', 'consumed')),
  consumed_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX grad_uploads_expiry_idx
  ON grad_uploads (expires_at) WHERE status <> 'consumed';

CREATE TABLE grad_deployments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  active_artifact_id TEXT NOT NULL,
  previous_artifact_id TEXT,
  fallback_model TEXT,
  explore_rate DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (explore_rate >= 0 AND explore_rate <= 0.5),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE INDEX grad_deployments_workspace_idx
  ON grad_deployments (workspace_id, created_at DESC, id COLLATE "C" DESC);

CREATE TABLE grad_inferences (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  deployment_name TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE grad_feedback (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  inference_id TEXT,
  session_id TEXT,
  deployment_name TEXT,
  idempotency_key TEXT NOT NULL,
  score DOUBLE PRECISION,
  expected_output JSONB,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX grad_feedback_deployment_idx
  ON grad_feedback (workspace_id, deployment_name);

CREATE TABLE grad_evals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'awaiting_scores', 'completed', 'failed', 'cancelled')),
  models JSONB NOT NULL,
  model_targets JSONB NOT NULL,
  baseline TEXT,
  dataset_id TEXT NOT NULL,
  dataset_name TEXT NOT NULL,
  dataset_version INTEGER NOT NULL,
  rubric JSONB NOT NULL,
  samples INTEGER NOT NULL CHECK (samples >= 1),
  temperature DOUBLE PRECISION NOT NULL,
  max_tokens INTEGER NOT NULL,
  "limit" INTEGER,
  pass_threshold DOUBLE PRECISION NOT NULL,
  judge_models JSONB NOT NULL DEFAULT '[]'::jsonb,
  local_scorers JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_outputs INTEGER NOT NULL DEFAULT 0,
  generated INTEGER NOT NULL DEFAULT 0,
  summary JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  error TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  worker_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  lease_seconds INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ
);

CREATE INDEX grad_evals_workspace_idx
  ON grad_evals (workspace_id, created_at DESC, id COLLATE "C" DESC);
CREATE INDEX grad_evals_queued_idx
  ON grad_evals (created_at, id COLLATE "C") WHERE status = 'queued';
CREATE INDEX grad_evals_lease_idx
  ON grad_evals (lease_expires_at) WHERE worker_id IS NOT NULL;

CREATE TABLE grad_eval_tasks (
  eval_id TEXT NOT NULL REFERENCES grad_evals (id) ON DELETE CASCADE,
  task_index INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  record JSONB NOT NULL,
  PRIMARY KEY (eval_id, task_index)
);

CREATE TABLE grad_eval_outputs (
  id TEXT PRIMARY KEY,
  eval_id TEXT NOT NULL REFERENCES grad_evals (id) ON DELETE CASCADE,
  task_index INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  model TEXT NOT NULL,
  sample_index INTEGER NOT NULL,
  input JSONB NOT NULL,
  output TEXT,
  expected_output JSONB,
  scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (eval_id, model, task_index, sample_index)
);

CREATE INDEX grad_eval_outputs_order_idx
  ON grad_eval_outputs (eval_id, task_index, model COLLATE "C", sample_index);

CREATE TABLE grad_eval_results (
  eval_id TEXT NOT NULL REFERENCES grad_evals (id) ON DELETE CASCADE,
  task_index INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  model TEXT NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  passed BOOLEAN NOT NULL,
  sample_scores JSONB NOT NULL,
  judge_model TEXT,
  PRIMARY KEY (eval_id, task_index, model)
);

CREATE TABLE grad_billing_outbox (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  tokens BIGINT NOT NULL CHECK (tokens >= 0),
  cost_usd DOUBLE PRECISION NOT NULL CHECK (cost_usd >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ
);

CREATE INDEX grad_billing_outbox_due_idx
  ON grad_billing_outbox (next_attempt_at) WHERE status = 'pending';
CREATE INDEX grad_billing_outbox_run_idx ON grad_billing_outbox (run_id, attempt);
