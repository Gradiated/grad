import { costForTokens } from "../catalog.js";
import {
  PlanEvalRequestSchema,
  type DatasetRecord,
  type EvalRubricItem,
  type PlanRunRequest,
} from "../contracts.js";
import { invalid } from "../errors.js";
import type { LabelingPlan } from "../planner.js";
import { LABEL_SCORE } from "../recipe-params.js";
import type { EvalRecord, Repositories, Store } from "../store/types.js";
import { combineScores } from "./evals/scoring.js";

/**
 * Router runs with Judge/validator rubric items: a labeling eval replays each
 * prompt against the candidates and scores the answers, and the router trains
 * on those scored responses (one record per answer: `metadata.model` plus the
 * combined rubric score as `scores.rubric`). Off-policy distill runs use the
 * same machinery with the teacher as the only model.
 */

/**
 * Off-policy distill runs: the teacher answers each prompt once (greedy, the
 * rollout's max_new_tokens) and the student trains on those answers.
 */
const teacherAnswersRequest = (
  request: PlanRunRequest,
  datasetVersion: number,
) => {
  const { recipe } = request;
  if (recipe.teacher === undefined) {
    throw invalid(
      "distill_teacher_required",
      "DistillRecipe needs teacher=: the model whose answers the student learns.",
    );
  }
  const maxTokens = recipe.rollout?.max_new_tokens;

  return PlanEvalRequestSchema.parse({
    name: `${request.name}-teacher`.slice(0, 64),
    models: [recipe.teacher],
    dataset: request.dataset,
    dataset_version: datasetVersion,
    samples: 1,
    temperature: 0,
    ...(typeof maxTokens === "number" ? { max_tokens: maxTokens } : {}),
  });
};

/** The labeling eval's request, or null when the run needs no labeling. */
export const labelingEvalRequest = (
  request: PlanRunRequest,
  datasetVersion: number,
) => {
  const { recipe } = request;
  if (recipe.kind === "distill" && recipe.rollout?.kind === "off_policy") {
    return teacherAnswersRequest(request, datasetVersion);
  }
  if (recipe.kind !== "router" || !Array.isArray(recipe.rubric)) return null;

  const items: EvalRubricItem[] = recipe.rubric;
  const local = items.filter((item) => item.kind === "code");
  if (local.length > 0) {
    throw invalid(
      "scorer_sandbox_unavailable",
      `Code scorers (${local.map((i) => i.name).join(", ")}) in a training recipe need a managed sandbox, which is post-v0. Score your records first and pass the score name (rubric="..."), or use Judge and validator items.`,
    );
  }
  if (!recipe.models || recipe.models.length < 2) {
    throw invalid(
      "router_candidates_required",
      "A router rubric of Judge/validator items replays your prompts against the candidates: pass recipe.models with at least two models.",
    );
  }

  return PlanEvalRequestSchema.parse({
    name: `${request.name}-labels`.slice(0, 64),
    models: recipe.models,
    dataset: request.dataset,
    dataset_version: datasetVersion,
    rubric: items,
    samples: 1,
    temperature: 0,
  });
};

export const toLabelingPlan = (plan: {
  estimated_model_calls: number;
  estimated_judge_calls: number;
  estimated_cost_usd: number;
}): LabelingPlan => ({
  estimated_model_calls: plan.estimated_model_calls,
  estimated_judge_calls: plan.estimated_judge_calls,
  estimated_cost_usd: plan.estimated_cost_usd,
});

const OUTPUT_PAGE = 1000;

/** The labeling eval's answers as router training records. */
export const labelRecords = async (
  store: Pick<Store, "evals">,
  evalRecord: EvalRecord,
): Promise<DatasetRecord[]> => {
  const records: DatasetRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.evals.listOutputs(
      evalRecord.id,
      {},
      { limit: OUTPUT_PAGE, cursor },
    );
    for (const output of page.data) {
      if (output.output === null) continue;
      const price =
        evalRecord.model_targets[output.model]?.price_per_million_tokens;
      records.push({
        id: output.id,
        group_id: `${evalRecord.id}:${output.task_index}`,
        messages: [
          ...output.input,
          { role: "assistant", content: output.output },
        ],
        metadata: { model: output.model },
        scores: {
          [LABEL_SCORE]: combineScores(evalRecord.rubric, output.scores),
        },
        ...(price == null
          ? {}
          : {
              metrics: {
                cost_usd: costForTokens(
                  output.prompt_tokens + output.completion_tokens,
                  price,
                ),
              },
            }),
      });
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);

  return records;
};

/** After a labeling eval finishes: start its router run, or cancel it. */
export const settleLabelledRuns = async (
  repos: Pick<Repositories, "runs">,
  evalRecord: Pick<EvalRecord, "id" | "status" | "error">,
  now: string,
): Promise<void> => {
  const patch =
    evalRecord.status === "completed"
      ? {}
      : {
          status: "cancelled" as const,
          finished_at: now,
          error: `Cancelled because its labeling eval '${evalRecord.id}' ended ${evalRecord.status}${evalRecord.error ? `: ${evalRecord.error}` : ""}.`,
        };
  for (const run of await repos.runs.listWaitingOn(evalRecord.id)) {
    await repos.runs.update(
      run.id,
      { ...patch, waiting_on: null, updated_at: now },
      { status: ["queued"] },
    );
  }
};

export const jsonlStream = (
  records: readonly DatasetRecord[],
): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(
        new TextEncoder().encode(
          records.map((r) => `${JSON.stringify(r)}\n`).join(""),
        ),
      );
      controller.close();
    },
  });
