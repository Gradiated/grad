-- Gradiated Cloud adapters (r9-cloudadapters). Every column has a default, so
-- self-hosted servers keep working unchanged.

-- Billing in integers: what a ledger row bills in nano-USD, who bills it
-- (`gateway`: a Cloud eval's model tokens, billed once by the inference
-- gateway; grad shows them and never pushes them), the SKU it bills, and the
-- transaction that wrote it. The exporter reads rows in (txid, seq) order and
-- only from transactions older than every open one, so a late commit with a
-- lower seq is never skipped.
ALTER TABLE grad_usage ADD COLUMN IF NOT EXISTS amount_nano_usd BIGINT NOT NULL DEFAULT 0
  CHECK (amount_nano_usd >= 0);
ALTER TABLE grad_usage ADD COLUMN IF NOT EXISTS billed_by TEXT NOT NULL DEFAULT 'grad'
  CHECK (billed_by IN ('grad', 'gateway'));
ALTER TABLE grad_usage ADD COLUMN IF NOT EXISTS sku TEXT;
ALTER TABLE grad_usage ADD COLUMN IF NOT EXISTS txid xid8 NOT NULL DEFAULT pg_current_xact_id();
UPDATE grad_usage SET amount_nano_usd = round(cost_usd::numeric * 1000000000)
  WHERE amount_nano_usd = 0 AND cost_usd > 0;
CREATE INDEX IF NOT EXISTS grad_usage_export_idx ON grad_usage (txid, seq)
  WHERE billed_by = 'grad';

-- The Cloud usage exporter's cursor: one row, locked FOR UPDATE SKIP LOCKED by
-- the replica exporting, so replicas never push the same batch at once.
CREATE TABLE IF NOT EXISTS grad_usage_export (
  name TEXT PRIMARY KEY,
  txid xid8 NOT NULL,
  seq BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO grad_usage_export (name, txid, seq) VALUES ('cloud', '0', 0)
  ON CONFLICT (name) DO NOTHING;

-- The price list version a run was planned and created with; its usage rows
-- bill at that version, whatever the price list says later.
ALTER TABLE grad_runs ADD COLUMN IF NOT EXISTS price_version TEXT;

-- Workspace lifecycle (Cloud: the product's suspend/reinstate/delete hooks).
-- No row: active. A deleted workspace is purged by the maintenance tick once
-- purge_after passes, in bounded passes (this row is the durable job).
CREATE TABLE IF NOT EXISTS grad_workspace_states (
  workspace_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('active', 'suspended', 'deleted')),
  purge_after TIMESTAMPTZ,
  purged_at TIMESTAMPTZ,
  next_purge_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS grad_workspace_states_purge_idx
  ON grad_workspace_states (next_purge_at) WHERE state = 'deleted' AND purged_at IS NULL;

-- KMS envelope encryption: the value's data key wrapped by the AWS KMS key
-- `key_id` names (`kms:<key id>`). NULL: sealed by a local GRAD_SECRETS_KEY.
ALTER TABLE grad_secrets ADD COLUMN IF NOT EXISTS wrapped_key BYTEA;
