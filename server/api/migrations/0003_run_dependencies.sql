-- Chained runs (run.then(...)): a run can start from another run's artifact.
-- waiting_on is set while the dependency has not completed; such runs are not claimable.
ALTER TABLE grad_runs
  ADD COLUMN depends_on TEXT REFERENCES grad_runs (id),
  ADD COLUMN waiting_on TEXT REFERENCES grad_runs (id);

CREATE INDEX grad_runs_waiting_idx ON grad_runs (waiting_on) WHERE waiting_on IS NOT NULL;
