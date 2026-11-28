-- Indexes measured at scale (p1-scale: 1k workspaces, 100k runs, 10M job
-- events, 1M eval outputs, 1M usage rows).

-- Foreign keys whose referencing column had no usable index: every deleted
-- run, job or dataset (a workspace purge deletes 500 per pass) scanned the
-- whole referencing table. grad_artifacts.run_id alone cost 16 ms per run
-- (1.6 s of a 1.8 s pass over 151 jobs).
CREATE INDEX IF NOT EXISTS grad_artifacts_run_id_idx ON grad_artifacts (run_id);
CREATE INDEX IF NOT EXISTS grad_evals_run_idx ON grad_evals (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS grad_evals_dataset_idx ON grad_evals (dataset_id);
CREATE INDEX IF NOT EXISTS grad_runs_dataset_idx ON grad_runs (dataset_id);
CREATE INDEX IF NOT EXISTS grad_sources_sync_job_idx ON grad_sources (sync_job_id)
  WHERE sync_job_id IS NOT NULL;

-- GET /v1/usage?run_id= reads the run's rows (and its evals') by ref, not
-- the workspace's whole ledger.
CREATE INDEX IF NOT EXISTS grad_usage_ref_idx ON grad_usage (ref_id, seq);

-- Duplicates: 0001 and 0002 both indexed grad_artifacts (storage_key), and
-- eval outputs carried the same key twice (a unique constraint and the
-- listing order). One unique index in listing order serves both; ON CONFLICT
-- (eval_id, model, task_index, sample_index) infers it (column order and
-- collation don't matter to inference).
DROP INDEX IF EXISTS grad_artifacts_storage_idx;
CREATE UNIQUE INDEX IF NOT EXISTS grad_eval_outputs_task_idx
  ON grad_eval_outputs (eval_id, task_index, model COLLATE "C", sample_index);
ALTER TABLE grad_eval_outputs
  DROP CONSTRAINT IF EXISTS grad_eval_outputs_eval_id_model_task_index_sample_index_key;
DROP INDEX IF EXISTS grad_eval_outputs_order_idx;
