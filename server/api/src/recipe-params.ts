import type {
  LossSpec,
  OptimizerSpec,
  RecipeKind,
  RecipeSpec,
} from "./contracts.js";
import { invalid } from "./errors.js";

/** Recipe-specific RecipeSpec fields and the recipes that use them. */
const RECIPE_FIELDS = {
  beta: ["dpo"],
  models: ["router"],
  max_quality_drop: ["router"],
  rubric: ["router"],
  pricing: ["router"],
  fallback: ["router"],
  context_text: ["cartridge"],
  context_uri: ["cartridge"],
  num_tokens: ["cartridge"],
  max_new_tokens: ["cartridge"],
  slot_token: ["cartridge"],
  teacher: ["cartridge", "distill"],
  temp: ["embedding"],
  pool: ["embedding"],
  env_name: ["grpo"],
  group_size: ["grpo"],
} as const satisfies Partial<Record<keyof RecipeSpec, readonly RecipeKind[]>>;

const LOSS_RECIPES: Record<LossSpec["kind"], readonly RecipeKind[]> = {
  cross_entropy: ["sft"],
  dpo: ["dpo"],
  infonce: ["embedding"],
  top_k_kl_distill: ["cartridge", "distill"],
};

const DEFAULT_OPTIMIZER: OptimizerSpec = {
  kind: "adamw",
  betas: [0.9, 0.95],
  weight_decay: 0,
  grad_clip: 1.0,
};

export interface ResolvedRecipeParams {
  /** Recipe-specific values forwarded to the trainer as `recipe_params`. */
  params: Record<string, unknown>;
  optimizer: OptimizerSpec;
  reduction: "per_example" | "per_token";
}

const conflict = (field: string, lossField: string): never => {
  throw invalid(
    "recipe_param_conflict",
    `recipe.${field} conflicts with recipe.loss.${lossField}; set one of them.`,
  );
};

const pick = <T>(
  shorthand: T | undefined,
  fromLoss: T | undefined,
  names: [string, string],
): T | undefined => {
  if (
    shorthand !== undefined &&
    fromLoss !== undefined &&
    shorthand !== fromLoss
  ) {
    conflict(...names);
  }

  return fromLoss ?? shorthand;
};

const assertFieldsApply = (recipe: RecipeSpec): void => {
  for (const [field, kinds] of Object.entries(RECIPE_FIELDS)) {
    if (recipe[field as keyof RecipeSpec] === undefined) continue;
    if (!(kinds as readonly string[]).includes(recipe.kind)) {
      throw invalid(
        "recipe_param_unsupported",
        `recipe.${field} does not apply to recipe '${recipe.kind}' (it is a parameter of: ${kinds.join(", ")}).`,
      );
    }
  }

  if (recipe.loss && !LOSS_RECIPES[recipe.loss.kind].includes(recipe.kind)) {
    const own = Object.entries(LOSS_RECIPES)
      .filter(([, kinds]) => kinds.includes(recipe.kind))
      .map(([kind]) => kind);
    throw invalid(
      "loss_unsupported",
      own.length > 0
        ? `Recipe '${recipe.kind}' trains with loss kind ${own.join(" or ")}, not '${recipe.loss.kind}'.`
        : `Recipe '${recipe.kind}' chooses its loss itself (per question type for decision models); remove recipe.loss.`,
    );
  }

  if (recipe.context_uri !== undefined) {
    throw invalid(
      "context_uri_unsupported",
      "This server does not fetch cartridge contexts from URIs; pass the document as recipe.context_text (Context.from_file reads a local file).",
    );
  }
};

const ROUTER_KEYS = ["rubric", "pricing", "fallback", "max_quality_drop"];
const CARTRIDGE_KEYS = [
  "context_text",
  "num_tokens",
  "teacher",
  "max_new_tokens",
  "slot_token",
];
const WAVE2_KEYS = ["teacher", "env_name", "group_size"];

/**
 * Validates the recipe-specific parameters of a RecipeSpec and maps them to the
 * trainer's `recipe_params`. A parameter a recipe cannot honour is a 422, never
 * a silent drop.
 */
export const resolveRecipeParams = (
  recipe: RecipeSpec,
): ResolvedRecipeParams => {
  assertFieldsApply(recipe);

  const params: Record<string, unknown> = {};
  const copy = (keys: readonly string[]) => {
    for (const key of keys) {
      const value = recipe[key as keyof RecipeSpec];
      if (value !== undefined) params[key] = value;
    }
  };

  const loss = recipe.loss;
  const reduction =
    pick(
      recipe.reduction,
      loss?.kind === "cross_entropy" ? loss.reduction : undefined,
      ["reduction", "reduction"],
    ) ?? "per_example";

  switch (recipe.kind) {
    case "dpo": {
      const beta = pick(
        recipe.beta,
        loss?.kind === "dpo" ? loss.beta : undefined,
        ["beta", "beta"],
      );
      params.loss = { kind: "dpo", beta: beta ?? 0.1 };
      break;
    }
    case "embedding": {
      const temp = pick(
        recipe.temp,
        loss?.kind === "infonce" ? loss.temp : undefined,
        ["temp", "temp"],
      );
      params.loss = { kind: "infonce", temp: temp ?? 0.05 };
      params.pool = recipe.pool?.kind ?? "mean";
      break;
    }
    case "cartridge":
      copy(CARTRIDGE_KEYS);
      params.loss = {
        kind: "top_k_kl_distill",
        top_k: loss?.kind === "top_k_kl_distill" ? (loss.top_k ?? 20) : 20,
      };
      break;
    case "router":
      copy(ROUTER_KEYS);
      break;
    default:
      copy(WAVE2_KEYS);
      if (loss && recipe.kind !== "sft") params.loss = loss;
  }

  return {
    params,
    optimizer: { ...DEFAULT_OPTIMIZER, ...recipe.optimizer },
    reduction,
  };
};
