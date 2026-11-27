import type { EvalReport } from "../../src/contracts.js";

/** A held-out report shaped like the trainer's (shared core + SFT fields). */
export const evalReport = (
  extra: Record<string, unknown> = {},
): EvalReport => ({
  metric_name: "eval_loss",
  selected_step: 2,
  best_step: 2,
  final_step: 2,
  train_records: 18,
  eval_records: 2,
  warnings: [],
  eval_loss: 0.25,
  eval_token_accuracy: 0.9,
  ...extra,
});
