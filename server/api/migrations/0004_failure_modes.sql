-- Money is integer micro-USD (a price in USD per million tokens is micro-USD
-- per token), never float dollars. Cost is computed in one place
-- (catalog.costMicroUsd) and sums are exact.
ALTER TABLE grad_runs
  ADD COLUMN max_cost_micro_usd BIGINT CHECK (max_cost_micro_usd IS NULL OR max_cost_micro_usd > 0),
  ADD COLUMN billed_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (billed_micro_usd >= 0);
UPDATE grad_runs
  SET max_cost_micro_usd = GREATEST(1, round(max_cost_usd * 1000000)),
      billed_micro_usd = round(billed_cost_usd * 1000000);
ALTER TABLE grad_runs DROP COLUMN max_cost_usd, DROP COLUMN billed_cost_usd;

ALTER TABLE grad_billing_outbox
  ADD COLUMN cost_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0);
UPDATE grad_billing_outbox SET cost_micro_usd = round(cost_usd * 1000000);
ALTER TABLE grad_billing_outbox DROP COLUMN cost_usd;

ALTER TABLE grad_eval_outputs
  ADD COLUMN cost_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0);
UPDATE grad_eval_outputs SET cost_micro_usd = round(cost_usd * 1000000);
ALTER TABLE grad_eval_outputs DROP COLUMN cost_usd;

ALTER TABLE grad_evals
  ADD COLUMN total_cost_micro_usd BIGINT NOT NULL DEFAULT 0 CHECK (total_cost_micro_usd >= 0);
UPDATE grad_evals SET total_cost_micro_usd = round(total_cost_usd * 1000000);
ALTER TABLE grad_evals DROP COLUMN total_cost_usd;

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
