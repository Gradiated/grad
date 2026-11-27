import { createHash } from "node:crypto";

import type { ModelCatalog } from "./catalog.js";
import { isArtifactRef, resolveContinuation } from "./continued-training.js";
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
  const train: DatasetRecord[] = [];
  const evalSet: DatasetRecord[] = [];

  records.forEach((record, index) => {
    const key = splitKey(record, index, options.strategy);
    (hashFraction(key, options.seed) < options.eval_fraction
      ? evalSet
      : train
    ).push(record);
  });

  if (train.length === 0 && evalSet.length > 0) {
    train.push(evalSet.shift() as DatasetRecord);
  }

  return { train, eval: evalSet };
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
        ? `Model '${requested}' is not in the trainable catalog; see GET /v1/models (self-hosted servers can register models with GRAD_EXTRA_MODELS_JSON).`
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
  if (unpriced.length > 0 && !loggedCosts) {
    warnings.push(
      `No price for ${unpriced.join(", ")} (recipe.pricing or metrics.cost_usd on your records): the router maximizes offload rate and cost_savings_pct is null.`,
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
  allowWave2?: boolean;
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

  if (!isV0Recipe(recipe.kind) && !context.allowWave2) {
    throw invalid(
      "recipe_deferred",
      `Recipe '${recipe.kind}' is deferred past v0 on this server; supported v0 recipes are ${V0_RECIPE_KINDS.join(", ")}.`,
    );
  }

  const { model, adapter, base } = resolveStart(request, context);
  if (
    recipe.teacher !== undefined &&
    context.catalog.find(recipe.teacher)?.family !== model.family
  ) {
    throw invalid(
      "unknown_model",
      `Teacher '${recipe.teacher}' is not a ${model.family} model in the trainable catalog; see GET /v1/models.`,
    );
  }

  if (
    recipe.kind === "cartridge" &&
    !recipe.context_text &&
    !recipe.context_uri
  ) {
    throw invalid(
      "cartridge_context_required",
      "Cartridge recipes need the document to compress: pass recipe.context_text or recipe.context_uri.",
    );
  }

  if (records.length === 0) {
    throw invalid(
      "empty_dataset",
      `Dataset '${request.dataset}' has zero records.`,
    );
  }

  const labelled = Array.isArray(recipe.rubric);
  if (labelled && !context.labeling) {
    throw new Error("A router rubric of rubric items needs a labeling plan.");
  }
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
  if (usability.usable < usability.total && recipe.kind !== "dpo") {
    warnings.push(
      `${usability.total - usability.usable} of ${usability.total} records cannot be used by '${recipe.kind}' and will be skipped (${usability.reasons.join("; ")}).`,
    );
  }
  if (recipe.kind === "dpo" && usability.reasons.length > 0) {
    warnings.push(
      `Some records were not paired: ${usability.reasons.join("; ")}.`,
    );
  }

  const resolvedParams = resolveRecipeParams(recipe);
  const recipeParams = resolvedParams.params;
  if (recipe.kind === "router") {
    recipeParams.models = resolveRouterCandidates(
      recipe,
      usability,
      records,
      warnings,
    );
  }

  const defaultBatch = recipe.kind === "grpo" ? 32 : 128;
  const batchSize = recipe.batch_size ?? defaultBatch;
  const evalFraction =
    request.split?.eval_fraction ??
    (recipe.kind === "router" || recipe.kind === "decision" ? 0.15 : 0.1);
  const splitStrategy =
    request.split?.strategy ??
    (recipe.kind === "dpo" ? "by_group" : "by_session");
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

  const estimatedSteps = Math.max(
    1,
    Math.ceil((train.length * recipe.epochs) / batchSize),
  );
  if (estimatedSteps < 100) {
    const suggested = Math.max(
      1,
      Math.floor((train.length * recipe.epochs) / 100),
    );
    warnings.push(
      `${estimatedSteps} steps is below the 100 we recommend; use batch_size=${suggested} or more epochs/data.`,
    );
  }
  if (truncated > 0) {
    warnings.push(
      `${truncated} training records exceed ${model.max_context_tokens} tokens and will be truncated.`,
    );
  }

  const estimatedTokens = totalTokens * recipe.epochs;
  const price = model.price_per_million_tokens_usd;
  const labeling = context.labeling ?? null;
  const estimatedCostUsd = Number(
    (
      (estimatedTokens / 1_000_000) * price +
      (labeling?.estimated_cost_usd ?? 0)
    ).toFixed(4),
  );
  if (labeling) {
    warnings.push(
      `Before training, a labeling eval replays each prompt against ${(recipe.models ?? []).join(", ")} and scores the answers with your rubric: ${labeling.estimated_model_calls} model calls and ${labeling.estimated_judge_calls} judge calls, about $${labeling.estimated_cost_usd.toFixed(4)} (billed as an eval).`,
    );
  }
  if (
    request.max_cost_usd !== undefined &&
    estimatedCostUsd > request.max_cost_usd
  ) {
    warnings.push(
      `Estimated cost ($${estimatedCostUsd.toFixed(2)}) exceeds max_cost_usd ($${request.max_cost_usd.toFixed(2)}); the run will stop early with status stopped_budget.`,
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
    warnings,
  };
};
