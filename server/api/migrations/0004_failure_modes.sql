-- Billed tokens are the source of truth for a run's cost (derived as
-- tokens x price in one place), so the float running total goes.
ALTER TABLE grad_runs DROP COLUMN billed_cost_usd;

-- Worker writes are replay-safe on natural keys (inserted ON CONFLICT DO NOTHING):
-- record batches by (import, attempt, batch), metrics by (run, attempt, step).
ALTER TABLE grad_import_parts
  ADD COLUMN batch INTEGER,
  ADD COLUMN dropped INTEGER NOT NULL DEFAULT 0 CHECK (dropped >= 0),
  ALTER COLUMN part DROP NOT NULL;
CREATE UNIQUE INDEX grad_import_parts_batch_idx ON grad_import_parts (import_id, attempt, batch);

ALTER TABLE grad_run_metrics ADD COLUMN step INTEGER;
UPDATE grad_run_metrics SET step = (point->>'step')::int;
DELETE FROM grad_run_metrics m USING grad_run_metrics d
  WHERE m.run_id = d.run_id AND m.attempt = d.attempt AND m.step = d.step AND m.seq > d.seq;
ALTER TABLE grad_run_metrics ALTER COLUMN step SET NOT NULL;
CREATE UNIQUE INDEX grad_run_metrics_step_idx ON grad_run_metrics (run_id, attempt, step);

-- Dataset versions are prefixes of one append-only part list: a version row
-- holds its part count instead of a copy of every earlier part.
CREATE TABLE grad_dataset_parts (
  dataset_id TEXT NOT NULL REFERENCES grad_datasets (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  key TEXT NOT NULL,
  count BIGINT NOT NULL CHECK (count >= 0),
  sha256 TEXT NOT NULL,
  bytes BIGINT NOT NULL CHECK (bytes >= 0),
  PRIMARY KEY (dataset_id, seq)
);
INSERT INTO grad_dataset_parts (dataset_id, seq, key, count, sha256, bytes)
  SELECT v.dataset_id, (p.ord - 1)::int, p.part->>'key', (p.part->>'count')::bigint,
         p.part->>'sha256', (p.part->>'bytes')::bigint
  FROM grad_dataset_versions v
  JOIN grad_datasets d ON d.id = v.dataset_id AND d.version = v.version
  CROSS JOIN LATERAL jsonb_array_elements(v.parts) WITH ORDINALITY AS p(part, ord);
ALTER TABLE grad_dataset_versions ADD COLUMN part_count INTEGER NOT NULL DEFAULT 0;
UPDATE grad_dataset_versions SET part_count = jsonb_array_length(parts);
ALTER TABLE grad_dataset_versions DROP COLUMN parts;
