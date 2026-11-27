-- Artifact registry (r9-artifacts): pins. A holder (a model version Gradiated
-- Cloud published, say) keeps a released artifact alive. ON DELETE RESTRICT
-- makes this structural: no path deletes a pinned artifact's row (user
-- delete, retention, workspace cleanup), and the orphaned-blob sweep only
-- deletes objects no row references, so its bundle stays too.
CREATE TABLE IF NOT EXISTS grad_artifact_pins (
  workspace_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  holder TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, artifact_id, holder),
  FOREIGN KEY (workspace_id, artifact_id)
    REFERENCES grad_artifacts (workspace_id, id) ON DELETE RESTRICT
);

-- Artifact imports are import jobs whose payload names an artifact (not a
-- dataset): GET /v1/imports lists dataset imports only.
CREATE INDEX IF NOT EXISTS grad_jobs_artifact_import_idx
  ON grad_jobs (workspace_id, created_at DESC, id COLLATE "C" DESC)
  WHERE kind = 'import' AND payload ? 'artifact';
