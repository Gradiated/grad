import { z } from "@hono/zod-openapi";

import {
  BINARY_RUBRIC_KINDS,
  EvalRubricItemSchema,
  messageText,
  NON_DEPLOYABLE_FORMATS,
  RECORD_MODEL,
  type DatasetRecord,
  type EvalMode,
  type EvalRubricItem,
  type PlanEvalRequest,
  type PlanEvalResponse,
} from "../../contracts.js";
import { evalsOnCloud } from "../../cloud/gateway.js";
import type { AppDependencies } from "../../deps.js";
import { ApiError, invalid, unavailable } from "../../errors.js";
import {
  recordPromptAndReference,
  recordPromptAndResponse,
} from "../../records.js";
import { estimateTextTokens } from "../../render.js";
import type { EvalRecord, EvalTask } from "../../store/types.js";
import type { DatasetService, ResolvedDatasetVersion } from "../datasets.js";

type ModelTargets = EvalRecord["model_targets"];
type JudgeTargets = EvalRecord["judge_targets"];

interface ResolvedEvalPlan {
  response: PlanEvalResponse;
  dataset: ResolvedDatasetVersion;
  targets: ModelTargets;
  /** Usable records (at most the request's limit): one task each. */
  taskCount: number;
  /** The request's rubric, or the dataset's own (benchmarks), or non_empty. */
  rubric: EvalRubricItem[];
  judgeModels: string[];
  judgeTargets: JudgeTargets;
  localScorers: string[];
  passThreshold: number;
}

export const resolvePassThreshold = (
  rubric: readonly EvalRubricItem[],
  explicit: number | null,
): number => {
  if (explicit !== null) return explicit;

  return rubric.every((item) =>
    (BINARY_RUBRIC_KINDS as readonly string[]).includes(item.kind),
  )
    ? 1.0
    : 0.5;
};

/** Resolves catalog ids and workspace artifact refs to inference model names and prices. */
const resolveModelTargets = async (
  deps: Pick<AppDependencies, "catalog" | "store">,
  workspaceId: string,
  models: readonly string[],
): Promise<ModelTargets> => {
  const targets: ModelTargets = {};

  for (const ref of models) {
    if (targets[ref]) continue;

    const catalogModel = deps.catalog.find(ref);
    if (catalogModel) {
      targets[ref] = {
        inference_model: catalogModel.id,
        price_per_million_tokens: catalogModel.price_per_million_tokens_usd,
      };
      continue;
    }

    const artifact = ref.includes("@")
      ? await deps.store.artifacts.get(workspaceId, ref)
      : null;
    if (!artifact) {
      throw invalid(
        "unknown_model",
        `Model '${ref}' is neither a catalog model (run \`grad models list\`, GET /v1/base-models) nor an artifact in this workspace ('name@version' or 'name@latest').`,
      );
    }
    if (NON_DEPLOYABLE_FORMATS.includes(artifact.format)) {
      throw invalid(
        "artifact_not_servable",
        `Artifact '${artifact.id}' has format '${artifact.format}' and cannot be served for evaluation.`,
      );
    }

    targets[ref] = {
      inference_model: artifact.id,
      price_per_million_tokens:
        deps.catalog.priceFor(artifact.base_model) ?? null,
    };
  }

  return targets;
};

/**
 * Resolves judge models like eval models, but stricter: a judge is a priced
 * catalog model, an operator-configured judge (GRAD_JUDGE_MODELS_JSON), or a
 * servable artifact of this workspace priced at its base model. Anything else
 * is 422 unknown_judge_model, so no judge runs unbilled and no workspace can
 * judge with another's artifact.
 */
const resolveJudgeTargets = async (
  deps: Pick<AppDependencies, "catalog" | "store">,
  workspaceId: string,
  judges: readonly string[],
): Promise<JudgeTargets> => {
  const targets: JudgeTargets = {};
  for (const ref of judges) {
    if (targets[ref]) continue;
    const price = deps.catalog.judgePriceFor(ref);
    if (price !== undefined) {
      targets[ref] = {
        inference_model: ref.trim().toLowerCase(),
        price_per_million_tokens: price,
      };
      continue;
    }
    const artifact = ref.includes("@")
      ? await deps.store.artifacts.get(workspaceId, ref)
      : null;
    const base = artifact && deps.catalog.priceFor(artifact.base_model);
    if (!artifact || base === undefined || base === null) {
      throw invalid(
        "unknown_judge_model",
        `Judge model '${ref}' is neither a priced judge on this server (${deps.catalog.judgeModels().join(", ")}) nor an artifact in this workspace ('name@version'). Operators add judges with GRAD_JUDGE_MODELS_JSON.`,
      );
    }
    if (NON_DEPLOYABLE_FORMATS.includes(artifact.format)) {
      throw invalid(
        "artifact_not_servable",
        `Artifact '${artifact.id}' has format '${artifact.format}' and cannot be served as a judge.`,
      );
    }
    targets[ref] = {
      inference_model: artifact.id,
      price_per_million_tokens: base,
    };
  }

  return targets;
};

interface BuiltTasks {
  tasks: EvalTask[];
  count: number;
  skipped: number;
  alreadyScored: number;
  promptTokens: number;
  referenceTokens: number;
}

/**
 * A scoring job's task: a record with an id (scores merge by id) and its own
 * answer, missing at least one of the rubric's scores (scored rows are skipped).
 */
const scoreTask = (
  record: DatasetRecord,
  names: readonly string[],
): { prompt: string; reference: string } | "skip" | "scored" => {
  const parts = recordPromptAndResponse(record);
  if (!record.id || !parts || parts.response === null) return "skip";
  if (names.every((name) => record.scores?.[name] !== undefined)) {
    return "scored";
  }

  return {
    prompt: parts.prompt.map(messageText).join("\n"),
    reference: parts.response,
  };
};

/** Counts `record` into `built` and returns the task it makes, or null (skipped). */
const addTask = (
  built: BuiltTasks,
  record: DatasetRecord,
  score: readonly string[] | null,
): EvalTask | null => {
  const index = built.count;
  if (score) {
    const task = scoreTask(record, score);
    if (task === "skip") built.skipped += 1;
    if (task === "scored") built.alreadyScored += 1;
    if (typeof task === "string") return null;

    built.count += 1;
    built.promptTokens += estimateTextTokens(task.prompt);
    built.referenceTokens += estimateTextTokens(task.reference);
    return { task_index: index, task_id: record.id as string, record };
  }

  const pr = recordPromptAndReference(record);
  if (!pr || pr.prompt.length === 0) {
    built.skipped += 1;
    return null;
  }

  built.count += 1;
  built.promptTokens += estimateTextTokens(
    pr.prompt.map(messageText).join("\n"),
  );
  built.referenceTokens +=
    pr.reference === null ? 256 : estimateTextTokens(pr.reference);
  return {
    task_index: index,
    task_id: record.id ?? `task_${index + 1}`,
    record,
  };
};

const noTasks = (): BuiltTasks => ({
  tasks: [],
  count: 0,
  skipped: 0,
  alreadyScored: 0,
  promptTokens: 0,
  referenceTokens: 0,
});

/** An eval's tasks: the usable records of its pinned dataset version, in order. */
export const buildTasks = (
  records: readonly DatasetRecord[],
  limit: number | undefined,
  score: readonly string[] | null,
): BuiltTasks => {
  const built = noTasks();
  for (const record of records) {
    if (limit !== undefined && built.count >= limit) break;
    const task = addTask(built, record, score);
    if (task) built.tasks.push(task);
  }

  return built;
};

/** `buildTasks` without the tasks: counts and token sums, streamed (a plan keeps no records). */
const countTasks = async (
  records: AsyncIterable<DatasetRecord>,
  limit: number | undefined,
  score: readonly string[] | null,
): Promise<BuiltTasks> => {
  const built = noTasks();
  for await (const record of records) {
    if (limit !== undefined && built.count >= limit) break;
    addTask(built, record, score);
  }

  return built;
};

const INFERENCE_UNAVAILABLE_DETAIL =
  "Evals need model outputs: set GRAD_INFERENCE_BASE_URL on the server (an OpenAI-compatible vLLM/SGLang endpoint serving your base models and LoRA artifacts by name, or the Gradiated gateway; for `grad local up`, export it before starting the stack) and optionally GRAD_JUDGE_BASE_URL.";

/** Gradiated Cloud before its gateway's eval lane is connected: nothing for the caller to set. */
const CLOUD_EVALS_UNAVAILABLE_DETAIL =
  "Evals aren't available on Gradiated Cloud yet: they are coming soon. Training, datasets and artifact downloads work now.";

const DEFAULT_RUBRIC: EvalRubricItem[] = [
  { name: "non_empty", kind: "validator", weight: 1, validator: "non_empty" },
];

/** A dataset's own rubric (`metadata.rubric`, set by benchmark imports), else non_empty. */
const datasetRubric = (dataset: {
  metadata: Record<string, unknown>;
}): EvalRubricItem[] => {
  const parsed = z
    .array(EvalRubricItemSchema)
    .min(1)
    .safeParse(dataset.metadata.rubric);

  return parsed.success ? parsed.data : DEFAULT_RUBRIC;
};

const JUDGE_UNAVAILABLE_DETAIL =
  "Judges need a model endpoint: set GRAD_INFERENCE_BASE_URL on the server and the eval workers (and GRAD_JUDGE_BASE_URL on the eval workers when judges are served elsewhere). Regex, validator and code scorers need no endpoint.";

/**
 * Plans an eval. `mode: "score"` (`dataset.score()`) grades the records' own
 * answers under the model name `record`, so it calls no model and only needs
 * an endpoint for judges.
 */
export const planEvalRequest = async (
  deps: AppDependencies,
  datasets: DatasetService,
  workspaceId: string,
  request: PlanEvalRequest,
  mode: EvalMode = "eval",
  fixedTargets?: ModelTargets,
): Promise<ResolvedEvalPlan> => {
  const scoring = mode === "score";
  if (!deps.inferenceConfigured && !scoring) {
    throw unavailable(
      "inference_unavailable",
      evalsOnCloud(deps)
        ? CLOUD_EVALS_UNAVAILABLE_DETAIL
        : INFERENCE_UNAVAILABLE_DETAIL,
    );
  }

  const dataset = await datasets.resolve(
    workspaceId,
    request.dataset,
    request.dataset_version,
  );
  const rubric = request.rubric ?? datasetRubric(dataset.dataset);
  const judgeItems = rubric.filter((r) => r.kind === "judge");
  if (!deps.inferenceConfigured && judgeItems.length > 0) {
    throw unavailable("inference_unavailable", JUDGE_UNAVAILABLE_DETAIL);
  }

  const names = rubric.map((r) => r.name);
  if (new Set(names).size !== names.length) {
    throw invalid("duplicate_scorer", "Rubric item names must be unique.");
  }

  const judgeModels = [...new Set(judgeItems.map((r) => r.model ?? ""))];
  const judgeTargets = await resolveJudgeTargets(
    deps,
    workspaceId,
    judgeModels,
  );
  const targets: ModelTargets = scoring
    ? {
        [RECORD_MODEL]: {
          inference_model: RECORD_MODEL,
          price_per_million_tokens: 0,
        },
      }
    : (fixedTargets ??
      (await resolveModelTargets(deps, workspaceId, request.models)));
  const built = await countTasks(
    datasets.records(dataset.version),
    request.limit,
    scoring ? names : null,
  );
  const taskCount = built.count;

  const localScorers = rubric
    .filter((r) => r.kind === "code")
    .map((r) => r.name);
  const passThreshold = resolvePassThreshold(rubric, request.pass_threshold);

  const outputs = taskCount * request.models.length * request.samples;
  const modelCalls = scoring ? 0 : outputs;
  const judgeCalls = outputs * judgeItems.length;
  const perCallTokens =
    taskCount > 0
      ? (built.promptTokens + built.referenceTokens) / taskCount
      : 0;

  let cost = 0;
  for (const model of request.models) {
    const price = targets[model]?.price_per_million_tokens ?? 0;
    cost += ((taskCount * request.samples * perCallTokens) / 1_000_000) * price;
  }
  for (const item of judgeItems) {
    const price = judgeTargets[item.model ?? ""]?.price_per_million_tokens ?? 0;
    cost += ((outputs * (perCallTokens + 400)) / 1_000_000) * price;
  }
  const estimatedCost = Number(cost.toFixed(6));

  const warnings: string[] = [];
  if (built.skipped > 0) {
    warnings.push(
      scoring
        ? `${built.skipped} record(s) have no id, prompt or answer to score and are skipped.`
        : `${built.skipped} record(s) have no usable prompt (a user turn) and are skipped.`,
    );
  }
  if (built.alreadyScored > 0) {
    warnings.push(
      `${built.alreadyScored} record(s) already have every score (${names.join(", ")}) and are skipped.`,
    );
  }
  if (taskCount === 0 && !scoring) {
    warnings.push(
      "The dataset has no records with a usable prompt; nothing would be evaluated.",
    );
  }
  if (request.samples === 1 && !scoring) {
    warnings.push(
      "samples=1 is fine for a quick check; use samples>=3 for decisions you will act on.",
    );
  }
  if (
    request.baseline !== undefined &&
    !request.models.includes(request.baseline)
  ) {
    warnings.push(
      `baseline '${request.baseline}' is not in models; paired vs_baseline diff will be omitted.`,
    );
  }
  if (localScorers.length > 0) {
    warnings.push(
      `Code scorers (${localScorers.join(", ")}) run in your SDK process: the eval waits in 'awaiting_scores' until their scores are posted.`,
    );
  }
  const unpriced = request.models.filter(
    (m) => targets[m]?.price_per_million_tokens === null,
  );
  if (unpriced.length > 0) {
    warnings.push(
      `No catalog price for ${unpriced.join(", ")}; their cost is not included.`,
    );
  }

  return {
    response: {
      task_source_kind: "dataset",
      dataset_version: dataset.version.version,
      estimated_tasks: taskCount,
      estimated_model_calls: modelCalls,
      estimated_judge_calls: judgeCalls,
      estimated_cost_usd: estimatedCost,
      judge_models: judgeModels,
      local_scorers: localScorers,
      pass_threshold: passThreshold,
      warnings,
    },
    dataset,
    targets,
    taskCount,
    rubric,
    judgeModels,
    judgeTargets,
    localScorers,
    passThreshold,
  };
};

export const assertNonEmptyPlan = (plan: ResolvedEvalPlan): void => {
  if (plan.taskCount === 0) {
    throw new ApiError(
      422,
      "empty_eval",
      "Nothing to evaluate",
      `Dataset '${plan.dataset.dataset.name}' version ${plan.dataset.version.version} has no records with a usable prompt.`,
    );
  }
};
