import type { AdapterSpec, LoggerSpec, LossSpec, OptimizerSpec, PoolingSpec, RecipeEval, RecipeKind, RecipeSpec, RolloutSpec, SplitSpec } from "./generated/models.js";
import { isNodeRuntime } from "./core.js";
import { GradUsageError } from "./errors.js";
import { toRubric, type RubricInput } from "./rubrics.js";

/** A catalog model id, or an Artifact (`name@version`) to keep training its adapter (SFT and DPO). */
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

/** Train/eval splits (pass as `runs.create({ split })`). Default: by session, 10% held out (15% for routers and decision models). */
export const splits = {
  bySession: split("by_session"),
  byGroup: split("by_group"),
  random: split("random"),
};

/** The loss each recipe trains with; only its parameters are tunable in v0. */
export const losses = {
  crossEntropy: (options: { reduction?: "per_example" | "per_token" } = {}) => ({ kind: "cross_entropy" as const, ...options }),
  dpo: (options: { beta?: number } = {}) => ({ kind: "dpo" as const, ...options }),
  infoNCE: (options: { temp?: number } = {}) => ({ kind: "infonce" as const, ...options }),
  topKKLDistill: (options: { topK?: number } = {}): LossSpec => ({ kind: "top_k_kl_distill", ...options }),
};

/** Distillation rollouts (`recipes.distill({ rollout })`). */
export const rollouts = {
  /** The student writes each answer (default "auto": sized from your records) and the teacher scores those tokens. */
  onPolicy: (options: { maxNewTokens?: number | "auto" } = {}): RolloutSpec => ({
    kind: "on_policy",
    ...(options.maxNewTokens !== undefined && options.maxNewTokens !== "auto" ? { maxNewTokens: options.maxNewTokens } : {}),
  }),
  /** The teacher answers each prompt once through the inference endpoint (a labeling eval) and the student trains on them. */
  offPolicy: (options: { maxNewTokens?: number } = {}): RolloutSpec => ({
    kind: "off_policy",
    ...(options.maxNewTokens !== undefined ? { maxNewTokens: options.maxNewTokens } : {}),
  }),
};

/** AdamW settings (`lr` here is the same as the recipe's `lr`). */
export const optim = {
  adamW: (options: { lr?: number; betas?: [number, number]; weightDecay?: number; gradClip?: number } = {}) => ({ kind: "adamw" as const, ...options }),
};

/** Embedding pooling. */
export const pooling = {
  mean: (): PoolingSpec => ({ kind: "mean" }),
  cls: (): PoolingSpec => ({ kind: "cls" }),
};

/** Text baked into a cartridge. */
export class Context {
  private constructor(private readonly source: { text: string } | { file: string }) {}

  static fromText(text: string): Context {
    return new Context({ text });
  }

  /** Read from disk when the run is submitted (Node only). */
  static fromFile(path: string): Context {
    return new Context({ file: path });
  }

  /** The RecipeSpec fields for this context. */
  async toSpec(): Promise<Pick<RecipeSpec, "contextText">> {
    if ("text" in this.source) return { contextText: this.source.text };
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
  optimizer?: ReturnType<typeof optim.adamW>;
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
  /** "auto" (every 25% of the run, at most every 20 steps) or a number of optimizer steps. */
  evalEvery?: number | "auto";
  /** Extra evals on each checkpoint: a dataset (or its name), or `{ dataset, rubric?, limit?, name?, version? }`. */
  evals?: Array<string | { name: string; recordCount: number } | CheckpointEvalOptions>;
  /** Experiment trackers: `[loggers.wandb({ project, secret })]` or `[loggers.mlflow({ trackingUri })]`. */
  loggers?: LoggerSpec[];
}

/** One of a recipe's `evals`, scored on every checkpoint during training. */
export interface CheckpointEvalOptions {
  dataset: string | { name: string };
  /** Judges, regexes and validators (local functions can't run during training). */
  rubric?: RubricInput;
  limit?: number;
  name?: string;
  version?: number;
}

const checkpointEval = (item: NonNullable<CommonRecipeOptions["evals"]>[number]): RecipeEval => {
  if (typeof item === "string") return { dataset: item };
  if ("recordCount" in item) return { dataset: item.name };
  const { dataset, rubric, ...rest } = item;
  const out: RecipeEval = { dataset: typeof dataset === "string" ? dataset : dataset.name, ...rest };
  if (rubric !== undefined) {
    const built = toRubric(rubric);
    if (built.local.size > 0) {
      throw usage(`evals: local scorers (${[...built.local.keys()].join(", ")}) can't run during training; use judges, regexes and validators.`);
    }
    out.rubric = built.wire;
  }
  return out;
};

/** Experiment trackers for recipe `loggers`; keys come from workspace secrets. A failing tracker never fails the run. */
export const loggers = {
  /** Weights & Biases: `secret` names the workspace secret holding the API key. */
  wandb: (options: { project: string; secret: string; entity?: string; runName?: string; host?: string }): LoggerSpec => ({ kind: "wandb", ...options }),
  /** MLflow: `secret` names a workspace secret with a bearer token, if the server needs one. */
  mlflow: (options: { trackingUri: string; experiment?: string; secret?: string; runName?: string }): LoggerSpec => ({ kind: "mlflow", ...options }),
};

const COMMON_KEYS = [
  "model", "adapter", "lr", "lrScale", "optimizer", "batchSize", "epochs", "schedule", "warmup", "trainOn", "thinking",
  "preserveThinking", "reduction", "select", "checkpointTtlDays", "evalEvery", "evals", "loggers",
] as const;

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

const usage = (message: string): GradUsageError => new GradUsageError(message, "unsupported_recipe_option");

const common = (options: CommonRecipeOptions): Partial<RecipeSpec> => {
  const out: Record<string, unknown> = {};
  for (const key of COMMON_KEYS) if (options[key] !== undefined) out[key] = options[key];
  if (options.model !== undefined) out.model = modelId(options.model);
  if (options.evalEvery === "auto") delete out.evalEvery;
  if (options.evals !== undefined) out.evals = options.evals.map(checkpointEval);
  if (options.optimizer !== undefined) {
    const { lr, kind, betas, weightDecay, gradClip } = options.optimizer;
    if (lr !== undefined) {
      if (options.lr !== undefined && options.lr !== lr) throw usage(`lr ${String(options.lr)} conflicts with optim.adamW({ lr: ${lr} }).`);
      out.lr = lr;
    }
    const optimizer: OptimizerSpec = { kind, betas: betas ?? [0.9, 0.95], weightDecay: weightDecay ?? 0, gradClip: gradClip ?? 1 };
    out.optimizer = optimizer;
  }
  return out as Partial<RecipeSpec>;
};

const build = <O extends CommonRecipeOptions>(recipe: string, options: O, extra: readonly string[]): Partial<RecipeSpec> => {
  const known = new Set<string>([...COMMON_KEYS, ...extra]);
  const unknown = Object.keys(options).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    throw usage(`recipes.${recipe}() does not support ${unknown.map((k) => `'${k}'`).join(", ")}; it would be ignored, so it is rejected.`);
  }
  return common(options);
};

/** A loss shorthand: `loss` sets the same field as the recipe's own option, which must agree. */
const fromLoss = <T>(recipe: string, field: string, direct: T | undefined, viaLoss: T | undefined): T | undefined => {
  if (direct !== undefined && viaLoss !== undefined && direct !== viaLoss) throw usage(`recipes.${recipe}(): ${field} conflicts with loss.${field}.`);
  return direct ?? viaLoss;
};

const set = <K extends keyof RecipeSpec>(key: K, value: RecipeSpec[K] | undefined): Partial<RecipeSpec> =>
  value === undefined ? {} : ({ [key]: value } as Partial<RecipeSpec>);

export const recipes = {
  /** Supervised fine-tuning on chat records. */
  sft: (options: CommonRecipeOptions & { mergeOnExport?: boolean; loss?: ReturnType<typeof losses.crossEntropy> } = {}): Recipe => {
    const fields = build("sft", options, ["mergeOnExport", "loss"]);
    const reduction = fromLoss("sft", "reduction", options.reduction, options.loss?.reduction);
    if (options.mergeOnExport !== undefined) {
      const adapter = fields.adapter ?? { kind: "lora" };
      if (adapter.kind !== "lora") throw usage("mergeOnExport needs a LoRA adapter.");
      fields.adapter = { ...adapter, mergeOnExport: options.mergeOnExport };
    }
    return new Recipe("sft", { ...fields, ...set("reduction", reduction) });
  },
  /** Direct preference optimization on chosen/rejected pairs (pass `model: sftRun.artifact` to continue an SFT run). */
  dpo: (options: CommonRecipeOptions & { beta?: number; loss?: ReturnType<typeof losses.dpo> } = {}): Recipe => {
    const fields = build("dpo", options, ["beta", "loss"]);
    return new Recipe("dpo", { ...fields, ...set("beta", fromLoss("dpo", "beta", options.beta, options.loss?.beta)) });
  },
  /** Learned router across candidate models (default backbone qwen/qwen3-0.6b). */
  router: (
    options: CommonRecipeOptions & {
      models?: ModelRef[];
      maxQualityDrop?: number;
      /** A score name on your records, or Judge/validator items (the server labels your prompts with an eval first). */
      rubric?: string | RubricInput;
      /** USD per request for each candidate. */
      pricing?: Record<string, number>;
      fallback?: ModelRef;
    } = {},
  ): Recipe => {
    const fields = build("router", options, ["models", "maxQualityDrop", "rubric", "pricing", "fallback"]);
    let rubric: RecipeSpec["rubric"];
    if (typeof options.rubric === "string") rubric = options.rubric;
    else if (options.rubric !== undefined) {
      const { wire, local } = toRubric(options.rubric);
      if (local.size > 0) throw usage("recipes.router({ rubric }) cannot run local scorer functions (that needs a sandbox, post-v0); use a Judge or validators.");
      if (options.models === undefined) throw usage("recipes.router({ rubric: Judge }) replays your prompts against the candidates: pass models.");
      rubric = wire;
    }
    return new Recipe("router", {
      ...fields,
      ...set("models", options.models?.map(modelId)),
      ...set("maxQualityDrop", options.maxQualityDrop),
      ...set("rubric", rubric),
      ...set("pricing", options.pricing),
      ...set("fallback", options.fallback === undefined ? undefined : modelId(options.fallback)),
    });
  },
  /** Decision model (default backbone gradiated/linden-1). */
  decisionModel: (options: CommonRecipeOptions = {}): Recipe => new Recipe("decision", build("decisionModel", options, [])),
  /** Context cartridge: compress a document into trainable prefix KV tokens. */
  cartridge: (
    options: CommonRecipeOptions & { context: Context; numTokens?: number; teacher?: ModelRef; loss?: LossSpec; maxNewTokens?: number },
  ): Recipe => {
    const fields = build("cartridge", options, ["context", "numTokens", "teacher", "loss", "maxNewTokens"]);
    if (!(options.context instanceof Context)) throw new GradUsageError("recipes.cartridge() needs context: Context.fromText/fromFile(...).", "invalid_recipe");
    return new Recipe(
      "cartridge",
      {
        ...fields,
        ...set("numTokens", options.numTokens),
        ...set("teacher", options.teacher === undefined ? undefined : modelId(options.teacher)),
        ...set("loss", options.loss),
        ...set("maxNewTokens", options.maxNewTokens),
      },
      options.context,
    );
  },
  /**
   * Distillation: a LoRA student learns a teacher on your prompts. On-policy (default) the teacher
   * must be a catalog model sharing the student's tokenizer; off-policy it can be an Artifact or any
   * model the inference endpoint serves.
   */
  distill: (
    options: CommonRecipeOptions & { teacher: ModelRef; rollout?: RolloutSpec; loss?: LossSpec; context?: Context },
  ): Recipe => {
    const fields = build("distill", options, ["teacher", "rollout", "loss", "context"]);
    if (options.teacher === undefined) throw new GradUsageError("recipes.distill() needs teacher: a catalog model or an Artifact.", "invalid_recipe");
    const offPolicy = options.rollout?.kind === "off_policy";
    const expected = offPolicy ? "cross_entropy" : "top_k_kl_distill";
    if (options.loss !== undefined && options.loss.kind !== expected) {
      throw usage(`recipes.distill(): ${offPolicy ? "off" : "on"}-policy distillation trains with loss kind '${expected}', not '${options.loss.kind}'.`);
    }
    if (options.context !== undefined && offPolicy) throw usage("recipes.distill(): context is read by the teacher on-policy; drop rollout: rollouts.offPolicy().");
    return new Recipe(
      "distill",
      { ...fields, teacher: modelId(options.teacher), ...set("rollout", options.rollout), ...set("loss", options.loss) },
      options.context,
    );
  },
  /** Reward model: a scalar head trained on chosen/rejected pairs (and, with `rubric`, scored answers). */
  rewardModel: (options: CommonRecipeOptions & { rubric?: string } = {}): Recipe => {
    const fields = build("rewardModel", options, ["rubric"]);
    return new Recipe("reward", { ...fields, ...set("rubric", options.rubric) });
  },
  /** Embedding model (full encoder fine-tune; default baai/bge-small-en-v1.5). */
  embedding: (options: CommonRecipeOptions & { temp?: number; loss?: ReturnType<typeof losses.infoNCE>; pool?: PoolingSpec } = {}): Recipe => {
    const fields = build("embedding", options, ["temp", "loss", "pool"]);
    return new Recipe("embedding", {
      ...fields,
      ...set("temp", fromLoss("embedding", "temp", options.temp, options.loss?.temp)),
      ...set("pool", options.pool),
    });
  },
};

export const toRecipeSpec = async (recipe: Recipe | RecipeSpec): Promise<RecipeSpec> => (recipe instanceof Recipe ? recipe.toSpec() : recipe);
