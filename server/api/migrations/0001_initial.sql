-- grad control plane schema. Applied once by src/store/migrate.ts (tracked in
-- grad_schema_migrations, serialized with an advisory lock). Timestamps are
-- written by the application clock, which is anchored to the database clock.
--
-- Ten tables:
--   grad_api_keys, grad_datasets, grad_dataset_parts,
--   grad_jobs (the one queue: train, import, eval), grad_job_events,
--   grad_runs, grad_evals, grad_eval_outputs, grad_artifacts, grad_usage.
--
-- Idempotency: create endpoints store the caller's Idempotency-Key and a hash
-- of the request on the row they create, unique per workspace. Worker writes
-- carry natural keys ((job, attempt, step|batch), (run, attempt, step)).

CREATE TABLE grad_api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key TEXT,
  request_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  UNIQUE (workspace_id, idempotency_key)
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
  idempotency_key TEXT,
  request_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (workspace_id, name),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX grad_datasets_workspace_idx
  ON grad_datasets (workspace_id, created_at DESC, id COLLATE "C" DESC);

-- The one queue. Runs and evals share their job's id (grad_runs.id and
-- grad_evals.id reference it); imports keep their few fields in payload.
CREATE TABLE grad_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('train', 'import', 'eval')),
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'running', 'awaiting_scores', 'completed', 'failed', 'cancelled', 'stopped_budget')),
  -- Every claim bumps attempt (the fencing token, and part of billing keys).
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  -- Attempts that ended without a result since creation or the last resume.
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
  worker_id TEXT,
  -- The key that claimed the open attempt (workerKeyOf): a worker id names a
  -- process, never an authority, so every lease check matches both.
  worker_key TEXT,
  lease_expires_at TIMESTAMPTZ,
  lease_seconds INTEGER NOT NULL DEFAULT 0,
  -- What the open attempt has already put in grad_usage (tokens, cost, when):
  -- usage is billed in increments while the attempt runs, not only at its end.
  billed_through BIGINT NOT NULL DEFAULT 0 CHECK (billed_through >= 0),
  billed_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
  billed_at TIMESTAMPTZ,
  -- Not claimable until this job finishes (a router run's labeling eval).
  waiting_on TEXT REFERENCES grad_jobs (id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  idempotency_key TEXT,
  request_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX grad_jobs_workspace_idx
  ON grad_jobs (workspace_id, kind, created_at DESC, id COLLATE "C" DESC);
CREATE INDEX grad_jobs_queued_idx
  ON grad_jobs (created_at, id COLLATE "C") WHERE status = 'queued';
CREATE INDEX grad_jobs_lease_idx
  ON grad_jobs (lease_expires_at) WHERE worker_id IS NOT NULL;
CREATE INDEX grad_jobs_waiting_idx
  ON grad_jobs (waiting_on) WHERE waiting_on IS NOT NULL;
-- An uploaded file is imported into a dataset once (its natural key).
CREATE UNIQUE INDEX grad_jobs_import_upload_idx
  ON grad_jobs ((payload->>'dataset_id'), (payload->'source'->>'sha256'))
  WHERE kind = 'import' AND payload->'source'->>'kind' = 'upload';
CREATE INDEX grad_jobs_awaiting_idx
  ON grad_jobs (updated_at) WHERE status = 'awaiting_scores';

-- Append-only job log (metrics today). A worker write is stored once per
-- (job, attempt, type, step); the SSE metrics stream resumes from seq.
CREATE TABLE grad_job_events (
  seq BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES grad_jobs (id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  type TEXT NOT NULL,
  step INTEGER NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (job_id, attempt, type, step)
);

CREATE INDEX grad_job_events_job_idx ON grad_job_events (job_id, type, seq);
CREATE INDEX grad_job_events_created_idx ON grad_job_events (created_at);

-- Immutable gzip-compressed JSONL objects (.jsonl.gz). Version N of a dataset is every part with
-- version <= N, in (version, batch, id) order. An import stages its parts with
-- version NULL (keyed by job, attempt, batch); they become visible when the
-- import commits them as the next version.
CREATE TABLE grad_dataset_parts (
  id BIGSERIAL PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES grad_datasets (id) ON DELETE CASCADE,
  version INTEGER CHECK (version >= 1),
  job_id TEXT REFERENCES grad_jobs (id) ON DELETE CASCADE,
  attempt INTEGER,
  batch INTEGER,
  -- NULL when every record of a staged batch was dropped.
  key TEXT,
  -- Distinct records the part adds to the merged dataset (score updates and
  -- reset markers add none), so record_count is the merged count.
  count BIGINT NOT NULL CHECK (count >= 0),
  -- The part holds a full sync's reset marker: the count restarts here.
  resets BOOLEAN NOT NULL DEFAULT false,
  -- Of the uncompressed JSONL, so identical records dedupe; bytes is the
  -- stored (compressed) size.
  sha256 TEXT,
  bytes BIGINT NOT NULL DEFAULT 0 CHECK (bytes >= 0),
  dropped INTEGER NOT NULL DEFAULT 0 CHECK (dropped >= 0),
  idempotency_key TEXT,
  request_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (job_id, attempt, batch),
  UNIQUE (dataset_id, idempotency_key)
);

CREATE INDEX grad_dataset_parts_version_idx
  ON grad_dataset_parts (dataset_id, version, batch, id) WHERE version IS NOT NULL;

CREATE TABLE grad_runs (
  id TEXT PRIMARY KEY REFERENCES grad_jobs (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  dataset_id TEXT NOT NULL REFERENCES grad_datasets (id),
  dataset_name TEXT NOT NULL,
  dataset_version INTEGER NOT NULL,
  recipe_kind TEXT NOT NULL,
  resolved_config JSONB NOT NULL,
  max_cost_usd DOUBLE PRECISION CHECK (max_cost_usd IS NULL OR max_cost_usd > 0),
  price_per_million_tokens DOUBLE PRECISION NOT NULL,
  total_steps INTEGER NOT NULL DEFAULT 0,
  current_step INTEGER NOT NULL DEFAULT 0,
  -- Tokens of closed (billed) attempts; cost is derived from tokens x price.
  billed_tokens BIGINT NOT NULL DEFAULT 0 CHECK (billed_tokens >= 0),
  -- Latest tokens reported by the open attempt (0 when none is open).
  attempt_tokens BIGINT NOT NULL DEFAULT 0 CHECK (attempt_tokens >= 0),
  latest_metric JSONB,
  eval_report JSONB,
  -- recipe.evals results, appended once per finished checkpoint eval.
  checkpoint_evals JSONB NOT NULL DEFAULT '[]'::jsonb,
  artifact_id TEXT
);

-- Checkpoints and releases. A checkpoint is a run attempt's step (it expires);
-- promote adds a release row (name@version) over the same immutable blob.
CREATE TABLE grad_artifacts (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('checkpoint', 'release')),
  name TEXT,
  version TEXT,
  version_day TEXT,
  version_seq INTEGER,
  run_id TEXT REFERENCES grad_runs (id) ON DELETE SET NULL,
  attempt INTEGER,
  step INTEGER CHECK (step >= 0),
  eval_score DOUBLE PRECISION,
  -- The checkpoint a release was promoted from.
  source_id TEXT,
  base_model TEXT NOT NULL,
  recipe_kind TEXT NOT NULL,
  -- NULL for a checkpoint that holds training state only.
  format TEXT,
  storage_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  eval_report JSONB,
  best BOOLEAN NOT NULL DEFAULT FALSE,
  final BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CHECK (kind = 'checkpoint' OR (name IS NOT NULL AND version IS NOT NULL AND format IS NOT NULL))
);

CREATE UNIQUE INDEX grad_artifacts_checkpoint_idx
  ON grad_artifacts (run_id, attempt, step) WHERE kind = 'checkpoint';
CREATE UNIQUE INDEX grad_artifacts_version_idx
  ON grad_artifacts (workspace_id, name, version_day, version_seq) WHERE kind = 'release';
CREATE INDEX grad_artifacts_release_idx
  ON grad_artifacts (workspace_id, created_at DESC, id COLLATE "C" DESC) WHERE kind = 'release';
CREATE INDEX grad_artifacts_run_idx
  ON grad_artifacts (run_id, step, attempt, id COLLATE "C") WHERE kind = 'checkpoint';
CREATE INDEX grad_artifacts_expiry_idx
  ON grad_artifacts (expires_at) WHERE kind = 'checkpoint' AND expires_at IS NOT NULL;
CREATE INDEX grad_artifacts_storage_idx ON grad_artifacts (storage_key);

CREATE TABLE grad_evals (
  id TEXT PRIMARY KEY REFERENCES grad_jobs (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  models JSONB NOT NULL,
  model_targets JSONB NOT NULL,
  baseline TEXT,
  dataset_id TEXT NOT NULL REFERENCES grad_datasets (id),
  dataset_name TEXT NOT NULL,
  dataset_version INTEGER NOT NULL,
  rubric JSONB NOT NULL,
  -- score: dataset.score() grades the records' own answers (model "record")
  -- and, when it completes, writes their scores as the dataset's next version.
  mode TEXT NOT NULL DEFAULT 'eval' CHECK (mode IN ('eval', 'score')),
  scored_dataset_version INTEGER,
  -- recipe.evals: the run and checkpoint step this eval scores.
  run_id TEXT REFERENCES grad_runs (id) ON DELETE SET NULL,
  run_step INTEGER,
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
  total_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0
);

-- One row per (model, task, sample). The tasks are the pinned dataset
-- version's usable records; `score` is the combined rubric score, set when
-- the eval completes, and per-task results are aggregated from it.
CREATE TABLE grad_eval_outputs (
  id TEXT PRIMARY KEY,
  eval_id TEXT NOT NULL REFERENCES grad_evals (id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  task_index INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  model TEXT NOT NULL,
  sample_index INTEGER NOT NULL,
  record JSONB NOT NULL,
  input JSONB NOT NULL,
  output TEXT,
  expected_output JSONB,
  scores JSONB NOT NULL DEFAULT '{}'::jsonb,
  score DOUBLE PRECISION,
  error TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (eval_id, model, task_index, sample_index)
);

CREATE INDEX grad_eval_outputs_order_idx
  ON grad_eval_outputs (eval_id, task_index, model COLLATE "C", sample_index);

-- Append-only usage ledger. An attempt bills in increments: a row whenever
-- its unbilled usage passes a threshold (tokens or time), at checkpoints, and
-- a final row in the transaction that closes it. Each row covers the
-- attempt's tokens (tokens_from, tokens_through] and is keyed by its end, so
-- a replay adds nothing and an attempt's rows sum to what it used. Gradiated
-- Cloud copies the ledger from a cursor (seq); GET /v1/usage lists it.
CREATE TABLE grad_usage (
  seq BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('run', 'eval')),
  ref_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  tokens_from BIGINT NOT NULL CHECK (tokens_from >= 0),
  tokens_through BIGINT NOT NULL CHECK (tokens_through >= tokens_from),
  tokens BIGINT NOT NULL CHECK (tokens >= 0),
  cost_usd DOUBLE PRECISION NOT NULL CHECK (cost_usd >= 0),
  price_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX grad_usage_workspace_idx ON grad_usage (workspace_id, seq DESC);

-- Workspace secrets (provider keys, HF tokens). Values are AES-256-GCM sealed
-- by the application (src/secrets.ts; AAD = workspace + name) and never
-- returned; key_id names the GRAD_SECRETS_KEY that sealed them.
CREATE TABLE grad_secrets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_id TEXT NOT NULL,
  nonce BYTEA NOT NULL,
  ciphertext BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE INDEX grad_secrets_workspace_idx
  ON grad_secrets (workspace_id, created_at DESC, id COLLATE "C" DESC);

-- Observability sources syncing into a dataset. A source feeds exactly one
-- dataset (a dataset may have several sources) and is deleted with it. A
-- sync is an import job; sync_job_id is the latest one (at most one queued or
-- running per source, and at most one started per minute), and watermark
-- only advances when that job completes. pending_full: a full sync was asked
-- for while another sync ran; it is queued when that one ends. Failed syncs
-- set last_error and back the schedule off; after 10 in a row the source is
-- paused until a manual sync or a new value for its secret.
CREATE TABLE grad_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  dataset_id TEXT NOT NULL REFERENCES grad_datasets (id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  host TEXT,
  secret_name TEXT,
  project TEXT,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  schedule TEXT,
  next_sync_at TIMESTAMPTZ,
  watermark JSONB,
  sync_job_id TEXT REFERENCES grad_jobs (id) ON DELETE SET NULL,
  last_synced_at TIMESTAMPTZ,
  pending_full BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  paused_reason TEXT,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  idempotency_key TEXT,
  request_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (workspace_id, idempotency_key)
);

CREATE INDEX grad_sources_workspace_idx
  ON grad_sources (workspace_id, created_at DESC, id COLLATE "C" DESC);
CREATE INDEX grad_sources_due_idx
  ON grad_sources (next_sync_at) WHERE next_sync_at IS NOT NULL;
CREATE INDEX grad_sources_secret_idx
  ON grad_sources (workspace_id, secret_name) WHERE secret_name IS NOT NULL;
