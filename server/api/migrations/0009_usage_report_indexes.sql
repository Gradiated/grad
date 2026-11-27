-- Usage reports (GET /v1/usage/summary and the filtered GET /v1/usage). These
-- two indexes were first added to 0001 after it had shipped in a release, so
-- databases created by an earlier 0001 never got them; they live here instead.
-- IF NOT EXISTS: databases created from that edited 0001 already have them.

-- Usage reports find the run a labeling or teacher eval belongs to.
CREATE INDEX IF NOT EXISTS grad_runs_label_eval_idx
  ON grad_runs ((resolved_config->>'label_eval_id'))
  WHERE resolved_config->>'label_eval_id' IS NOT NULL;

-- A period of one workspace's ledger.
CREATE INDEX IF NOT EXISTS grad_usage_workspace_time_idx
  ON grad_usage (workspace_id, created_at);
