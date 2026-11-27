import type { EvalModelSummary } from "../../contracts.js";
import type {
  EvalOutputRow,
  EvalRecord,
  EvalResultRow,
} from "../../store/types.js";
import { combineScores } from "./scoring.js";
import { bootstrapMeanCI, computePassAtK } from "./stats.js";

const round4 = (value: number): number => Number(value.toFixed(4));

interface TaskCell {
  taskIndex: number;
  taskId: string;
  samples: number[];
  tokens: number;
  cost: number;
  errors: number;
}

export interface Aggregation {
  summary: EvalModelSummary[];
  results: EvalResultRow[];
  totalCostUsd: number;
}

/**
 * Aggregates per-sample outputs into per-(task, model) results and per-model
 * summaries: bootstrap 95% CI over task scores, unbiased pass@k, and a paired
 * bootstrap diff against the baseline over the tasks both models answered.
 */
export const aggregateEval = (
  evalRun: Pick<
    EvalRecord,
    | "id"
    | "models"
    | "baseline"
    | "rubric"
    | "samples"
    | "pass_threshold"
    | "judge_models"
    | "model_targets"
  >,
  outputs: readonly EvalOutputRow[],
): Aggregation => {
  const cells = new Map<string, Map<number, TaskCell>>();
  let totalCost = 0;

  for (const output of outputs) {
    const byTask = cells.get(output.model) ?? new Map<number, TaskCell>();
    cells.set(output.model, byTask);
    const cell = byTask.get(output.task_index) ?? {
      taskIndex: output.task_index,
      taskId: output.task_id,
      samples: [],
      tokens: 0,
      cost: 0,
      errors: 0,
    };
    byTask.set(output.task_index, cell);

    cell.samples.push(
      output.output === null ? 0 : combineScores(evalRun.rubric, output.scores),
    );
    cell.tokens += output.prompt_tokens + output.completion_tokens;
    cell.cost += output.cost_usd;
    if (output.error !== null) cell.errors += 1;
    totalCost += output.cost_usd;
  }

  const results: EvalResultRow[] = [];
  const taskScores = new Map<string, Map<number, number>>();
  const judgeModel = evalRun.judge_models[0] ?? null;

  for (const model of evalRun.models) {
    const scores = new Map<number, number>();
    taskScores.set(model, scores);
    const sorted = [...(cells.get(model)?.values() ?? [])].sort(
      (a, b) => a.taskIndex - b.taskIndex,
    );
    for (const cell of sorted) {
      const score = round4(
        cell.samples.reduce((a, b) => a + b, 0) / cell.samples.length,
      );
      scores.set(cell.taskIndex, score);
      results.push({
        eval_id: evalRun.id,
        task_index: cell.taskIndex,
        task_id: cell.taskId,
        model,
        score,
        passed: cell.samples.some((s) => s >= evalRun.pass_threshold),
        sample_scores: cell.samples.map(round4),
        judge_model: judgeModel,
      });
    }
  }

  const baselineScores = evalRun.baseline
    ? taskScores.get(evalRun.baseline)
    : undefined;

  const summary = evalRun.models.map((model, modelIndex): EvalModelSummary => {
    const modelCells = [...(cells.get(model)?.values() ?? [])];
    const scores = taskScores.get(model) ?? new Map<number, number>();
    const values = [...scores.values()];
    const ci = bootstrapMeanCI(values, 42 + modelIndex);

    const passAtK: Record<string, number> = {};
    for (const k of new Set([1, evalRun.samples])) {
      const perTask = modelCells.map((cell) =>
        computePassAtK(
          cell.samples.map((s) => s >= evalRun.pass_threshold),
          k,
        ),
      );
      passAtK[`pass@${k}`] =
        perTask.length > 0
          ? round4(perTask.reduce((a, b) => a + b, 0) / perTask.length)
          : 0;
    }

    let vsBaseline: EvalModelSummary["vs_baseline"] = null;
    if (baselineScores && evalRun.baseline && model !== evalRun.baseline) {
      const diffs: number[] = [];
      for (const [taskIndex, score] of scores) {
        const base = baselineScores.get(taskIndex);
        if (base !== undefined) diffs.push(score - base);
      }
      if (diffs.length > 0) {
        const diff = bootstrapMeanCI(diffs, 1000 + modelIndex);
        vsBaseline = {
          delta: diff.mean,
          ci_low: diff.ci_low,
          ci_high: diff.ci_high,
        };
      }
    }

    const tasks = modelCells.length;
    const tokens = modelCells.reduce((sum, c) => sum + c.tokens, 0);
    const cost = modelCells.reduce((sum, c) => sum + c.cost, 0);
    const priced =
      evalRun.model_targets[model]?.price_per_million_tokens !== null &&
      evalRun.model_targets[model] !== undefined;

    return {
      model,
      overall: ci.mean,
      ci_low: ci.ci_low,
      ci_high: ci.ci_high,
      pass_at_k: passAtK,
      vs_baseline: vsBaseline,
      tasks,
      errors: modelCells.reduce((sum, c) => sum + c.errors, 0),
      tokens_per_task: tasks > 0 ? round4(tokens / tasks) : 0,
      cost_per_1k_tasks_usd:
        priced && tasks > 0 ? round4((cost / tasks) * 1000) : null,
    };
  });

  return { summary, results, totalCostUsd: Number(totalCost.toFixed(6)) };
};
