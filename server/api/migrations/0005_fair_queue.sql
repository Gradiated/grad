-- Fair claims across workspaces (r9-sched): a claim picks the workspace with
-- the fewest running jobs of the kind, then its oldest queued job. This index
-- serves both halves: running counts per (kind, workspace) and each
-- workspace's queue in age order.
CREATE INDEX IF NOT EXISTS grad_jobs_fair_idx
  ON grad_jobs (kind, status, workspace_id, created_at, id COLLATE "C")
  WHERE status IN ('queued', 'running');

-- GPU memory (GB) a train job needs (the plan's min_gpu_memory_gb); null:
-- unknown (and every job queued before this migration): any worker may claim it.
ALTER TABLE grad_jobs ADD COLUMN IF NOT EXISTS min_gpu_memory_gb DOUBLE PRECISION
  CHECK (min_gpu_memory_gb > 0);

-- Workers seen claiming (throttled upsert per claim poll): what they can run,
-- so a job no online worker fits says so. Never shown with an id or host.
CREATE TABLE IF NOT EXISTS grad_workers (
  id TEXT PRIMARY KEY,
  kinds TEXT[] NOT NULL,
  device TEXT CHECK (device IN ('cpu', 'gpu')),
  gpu_memory_gb DOUBLE PRECISION,
  last_seen_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS grad_workers_seen_idx ON grad_workers (last_seen_at);
