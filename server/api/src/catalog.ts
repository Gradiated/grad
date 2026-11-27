import { z } from "zod";

import {
  TrainableModelSchema,
  type RecipeKind,
  type TrainableModel,
} from "./contracts.js";

type CatalogEntry = Omit<TrainableModel, "recipes">;

const QWEN_LRS = {
  "qwen/qwen3-0.6b": { sft: 8e-4, dpo: 3e-5, router: 5e-4, decision: 5e-4 },
  "qwen/qwen3-1.7b": { sft: 7e-4, dpo: 3e-5, router: 5e-4, decision: 4e-4 },
  "qwen/qwen3-4b": { sft: 6e-4, dpo: 2.5e-5, cartridge: 1.2e-2 },
  "qwen/qwen3-8b": { sft: 5e-4, dpo: 2e-5, cartridge: 1e-2 },
  "qwen/qwen3-14b": { sft: 4e-4, dpo: 1.5e-5, cartridge: 1e-2 },
  "qwen/qwen3-32b": { sft: 3e-4, dpo: 1e-5, cartridge: 1e-2 },
} as const;

const qwen = (
  id: keyof typeof QWEN_LRS,
  hfRepo: string,
  price: number,
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
});

export const BUILTIN_MODELS: readonly CatalogEntry[] = [
  qwen("qwen/qwen3-0.6b", "Qwen/Qwen3-0.6B", 0.15, ["lora"], ["router"]),
  qwen("qwen/qwen3-1.7b", "Qwen/Qwen3-1.7B", 0.22, ["lora"], []),
  qwen("qwen/qwen3-4b", "Qwen/Qwen3-4B", 0.3, ["lora", "prefix_kv"], []),
  qwen(
    "qwen/qwen3-8b",
    "Qwen/Qwen3-8B",
    0.4,
    ["lora", "prefix_kv"],
    ["sft", "dpo", "cartridge"],
  ),
  qwen("qwen/qwen3-14b", "Qwen/Qwen3-14B", 0.7, ["lora", "prefix_kv"], []),
  qwen("qwen/qwen3-32b", "Qwen/Qwen3-32B", 1.2, ["lora", "prefix_kv"], []),
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
  },
];

const ExtraModelSchema = TrainableModelSchema.omit({ recipes: true }).extend({
  id: z
    .string()
    .min(1)
    .max(160)
    .transform((v) => v.trim().toLowerCase()),
  hf_repo: z.string().min(1).max(200).nullable().default(null),
  default_for: TrainableModelSchema.shape.default_for.default([]),
  template_revision: z.string().min(1).default("qwen3@3"),
  max_context_tokens: z.number().int().positive().default(32_768),
});

export interface ModelCatalog {
  list(): readonly TrainableModel[];
  find(modelId: string): TrainableModel | undefined;
  defaultModelFor(kind: RecipeKind): TrainableModel | undefined;
  priceFor(modelId: string): number | undefined;
}

const withRecipes = (entry: CatalogEntry): TrainableModel => ({
  ...entry,
  recipes: Object.keys(entry.calibrated_lrs).sort() as RecipeKind[],
});

/**
 * Builds the trainable-model catalog. `extraModelsJson` (from
 * `GRAD_EXTRA_MODELS_JSON`) adds or overrides entries; tests use it to register
 * tiny models. The catalog is the single price source for billing.
 */
export const createModelCatalog = (extraModelsJson?: string): ModelCatalog => {
  const extras = extraModelsJson?.trim()
    ? (() => {
        let raw: unknown;
        try {
          raw = JSON.parse(extraModelsJson);
        } catch (error) {
          throw new Error(
            `GRAD_EXTRA_MODELS_JSON is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const parsed = z.array(ExtraModelSchema).safeParse(raw);
        if (!parsed.success) {
          throw new Error(
            `GRAD_EXTRA_MODELS_JSON is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
          );
        }
        return parsed.data;
      })()
    : [];

  const byId = new Map<string, TrainableModel>();
  for (const entry of [...BUILTIN_MODELS, ...extras]) {
    byId.set(entry.id, withRecipes(entry));
  }

  const models = Array.from(byId.values());

  return {
    list: () => models,
    find: (modelId) => byId.get(modelId.trim().toLowerCase()),
    defaultModelFor: (kind) => models.find((m) => m.default_for.includes(kind)),
    priceFor: (modelId) =>
      byId.get(modelId.trim().toLowerCase())?.price_per_million_tokens_usd,
  };
};

export const costForTokens = (
  tokens: number,
  pricePerMillion: number,
): number => Number(((tokens / 1_000_000) * pricePerMillion).toFixed(6));
