import { z } from "@hono/zod-openapi";

import {
  IsoTimestampSchema,
  ModelIdSchema,
  NextCursorSchema,
  Sha256HexSchema,
  SlugSchema,
} from "./common.js";
import { EvalReportSchema } from "./eval-report.js";
import { EvalRubricItemSchema } from "./evals.js";

export const AdapterSpecSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("lora"),
      rank: z.number().int().min(1).max(256).default(32),
      alpha: z.number().int().min(1).max(512).default(32),
      merge_on_export: z.boolean().default(false),
    }),
    z.object({
      kind: z.literal("prefix_kv"),
      num_tokens: z.number().int().min(16).max(4096).default(256),
    }),
    z.object({
      kind: z.literal("frozen_head"),
    }),
  ])
  .openapi("AdapterSpec");

export type AdapterSpec = z.infer<typeof AdapterSpecSchema>;

export const SplitSpecSchema = z
  .object({
    strategy: z
      .enum(["by_session", "by_group", "random"])
      .default("by_session"),
    eval_fraction: z.number().min(0).max(0.5).optional(),
    seed: z.number().int().default(42),
  })
  .openapi("SplitSpec");

export type SplitSpec = z.infer<typeof SplitSpecSchema>;

export const V0_RECIPE_KINDS = [
  "sft",
  "dpo",
  "router",
  "decision",
  "cartridge",
  "embedding",
  "distill",
  "reward",
] as const;

export const ALL_RECIPE_KINDS = [...V0_RECIPE_KINDS, "grpo"] as const;

export const RecipeKindSchema = z.enum(ALL_RECIPE_KINDS).openapi("RecipeKind");
export type RecipeKind = z.infer<typeof RecipeKindSchema>;

export const OptimizerSpecSchema = z
  .object({
    kind: z.literal("adamw").default("adamw"),
    betas: z
      .tuple([z.number().min(0).lt(1), z.number().min(0).lt(1)])
      .default([0.9, 0.95]),
    weight_decay: z.number().min(0).max(1).default(0),
    grad_clip: z.number().min(0).max(1000).default(1.0).openapi({
      description: "Max global gradient norm; 0 disables clipping.",
    }),
  })
  .strict()
  .openapi("OptimizerSpec");

export type OptimizerSpec = z.infer<typeof OptimizerSpecSchema>;

export const LossSpecSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("cross_entropy"),
        reduction: z.enum(["per_example", "per_token"]).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("dpo"),
        beta: z.number().positive().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("infonce"),
        temp: z.number().positive().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("top_k_kl_distill"),
        top_k: z.number().int().min(1).max(256).optional(),
      })
      .strict(),
  ])
  .openapi("LossSpec");

export type LossSpec = z.infer<typeof LossSpecSchema>;

export const RolloutSpecSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("on_policy"),
        max_new_tokens: z
          .union([z.literal("auto"), z.number().int().min(1).max(8192)])
          .optional()
          .openapi({
            description:
              "Length of each student answer; auto (default) sizes it from the assistant turns in your records (256 without any).",
          }),
      })
      .strict(),
    z
      .object({
        kind: z.literal("off_policy"),
        max_new_tokens: z.number().int().min(1).max(8192).optional(),
      })
      .strict(),
  ])
  .openapi("RolloutSpec", {
    description:
      "DistillRecipe: on_policy (default) samples answers from the student and the trainer scores them with the teacher's top-k logits; off_policy has the teacher answer each prompt once through the inference endpoint and trains the student on those answers.",
  });

export type RolloutSpec = z.infer<typeof RolloutSpecSchema>;

export const PoolingSpecSchema = z
  .object({ kind: z.enum(["mean", "cls"]) })
  .strict()
  .openapi("PoolingSpec");

export const RecipeSpecSchema = z
  .object({
    kind: RecipeKindSchema,
    model: ModelIdSchema.optional(),
    adapter: AdapterSpecSchema.optional(),
    lr: z.union([z.literal("auto"), z.number().positive()]).default("auto"),
    lr_scale: z.number().positive().max(100).default(1.0),
    batch_size: z.number().int().min(1).max(4096).optional(),
    epochs: z.number().int().min(1).max(20).default(1),
    schedule: z.enum(["linear", "cosine", "constant"]).default("linear"),
    warmup: z.number().min(0).max(0.5).default(0.03),
    train_on: z.enum(["last", "all_assistant"]).default("last"),
    thinking: z.enum(["auto", "on", "off"]).default("auto"),
    preserve_thinking: z.boolean().default(false),
    reduction: z.enum(["per_example", "per_token"]).optional().openapi({
      description: "Default per_example.",
    }),
    select: z.enum(["best", "last"]).default("best"),
    checkpoint_ttl_days: z.number().int().min(1).max(365).default(30),
    beta: z.number().positive().optional(),
    models: z.array(ModelIdSchema).optional(),
    max_quality_drop: z.number().min(0).max(0.5).optional(),
    context_text: z.string().max(4_000_000).optional(),
    num_tokens: z.number().int().min(16).max(4096).optional(),
    temp: z.number().positive().optional(),
    teacher: ModelIdSchema.optional().openapi({
      description:
        "CartridgeRecipe and DistillRecipe: the model to learn from. DistillRecipe also takes an artifact (name@version) with rollout off_policy.",
    }),
    rollout: RolloutSpecSchema.optional(),
    optimizer: OptimizerSpecSchema.optional(),
    eval_every: z
      .union([z.literal("auto"), z.number().int().min(1)])
      .default("auto")
      .openapi({
        description:
          "Optimizer steps between held-out evaluations; auto = every 10% of steps (the checkpoint interval).",
      }),
    loss: LossSpecSchema.optional(),
    pool: PoolingSpecSchema.optional(),
    rubric: z
      .union([
        z.string().min(1).max(80),
        z.array(EvalRubricItemSchema).min(1).max(32),
      ])
      .optional()
      .openapi({
        description:
          "RouterRecipe: a score name on your records (scores[rubric]), or Judge/validator items: the server then replays each prompt against recipe.models and scores the answers in a labeling eval before training. RewardModelRecipe: a score name in [0, 1] on records ending in an assistant turn, trained pointwise next to the chosen/rejected pairs.",
      }),
    pricing: z.record(ModelIdSchema, z.number().min(0)).optional().openapi({
      description:
        "RouterRecipe: USD per request for each candidate; overrides metrics.cost_usd on your records.",
    }),
    fallback: ModelIdSchema.optional().openapi({
      description:
        "RouterRecipe: the candidate that gets every request the router does not offload (default: the best-scoring candidate).",
    }),
    max_new_tokens: z.number().int().min(1).max(8192).optional().openapi({
      description:
        "CartridgeRecipe: teacher answer length per prompt during distillation (default 256).",
    }),
    slot_token: z.string().min(1).max(64).optional().openapi({
      description:
        "CartridgeRecipe: a reserved token that marks where the cartridge goes (default: the first reserved token that tokenizes atomically).",
    }),
  })
  .strict()
  .openapi("RecipeSpec");

export type RecipeSpec = z.infer<typeof RecipeSpecSchema>;

export const PlanRunRequestSchema = z
  .object({
    dataset: SlugSchema,
    name: SlugSchema,
    recipe: RecipeSpecSchema,
    split: SplitSpecSchema.optional(),
    max_cost_usd: z.number().positive().optional(),
  })
  .strict()
  .openapi("PlanRunRequest");

export type PlanRunRequest = z.infer<typeof PlanRunRequestSchema>;

export const ResolvedAdapterSchema = z.union([
  AdapterSpecSchema,
  z.object({ kind: z.literal("encoder_full") }),
]);

export type ResolvedAdapter = z.infer<typeof ResolvedAdapterSchema>;

export const BaseArtifactSchema = z
  .object({
    id: z.string().min(1),
    recipe_kind: RecipeKindSchema,
    format: z.literal("peft_lora"),
    sha256: Sha256HexSchema,
  })
  .openapi("BaseArtifact");

export type BaseArtifact = z.infer<typeof BaseArtifactSchema>;

export const ResolvedRunConfigSchema = z
  .object({
    rule_version: z.string(),
    dataset: SlugSchema,
    dataset_version: z.number().int().min(0),
    name: SlugSchema,
    recipe_kind: RecipeKindSchema,
    model: z.string(),
    template_revision: z.string(),
    adapter: ResolvedAdapterSchema,
    lr: z.number().positive(),
    lr_source: z.string(),
    batch_size: z.number().int().min(1),
    epochs: z.number().int().min(1),
    schedule: z.enum(["linear", "cosine", "constant"]),
    warmup: z.number(),
    train_on: z.enum(["last", "all_assistant"]),
    thinking: z.enum(["auto", "on", "off"]),
    preserve_thinking: z.boolean(),
    reduction: z.enum(["per_example", "per_token"]),
    select: z.enum(["best", "last"]),
    checkpoint_every_steps: z.number().int().min(1),
    eval_every_steps: z.number().int().min(1),
    optimizer: OptimizerSpecSchema,
    checkpoint_ttl_days: z.number().int().min(1),
    split: z.object({
      strategy: z.enum(["by_session", "by_group", "random"]),
      eval_fraction: z.number(),
      seed: z.number().int(),
      train_records: z.number().int().min(0),
      eval_records: z.number().int().min(0),
    }),
    label_eval_id: z.string().nullable().openapi({
      description:
        "The labeling eval whose answers the run trains on: router runs with a Judge/validator rubric, and off-policy distill runs (the teacher's answers).",
    }),
    base_artifact: BaseArtifactSchema.nullable().openapi({
      description:
        "Continued training: the artifact whose adapter the run starts from (recipe.model was an artifact reference).",
    }),
    recipe_params: z.record(z.string(), z.unknown()),
  })
  .openapi("ResolvedRunConfig");

export type ResolvedRunConfig = z.infer<typeof ResolvedRunConfigSchema>;

export const PlanRunResponseSchema = z
  .object({
    resolved_config: ResolvedRunConfigSchema,
    dataset_version: z.number().int().min(0),
    usable_records: z.number().int().min(0),
    total_records: z.number().int().min(0),
    estimated_steps: z.number().int().min(0),
    estimated_tokens: z.number().int().min(0),
    estimated_cost_usd: z.number().min(0),
    price_per_million_tokens: z.number().positive(),
    trained_token_fraction: z.number().min(0).max(1),
    labeling: z
      .object({
        estimated_model_calls: z.number().int().min(0),
        estimated_judge_calls: z.number().int().min(0),
        estimated_cost_usd: z.number().min(0),
      })
      .nullable()
      .openapi({
        description:
          "The labeling eval that runs before training (billed as an eval, included in estimated_cost_usd): router runs with a Judge/validator rubric replay prompts against the candidates; off-policy distill runs have the teacher answer each prompt.",
      }),
    teacher: z
      .object({
        model: z.string(),
        price_per_million_tokens: z.number().min(0),
        estimated_tokens: z.number().int().min(0),
        estimated_cost_usd: z.number().min(0),
      })
      .nullable()
      .openapi({
        description:
          "On-policy distill runs: the teacher's scoring tokens at the teacher's price (included in estimated_tokens as student-price tokens, and in estimated_cost_usd).",
      }),
    warnings: z.array(z.string()),
  })
  .openapi("PlanRunResponse");

export type PlanRunResponse = z.infer<typeof PlanRunResponseSchema>;

export const RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "stopped_budget",
] as const;

export const RunStatusSchema = z.enum(RUN_STATUSES).openapi("RunStatus");

export type RunStatus = z.infer<typeof RunStatusSchema>;

const EvalMetricsSchema = z
  .record(z.string(), z.number().nullable())
  .nullable()
  .optional()
  .openapi({
    description:
      "Held-out metrics of an eval step by name (including the recipe's selection metric, eval_report.metric_name); absent on steps without an eval.",
  });

/** Metric point as reported by a trainer worker (extra numeric keys allowed). */
export const MetricPointInputSchema = z
  .looseObject({
    step: z.number().int().min(0),
    loss: z.number(),
    eval_loss: z.number().nullable().optional(),
    eval_metrics: EvalMetricsSchema,
    grad_norm: z.number().nullable().optional(),
    lr: z.number().nullable().optional(),
    tokens_per_sec: z.number().nullable().optional(),
    tokens: z.number().int().min(0).openapi({
      description:
        "Tokens processed by this attempt so far (not the run total): a resumed attempt starts at 0, so tokens restored from a checkpoint are never billed twice.",
    }),
    cost_usd: z.number().min(0).optional(),
    timestamp: IsoTimestampSchema,
  })
  .openapi("MetricPointInput");

export type MetricPointInput = z.infer<typeof MetricPointInputSchema>;

/** Stored metric point. `seq` is the per-server monotonic cursor (SSE event id). */
export const MetricPointSchema = z
  .looseObject({
    seq: z.number().int().min(1),
    attempt: z.number().int().min(1),
    step: z.number().int().min(0),
    loss: z.number(),
    eval_loss: z.number().nullable().optional(),
    eval_metrics: EvalMetricsSchema,
    grad_norm: z.number().nullable().optional(),
    lr: z.number().nullable().optional(),
    tokens_per_sec: z.number().nullable().optional(),
    tokens: z.number().int().min(0),
    cost_usd: z.number().min(0),
    timestamp: IsoTimestampSchema,
  })
  .openapi("MetricPoint");

export type MetricPoint = z.infer<typeof MetricPointSchema>;

export const RunSchema = z
  .object({
    id: z.string().min(1),
    workspace_id: z.string().min(1),
    name: SlugSchema,
    dataset_id: z.string().min(1),
    dataset_name: SlugSchema,
    dataset_version: z.number().int().min(0),
    recipe_kind: RecipeKindSchema,
    status: RunStatusSchema,
    resolved_config: ResolvedRunConfigSchema,
    max_cost_usd: z.number().positive().nullable(),
    price_per_million_tokens: z.number().positive(),
    tokens_processed: z.number().int().min(0),
    cost_usd: z.number().min(0),
    current_step: z.number().int().min(0),
    total_steps: z.number().int().min(0),
    attempt: z.number().int().min(0),
    max_attempts: z.number().int().min(1),
    latest_metric: MetricPointSchema.nullable(),
    eval_report: EvalReportSchema.nullable(),
    artifact_id: z.string().nullable(),
    error: z.string().nullable(),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
    finished_at: IsoTimestampSchema.nullable(),
  })
  .openapi("Run");

export type Run = z.infer<typeof RunSchema>;

export const ResumeRunRequestSchema = z
  .object({
    max_cost_usd: z.number().positive().optional(),
  })
  .openapi("ResumeRunRequest");

export const MetricsPageSchema = z
  .object({
    run_id: z.string(),
    status: RunStatusSchema,
    data: z.array(MetricPointSchema),
    next_cursor: NextCursorSchema,
    tail_cursor: z.string().openapi({
      description:
        "Cursor after the newest point returned so far; pass it back as `cursor` to poll for points written later (tailing a running run).",
    }),
  })
  .openapi("MetricsPage");

export const ArtifactFormatSchema = z
  .enum([
    "peft_lora",
    "merged_safetensors",
    "prefix_kv",
    "cartridge",
    "encoder_safetensors",
    "router_bundle",
    "decision_bundle",
    "reward_bundle",
    "reference",
  ])
  .openapi("ArtifactFormat");

export type ArtifactFormat = z.infer<typeof ArtifactFormatSchema>;

export const NON_DEPLOYABLE_FORMATS: readonly ArtifactFormat[] = ["reference"];

export const CheckpointSchema = z
  .object({
    id: z.string().min(1),
    workspace_id: z.string().min(1),
    run_id: z.string().min(1),
    attempt: z.number().int().min(1),
    step: z.number().int().min(0),
    eval_score: z.number().nullable(),
    format: ArtifactFormatSchema.nullable().openapi({
      description:
        "Artifact format when this checkpoint is exportable (promotable); null for training state only.",
    }),
    sha256: Sha256HexSchema,
    size_bytes: z.number().int().min(0),
    metadata: z.record(z.string(), z.unknown()),
    best: z.boolean(),
    final: z.boolean(),
    expires_at: IsoTimestampSchema.nullable(),
    created_at: IsoTimestampSchema,
  })
  .openapi("Checkpoint");

export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const PromoteCheckpointRequestSchema = z
  .object({
    name: SlugSchema.optional(),
  })
  .openapi("PromoteCheckpointRequest");

export const ArtifactSchema = z
  .object({
    id: z.string().min(1),
    workspace_id: z.string().min(1),
    name: SlugSchema,
    version: z.string().min(1),
    run_id: z.string().nullable(),
    checkpoint_id: z.string().nullable(),
    base_model: z.string().min(1),
    recipe_kind: RecipeKindSchema,
    format: ArtifactFormatSchema,
    sha256: Sha256HexSchema,
    size_bytes: z.number().int().min(0),
    manifest: z.record(z.string(), z.unknown()),
    eval_report: EvalReportSchema.nullable(),
    created_at: IsoTimestampSchema,
  })
  .openapi("Artifact");

export type Artifact = z.infer<typeof ArtifactSchema>;
