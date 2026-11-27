-- dataset.score(): an eval over the records' own outputs that writes a
-- score-update part as the dataset's next version.
ALTER TABLE grad_evals
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'eval' CHECK (mode IN ('eval', 'score')),
  ADD COLUMN scored_dataset_version INTEGER;
