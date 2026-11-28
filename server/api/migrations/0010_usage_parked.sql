-- Usage rows billing ingest refused for good (422/409). The exporter parks
-- such a row (the refusal code and when) and moves its cursor past it, so one
-- bad row never holds back the rest. Parked rows are never deleted; to retry
-- them by hand once the cause is fixed, clear the marks and re-stamp txid,
-- which puts them ahead of the export cursor again (docs/CLOUD_MODE.md).
ALTER TABLE grad_usage ADD COLUMN IF NOT EXISTS parked_code TEXT;
ALTER TABLE grad_usage ADD COLUMN IF NOT EXISTS parked_at TIMESTAMPTZ;

-- grad_usage_parked_rows counts them every maintenance tick.
CREATE INDEX IF NOT EXISTS grad_usage_parked_idx ON grad_usage (parked_at)
  WHERE parked_at IS NOT NULL;
