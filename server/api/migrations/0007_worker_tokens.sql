-- Lease-scoped worker tokens (r9-workerauth): an orchestrator mints one per
-- leased host through the internal API. Only the token's SHA-256 is stored;
-- the token is returned once. A token is valid until expires_at or until its
-- lease is revoked; maintenance deletes expired rows.
CREATE TABLE IF NOT EXISTS grad_worker_tokens (
  token_sha256 TEXT PRIMARY KEY CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  host_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  kinds TEXT[] NOT NULL CHECK (cardinality(kinds) > 0),
  gpu_memory_gb DOUBLE PRECISION CHECK (gpu_memory_gb > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS grad_worker_tokens_lease_idx
  ON grad_worker_tokens (lease_id);
CREATE INDEX IF NOT EXISTS grad_worker_tokens_expires_idx
  ON grad_worker_tokens (expires_at);
