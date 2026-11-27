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
