import { createHash } from "node:crypto";

import { z } from "zod";

import {
  TrainableModelSchema,
  type RecipeKind,
  type TrainableModel,
} from "./contracts.js";
import { issuesOf } from "./errors.js";

/**
 * `chars_per_token`: the base tokenizer's average characters per token on chat
 * text, which plan token estimates divide by (default 4: Qwen3 measures 4.64,
 * so plans err about 16% high; the 512-token dev tokenizer measures 1.5).
 * Internal: it isn't part of the public model listing.
 */
type CatalogEntry = Omit<TrainableModel, "recipes"> & {
  chars_per_token?: number | undefined;
  /** The id a gateway serves it under (see ModelCatalog.servingId). */
  serving_id?: string | undefined;
};

export const DEFAULT_CHARS_PER_TOKEN = 4;

const QWEN_LRS = {
  "qwen/qwen3-0.6b": {
    sft: 8e-4,
    dpo: 3e-5,
    router: 5e-4,
    decision: 5e-4,
    distill: 3e-4,
    reward: 1.5e-4,
  },
  "qwen/qwen3-1.7b": {
    sft: 7e-4,
    dpo: 3e-5,
    router: 5e-4,
    decision: 4e-4,
    distill: 2.5e-4,
    reward: 1.2e-4,
  },
  "qwen/qwen3-4b": {
    sft: 6e-4,
    dpo: 2.5e-5,
    cartridge: 1.2e-2,
    distill: 2e-4,
    reward: 1e-4,
  },
  "qwen/qwen3-8b": {
    sft: 5e-4,
    dpo: 2e-5,
    cartridge: 1e-2,
    distill: 2e-4,
    reward: 1e-4,
  },
  "qwen/qwen3-14b": {
    sft: 4e-4,
    dpo: 1.5e-5,
    cartridge: 1e-2,
    distill: 1.5e-4,
    reward: 8e-5,
  },
  // Eval and judge model only: no recipe trains it on one 80 GB GPU (r6/r7 GPU runs).
  "qwen/qwen3-32b": {},
} as const;

const qwen = (
  id: keyof typeof QWEN_LRS,
  hfRepo: string,
  price: number,
  minGpuMemoryGb: number,
  adapters: TrainableModel["adapters"],
  defaultFor: RecipeKind[],
): CatalogEntry => ({
  id,
  hf_repo: hfRepo,
  family: "llm",
  adapters,
  default_for: defaultFor,
  price_per_million_tokens_usd: price,
  max_context_tokens: 32_768,
  template_revision: "qwen3@3",
  calibrated_lrs: QWEN_LRS[id],
  min_gpu_memory_gb: minGpuMemoryGb,
});

const BUILTIN_MODELS: readonly CatalogEntry[] = [
  // min_gpu_memory_gb: peak reserved memory at the defaults (SFT, the most demanding
  // recipe), measured on an H100 80 GB, plus headroom; see server/trainer/README.md.
  qwen("qwen/qwen3-0.6b", "Qwen/Qwen3-0.6B", 0.15, 8, ["lora"], ["router"]),
  qwen("qwen/qwen3-1.7b", "Qwen/Qwen3-1.7B", 0.22, 12, ["lora"], []),
  qwen(
    "qwen/qwen3-4b",
    "Qwen/Qwen3-4B",
    0.3,
    20,
    ["lora", "prefix_kv"],
    ["distill"],
  ),
  qwen(
    "qwen/qwen3-8b",
    "Qwen/Qwen3-8B",
    0.4,
    36,
    ["lora", "prefix_kv"],
    ["sft", "dpo", "cartridge", "reward"],
  ),
  qwen("qwen/qwen3-14b", "Qwen/Qwen3-14B", 0.7, 56, ["lora", "prefix_kv"], []),
  qwen("qwen/qwen3-32b", "Qwen/Qwen3-32B", 1.2, 96, ["lora", "prefix_kv"], []),
  {
    id: "gradiated/linden-1",
    hf_repo: null,
    family: "llm",
    adapters: ["lora", "frozen_head"],
    default_for: ["decision"],
    price_per_million_tokens_usd: 0.2,
    max_context_tokens: 16_384,
    template_revision: "systemone@1",
    calibrated_lrs: { decision: 3e-4 },
    min_gpu_memory_gb: null,
  },
  {
    id: "baai/bge-small-en-v1.5",
    hf_repo: "BAAI/bge-small-en-v1.5",
    family: "encoder",
    adapters: ["encoder_full"],
    default_for: ["embedding"],
    price_per_million_tokens_usd: 0.08,
    max_context_tokens: 512,
    template_revision: "bge@1",
    calibrated_lrs: { embedding: 2e-5 },
    min_gpu_memory_gb: 4,
  },
];

// Ids are lowercased for lookups and prices; the casing as configured is the
// serving id unless `serving_id` (or `hf_repo`) names one.
const ExtraModelSchema = TrainableModelSchema.omit({ recipes: true }).extend({
  id: z
    .string()
    .min(1)
    .max(160)
    .transform((v) => v.trim()),
  serving_id: z.string().min(1).max(200).optional(),
  hf_repo: z.string().min(1).max(200).nullable().default(null),
  default_for: TrainableModelSchema.shape.default_for.default([]),
  template_revision: z.string().min(1).default("qwen3@3"),
  max_context_tokens: z.number().int().positive().default(32_768),
  min_gpu_memory_gb: z.number().positive().nullable().default(null),
  chars_per_token: z.number().positive().optional(),
});

export interface ModelCatalog {
  list(): readonly TrainableModel[];
  find(modelId: string): TrainableModel | undefined;
  defaultModelFor(kind: RecipeKind): TrainableModel | undefined;
  priceFor(modelId: string): number | undefined;
  /**
   * A judge's price: a catalog model's, or an operator-configured judge's
   * (`GRAD_JUDGE_MODELS_JSON`, e.g. a frontier model behind the gateway).
   * Undefined for a model nobody priced: such judges are refused.
   */
  judgePriceFor(modelId: string): number | undefined;
  /** The ids `judgePriceFor` knows, for error messages. */
  judgeModels(): readonly string[];
  /** The tokenizer's characters per token that plan estimates use (default 4). */
  charsPerToken(modelId: string): number;
  /**
   * The id an exact-match gateway (Gradiated Cloud's) serves a catalog model
   * or configured judge under, in its canonical casing: a judge's id as
   * configured; a model's `serving_id`, else its Hugging Face repo, else its
   * id as configured (`qwen/qwen3-0.6b` → `Qwen/Qwen3-0.6B`). Grad's own ids
   * (lookups, prices, SKUs) stay lowercase. Undefined for unknown models.
   */
  servingId(modelId: string): string | undefined;
  /** Short hash of every model's price: recorded on each usage row. */
  readonly priceVersion: string;
}

const withRecipes = ({
  chars_per_token: _density,
  serving_id: _serving,
  ...entry
}: CatalogEntry): TrainableModel => ({
  ...entry,
  recipes: Object.keys(entry.calibrated_lrs).sort() as RecipeKind[],
});

const JudgeModelSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(160)
      .transform((v) => v.trim()),
    price_per_million_tokens_usd: z.number().positive(),
  })
  .strict();

const parseJsonEnv = <T>(
  name: string,
  value: string | undefined,
  schema: z.ZodType<T>,
): T[] => {
  if (!value?.trim()) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = z.array(schema).safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${name} is invalid: ${issuesOf(parsed.error)}`);
  }

  return parsed.data;
};

/**
 * Builds the trainable-model catalog. `extraModelsJson` (from
 * `GRAD_EXTRA_MODELS_JSON`) adds or overrides entries; tests use it to register
 * tiny models. The catalog is the single price source for billing.
 */
export const createModelCatalog = (
  extraModelsJson?: string,
  judgeModelsJson?: string,
): ModelCatalog => {
  const extras = parseJsonEnv(
    "GRAD_EXTRA_MODELS_JSON",
    extraModelsJson,
    ExtraModelSchema,
  );
  const judgeList = parseJsonEnv(
    "GRAD_JUDGE_MODELS_JSON",
    judgeModelsJson,
    JudgeModelSchema,
  );
  const judges = new Map(
    judgeList.map((j) => [j.id.toLowerCase(), j.price_per_million_tokens_usd]),
  );

  const byId = new Map<string, TrainableModel>();
  const density = new Map<string, number>();
  const serving = new Map<string, string>();
  for (const raw of [...BUILTIN_MODELS, ...extras]) {
    const entry = { ...raw, id: raw.id.toLowerCase() };
    byId.set(entry.id, withRecipes(entry));
    density.set(entry.id, entry.chars_per_token ?? DEFAULT_CHARS_PER_TOKEN);
    serving.set(entry.id, raw.serving_id ?? raw.hf_repo ?? raw.id);
  }
  for (const judge of judgeList) serving.set(judge.id.toLowerCase(), judge.id);

  const models = Array.from(byId.values());
  const priceVersion = `p_${createHash("sha256")
    .update(
      [
        ...models.map((m) => `${m.id}=${m.price_per_million_tokens_usd}`),
        ...[...judges].map(([id, price]) => `judge:${id}=${price}`),
      ]
        .sort()
        .join("\n"),
    )
    .digest("hex")
    .slice(0, 12)}`;

  return {
    list: () => models,
    priceVersion,
    find: (modelId) => byId.get(modelId.trim().toLowerCase()),
    defaultModelFor: (kind) => models.find((m) => m.default_for.includes(kind)),
    priceFor: (modelId) =>
      byId.get(modelId.trim().toLowerCase())?.price_per_million_tokens_usd,
    judgePriceFor: (modelId) => {
      const id = modelId.trim().toLowerCase();

      return judges.get(id) ?? byId.get(id)?.price_per_million_tokens_usd;
    },
    judgeModels: () => [...new Set([...judges.keys(), ...byId.keys()])].sort(),
    charsPerToken: (modelId) =>
      density.get(modelId.trim().toLowerCase()) ?? DEFAULT_CHARS_PER_TOKEN,
    servingId: (modelId) => serving.get(modelId.trim().toLowerCase()),
  };
};

/** The billing SKU a base model trains at. */
export const trainSku = (model: string): string => `train:${model}`;
/** The SKU eval estimates price a gateway model's tokens at (Cloud). */
export const inferenceSku = (model: string): string => `inference:${model}`;
/** USD as integer nano-USD (billing's unit). */
export const nanoUsd = (usd: number): number => Math.round(usd * 1e9);

export const costForTokens = (
  tokens: number,
  pricePerMillion: number,
): number => Number(((tokens / 1_000_000) * pricePerMillion).toFixed(6));
