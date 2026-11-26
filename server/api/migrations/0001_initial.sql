CREATE TABLE IF NOT EXISTS grad_api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS grad_api_keys_workspace_idx
  ON grad_api_keys (workspace_id);

CREATE TABLE IF NOT EXISTS grad_datasets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  record_count INTEGER NOT NULL DEFAULT 0 CHECK (record_count >= 0),
  storage_key TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, name),
  UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS grad_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  dataset_id TEXT NOT NULL,
  dataset_name TEXT NOT NULL,
  recipe_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'stopped_budget')),
  resolved_config JSONB NOT NULL,
  max_cost_usd DOUBLE PRECISION CHECK (max_cost_usd IS NULL OR max_cost_usd > 0),
  tokens_processed BIGINT NOT NULL DEFAULT 0 CHECK (tokens_processed >= 0),
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  current_step INTEGER NOT NULL DEFAULT 0 CHECK (current_step >= 0),
  total_steps INTEGER NOT NULL DEFAULT 0 CHECK (total_steps >= 0),
  metrics_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  eval_report JSONB,
  artifact_id TEXT,
  error TEXT,
  worker_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, dataset_id) REFERENCES grad_datasets(workspace_id, id)
);

CREATE INDEX IF NOT EXISTS grad_runs_queued_idx
  ON grad_runs (created_at ASC) WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS grad_runs_running_lease_idx
  ON grad_runs (lease_expires_at) WHERE status = 'running';

CREATE INDEX IF NOT EXISTS grad_runs_workspace_idx
  ON grad_runs (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS grad_checkpoints (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step INTEGER NOT NULL CHECK (step >= 0),
  eval_score DOUBLE PRECISION,
  storage_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, run_id) REFERENCES grad_runs(workspace_id, id)
);

CREATE INDEX IF NOT EXISTS grad_checkpoints_run_idx
  ON grad_checkpoints (run_id, step ASC);

CREATE TABLE IF NOT EXISTS grad_artifacts (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, name, version),
  FOREIGN KEY (workspace_id, run_id) REFERENCES grad_runs(workspace_id, id),
  FOREIGN KEY (workspace_id, checkpoint_id) REFERENCES grad_checkpoints(workspace_id, id)
);

CREATE INDEX IF NOT EXISTS grad_artifacts_workspace_name_idx
  ON grad_artifacts (workspace_id, name, created_at DESC);

CREATE TABLE IF NOT EXISTS grad_deployments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  active_artifact_id TEXT NOT NULL,
  previous_artifact_id TEXT,
  fallback_model TEXT,
  explore_rate DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (explore_rate >= 0 AND explore_rate <= 0.5),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, name),
  FOREIGN KEY (workspace_id, active_artifact_id) REFERENCES grad_artifacts(workspace_id, id),
  FOREIGN KEY (workspace_id, previous_artifact_id) REFERENCES grad_artifacts(workspace_id, id)
);

CREATE TABLE IF NOT EXISTS grad_evals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  models JSONB NOT NULL,
  baseline TEXT,
  task_source JSONB NOT NULL,
  rubric JSONB NOT NULL,
  samples INTEGER NOT NULL DEFAULT 1 CHECK (samples >= 1),
  pass_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.8 CHECK (pass_threshold >= 0 AND pass_threshold <= 1),
  judge_models JSONB NOT NULL DEFAULT '[]'::jsonb,
  summary JSONB NOT NULL DEFAULT '[]'::jsonb,
  results JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (total_cost_usd >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS grad_evals_workspace_idx
  ON grad_evals (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS grad_feedback (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  inference_id TEXT,
  session_id TEXT,
  deployment_name TEXT,
  idempotency_key TEXT NOT NULL,
  score DOUBLE PRECISION,
  expected_output JSONB,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS grad_feedback_deployment_idx
  ON grad_feedback (workspace_id, deployment_name, created_at DESC);
