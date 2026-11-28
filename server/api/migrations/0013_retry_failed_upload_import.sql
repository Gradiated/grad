-- A file is imported into a dataset once, but a failed import no longer
-- holds it: importing the same file again starts a new import (it returned
-- the failed one forever). The new index is built before the old one goes,
-- so a live import stays unique throughout.
CREATE UNIQUE INDEX IF NOT EXISTS grad_jobs_import_upload_live_idx
  ON grad_jobs ((payload->>'dataset_id'), (payload->'source'->>'sha256'))
  WHERE kind = 'import' AND payload->'source'->>'kind' = 'upload' AND status <> 'failed';
DROP INDEX IF EXISTS grad_jobs_import_upload_idx;
