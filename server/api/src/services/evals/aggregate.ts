import type { EvalModelSummary } from "../../contracts.js";
import type { EvalRecord, EvalScoreRow } from "../../store/types.js";
import { combineScores } from "./scoring.js";
import { bootstrapMeanCI, computePassAtK } from "./stats.js";

const round4 = (value: number): number => Number(value.toFixed(4));

interface TaskCell {
  samples: number[];
  tokens: number;
  cost: number;
  errors: number;
}

/** A model's running totals, task by task in task order. */
interface ModelTotals {
  /** Each task's score (the mean of its samples), in task order. */
  scores: number[];
  /** Score minus the baseline's, for the tasks both answered. */
  diffs: number[];
  passAtK: Map<number, number>;
  tokens: number;
  cost: number;
  errors: number;
}

type EvalRun = Pick<
  EvalRecord,
  | "id"
  | "models"
  | "baseline"
  | "rubric"
  | "samples"
  | "pass_threshold"
  | "judge_models"
  | "model_targets"
>;

/**
 * Aggregates per-sample outputs into combined scores and per-model
 * summaries: bootstrap 95% CI over task scores, unbiased pass@k, and a
 * paired bootstrap diff against the baseline over the tasks both models
 * answered. Outputs are added a page at a time in (task, model, sample)
 * order (`listScoreRows`), so memory is a few numbers per task, not the
 * outputs.
 */
export const createEvalAggregator = (evalRun: EvalRun) => {
  const ks = [...new Set([1, evalRun.samples])];
  const totals = new Map<string, ModelTotals>(
    evalRun.models.map((m) => [
      m,
      {
        scores: [],
        diffs: [],
        passAtK: new Map(ks.map((k) => [k, 0])),
        tokens: 0,
        cost: 0,
        errors: 0,
      },
    ]),
  );
  let task: number | null = null;
  let cells = new Map<string, TaskCell>();
  let totalCost = 0;
  let count = 0;

  /** Folds the current task's cells into the models' totals. */
  const closeTask = () => {
    const scoreOf = (cell: TaskCell) =>
      round4(cell.samples.reduce((a, b) => a + b, 0) / cell.samples.length);
    const baseCell =
      evalRun.baseline && totals.has(evalRun.baseline)
        ? cells.get(evalRun.baseline)
        : undefined;
    const base = baseCell ? scoreOf(baseCell) : undefined;
    for (const [model, t] of totals) {
      const cell = cells.get(model);
      if (!cell) continue;
      const score = scoreOf(cell);
      t.scores.push(score);
      if (base !== undefined && model !== evalRun.baseline) {
        t.diffs.push(score - base);
      }
      for (const k of ks) {
        const passes = cell.samples.map((s) => s >= evalRun.pass_threshold);
        t.passAtK.set(k, (t.passAtK.get(k) ?? 0) + computePassAtK(passes, k));
      }
      t.tokens += cell.tokens;
      t.cost += cell.cost;
      t.errors += cell.errors;
    }
    cells = new Map();
  };

  return {
    /** Adds the next outputs; returns each one's combined rubric score (0 for a failed generation). */
    add: (
      outputs: readonly EvalScoreRow[],
    ): Array<{ id: string; score: number }> =>
      outputs.map((output) => {
        if (output.task_index !== task) {
          closeTask();
          task = output.task_index;
        }
        const cell = cells.get(output.model) ?? {
          samples: [],
          tokens: 0,
          cost: 0,
          errors: 0,
        };
        cells.set(output.model, cell);

        const score = output.answered
          ? combineScores(evalRun.rubric, output.scores)
          : 0;
        cell.samples.push(score);
        cell.tokens += output.prompt_tokens + output.completion_tokens;
        cell.cost += output.cost_usd;
        if (output.error !== null) cell.errors += 1;
        totalCost += output.cost_usd;
        count += 1;

        return { id: output.id, score };
      }),

    finish: (): {
      summary: EvalModelSummary[];
      totalCostUsd: number;
      generated: number;
    } => {
      closeTask();
      const summary = evalRun.models.map(
        (model, modelIndex): EvalModelSummary => {
          const t = totals.get(model) as ModelTotals;
          const tasks = t.scores.length;
          const ci = bootstrapMeanCI(t.scores, 42 + modelIndex);
          const passAtK: Record<string, number> = {};
          for (const k of ks) {
            passAtK[`pass@${k}`] =
              tasks > 0 ? round4((t.passAtK.get(k) ?? 0) / tasks) : 0;
          }
          const diff =
            t.diffs.length > 0
              ? bootstrapMeanCI(t.diffs, 1000 + modelIndex)
              : null;
          const priced =
            evalRun.model_targets[model] !== undefined &&
            evalRun.model_targets[model].price_per_million_tokens !== null;

          return {
            model,
            overall: ci.mean,
            ci_low: ci.ci_low,
            ci_high: ci.ci_high,
            pass_at_k: passAtK,
            vs_baseline: diff && {
              delta: diff.mean,
              ci_low: diff.ci_low,
              ci_high: diff.ci_high,
            },
            tasks,
            errors: t.errors,
            tokens_per_task: tasks > 0 ? round4(t.tokens / tasks) : 0,
            cost_per_1k_tasks_usd:
              priced && tasks > 0 ? round4((t.cost / tasks) * 1000) : null,
          };
        },
      );

      return {
        summary,
        totalCostUsd: Number(totalCost.toFixed(6)),
        generated: count,
      };
    },
  };
};
