-- A router run with Judge/validator rubric items waits on its labeling eval:
-- waiting_on holds the eval id until it completes; waiting runs are not claimable.
ALTER TABLE grad_runs ADD COLUMN waiting_on TEXT;

CREATE INDEX grad_runs_waiting_idx ON grad_runs (waiting_on) WHERE waiting_on IS NOT NULL;

-- Eval usage is billed through the same outbox as runs.
ALTER TABLE grad_billing_outbox
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'run' CHECK (kind IN ('run', 'eval'));
