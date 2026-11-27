-- Concurrent duplicates dedupe on a unique key (INSERT ... ON CONFLICT), not
-- on a check before the insert (r8 E2, E3).

-- A pushed part's content hash, set on push parts only (imports and scores
-- may legitimately repeat content): pushing the same records again is a
-- no-op. The oldest of any earlier duplicates keeps the key.
ALTER TABLE grad_dataset_parts ADD COLUMN push_sha256 TEXT;
UPDATE grad_dataset_parts p SET push_sha256 = p.sha256
WHERE p.job_id IS NULL AND p.sha256 IS NOT NULL AND p.version IS NOT NULL
  AND p.id = (
    SELECT min(q.id) FROM grad_dataset_parts q
    WHERE q.dataset_id = p.dataset_id AND q.sha256 = p.sha256
      AND q.job_id IS NULL AND q.version IS NOT NULL
  );
ALTER TABLE grad_dataset_parts
  ADD CONSTRAINT grad_dataset_parts_push_key UNIQUE (dataset_id, push_sha256);

-- One release per (checkpoint, name): promoting twice returns the first.
-- Releases an earlier race duplicated keep their name and blob but no
-- longer point at the checkpoint.
UPDATE grad_artifacts a SET source_id = NULL
WHERE a.kind = 'release' AND a.source_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM grad_artifacts b
    WHERE b.kind = 'release' AND b.workspace_id = a.workspace_id
      AND b.source_id = a.source_id AND b.name = a.name
      AND (b.created_at, b.id) < (a.created_at, a.id)
  );
CREATE UNIQUE INDEX grad_artifacts_promoted_idx
  ON grad_artifacts (workspace_id, source_id, name) WHERE kind = 'release';

-- The orphaned-blob sweep looks storage keys up in both tables.
CREATE INDEX grad_artifacts_storage_key_idx ON grad_artifacts (storage_key);
CREATE INDEX grad_dataset_parts_key_idx ON grad_dataset_parts (key) WHERE key IS NOT NULL;
