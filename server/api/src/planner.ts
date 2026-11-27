import { createHash } from "node:crypto";

import { DEFAULT_CHARS_PER_TOKEN, type ModelCatalog } from "./catalog.js";
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
import {
  assertFitsOneGpu,
  estimateDurationS,
  requiredGpuMemoryGb,
} from "./gpu-profile.js";
import { resolveRecipeParams } from "./recipe-params.js";
import {
  assessRecipeUsability,
  recordConversation,
  recordPromptAndResponse,
  recordShapeHelp,
  preferenceItems,
  routerObservations,
  type RecipeUsability,
} from "./records.js";

export const AUTO_RULE_VERSION = "auto@2";

/**
 * Rough text token estimate (chars / the base tokenizer's characters per
 * token, 4 by default); plans label counts as estimates. At 4 it errs high for
 * English prose (Qwen3 averages about 4.6 characters a token there) and low
 * for code-free CJK text.
 */
export const estimateTextTokens = (
  text: string,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
): number => {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  return Math.max(1, Math.ceil(trimmed.length / charsPerToken));
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
  /** The base tokenizer's characters per token (catalog; default 4). */
  charsPerToken?: number;
}

/** ChatML framing, exact for the Qwen3 tokenizer: `<|im_start|>`, role, newline. */
const HEADER_TOKENS = 3;
/** `<|im_end|>` and the newline after it. */
const FOOTER_TOKENS = 2;
/** `<think>\n\n</think>\n\n`, rendered (untrained) before a final answer without reasoning. */
const EMPTY_THINK = "<think>\n\n</think>\n\n";
const EMPTY_THINK_TOKENS = 4;
/** The generation header the trainer appends to router/classifier prompts. */
const GENERATION_HEADER_TOKENS = 3;
/** The trainer cuts every sequence to this many tokens (torch_common.model_max_len). */
export const TRAINER_MAX_SEQ_LEN = 8192;

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
    // The trainer renders the final answer behind an empty think block when it has none.
    const emptyThink =
      isLastAssistant &&
      i === messages.length - 1 &&
      !hasThinkingBlock(content);
    const header = `<|im_start|>${message.role}\n${emptyThink ? EMPTY_THINK : ""}`;
    const body = `${content}<|im_end|>\n`;
    const headerTokens = HEADER_TOKENS + (emptyThink ? EMPTY_THINK_TOKENS : 0);
    const bodyTokens =
      estimateTextTokens(content, options.charsPerToken) + FOOTER_TOKENS;

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
  const total = Math.max(16, estimateTextTokens(text, options.charsPerToken));

  return { total, trained: Math.max(8, Math.round(total * 0.4)) };
};

/** USD for a message: cents, or two significant digits below a cent ($0.00041). */
export const formatUsd = (usd: number): string => {
  if (usd === 0 || Math.abs(usd) >= 0.01) return `$${usd.toFixed(2)}`;
  const decimals = Math.min(8, 1 - Math.floor(Math.log10(Math.abs(usd))));

  return `$${usd.toFixed(decimals)}`;
};

/** The batch size the auto learning rates were calibrated at, and the default. */
export const CALIBRATED_BATCH_SIZE = 128;

/**
 * The default batch size: 128, or a quarter of the training items (at least
 * 8) when that's smaller, so a small dataset still takes about 4 optimizer
 * steps per epoch. Embedding keeps 128: its in-batch negatives need the
 * batch.
 */
export const defaultBatchSize = (kind: RecipeKind, items: number): number =>
  kind === "embedding"
    ? CALIBRATED_BATCH_SIZE
    : Math.min(CALIBRATED_BATCH_SIZE, Math.max(8, Math.floor(items / 4)));

/** The "too few steps" warning: the step count, and a batch size only when one reaches 100 steps. */
const fewStepsWarning = (p: {
  steps: number;
  stepsPerEpoch: number;
  items: number;
  epochs: number;
  batchSize: number;
}): string => {
  const reach = Math.floor((p.items * p.epochs) / 100);
  const advice =
    reach >= 1 && reach < p.batchSize
      ? `use batch_size=${reach} (or add epochs or data)`
      : "consider more data, more epochs or a smaller batch_size";
  const perEpoch = `${p.stepsPerEpoch} step${p.stepsPerEpoch === 1 ? "" : "s"} per epoch`;
  const total = p.epochs === 1 ? "" : ` (${p.steps} over ${p.epochs} epochs)`;

  return `${p.items} training example${p.items === 1 ? "" : "s"} at batch ${p.batchSize} is ${perEpoch}${total}, below the 100 steps we recommend; ${advice}.`;
};

/** Tokens of a record's prompt rendered with the generation header, or null without one. */
export const promptTokens = (
  record: DatasetRecord,
  options: RenderOptions,
): number | null => {
  const prompt = recordPromptAndResponse(record)?.prompt ?? [];
  if (!prompt.some((m) => m.role === "user")) return null;

  return (
    renderMessages(record.id ?? "record", prompt, options).total_tokens +
    GENERATION_HEADER_TOKENS
  );
};

/** Python's json.dumps(value, sort_keys=True, ensure_ascii=False). */
const pythonJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();

    return `{${keys.map((k) => `${JSON.stringify(k)}: ${pythonJson(obj[k])}`).join(", ")}}`;
  }

  return JSON.stringify(value) ?? "null";
};

/**
 * The router's prompt group, as recipes/router.py prompt_key: the record's
 * group_id, else a hash of its prompt messages.
 */
export const routerGroupKey = (record: DatasetRecord): string => {
  if (record.group_id !== undefined && record.group_id !== null) {
    return record.group_id;
  }
  const prompt = recordPromptAndResponse(record)?.prompt ?? [];
  const digest = createHash("sha256").update(pythonJson(prompt)).digest("hex");

  return `prompt:${digest.slice(0, 24)}`;
};

/**
 * The train/eval split the trainer uses for a recipe. Router runs split whole
 * prompt groups (by_session means by_group there), like RouterRunner.
 */
export const splitForRecipe = (
  kind: RecipeKind,
  records: readonly DatasetRecord[],
  options: {
    strategy: "by_session" | "by_group" | "random";
    eval_fraction: number;
    seed: number;
  },
): { train: DatasetRecord[]; eval: DatasetRecord[] } => {
  if (kind !== "router") return splitRecords(records, options);

  const keyed = records.map((r) =>
    r.group_id !== undefined && r.group_id !== null
      ? r
      : { ...r, group_id: routerGroupKey(r) },
  );
  const original = new Map(
    keyed.map((r, i) => [r, records[i] as DatasetRecord]),
  );
  const { train, eval: evalSet } = splitRecords(keyed, {
    ...options,
    strategy: options.strategy === "by_session" ? "by_group" : options.strategy,
  });
  const back = (rs: DatasetRecord[]) =>
    rs.map((r) => original.get(r) as DatasetRecord);

  return { train: back(train), eval: back(evalSet) };
};

/** Router training items: one per scored prompt group, metered on its prompt tokens only. */
const routerGroups = (
  records: readonly DatasetRecord[],
  recipe: PlanRunRequest["recipe"],
  options: RenderOptions,
): number[] => {
  const tokens = new Map<string, number>();
  const labelled = Array.isArray(recipe.rubric);
  for (const record of records) {
    const key = routerGroupKey(record);
    if (tokens.has(key)) continue;
    const scored =
      labelled ||
      routerObservations(record, {
        rubric: typeof recipe.rubric === "string" ? recipe.rubric : undefined,
        candidates: recipe.models?.map((m) => m.trim().toLowerCase()),
      }).models.length > 0;
    const count = scored ? promptTokens(record, options) : null;
    if (count !== null) tokens.set(key, Math.min(count, TRAINER_MAX_SEQ_LEN));
  }

  return [...tokens.values()];
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

  const evalFraction =
    request.split?.eval_fraction ??
    (recipe.kind === "router" || recipe.kind === "decision" ? 0.15 : 0.1);
  const splitStrategy =
    request.split?.strategy ?? (paired ? "by_group" : "by_session");
  const splitSeed = request.split?.seed ?? 42;
  const { train, eval: evalSet } = splitForRecipe(recipe.kind, records, {
    strategy: splitStrategy,
    eval_fraction: evalFraction,
    seed: splitSeed,
  });

  if (evalSet.length === 0) {
    warnings.push(
      "The eval split is empty; eval metrics will be unavailable. Add records or raise split.eval_fraction.",
    );
  }

  const reduction = resolvedParams.reduction;
  const renderOptions: RenderOptions = {
    templateRevision: model.template_revision,
    train_on: recipe.train_on,
    thinking: recipe.thinking,
    preserve_thinking: recipe.preserve_thinking,
    charsPerToken: context.catalog.charsPerToken(model.id),
  };

  const maxSeqLen = Math.min(model.max_context_tokens, TRAINER_MAX_SEQ_LEN);
  let totalTokens = 0;
  let trainedTokens = 0;
  let truncated = 0;
  let evalTokens = 0;
  let trainItems = train.length;
  if (recipe.kind === "router") {
    // One item per prompt group, prompt tokens only (recipes/router.py).
    const groups = routerGroups(train, recipe, renderOptions);
    trainItems = groups.length;
    totalTokens = groups.reduce((sum, t) => sum + t, 0);
    trainedTokens = totalTokens;
    evalTokens = routerGroups(evalSet, recipe, renderOptions).reduce(
      (sum, t) => sum + t,
      0,
    );
  } else if (paired) {
    // One item per pair: prompt + chosen and prompt + rejected both go through the model.
    const pointwise =
      recipe.kind === "reward" && typeof recipe.rubric === "string"
        ? recipe.rubric
        : undefined;
    const sequenceTokens = (items: ChatMessage[][][]) =>
      items.map((sequences) =>
        sequences.map((messages) =>
          renderMessages("pair", messages, renderOptions),
        ),
      );
    const trainSides = sequenceTokens(preferenceItems(train, pointwise));
    trainItems = trainSides.length;
    for (const sides of trainSides) {
      for (const side of sides) {
        totalTokens += Math.min(side.total_tokens, maxSeqLen);
        trainedTokens += Math.min(side.trained_tokens, maxSeqLen);
        if (side.total_tokens > maxSeqLen) truncated += 1;
      }
    }
    for (const sides of sequenceTokens(preferenceItems(evalSet, pointwise))) {
      for (const side of sides) {
        evalTokens += Math.min(side.total_tokens, maxSeqLen);
      }
    }
  } else {
    for (const record of train) {
      const counts = estimateRecordTokens(record, renderOptions);
      totalTokens += Math.min(counts.total, maxSeqLen);
      trainedTokens += Math.min(counts.trained, maxSeqLen);
      if (counts.total > maxSeqLen) truncated += 1;
    }
    for (const record of evalSet) {
      evalTokens += Math.min(
        estimateRecordTokens(record, renderOptions).total,
        maxSeqLen,
      );
    }
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

  const batchSize =
    recipe.batch_size ?? defaultBatchSize(recipe.kind, trainItems);
  let lr: number;
  let lrSource: string;
  if (recipe.lr === "auto") {
    const baseLr = model.calibrated_lrs[recipe.kind] as number;
    const scale =
      Math.sqrt(batchSize / CALIBRATED_BATCH_SIZE) * recipe.lr_scale;
    lr = Number((baseLr * scale).toPrecision(3));
    lrSource = `${AUTO_RULE_VERSION}: calibrated for ${model.id} at batch ${CALIBRATED_BATCH_SIZE}, sqrt batch scaling`;
  } else {
    lr = recipe.lr * recipe.lr_scale;
    lrSource = "explicit";
  }

  // As the trainer's loop: whole batches per epoch (the last one may be short).
  const stepsPerEpoch = Math.max(1, Math.ceil(trainItems / batchSize));
  const estimatedSteps = stepsPerEpoch * recipe.epochs;
  if (estimatedSteps < 100) {
    warnings.push(
      fewStepsWarning({
        steps: estimatedSteps,
        stepsPerEpoch,
        items: trainItems,
        epochs: recipe.epochs,
        batchSize,
      }),
    );
  }
  if (truncated > 0) {
    warnings.push(
      `${truncated} training records exceed ${maxSeqLen} tokens and will be truncated.`,
    );
  }

  const estimatedTokens = distill
    ? distill.estimatedTokens
    : totalTokens * recipe.epochs;
  const price = model.price_per_million_tokens_usd;
  const labeling = context.labeling ?? null;
  // What the run bills: every token through the model on a training step, at
  // the base's price (on-policy teacher tokens weighted to it). Held-out evals
  // during training aren't billed; labeling and recipe.evals bill as evals.
  const runCostUsd = (estimatedTokens / 1_000_000) * price;
  const teacherUsd = distill?.teacher?.estimated_cost_usd ?? 0;
  const evalUsd = labeling?.estimated_cost_usd ?? 0;
  const estimatedCostUsd = Number((runCostUsd + evalUsd).toFixed(4));
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

  // Every 10% of steps and at least every 20 steps; the trainer also checkpoints
  // every 5 minutes, and uploads in the background.
  const checkpointEvery = Math.max(
    1,
    Math.min(20, Math.floor(estimatedSteps * 0.1)),
  );
  // auto: every 25% of the run, at most every 20 steps (trainer.default_eval_every).
  // An eval costs far more than a checkpoint, so it doesn't follow the checkpoints;
  // the trainer checkpoints at every eval step.
  const evalEvery =
    recipe.eval_every === "auto"
      ? Math.max(
          1,
          Math.min(
            estimatedSteps,
            Math.max(20, Math.ceil(estimatedSteps * 0.25)),
          ),
        )
      : recipe.eval_every;
  if (evalEvery > estimatedSteps) {
    warnings.push(
      `eval_every=${evalEvery} is more than the ${estimatedSteps} estimated steps; the held-out split is evaluated only at the end.`,
    );
  }

  const teacherId =
    distill?.teacher?.model ??
    (recipe.kind === "cartridge" ? recipe.teacher : undefined);
  const teacher = teacherId ? (context.catalog.find(teacherId) ?? null) : null;
  const minGpuMemoryGb = requiredGpuMemoryGb(model, teacher);
  assertFitsOneGpu(recipe.kind, model, teacher, minGpuMemoryGb);
  const evals = Math.ceil(estimatedSteps / evalEvery) + 1;
  const estimatedDurationS = estimateDurationS({
    kind: recipe.kind,
    model,
    trainTokens: estimatedTokens,
    evalTokens,
    evals,
    stepCheckpoints: Math.ceil(estimatedSteps / checkpointEvery),
  });

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
    estimated_duration_s: estimatedDurationS,
    min_gpu_memory_gb: minGpuMemoryGb,
    price_per_million_tokens: price,
    trained_token_fraction:
      totalTokens > 0 ? Number((trainedTokens / totalTokens).toFixed(4)) : 0,
    labeling,
    teacher: distill?.teacher ?? null,
    cost_breakdown: {
      train_usd: Number(Math.max(0, runCostUsd - teacherUsd).toFixed(4)),
      teacher_usd: teacherUsd,
      eval_usd: Number(evalUsd.toFixed(4)),
    },
    warnings,
  };
};
