-- Source sampling, record caps and the version interval (r8-sources). IF NOT
-- EXISTS: databases created from an 0001 that briefly carried the first four
-- columns already have them.

ALTER TABLE grad_sources
  ADD COLUMN IF NOT EXISTS sample_rate DOUBLE PRECISION NOT NULL DEFAULT 1
    CHECK (sample_rate > 0 AND sample_rate <= 1),
  ADD COLUMN IF NOT EXISTS max_records_per_sync INTEGER CHECK (max_records_per_sync > 0),
  ADD COLUMN IF NOT EXISTS max_records_per_day INTEGER CHECK (max_records_per_day > 0),
  -- New traces synced on records_day (UTC, YYYY-MM-DD): what max_records_per_day counts.
  ADD COLUMN IF NOT EXISTS records_today INTEGER NOT NULL DEFAULT 0 CHECK (records_today >= 0),
  ADD COLUMN IF NOT EXISTS records_day TEXT,
  -- A scheduled sync commits a dataset version at most this often (seconds;
  -- 0: every sync). Its parts wait as settled parts until then.
  ADD COLUMN IF NOT EXISTS version_interval INTEGER NOT NULL DEFAULT 900
    CHECK (version_interval >= 0),
  ADD COLUMN IF NOT EXISTS last_version_at TIMESTAMPTZ,
  -- Records in settled parts that wait for the next version.
  ADD COLUMN IF NOT EXISTS pending_records BIGINT NOT NULL DEFAULT 0
    CHECK (pending_records >= 0);

-- A completed sync's parts that wait for the source's next version: settled
-- (in completion order) and still unversioned.
ALTER TABLE grad_dataset_parts
  ADD COLUMN IF NOT EXISTS source_id TEXT,
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS grad_dataset_parts_settled_idx
  ON grad_dataset_parts (source_id, settled_at, batch, id) WHERE version IS NULL;
