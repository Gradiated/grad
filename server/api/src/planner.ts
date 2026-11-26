import { createHash } from "node:crypto";

import {
  V0_RECIPE_KINDS,
  type AdapterSpec,
  type ChatMessage,
  type DatasetRecord,
  type PlanRunRequest,
  type PlanRunResponse,
  type RecipeKind,
  type ResolvedRunConfig,
  type TrainableModel,
} from "./contracts.js";

export const AUTO_RULE_VERSION = "auto@1";

export const TRAINABLE_MODELS: readonly TrainableModel[] = [
  {
    id: "qwen/qwen3-0.6b",
    adapters: ["lora"],
    default_for: ["router"],
    price_per_million_tokens_usd: 0.15,
    max_context_tokens: 32_768,
    template_revision: "qwen3@3",
    calibrated_lrs: {
      sft: 8e-4,
      dpo: 3e-5,
      router: 5e-4,
      decision: 5e-4,
      grpo: 8e-5,
      distill: 3e-4,
      reward: 2e-4,
    },
  },
  {
    id: "qwen/qwen3-1.7b",
    adapters: ["lora"],
    default_for: [],
    price_per_million_tokens_usd: 0.22,
    max_context_tokens: 32_768,
    template_revision: "qwen3@3",
    calibrated_lrs: {
      sft: 7e-4,
      dpo: 3e-5,
      router: 5e-4,
      decision: 4e-4,
      grpo: 7e-5,
      distill: 2.5e-4,
      reward: 1.5e-4,
    },
  },
  {
    id: "qwen/qwen3-4b",
    adapters: ["lora", "prefix_kv"],
    default_for: [],
    price_per_million_tokens_usd: 0.3,
    max_context_tokens: 32_768,
    template_revision: "qwen3@3",
    calibrated_lrs: {
      sft: 6e-4,
      dpo: 2.5e-5,
      cartridge: 1.2e-2,
      grpo: 6e-5,
      distill: 2.2e-4,
      reward: 1.2e-4,
    },
  },
  {
    id: "qwen/qwen3-8b",
    adapters: ["lora", "prefix_kv"],
    default_for: ["sft", "dpo", "cartridge", "distill", "reward", "grpo"],
    price_per_million_tokens_usd: 0.4,
    max_context_tokens: 32_768,
    template_revision: "qwen3@3",
    calibrated_lrs: {
      sft: 5e-4,
      dpo: 2e-5,
      cartridge: 1e-2,
      grpo: 5e-5,
      distill: 2e-4,
      reward: 1e-4,
    },
  },
  {
    id: "qwen/qwen3-14b",
    adapters: ["lora", "prefix_kv"],
    default_for: [],
    price_per_million_tokens_usd: 0.7,
    max_context_tokens: 32_768,
    template_revision: "qwen3@3",
    calibrated_lrs: {
      sft: 4e-4,
      dpo: 1.5e-5,
      cartridge: 1e-2,
      grpo: 4e-5,
      distill: 1.8e-4,
      reward: 8e-5,
    },
  },
  {
    id: "qwen/qwen3-32b",
    adapters: ["lora", "prefix_kv"],
    default_for: [],
    price_per_million_tokens_usd: 1.2,
    max_context_tokens: 32_768,
    template_revision: "qwen3@3",
    calibrated_lrs: {
      sft: 3e-4,
      dpo: 1e-5,
      cartridge: 1e-2,
      grpo: 3e-5,
      distill: 1.5e-4,
      reward: 6e-5,
    },
  },
  {
    id: "gradiated/linden-1",
    adapters: ["lora", "frozen_head"],
    default_for: ["decision"],
    price_per_million_tokens_usd: 0.2,
    max_context_tokens: 16_384,
    template_revision: "systemone@1",
    calibrated_lrs: {
      decision: 3e-4,
    },
  },
  {
    id: "baai/bge-small-en-v1.5",
    adapters: ["encoder_full"],
    default_for: ["embedding"],
    price_per_million_tokens_usd: 0.08,
    max_context_tokens: 512,
    template_revision: "bge@1",
    calibrated_lrs: {
      embedding: 2e-5,
    },
  },
];

const MODEL_BY_ID = new Map(TRAINABLE_MODELS.map((m) => [m.id, m]));

export const findTrainableModel = (
  modelId: string,
): TrainableModel | undefined => MODEL_BY_ID.get(modelId.trim().toLowerCase());

export const defaultModelForRecipe = (kind: RecipeKind): string => {
  switch (kind) {
    case "router":
      return "qwen/qwen3-0.6b";
    case "decision":
      return "gradiated/linden-1";
    case "embedding":
      return "baai/bge-small-en-v1.5";
    default:
      return "qwen/qwen3-8b";
  }
};

export const estimateTextTokens = (text: string): number => {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  return Math.max(1, Math.ceil(trimmed.length / 4));
};

const hashFraction = (key: string, seed: number): number => {
  const digest = createHash("sha256").update(`${seed}:${key}`).digest();
  const value = digest.readUInt32BE(0);

  return value / 0x1_0000_0000;
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

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;

    let key: string;
    if (options.strategy === "by_session") {
      key = record.session_id ?? record.id ?? `row:${index}`;
    } else if (options.strategy === "by_group") {
      key = record.group_id ?? record.session_id ?? record.id ?? `row:${index}`;
    } else {
      key = record.id ?? `row:${index}`;
    }

    if (hashFraction(key, options.seed) < options.eval_fraction) {
      evalSet.push(record);
    } else {
      train.push(record);
    }
  }

  if (train.length === 0 && evalSet.length > 0) {
    const moved = evalSet.shift();
    if (moved) train.push(moved);
  }

  return { train, eval: evalSet };
};

export interface RenderOptions {
  model: string;
  train_on: "last" | "all_assistant";
  thinking: "auto" | "on" | "off";
  preserve_thinking: boolean;
}

const stripThinking = (text: string): string =>
  text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");

const hasThinkingBlock = (text: string): boolean =>
  /<think>[\s\S]*?<\/think>/.test(text);

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
  const model = findTrainableModel(options.model);
  const templateRevision = model?.template_revision ?? "qwen3@3";

  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  const spans: Array<{ text: string; trained: boolean; tokens: number }> = [];
  let totalTokens = 0;
  let trainedTokens = 0;

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message) continue;

    const rawContent = message.content ?? "";
    const isAssistant = message.role === "assistant";
    const isLastAssistant = i === lastAssistantIndex;

    let trained = false;
    if (message.train !== undefined) {
      trained = message.train;
    } else if (isAssistant) {
      trained = options.train_on === "all_assistant" || isLastAssistant;
    }

    if (trained && isAssistant) {
      const hasThink = hasThinkingBlock(rawContent);
      if (options.thinking === "off" && hasThink) {
        throw new Error(
          `Record '${recordId}' contains a <think> block but thinking='off'.`,
        );
      }

      if (options.thinking === "on" && !hasThink) {
        throw new Error(
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
  }

  return {
    record_id: recordId,
    template_revision: templateRevision,
    total_tokens: totalTokens,
    trained_tokens: trainedTokens,
    trained_fraction: totalTokens > 0 ? trainedTokens / totalTokens : 0,
    spans,
  };
};

const estimateRecordTokens = (
  record: DatasetRecord,
  options: RenderOptions,
): { total: number; trained: number } => {
  if (record.messages && record.messages.length > 0) {
    const rendered = renderMessages(
      record.id ?? "record",
      record.messages,
      options,
    );

    return { total: rendered.total_tokens, trained: rendered.trained_tokens };
  }

  const parts: string[] = [];
  if (typeof record.prompt === "string") parts.push(record.prompt);
  if (typeof record.chosen === "string") parts.push(record.chosen);
  if (typeof record.rejected === "string") parts.push(record.rejected);
  if (record.query) parts.push(record.query);
  if (record.positive) parts.push(record.positive);
  if (record.negatives) parts.push(...record.negatives);
  if (record.state !== undefined) parts.push(JSON.stringify(record.state));
  if (record.questions !== undefined)
    parts.push(JSON.stringify(record.questions));
  if (record.expected_output !== undefined)
    parts.push(JSON.stringify(record.expected_output));

  const total = Math.max(16, estimateTextTokens(parts.join("\n")));
  const trained = Math.max(8, Math.round(total * 0.4));

  return { total, trained };
};

export const isV0Recipe = (kind: RecipeKind): boolean =>
  (V0_RECIPE_KINDS as readonly string[]).includes(kind);

export const planRun = (
  request: PlanRunRequest,
  records: readonly DatasetRecord[],
  options: { allowWave2?: boolean } = {},
): PlanRunResponse => {
  const { recipe } = request;
  const warnings: string[] = [];

  if (!isV0Recipe(recipe.kind) && !options.allowWave2) {
    throw new Error(
      `Recipe '${recipe.kind}' is deferred past v0 on this server; supported v0 recipes are ${V0_RECIPE_KINDS.join(", ")}.`,
    );
  }

  const modelId = recipe.model ?? defaultModelForRecipe(recipe.kind);
  const model = findTrainableModel(modelId);
  if (!model && recipe.lr === "auto") {
    throw new Error(
      `Model '${modelId}' has no calibrated lr='auto' entry. Pass an explicit numeric lr.`,
    );
  }

  let resolvedAdapter: ResolvedRunConfig["adapter"];
  if (recipe.kind === "embedding") {
    resolvedAdapter = { kind: "encoder_full" };
  } else if (recipe.kind === "cartridge") {
    const adapter: AdapterSpec =
      recipe.adapter?.kind === "prefix_kv"
        ? recipe.adapter
        : { kind: "prefix_kv", num_tokens: recipe.num_tokens ?? 256 };
    resolvedAdapter = adapter;
  } else {
    resolvedAdapter = recipe.adapter ?? {
      kind: "lora",
      rank: 32,
      alpha: 32,
      merge_on_export: false,
    };
  }

  const defaultBatch = recipe.kind === "grpo" ? 32 : 128;
  const batchSize = recipe.batch_size ?? defaultBatch;
  const evalFraction =
    request.split?.eval_fraction ??
    (recipe.kind === "router" || recipe.kind === "decision" ? 0.15 : 0.1);
  const splitStrategy = request.split?.strategy ?? "by_session";
  const splitSeed = request.split?.seed ?? 42;

  const { train, eval: evalSet } = splitRecords(records, {
    strategy: splitStrategy,
    eval_fraction: evalFraction,
    seed: splitSeed,
  });

  let lr: number;
  let lrSource: string;
  if (recipe.lr === "auto") {
    const baseLr = model?.calibrated_lrs[recipe.kind];
    if (!baseLr) {
      throw new Error(
        `No calibrated lr='auto' entry for model '${modelId}' with recipe '${recipe.kind}'. Pass an explicit lr.`,
      );
    }

    const scale = Math.sqrt(batchSize / defaultBatch) * recipe.lr_scale;
    lr = Number((baseLr * scale).toPrecision(3));
    lrSource = `${AUTO_RULE_VERSION} -> calibrated for ${modelId} at batch ${defaultBatch}`;
  } else {
    lr = recipe.lr * recipe.lr_scale;
    lrSource = "explicit";
  }

  const renderOptions: RenderOptions = {
    model: modelId,
    train_on: recipe.train_on,
    thinking: recipe.thinking,
    preserve_thinking: recipe.preserve_thinking,
  };

  let totalRecordTokens = 0;
  let trainedRecordTokens = 0;
  let zeroTrainedCount = 0;
  let truncatedCount = 0;
  const maxContext = model?.max_context_tokens ?? 32_768;

  for (const record of train) {
    const counts = estimateRecordTokens(record, renderOptions);
    totalRecordTokens += counts.total;
    trainedRecordTokens += counts.trained;
    if (counts.trained === 0) zeroTrainedCount += 1;
    if (counts.total > maxContext) truncatedCount += 1;
  }

  const estimatedSteps =
    train.length > 0
      ? Math.max(1, Math.ceil((train.length * recipe.epochs) / batchSize))
      : 0;

  if (estimatedSteps > 0 && estimatedSteps < 100) {
    const suggestedBatch = Math.max(
      1,
      Math.floor((train.length * recipe.epochs) / 100),
    );
    warnings.push(
      `${estimatedSteps} steps is below the 100 we recommend; use batch_size=${suggestedBatch} or more epochs/data.`,
    );
  }

  if (zeroTrainedCount > 0) {
    warnings.push(
      `${zeroTrainedCount} training records have zero trained tokens and will be skipped.`,
    );
  }

  if (truncatedCount > 0) {
    warnings.push(
      `${truncatedCount} training records exceed ${maxContext} tokens and will be truncated.`,
    );
  }

  const estimatedTokens = totalRecordTokens * recipe.epochs;
  const pricePerMillion = model?.price_per_million_tokens_usd ?? 0.4;
  const estimatedCostUsd = Number(
    ((estimatedTokens / 1_000_000) * pricePerMillion).toFixed(4),
  );

  if (
    request.max_cost_usd !== undefined &&
    estimatedCostUsd > request.max_cost_usd
  ) {
    warnings.push(
      `Estimated cost ($${estimatedCostUsd.toFixed(2)}) exceeds max_cost_usd ($${request.max_cost_usd.toFixed(2)}); the run will stop early and save a checkpoint.`,
    );
  }

  const checkpointEverySteps = Math.max(
    1,
    Math.min(20, Math.max(1, Math.floor(estimatedSteps * 0.1))),
  );

  const recipeParams: Record<string, unknown> = {};
  if (recipe.beta !== undefined) recipeParams.beta = recipe.beta;
  if (recipe.models !== undefined) recipeParams.models = recipe.models;
  if (recipe.max_quality_drop !== undefined)
    recipeParams.max_quality_drop = recipe.max_quality_drop;
  if (recipe.context_text !== undefined)
    recipeParams.context_text = recipe.context_text;
  if (recipe.context_uri !== undefined)
    recipeParams.context_uri = recipe.context_uri;
  if (recipe.num_tokens !== undefined)
    recipeParams.num_tokens = recipe.num_tokens;
  if (recipe.temp !== undefined) recipeParams.temp = recipe.temp;
  if (recipe.teacher !== undefined) recipeParams.teacher = recipe.teacher;
  if (recipe.env_name !== undefined) recipeParams.env_name = recipe.env_name;
  if (recipe.group_size !== undefined)
    recipeParams.group_size = recipe.group_size;

  const resolvedConfig: ResolvedRunConfig = {
    rule_version: AUTO_RULE_VERSION,
    dataset: request.dataset,
    name: request.name,
    recipe_kind: recipe.kind,
    model: modelId,
    template_revision: model?.template_revision ?? "qwen3@3",
    adapter: resolvedAdapter,
    lr,
    lr_source: lrSource,
    batch_size: batchSize,
    epochs: recipe.epochs,
    schedule: recipe.schedule,
    warmup: recipe.warmup,
    train_on: recipe.train_on,
    thinking: recipe.thinking,
    preserve_thinking: recipe.preserve_thinking,
    reduction: recipe.reduction,
    select: recipe.select,
    checkpoint_every_steps: checkpointEverySteps,
    checkpoint_ttl_days: recipe.checkpoint_ttl_days,
    split: {
      strategy: splitStrategy,
      eval_fraction: evalFraction,
      seed: splitSeed,
      train_records: train.length,
      eval_records: evalSet.length,
    },
    recipe_params: recipeParams,
  };

  return {
    resolved_config: resolvedConfig,
    estimated_steps: estimatedSteps,
    estimated_tokens: estimatedTokens,
    estimated_cost_usd: estimatedCostUsd,
    trained_token_fraction:
      totalRecordTokens > 0
        ? Number((trainedRecordTokens / totalRecordTokens).toFixed(4))
        : 0,
    warnings,
  };
};
