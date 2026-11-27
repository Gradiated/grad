-- Idempotency-Key replay store: one row per (caller, method, path, key).
CREATE TABLE grad_idempotency_keys (
  workspace_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_status INTEGER,
  response_headers JSONB,
  response_body TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, principal, method, path, idempotency_key)
);

CREATE INDEX grad_idempotency_keys_created_at ON grad_idempotency_keys (created_at);
