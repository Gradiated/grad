-- GET /v1/runs/counts (the console's status tabs): one GROUP BY status over a
-- workspace's runs, as an index-only scan (100k runs: 14 ms, against 40 ms
-- through the heap).
CREATE INDEX IF NOT EXISTS grad_jobs_status_count_idx
  ON grad_jobs (workspace_id, kind, status);
