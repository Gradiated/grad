import type { AdapterSpec, RecipeKind, RecipeSpec, SplitSpec } from "./generated/models.js";
import { isNodeRuntime } from "./core.js";
import { GradUsageError } from "./errors.js";

/** Anything with a name and version (an Artifact) can be a starting model. */
export type ModelRef = string | { name: string; version: string };

const modelId = (model: ModelRef): string => (typeof model === "string" ? model : `${model.name}@${model.version}`);

export const adapters = {
  /** LoRA adapter (`rank` default 32; `alpha` is fixed at 32 by the server's lr table). */
  lora: (options: { rank?: number; alpha?: number; mergeOnExport?: boolean } = {}): AdapterSpec => ({
    kind: "lora",
    ...(options.rank !== undefined ? { rank: options.rank } : {}),
    ...(options.alpha !== undefined ? { alpha: options.alpha } : {}),
    ...(options.mergeOnExport !== undefined ? { mergeOnExport: options.mergeOnExport } : {}),
  }),
  /** Trainable prefix KV tokens (cartridges); default 256 tokens. */
  prefixKv: (options: { numTokens?: number } = {}): AdapterSpec => ({
    kind: "prefix_kv",
    ...(options.numTokens !== undefined ? { numTokens: options.numTokens } : {}),
  }),
  /** Frozen backbone with a trained head (routers, decision models). */
  frozenHead: (): AdapterSpec => ({ kind: "frozen_head" }),
};

const split =
  (strategy: NonNullable<SplitSpec["strategy"]>) =>
  (options: { evalFraction?: number; seed?: number } = {}): SplitSpec => ({
    strategy,
    ...(options.evalFraction !== undefined ? { evalFraction: options.evalFraction } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  });

/** Train/eval splits. Default: by session, 10% held out (15% for routers and decision models). */
export const splits = {
  bySession: split("by_session"),
  byGroup: split("by_group"),
  random: split("random"),
};

/** Loss settings that map to recipe fields the server understands. */
export const losses = {
  dpo: (options: { beta?: number } = {}) => ({ loss: "dpo" as const, ...options }),
  infoNCE: (options: { temp?: number } = {}) => ({ loss: "info_nce" as const, ...options }),
};

/** Text baked into a cartridge or distillation run. */
export class Context {
  private constructor(
    private readonly source: { text: string } | { uri: string } | { file: string },
  ) {}

  static fromText(text: string): Context {
    return new Context({ text });
  }

  /** Read from disk when the run is submitted (Node only). */
  static fromFile(path: string): Context {
    return new Context({ file: path });
  }

  /** A `s3://`, `gs://` or `https://` URI the trainer fetches. */
  static fromUri(uri: string): Context {
    return new Context({ uri });
  }

  /** The RecipeSpec fields for this context. */
  async toSpec(): Promise<Pick<RecipeSpec, "contextText" | "contextUri">> {
    if ("text" in this.source) return { contextText: this.source.text };
    if ("uri" in this.source) return { contextUri: this.source.uri };
    if (!isNodeRuntime()) throw new GradUsageError("Context.fromFile needs Node.js; use Context.fromText in a browser.", "node_only");
    const { readTextFile } = await import("./node/files.js");
    return { contextText: await readTextFile(this.source.file) };
  }
}

/** Options every recipe accepts (each language's casing of the documented names). */
export interface CommonRecipeOptions {
  model?: ModelRef;
  adapter?: AdapterSpec;
  lr?: number | "auto";
  lrScale?: number;
  batchSize?: number;
  epochs?: number;
  schedule?: "linear" | "cosine" | "constant";
  warmup?: number;
  trainOn?: "last" | "all_assistant";
  thinking?: "auto" | "on" | "off";
  preserveThinking?: boolean;
  reduction?: "per_example" | "per_token";
  select?: "best" | "last";
  checkpointTtlDays?: number;
}

/** A recipe ready to submit; build one with `recipes.*`. */
export class Recipe {
  constructor(
    readonly kind: RecipeKind,
    private readonly fields: Partial<RecipeSpec>,
    private readonly context?: Context,
  ) {}

  /** The wire RecipeSpec (only the fields you set; the server applies documented defaults). */
  async toSpec(): Promise<RecipeSpec> {
    const extra = this.context ? await this.context.toSpec() : {};
    return { kind: this.kind, ...this.fields, ...extra };
  }
}

const common = (options: CommonRecipeOptions): Partial<RecipeSpec> => {
  const out: Partial<RecipeSpec> = {};
  if (options.model !== undefined) out.model = modelId(options.model);
  if (options.adapter !== undefined) out.adapter = options.adapter;
  if (options.lr !== undefined) out.lr = options.lr;
  if (options.lrScale !== undefined) out.lrScale = options.lrScale;
  if (options.batchSize !== undefined) out.batchSize = options.batchSize;
  if (options.epochs !== undefined) out.epochs = options.epochs;
  if (options.schedule !== undefined) out.schedule = options.schedule;
  if (options.warmup !== undefined) out.warmup = options.warmup;
  if (options.trainOn !== undefined) out.trainOn = options.trainOn;
  if (options.thinking !== undefined) out.thinking = options.thinking;
  if (options.preserveThinking !== undefined) out.preserveThinking = options.preserveThinking;
  if (options.reduction !== undefined) out.reduction = options.reduction;
  if (options.select !== undefined) out.select = options.select;
  if (options.checkpointTtlDays !== undefined) out.checkpointTtlDays = options.checkpointTtlDays;
  return out;
};

const rejectUnknown = (recipe: string, options: object, allowed: readonly string[]): void => {
  const known = new Set([
    "model", "adapter", "lr", "lrScale", "batchSize", "epochs", "schedule", "warmup", "trainOn", "thinking",
    "preserveThinking", "reduction", "select", "checkpointTtlDays", ...allowed,
  ]);
  const unknown = Object.keys(options).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw new GradUsageError(
      `recipes.${recipe}() does not support ${unknown.map((k) => `'${k}'`).join(", ")} on this server version; it would be ignored, so it is rejected.`,
      "unsupported_recipe_option",
    );
  }
};

export const recipes = {
  /** Supervised fine-tuning on chat records. */
  sft: (options: CommonRecipeOptions & { mergeOnExport?: boolean } = {}): Recipe => {
    rejectUnknown("sft", options, ["mergeOnExport"]);
    const fields = common(options);
    if (options.mergeOnExport !== undefined) {
      const adapter = fields.adapter ?? { kind: "lora" };
      if (adapter.kind !== "lora") throw new GradUsageError("mergeOnExport needs a LoRA adapter.", "unsupported_recipe_option");
      fields.adapter = { ...adapter, mergeOnExport: options.mergeOnExport };
    }
    return new Recipe("sft", fields);
  },
  /** Direct preference optimization on chosen/rejected pairs. */
  dpo: (options: CommonRecipeOptions & { beta?: number; loss?: ReturnType<typeof losses.dpo> } = {}): Recipe => {
    rejectUnknown("dpo", options, ["beta", "loss"]);
    const beta = options.beta ?? options.loss?.beta;
    return new Recipe("dpo", { ...common(options), ...(beta !== undefined ? { beta } : {}) });
  },
  /** Learned router across candidate models (default backbone qwen/qwen3-0.6b). */
  router: (options: CommonRecipeOptions & { models?: string[]; maxQualityDrop?: number } = {}): Recipe => {
    rejectUnknown("router", options, ["models", "maxQualityDrop"]);
    return new Recipe("router", {
      ...common(options),
      ...(options.models !== undefined ? { models: options.models } : {}),
      ...(options.maxQualityDrop !== undefined ? { maxQualityDrop: options.maxQualityDrop } : {}),
    });
  },
  /** Decision model (default backbone gradiated/linden-1). */
  decisionModel: (options: CommonRecipeOptions = {}): Recipe => {
    rejectUnknown("decisionModel", options, []);
    return new Recipe("decision", common(options));
  },
  /** Context cartridge: compress a document into trainable prefix KV tokens. */
  cartridge: (options: CommonRecipeOptions & { context: Context; numTokens?: number; teacher?: ModelRef }): Recipe => {
    rejectUnknown("cartridge", options, ["context", "numTokens", "teacher"]);
    if (!(options.context instanceof Context)) {
      throw new GradUsageError("recipes.cartridge() needs context: Context.fromText/fromFile/fromUri(...).", "invalid_recipe");
    }
    return new Recipe(
      "cartridge",
      {
        ...common(options),
        ...(options.numTokens !== undefined ? { numTokens: options.numTokens } : {}),
        ...(options.teacher !== undefined ? { teacher: modelId(options.teacher) } : {}),
      },
      options.context,
    );
  },
  /** Embedding model (full encoder fine-tune; default baai/bge-small-en-v1.5). */
  embedding: (options: CommonRecipeOptions & { temp?: number; loss?: ReturnType<typeof losses.infoNCE> } = {}): Recipe => {
    rejectUnknown("embedding", options, ["temp", "loss"]);
    const temp = options.temp ?? options.loss?.temp;
    return new Recipe("embedding", { ...common(options), ...(temp !== undefined ? { temp } : {}) });
  },
  /** On-policy distillation from a teacher (Wave 2: the server rejects it unless enabled). */
  distill: (options: CommonRecipeOptions & { teacher: ModelRef; context?: Context }): Recipe => {
    rejectUnknown("distill", options, ["teacher", "context"]);
    return new Recipe("distill", { ...common(options), teacher: modelId(options.teacher) }, options.context);
  },
  /** Reward model on preference pairs (Wave 2). */
  rewardModel: (options: CommonRecipeOptions = {}): Recipe => {
    rejectUnknown("rewardModel", options, []);
    return new Recipe("reward", common(options));
  },
  /** GRPO reinforcement learning against an environment (Wave 2). */
  grpo: (options: CommonRecipeOptions & { envName?: string; groupSize?: number } = {}): Recipe => {
    rejectUnknown("grpo", options, ["envName", "groupSize"]);
    return new Recipe("grpo", {
      ...common(options),
      ...(options.envName !== undefined ? { envName: options.envName } : {}),
      ...(options.groupSize !== undefined ? { groupSize: options.groupSize } : {}),
    });
  },
};

export const toRecipeSpec = async (recipe: Recipe | RecipeSpec): Promise<RecipeSpec> =>
  recipe instanceof Recipe ? recipe.toSpec() : recipe;
