-- Eval spend caps: generation stops at max_cost_usd and the eval ends stopped_budget
-- with partial results. Eval usage is billed through the same outbox as runs.
ALTER TABLE grad_evals
  ADD COLUMN max_cost_usd DOUBLE PRECISION CHECK (max_cost_usd IS NULL OR max_cost_usd > 0),
  ADD COLUMN estimated_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN budget_stopped BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE grad_evals DROP CONSTRAINT grad_evals_status_check;
ALTER TABLE grad_evals ADD CONSTRAINT grad_evals_status_check
  CHECK (status IN ('queued', 'running', 'awaiting_scores', 'completed', 'stopped_budget', 'failed', 'cancelled'));

ALTER TABLE grad_billing_outbox
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'run' CHECK (kind IN ('run', 'eval'));
