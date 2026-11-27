-- Queued runs can wait on a gate: a dependency run (chained runs, run.then(...)) whose
-- artifact they start from, or a router run's labeling eval. waiting_on holds that run or
-- eval id until the gate is released; waiting runs are not claimable.
ALTER TABLE grad_runs
  ADD COLUMN depends_on TEXT REFERENCES grad_runs (id),
  ADD COLUMN waiting_on TEXT;

CREATE INDEX grad_runs_waiting_idx ON grad_runs (waiting_on) WHERE waiting_on IS NOT NULL;
