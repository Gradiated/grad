import type { AdapterSpec, RecipeSpec, SplitSpec } from "./generated/client.js";

export const adapters = {
  lora: (opts?: {
    rank?: number;
    alpha?: number;
    mergeOnExport?: boolean;
  }): AdapterSpec => ({
    kind: "lora",
    rank: opts?.rank ?? 32,
    alpha: opts?.alpha ?? 32,
    merge_on_export: opts?.mergeOnExport ?? false,
  }),
  prefixKv: (numTokens = 256): AdapterSpec => ({
    kind: "prefix_kv",
    num_tokens: numTokens,
  }),
  frozenHead: (): AdapterSpec => ({
    kind: "frozen_head",
  }),
};

export const splits = {
  bySession: (evalFraction?: number, seed = 42): SplitSpec => ({
    strategy: "by_session",
    ...(evalFraction !== undefined ? { eval_fraction: evalFraction } : {}),
    seed,
  }),
  byGroup: (evalFraction?: number, seed = 42): SplitSpec => ({
    strategy: "by_group",
    ...(evalFraction !== undefined ? { eval_fraction: evalFraction } : {}),
    seed,
  }),
  random: (evalFraction?: number, seed = 42): SplitSpec => ({
    strategy: "random",
    ...(evalFraction !== undefined ? { eval_fraction: evalFraction } : {}),
    seed,
  }),
};

export const recipes = {
  sft: (opts: Partial<RecipeSpec> = {}): RecipeSpec => ({
    kind: "sft",
    ...opts,
  }),
  dpo: (opts: Partial<RecipeSpec> = {}): RecipeSpec => ({
    kind: "dpo",
    beta: opts.beta ?? 0.1,
    ...opts,
  }),
  router: (
    opts: Partial<RecipeSpec> & {
      models?: string[];
      max_quality_drop?: number;
    } = {},
  ): RecipeSpec => ({
    kind: "router",
    models: opts.models ?? ["qwen/qwen3-8b", "qwen/qwen3-32b"],
    max_quality_drop: opts.max_quality_drop ?? 0.02,
    ...opts,
  }),
  decision: (opts: Partial<RecipeSpec> = {}): RecipeSpec => ({
    kind: "decision",
    ...opts,
  }),
  cartridge: (opts: Partial<RecipeSpec> = {}): RecipeSpec => ({
    kind: "cartridge",
    num_tokens: opts.num_tokens ?? 256,
    ...opts,
  }),
  embedding: (opts: Partial<RecipeSpec> = {}): RecipeSpec => ({
    kind: "embedding",
    temp: opts.temp ?? 0.05,
    ...opts,
  }),
  // Wave 2 forward-compatible helpers
  distill: (opts: Partial<RecipeSpec> = {}): RecipeSpec => ({
    kind: "distill",
    teacher: opts.teacher ?? "qwen/qwen3-32b",
    ...opts,
  }),
  reward: (opts: Partial<RecipeSpec> = {}): RecipeSpec => ({
    kind: "reward",
    ...opts,
  }),
  grpo: (opts: Partial<RecipeSpec> = {}): RecipeSpec => ({
    kind: "grpo",
    group_size: opts.group_size ?? 8,
    ...opts,
  }),
};
