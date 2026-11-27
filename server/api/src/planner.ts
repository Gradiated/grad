import { createHash } from "node:crypto";

import type { ModelCatalog } from "./catalog.js";
import { isArtifactRef, resolveContinuation } from "./continued-training.js";
import { planDistill, type DistillPlan } from "./distill-plan.js";
import {
  V0_RECIPE_KINDS,
  messageText,
  type AdapterSpec,
  type Artifact,
  type BaseArtifact,
  type ChatMessage,
  type DatasetRecord,
  type PlanRunRequest,
  type PlanRunResponse,
  type RecipeKind,
  type ResolvedRunConfig,
  type TrainableModel,
} from "./contracts.js";
import { invalid } from "./errors.js";
import { resolveRecipeParams } from "./recipe-params.js";
import {
  assessRecipeUsability,
  recordConversation,
  recordShapeHelp,
  type RecipeUsability,
} from "./records.js";

export const AUTO_RULE_VERSION = "auto@2";

/** Rough token estimate (chars / 4); plans label counts as estimates. */
export const estimateTextTokens = (text: string): number => {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  return Math.max(1, Math.ceil(trimmed.length / 4));
};

const hashFraction = (key: string, seed: number): number =>
  createHash("sha256").update(`${seed}:${key}`).digest().readUInt32BE(0) /
  0x1_0000_0000;

/** Split key shared with the trainer: empty ids fall through like missing ones. */
const splitKey = (
  record: DatasetRecord,
  index: number,
  strategy: "by_session" | "by_group" | "random",
): string => {
  const pick = (...values: Array<string | null | undefined>) =>
    values.find((v) => typeof v === "string" && v.length > 0);

  if (strategy === "by_session") {
    return pick(record.session_id, record.id) ?? `row:${index}`;
  }
  if (strategy === "by_group") {
    return (
      pick(record.group_id, record.session_id, record.id) ?? `row:${index}`
    );
  }

  return pick(record.id) ?? `row:${index}`;
};

export const splitRecords = (
  records: readonly DatasetRecord[],
  options: {
    strategy: "by_session" | "by_group" | "random";
    eval_fraction: number;
    seed: number;
  },
): { train: DatasetRecord[]; eval: DatasetRecord[] } => {
  const keys = records.map((record, index) =>
    splitKey(record, index, options.strategy),
  );
  const fractions = keys.map((key) => hashFraction(key, options.seed));
  const inEval = fractions.map((f) => f < options.eval_fraction);

  if (inEval.length > 0 && inEval.every(Boolean)) {
    inEval[0] = false;
  } else if (options.eval_fraction > 0 && !inEval.some(Boolean)) {
    // With two or more groups the eval side is never empty: the group that
    // hashes lowest is held out (tiny datasets otherwise trained unevaluated).
    let lowest = 0;
    fractions.forEach((f, i) => {
      if (f < (fractions[lowest] as number)) lowest = i;
    });
    const held = keys[lowest];
    if (keys.some((key) => key !== held)) {
      keys.forEach((key, i) => {
        if (key === held) inEval[i] = true;
      });
    }
  }

  return {
    train: records.filter((_, i) => !inEval[i]),
    eval: records.filter((_, i) => inEval[i]),
  };
};

export interface RenderOptions {
  templateRevision: string;
  train_on: "last" | "all_assistant";
  thinking: "auto" | "on" | "off";
  preserve_thinking: boolean;
}

const stripThinking = (text: string): string =>
  text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");

const hasThinkingBlock = (text: string): boolean =>
  /<think>[\s\S]*?<\/think>/.test(text);

/**
 * ChatML preview with loss masks. Token counts are estimates; the trainer
 * renders with the pinned tokenizer and chat template.
 */
export const renderMessages = (
  recordId: string,
  messages: readonly ChatMessage[],
  options: RenderOptions,
): {
  record_id: string;
  template_revision: string;
  total_tokens: number;
  trained_tokens: number;
  trained_fraction: number;
  spans: Array<{ text: string; trained: boolean; tokens: number }>;
} => {
  let lastAssistantIndex = -1;
  messages.forEach((m, i) => {
    if (m.role === "assistant") lastAssistantIndex = i;
  });

  const spans: Array<{ text: string; trained: boolean; tokens: number }> = [];
  let totalTokens = 0;
  let trainedTokens = 0;

  messages.forEach((message, i) => {
    const rawContent = messageText(message);
    const isAssistant = message.role === "assistant";
    const isLastAssistant = i === lastAssistantIndex;

    const trained =
      message.train ??
      (isAssistant &&
        (options.train_on === "all_assistant" || isLastAssistant));

    if (trained && isAssistant) {
      const hasThink = hasThinkingBlock(rawContent);
      if (options.thinking === "off" && hasThink) {
        throw invalid(
          "render_conflict",
          `Record '${recordId}' contains a <think> block but thinking='off'.`,
        );
      }
      if (options.thinking === "on" && !hasThink) {
        throw invalid(
          "render_conflict",
          `Record '${recordId}' has no <think> block but thinking='on'.`,
        );
      }
    }

    const content =
      isAssistant && !isLastAssistant && !options.preserve_thinking
        ? stripThinking(rawContent)
        : rawContent;
    const header = `<|im_start|>${message.role}\n`;
    const body = `${content}<|im_end|>\n`;
    const headerTokens = estimateTextTokens(header) + 2;
    const bodyTokens = estimateTextTokens(body) + 1;

    spans.push({ text: header, trained: false, tokens: headerTokens });
    spans.push({ text: body, trained, tokens: bodyTokens });
    totalTokens += headerTokens + bodyTokens;
    if (trained) trainedTokens += bodyTokens;
  });

  return {
    record_id: recordId,
    template_revision: options.templateRevision,
    total_tokens: totalTokens,
    trained_tokens: trainedTokens,
    trained_fraction: totalTokens > 0 ? trainedTokens / totalTokens : 0,
    spans,
  };
};

const textOf = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map((m) => messageText(m as ChatMessage)).join("\n")
      : value === undefined
        ? ""
        : JSON.stringify(value);

const estimateRecordTokens = (
  record: DatasetRecord,
  options: RenderOptions,
): { total: number; trained: number } => {
  const conversation = recordConversation(record);
  if (conversation.length > 0) {
    const rendered = renderMessages(
      record.id ?? "record",
      conversation,
      options,
    );

    return { total: rendered.total_tokens, trained: rendered.trained_tokens };
  }

  const text = [
    textOf(record.prompt),
    textOf(record.chosen),
    textOf(record.rejected),
    record.query ?? "",
    record.positive ?? "",
    ...(record.negatives ?? []),
    record.state === undefined ? "" : JSON.stringify(record.state),
    record.expected_output === undefined
      ? ""
      : JSON.stringify(record.expected_output),
  ].join("\n");
  const total = Math.max(16, estimateTextTokens(text));

  return { total, trained: Math.max(8, Math.round(total * 0.4)) };
};

/** USD for a message: cents, or two significant digits below a cent ($0.00041). */
export const formatUsd = (usd: number): string => {
  if (usd === 0 || Math.abs(usd) >= 0.01) return `$${usd.toFixed(2)}`;
  const decimals = Math.min(8, 1 - Math.floor(Math.log10(Math.abs(usd))));

  return `$${usd.toFixed(decimals)}`;
};

/** The "too few steps" advice: a batch size only when one reaches 100 steps. */
const fewStepsWarning = (
  steps: number,
  examples: number,
  batchSize: number,
): string => {
  const reach = Math.floor(examples / 100);
  const advice =
    reach >= 1 && reach < batchSize
      ? `use batch_size=${reach} (or add epochs or data)`
      : "add data or epochs";

  return `${steps} ${steps === 1 ? "step is" : "steps are"} below the 100 we recommend; ${advice}.`;
};

export const isV0Recipe = (kind: RecipeKind): boolean =>
  (V0_RECIPE_KINDS as readonly string[]).includes(kind);

const assertRecipeSupported = (
  kind: RecipeKind,
  model: TrainableModel,
  catalog: ModelCatalog,
): void => {
  if (model.recipes.includes(kind)) return;

  const supported = catalog
    .list()
    .filter((m) => m.recipes.includes(kind))
    .map((m) => m.id);
  throw invalid(
    "recipe_not_supported_for_model",
    `Model '${model.id}' does not support recipe '${kind}'. Models that do: ${supported.join(", ") || "none"}.`,
  );
};

/** The closest catalog id by edit distance, when it is a plausible typo. */
const closestModel = (
  requested: string,
  ids: readonly string[],
): string | undefined => {
  const distance = (a: string, b: string): number => {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i += 1) {
      const row = [i];
      for (let j = 1; j <= b.length; j += 1) {
        row[j] = Math.min(
          (prev[j] ?? 0) + 1,
          (row[j - 1] ?? 0) + 1,
          (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
      }
      prev = row;
    }

    return prev[b.length] ?? 0;
  };
  const want = requested.trim().toLowerCase();
  const best = ids
    .map((id) => ({ id, d: distance(want, id) }))
    .sort((x, y) => x.d - y.d)[0];

  return best && best.d <= Math.max(2, Math.floor(want.length / 4))
    ? best.id
    : undefined;
};

/** "Not in the catalog", the closest id, and how to list the catalog. */
export const unknownModelMessage = (
  requested: string,
  catalog: ModelCatalog,
): string => {
  const near = closestModel(
    requested,
    catalog.list().map((m) => m.id),
  );

  return `Model '${requested}' is not in the trainable catalog${near ? `; did you mean '${near}'?` : "."} Run \`grad models list\` (GET /v1/base-models) to see it; self-hosted servers can add models with GRAD_EXTRA_MODELS_JSON.`;
};

const resolveModel = (
  request: PlanRunRequest,
  catalog: ModelCatalog,
): TrainableModel => {
  const { kind } = request.recipe;
  const requested = request.recipe.model;
  const model = requested
    ? catalog.find(requested)
    : catalog.defaultModelFor(kind);
  if (!model) {
    throw invalid(
      "unknown_model",
      requested
        ? unknownModelMessage(requested, catalog)
        : `No default model is configured for recipe '${kind}'; pass recipe.model.`,
    );
  }

  assertRecipeSupported(kind, model, catalog);

  return model;
};

const resolveAdapter = (
  request: PlanRunRequest,
  model: TrainableModel,
): ResolvedRunConfig["adapter"] => {
  const { recipe } = request;
  let adapter: ResolvedRunConfig["adapter"];

  if (recipe.kind === "embedding") {
    adapter = { kind: "encoder_full" };
  } else if (recipe.kind === "cartridge") {
    adapter =
      recipe.adapter?.kind === "prefix_kv"
        ? recipe.adapter
        : ({
            kind: "prefix_kv",
            num_tokens: recipe.num_tokens ?? 256,
          } satisfies AdapterSpec);
  } else {
    adapter = recipe.adapter ?? {
      kind: "lora",
      rank: 32,
      alpha: 32,
      merge_on_export: false,
    };
  }

  if (!model.adapters.includes(adapter.kind)) {
    throw invalid(
      "adapter_not_supported",
      `Model '${model.id}' does not support adapter '${adapter.kind}' (supported: ${model.adapters.join(", ")}).`,
    );
  }

  return adapter;
};

/** Router candidates (explicit or discovered) checked against fallback and pricing. */
const resolveRouterCandidates = (
  recipe: PlanRunRequest["recipe"],
  usability: RecipeUsability,
  records: readonly DatasetRecord[],
  warnings: string[],
): string[] => {
  const candidates = recipe.models ?? usability.discoveredModels ?? [];
  if (candidates.length < 2) {
    throw invalid(
      "router_candidates_required",
      "Router training needs scores for at least two candidate models: pass recipe.models or include scored responses from two or more models.",
    );
  }
  if (recipe.fallback !== undefined && !candidates.includes(recipe.fallback)) {
    throw invalid(
      "router_fallback_not_candidate",
      `recipe.fallback '${recipe.fallback}' is not one of the candidates (${candidates.join(", ")}).`,
    );
  }
  const unknownPrices = Object.keys(recipe.pricing ?? {}).filter(
    (m) => !candidates.includes(m),
  );
  if (unknownPrices.length > 0) {
    throw invalid(
      "router_pricing_not_candidate",
      `recipe.pricing names models that are not candidates: ${unknownPrices.join(", ")}.`,
    );
  }
  const unpriced = candidates.filter((m) => recipe.pricing?.[m] === undefined);
  const loggedCosts = records.some(
    (r) => typeof r.metrics?.cost_usd === "number",
  );
  // A Judge or Rubric labels the prompts in an eval, which records each call's cost.
  const labeled = typeof recipe.rubric === "object" && recipe.rubric !== null;
  if (unpriced.length > 0 && !loggedCosts && !labeled) {
    warnings.push(
      `No per-request serving price for ${unpriced.join(", ")} (pass recipe.pricing, or log metrics.cost_usd on your records): the router maximizes offload rate and cost_savings_pct is null.`,
    );
  }

  return candidates;
};

export type LabelingPlan = NonNullable<PlanRunResponse["labeling"]>;

export interface PlanContext {
  /** Router runs with rubric items: the labeling eval's estimate. */
  labeling?: LabelingPlan | null;
  catalog: ModelCatalog;
  datasetVersion: number;
  /** The artifact `recipe.model` names (continued training). */
  baseArtifact?: Artifact | null;
}

type Start = {
  model: TrainableModel;
  adapter: ResolvedRunConfig["adapter"];
  base: BaseArtifact | null;
};

/** Base model, adapter and (for continued training) the starting artifact. */
const resolveStart = (request: PlanRunRequest, context: PlanContext): Start => {
  if (!isArtifactRef(request.recipe.model)) {
    const model = resolveModel(request, context.catalog);

    return { model, adapter: resolveAdapter(request, model), base: null };
  }

  const start = resolveContinuation(
    request.recipe,
    context.baseArtifact ?? null,
    context.catalog,
  );
  assertRecipeSupported(request.recipe.kind, start.model, context.catalog);

  return start;
};

/** Resolves every default for a run and estimates its cost. Throws ApiError(422). */
export const planRun = (
  request: PlanRunRequest,
  records: readonly DatasetRecord[],
  context: PlanContext,
): PlanRunResponse => {
  const { recipe } = request;
  const warnings: string[] = [];

  if (!isV0Recipe(recipe.kind)) {
    throw invalid(
      "recipe_deferred",
      `Recipe '${recipe.kind}' is deferred past v0 (it arrives in Wave 2); supported v0 recipes are ${V0_RECIPE_KINDS.join(", ")}.`,
    );
  }

  const { model, adapter, base } = resolveStart(request, context);
  if (
    recipe.kind === "cartridge" &&
    recipe.teacher !== undefined &&
    context.catalog.find(recipe.teacher)?.family !== model.family
  ) {
    throw invalid(
      "unknown_model",
      `Teacher '${recipe.teacher}' is not a ${model.family} model in the trainable catalog; run \`grad models list\` (GET /v1/base-models).`,
    );
  }

  if (recipe.kind === "cartridge" && !recipe.context_text) {
    throw invalid(
      "cartridge_context_required",
      "Cartridge recipes need the document to compress: pass recipe.context_text (Context.from_file reads a local file).",
    );
  }

  if (records.length === 0) {
    throw invalid(
      "empty_dataset",
      `Dataset '${request.dataset}' has zero records.`,
    );
  }

  const labelled = Array.isArray(recipe.rubric);
  const offPolicy =
    recipe.kind === "distill" && recipe.rollout?.kind === "off_policy";
  const usability = assessRecipeUsability(recipe.kind, records, {
    rubric: typeof recipe.rubric === "string" ? recipe.rubric : undefined,
    labelled,
    candidates: recipe.models,
  });
  if (usability.usable === 0) {
    throw invalid(
      "no_usable_records",
      `None of the ${records.length} records in '${request.dataset}' can train recipe '${recipe.kind}' (${usability.reasons.join("; ")}). ${recordShapeHelp(recipe.kind)}`,
    );
  }
  const paired = recipe.kind === "dpo" || recipe.kind === "reward";
  if (usability.unusable > 0) {
    warnings.push(
      `${usability.unusable} of ${usability.total} records cannot be used by '${recipe.kind}' and will be skipped (${usability.reasons.join("; ")}); for example ${usability.examples.map((e) => `'${e}'`).join(", ")}.`,
    );
  }

  const resolvedParams = resolveRecipeParams(recipe);
  const recipeParams = resolvedParams.params;
  if ((labelled || offPolicy) && !context.labeling) {
    throw new Error("This run trains on a labeling eval and needs its plan.");
  }
  if (recipe.kind === "router") {
    recipeParams.models = resolveRouterCandidates(
      recipe,
      usability,
      records,
      warnings,
    );
  }

  const defaultBatch = 128;
  const batchSize = recipe.batch_size ?? defaultBatch;
  const evalFraction =
    request.split?.eval_fraction ??
    (recipe.kind === "router" || recipe.kind === "decision" ? 0.15 : 0.1);
  const splitStrategy =
    request.split?.strategy ?? (paired ? "by_group" : "by_session");
  const splitSeed = request.split?.seed ?? 42;
  const { train, eval: evalSet } = splitRecords(records, {
    strategy: splitStrategy,
    eval_fraction: evalFraction,
    seed: splitSeed,
  });

  if (evalSet.length === 0) {
    warnings.push(
      "The eval split is empty; eval metrics will be unavailable. Add records or raise split.eval_fraction.",
    );
  }

  let lr: number;
  let lrSource: string;
  if (recipe.lr === "auto") {
    const baseLr = model.calibrated_lrs[recipe.kind] as number;
    const scale = Math.sqrt(batchSize / defaultBatch) * recipe.lr_scale;
    lr = Number((baseLr * scale).toPrecision(3));
    lrSource = `${AUTO_RULE_VERSION}: calibrated for ${model.id} at batch ${defaultBatch}, sqrt batch scaling`;
  } else {
    lr = recipe.lr * recipe.lr_scale;
    lrSource = "explicit";
  }

  const reduction = resolvedParams.reduction;
  const renderOptions: RenderOptions = {
    templateRevision: model.template_revision,
    train_on: recipe.train_on,
    thinking: recipe.thinking,
    preserve_thinking: recipe.preserve_thinking,
  };

  let totalTokens = 0;
  let trainedTokens = 0;
  let truncated = 0;
  for (const record of train) {
    const counts = estimateRecordTokens(record, renderOptions);
    totalTokens += counts.total;
    trainedTokens += counts.trained;
    if (counts.total > model.max_context_tokens) truncated += 1;
  }

  let distill: DistillPlan | null = null;
  if (recipe.kind === "distill") {
    distill = planDistill(
      request,
      model,
      context.catalog,
      { train, eval: evalSet },
      renderOptions,
    );
    warnings.push(...distill.warnings);
    recipeParams.rollout = distill.rollout;
    if (distill.teacherTokenWeight !== null) {
      recipeParams.teacher_token_weight = distill.teacherTokenWeight;
    }
  }

  const estimatedSteps = Math.max(
    1,
    Math.ceil((train.length * recipe.epochs) / batchSize),
  );
  if (estimatedSteps < 100) {
    warnings.push(
      fewStepsWarning(estimatedSteps, train.length * recipe.epochs, batchSize),
    );
  }
  if (truncated > 0) {
    warnings.push(
      `${truncated} training records exceed ${model.max_context_tokens} tokens and will be truncated.`,
    );
  }

  const estimatedTokens = distill
    ? distill.estimatedTokens
    : totalTokens * recipe.epochs;
  const price = model.price_per_million_tokens_usd;
  const labeling = context.labeling ?? null;
  const estimatedCostUsd = Number(
    (
      (estimatedTokens / 1_000_000) * price +
      (labeling?.estimated_cost_usd ?? 0)
    ).toFixed(4),
  );
  if (labeling && offPolicy) {
    warnings.push(
      `Before training, the teacher '${recipe.teacher ?? ""}' answers each prompt in a labeling eval: ${labeling.estimated_model_calls} model calls, about $${labeling.estimated_cost_usd.toFixed(4)} (billed as an eval).`,
    );
  } else if (labeling) {
    warnings.push(
      `Before training, a labeling eval replays each prompt against ${(recipe.models ?? []).join(", ")} and scores the answers with your rubric: ${labeling.estimated_model_calls} model calls and ${labeling.estimated_judge_calls} judge calls, about $${labeling.estimated_cost_usd.toFixed(4)} (billed as an eval).`,
    );
  }
  if (
    request.max_cost_usd !== undefined &&
    estimatedCostUsd > request.max_cost_usd
  ) {
    warnings.push(
      `Estimated cost (${formatUsd(estimatedCostUsd)}) exceeds max_cost_usd (${formatUsd(request.max_cost_usd)}); the run will stop early with status stopped_budget.`,
    );
  }

  const checkpointEvery = Math.max(
    1,
    Math.min(20, Math.floor(estimatedSteps * 0.1)),
  );
  const evalEvery =
    recipe.eval_every === "auto" ? checkpointEvery : recipe.eval_every;
  if (evalEvery > estimatedSteps) {
    warnings.push(
      `eval_every=${evalEvery} is more than the ${estimatedSteps} estimated steps; the held-out split is evaluated only at the end.`,
    );
  }

  const resolvedConfig: ResolvedRunConfig = {
    rule_version: AUTO_RULE_VERSION,
    dataset: request.dataset,
    dataset_version: context.datasetVersion,
    name: request.name,
    recipe_kind: recipe.kind,
    model: model.id,
    template_revision: model.template_revision,
    adapter,
    lr,
    lr_source: lrSource,
    batch_size: batchSize,
    epochs: recipe.epochs,
    schedule: recipe.schedule,
    warmup: recipe.warmup,
    train_on: recipe.train_on,
    thinking: recipe.thinking,
    preserve_thinking: recipe.preserve_thinking,
    reduction,
    select: recipe.select,
    checkpoint_every_steps: checkpointEvery,
    eval_every_steps: evalEvery,
    optimizer: resolvedParams.optimizer,
    checkpoint_ttl_days: recipe.checkpoint_ttl_days,
    split: {
      strategy: splitStrategy,
      eval_fraction: evalFraction,
      seed: splitSeed,
      train_records: train.length,
      eval_records: evalSet.length,
    },
    label_eval_id: null,
    base_artifact: base,
    recipe_params: recipeParams,
  };

  return {
    resolved_config: resolvedConfig,
    dataset_version: context.datasetVersion,
    usable_records: usability.usable,
    total_records: usability.total,
    estimated_steps: estimatedSteps,
    estimated_tokens: estimatedTokens,
    estimated_cost_usd: estimatedCostUsd,
    price_per_million_tokens: price,
    trained_token_fraction:
      totalTokens > 0 ? Number((trainedTokens / totalTokens).toFixed(4)) : 0,
    labeling,
    teacher: distill?.teacher ?? null,
    warnings,
  };
};
