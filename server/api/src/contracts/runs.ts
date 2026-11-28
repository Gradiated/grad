import { z } from "@hono/zod-openapi";

import {
  IsoTimestampSchema,
  ModelIdSchema,
  NextCursorSchema,
  nullable,
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

export const MAX_CHECKPOINT_EVALS = 4;

export const RecipeEvalSchema = z
  .object({
    dataset: SlugSchema,
    version: z.number().int().min(1).optional().openapi({
      description:
        "Dataset version (default: the current one, pinned at plan time).",
    }),
    rubric: z.array(EvalRubricItemSchema).min(1).max(32).optional().openapi({
      description:
        "Judges, regexes and validators (default: the dataset's own rubric, such as a benchmark's answer check). Code scorers can't run during training.",
    }),
    limit: z.number().int().min(1).max(100_000).optional().openapi({
      description: "Evaluate the first N tasks at each checkpoint.",
    }),
    name: SlugSchema.optional().openapi({
      description:
        "Name of this eval in the report (default: the dataset name).",
    }),
  })
  .strict()
  .openapi("RecipeEval");

const LoggerCommon = {
  run_name: z.string().min(1).max(128).optional().openapi({
    description: "Tracker run name (default: the grad run name).",
  }),
};

export const LoggerSpecSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("wandb"),
        project: z.string().min(1).max(128),
        entity: z.string().min(1).max(128).optional(),
        host: z.string().url().optional().openapi({
          description: "W&B server (default https://api.wandb.ai).",
        }),
        secret: SlugSchema.openapi({
          description: "Workspace secret holding the W&B API key.",
        }),
        ...LoggerCommon,
      })
      .strict(),
    z
      .object({
        kind: z.literal("mlflow"),
        tracking_uri: z.string().url(),
        experiment: z.string().min(1).max(256).optional(),
        secret: SlugSchema.optional().openapi({
          description:
            "Workspace secret holding a bearer token for the tracking server, if it needs one.",
        }),
        ...LoggerCommon,
      })
      .strict(),
  ])
  .openapi("LoggerSpec");

export type LoggerSpec = z.infer<typeof LoggerSpecSchema>;

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
          "Optimizer steps between held-out evaluations; auto = every 25% of the run, at most every 20 steps; each eval step is also a checkpoint.",
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
    evals: z
      .array(RecipeEvalSchema)
      .min(1)
      .max(MAX_CHECKPOINT_EVALS)
      .optional()
      .openapi({
        description:
          "Extra evals on each checkpoint during training (the eval executor, billed like any eval). Results are in run.checkpoint_evals, the run's checkpoint_eval events and eval_report.checkpoint_evals.",
      }),
    loggers: z.array(LoggerSpecSchema).min(1).max(4).optional().openapi({
      description:
        "Experiment trackers that receive the run's metrics. A tracker that fails is reported and dropped; it never fails the run.",
    }),
  })
  .strict()
  .openapi("RecipeSpec");

export type RecipeSpec = z.infer<typeof RecipeSpecSchema>;

export const PlanRunRequestSchema = z
  .object({
    dataset: SlugSchema.openapi({
      description: "Dataset to train on. The run pins its current version.",
    }),
    name: SlugSchema.openapi({
      description:
        "Run name; the artifact it produces is released as `name@version`.",
    }),
    recipe: RecipeSpecSchema,
    split: SplitSpecSchema.optional(),
    max_cost_usd: z.number().positive().optional().openapi({
      description:
        "Hard spend cap in USD. The run stops with `stopped_budget` and keeps its checkpoint when it reaches the cap, and is never billed past it. Default: no cap.",
    }),
  })
  .strict()
  .openapi("PlanRunRequest");

export type PlanRunRequest = z.infer<typeof PlanRunRequestSchema>;

export const ResolvedAdapterSchema = z.union([
  AdapterSpecSchema,
  z.object({ kind: z.literal("encoder_full") }),
]);

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
    rule_version: z.string().openapi({
      description:
        "The version of the rules that resolved the `auto` defaults (`auto@2`); a config keeps resolving the same way.",
    }),
    dataset: SlugSchema,
    dataset_version: z
      .number()
      .int()
      .min(0)
      .openapi({ description: "The pinned dataset version." }),
    name: SlugSchema,
    recipe_kind: RecipeKindSchema,
    model: z.string().openapi({ description: "The base model trained." }),
    template_revision: z.string().openapi({
      description:
        "The pinned chat template (`qwen3@3`); evals of the run's checkpoints use it too.",
    }),
    adapter: ResolvedAdapterSchema,
    lr: z
      .number()
      .positive()
      .openapi({ description: "The resolved learning rate." }),
    lr_source: z.string().openapi({
      description:
        "Where `lr` came from: the calibrated rule (`auto@2: calibrated for ... at batch 128, sqrt batch scaling`) or the value you passed.",
    }),
    batch_size: z
      .number()
      .int()
      .min(1)
      .openapi({ description: "Training examples per optimizer step." }),
    epochs: z
      .number()
      .int()
      .min(1)
      .openapi({ description: "Passes over the training split." }),
    schedule: z
      .enum(["linear", "cosine", "constant"])
      .openapi({ description: "Learning-rate schedule after warmup." }),
    warmup: z.number().openapi({
      description: "The fraction of steps spent warming up the learning rate.",
    }),
    train_on: z.enum(["last", "all_assistant"]).openapi({
      description:
        "Which assistant turns are trained: the last one, or every one.",
    }),
    thinking: z
      .enum(["auto", "on", "off"])
      .openapi({ description: "Thinking mode the records are rendered with." }),
    preserve_thinking: z.boolean().openapi({
      description:
        "Whether earlier assistant turns keep their reasoning in the prompt.",
    }),
    reduction: z.enum(["per_example", "per_token"]).openapi({
      description:
        "How the loss averages: per example, then across the batch, or per token.",
    }),
    select: z.enum(["best", "last"]).openapi({
      description:
        "Which checkpoint becomes the artifact: the best by the held-out metric, or the last.",
    }),
    checkpoint_every_steps: z
      .number()
      .int()
      .min(1)
      .openapi({ description: "Steps between checkpoints." }),
    eval_every_steps: z
      .number()
      .int()
      .min(1)
      .openapi({ description: "Steps between held-out evaluations." }),
    optimizer: OptimizerSpecSchema,
    checkpoint_ttl_days: z.number().int().min(1).openapi({
      description:
        "Days an intermediate checkpoint is kept; the best and final never expire.",
    }),
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
    base_artifact: nullable(BaseArtifactSchema).openapi({
      description:
        "Continued training: the artifact whose adapter the run starts from (recipe.model was an artifact reference).",
    }),
    recipe_params: z.record(z.string(), z.unknown()).openapi({
      description:
        "The recipe's own settings (router candidates, DPO `beta`, a cartridge's context, ...).",
    }),
    checkpoint_evals: z
      .array(
        z.object({
          name: SlugSchema,
          dataset: SlugSchema,
          dataset_version: z.number().int().min(1),
          rubric: z.array(EvalRubricItemSchema),
          limit: z.number().int().min(1).nullable(),
        }),
      )
      .optional()
      .openapi({
        description:
          "recipe.evals, with the dataset version and rubric pinned.",
      }),
    loggers: z.array(LoggerSpecSchema).optional(),
  })
  .openapi("ResolvedRunConfig");

export type CheckpointEvalSpec = NonNullable<
  ResolvedRunConfig["checkpoint_evals"]
>[number];

export type ResolvedRunConfig = z.infer<typeof ResolvedRunConfigSchema>;

export const PlanRunResponseSchema = z
  .object({
    resolved_config: ResolvedRunConfigSchema,
    dataset_version: z
      .number()
      .int()
      .min(0)
      .openapi({ description: "The dataset version the run would pin." }),
    usable_records: z.number().int().min(0).openapi({
      description:
        "Records the recipe can train on (the rest are skipped; a warning says why).",
    }),
    total_records: z
      .number()
      .int()
      .min(0)
      .openapi({ description: "Records in the dataset version." }),
    estimated_steps: z
      .number()
      .int()
      .min(0)
      .openapi({ description: "Optimizer steps the run would take." }),
    estimated_tokens: z.number().int().min(0).openapi({
      description: "Tokens the run would process (billed tokens).",
    }),
    estimated_cost_usd: z.number().min(0).openapi({
      description:
        "Everything the run is expected to bill: training (and teacher) tokens, plus the evals it starts (labeling, recipe.evals). See cost_breakdown.",
    }),
    estimated_duration_s: z.number().int().min(0).openapi({
      description:
        "Wall-clock estimate in seconds on one H100 80 GB: model load and export, training at the measured tokens/s for this base and recipe, evaluations and checkpoints. Excludes queueing and any labeling eval.",
    }),
    min_gpu_memory_gb: z.number().positive().nullable().openapi({
      description:
        "GPU memory (GB) this run needs: the base's min_gpu_memory_gb plus a teacher loaded beside it. Null when the base's requirement is unknown.",
    }),
    price_per_million_tokens: z.number().positive().openapi({
      description: "The base model's price, USD per million tokens.",
    }),
    trained_token_fraction: z.number().min(0).max(1).openapi({
      description:
        "The share of tokens that are trained on (the loss mask), the rest being prompt context.",
    }),
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
    cost_breakdown: z
      .object({
        train_usd: z.number().min(0).openapi({
          description:
            "The base model's tokens on every training step: each record (or both sides of a preference pair) once per epoch, at price_per_million_tokens. Held-out evaluation during training is not billed.",
        }),
        teacher_usd: z.number().min(0).openapi({
          description:
            "The teacher's tokens (on-policy distill), at its price.",
        }),
        eval_usd: z.number().min(0).openapi({
          description:
            "Evals the run starts, billed as evals: the labeling eval before training and recipe.evals on every checkpoint.",
        }),
      })
      .openapi("PlanCostBreakdown", {
        description:
          "estimated_cost_usd split by what bills it; the parts sum to it (to rounding).",
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
  "stopped_balance",
] as const;

export const RunStatusSchema = z.enum(RUN_STATUSES).openapi("RunStatus", {
  description:
    "stopped_budget: the run reached its max_cost_usd (resume with a higher cap). stopped_balance: the workspace ran out of balance on Cloud (top up, then resume; the cap is unchanged). Both keep their checkpoints.",
});

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

export const CheckpointEvalResultSchema = z
  .object({
    name: z.string(),
    step: z.number().int().min(0),
    checkpoint_id: z.string(),
    eval_id: z.string().nullable(),
    dataset: SlugSchema,
    dataset_version: z.number().int().min(1),
    status: z.enum(["completed", "failed", "cancelled"]),
    score: z.number().nullable().openapi({
      description:
        "The checkpoint's overall rubric score (null unless completed).",
    }),
    cost_usd: z.number().min(0),
    error: z.string().nullable(),
  })
  .openapi("CheckpointEvalResult");

export type CheckpointEvalResult = z.infer<typeof CheckpointEvalResultSchema>;

export const RUN_PHASES = [
  "queued",
  "waiting_for_compute",
  "starting",
  "loading_model",
  "training",
  "evaluating",
  "checkpointing",
  "uploading",
  "completing",
  "stopping",
] as const;

export const RunPhaseSchema = z.enum(RUN_PHASES).openapi("RunPhase", {
  description:
    "Where a run is in its lifecycle. queued, waiting_for_compute (queued for longer than the server's threshold with no worker claiming it), starting (a worker claimed it) and stopping (cancelled while a worker holds it: the run ends once the worker stops, or once its lease expires if the worker is gone) come from the server; the worker reports the rest. training, evaluating and checkpointing repeat.",
});

export type RunPhase = z.infer<typeof RunPhaseSchema>;

/** Phases a trainer worker reports (the server emits the others). */
export const WORKER_PHASES = [
  "loading_model",
  "training",
  "evaluating",
  "checkpointing",
  "uploading",
  "completing",
] as const satisfies readonly RunPhase[];

export const InterruptionReasonSchema = z
  .enum(["lease_lost", "compute_reclaimed", "worker_error", "oom"])
  .openapi("InterruptionReason", {
    description:
      "Why an attempt ended without a result: lease_lost (the worker was lost: it stopped heartbeating after a crash, kill or network failure), compute_reclaimed (the GPU was reclaimed; the worker saved a checkpoint when it had time and handed the run back), worker_error (the worker hit an unexpected error and handed the run back), oom (CUDA out of memory).",
  });

export type InterruptionReason = z.infer<typeof InterruptionReasonSchema>;

export const GpuInfoSchema = z
  .object({
    name: z.string().min(1).max(200),
    memory_gb: z.number().min(0).max(100_000),
  })
  .openapi("GpuInfo");

export const RunInterruptionSchema = z
  .object({
    attempt: z.number().int().min(1),
    reason: InterruptionReasonSchema,
    step: z.number().int().min(0),
    resume_step: z.number().int().min(0).nullable(),
    at: IsoTimestampSchema,
    message: z.string(),
  })
  .openapi("RunInterruption");

export type RunInterruption = z.infer<typeof RunInterruptionSchema>;

export const RunSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .openapi({ description: "Run id (`run_` and 24 hex characters)." }),
    workspace_id: z.string().min(1),
    name: SlugSchema.openapi({
      description: "Run name; its artifact is released as `name@version`.",
    }),
    dataset_id: z
      .string()
      .min(1)
      .openapi({ description: "Id of the dataset trained on." }),
    dataset_name: SlugSchema.openapi({
      description: "Name of the dataset trained on.",
    }),
    dataset_version: z.number().int().min(0).openapi({
      description: "The dataset version the run pinned when it was created.",
    }),
    recipe_kind: RecipeKindSchema,
    status: RunStatusSchema,
    resolved_config: ResolvedRunConfigSchema,
    max_cost_usd: z.number().positive().nullable().openapi({
      description:
        "Hard spend cap in USD (null: none). The run is never billed past it.",
    }),
    price_per_million_tokens: z.number().positive().openapi({
      description:
        "USD per million tokens processed, fixed when the run was created.",
    }),
    tokens_processed: z.number().int().min(0).openapi({
      description: "Training tokens processed so far, over every attempt.",
    }),
    cost_usd: z.number().min(0).openapi({
      description:
        "Cost of the tokens processed so far, in USD. It counts the whole step that crossed max_cost_usd; billing stops at the cap.",
    }),
    current_step: z
      .number()
      .int()
      .min(0)
      .openapi({ description: "Last optimizer step reported." }),
    total_steps: z.number().int().min(0).openapi({
      description: "Planned optimizer steps.",
    }),
    attempt: z.number().int().min(0).openapi({
      description:
        "Attempts started so far (every start on a worker counts, including ones whose GPU was reclaimed).",
    }),
    max_attempts: z.number().int().min(1).openapi({
      description:
        "The run fails once this many attempts end without a result (lost worker, worker error, OOM). Attempts whose GPU was reclaimed don't count toward it.",
    }),
    phase: z.enum(RUN_PHASES).nullable().openapi({
      description:
        "What the run is doing now; null once it has finished (finished_at is set). A cancelled run whose worker hasn't stopped yet reads stopping. The run's events keep every phase it went through.",
    }),
    phase_since: IsoTimestampSchema.nullable().openapi({
      description: "When the run entered its phase; null with phase.",
    }),
    last_interruption: nullable(RunInterruptionSchema),
    workers_online: z.number().int().min(0).nullable().openapi({
      description:
        "While queued: workers of this kind holding a lease (all busy). Null otherwise.",
    }),
    autoscaling: z.boolean().nullable().openapi({
      description:
        "While queued: true when workers scale from zero (KEDA), so a worker is starting. Null otherwise.",
    }),
    queue_position: z.number().int().min(0).nullable().openapi({
      description:
        "While queued for a worker: about how many runs start before this one. Claims are fair across workspaces (the workspace with the fewest running runs goes next), so this counts other workspaces' runs too. Approximate; null otherwise.",
    }),
    queue_message: z.string().nullable().openapi({
      description:
        'While queued for a worker: why it waits, ready to show: "Queued behind 3 runs", "Queued: workspace concurrency limit (8 running)" (the workspace runs as many as it may at once), or "Waiting for a GPU with ≥46 GB; online workers have 24 GB". Null when it is next in line, and once it is claimed.',
    }),
    min_gpu_memory_gb: z.number().positive().nullable().openapi({
      description:
        "GPU memory (GB) the run needs (its plan's min_gpu_memory_gb): only workers with at least this much claim it. Null when unknown.",
    }),
    latest_metric: nullable(MetricPointSchema),
    eval_report: nullable(EvalReportSchema),
    checkpoint_evals: z.array(CheckpointEvalResultSchema).openapi({
      description:
        "recipe.evals results, one per finished eval: a checkpoint (step) on a dataset.",
    }),
    artifact_id: z.string().nullable().openapi({
      description:
        "The released artifact (`name@version`) once the run completes; null before.",
    }),
    error: z.string().nullable().openapi({
      description: "Why the run failed or stopped; null otherwise.",
    }),
    created_at: IsoTimestampSchema.openapi({
      description: "When the run was created.",
    }),
    updated_at: IsoTimestampSchema.openapi({
      description: "When the run last changed.",
    }),
    finished_at: IsoTimestampSchema.nullable().openapi({
      description:
        "When the run reached a final status; null while it is queued or running.",
    }),
    warnings: z.array(z.string()).optional().openapi({
      description:
        "Only on the response that created the run (POST /v1/runs): the plan's warnings, such as another queued or running run with the same name. They're also the run's first warning events.",
    }),
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

export type MetricsPage = z.infer<typeof MetricsPageSchema>;

export const RunCountsSchema = z
  .object({
    total: z.number().int().min(0),
    by_status: z
      .object(
        Object.fromEntries(
          RUN_STATUSES.map((status) => [status, z.number().int().min(0)]),
        ) as Record<RunStatus, z.ZodNumber>,
      )
      .openapi({ description: "Runs per status (0 when none)." }),
  })
  .openapi("RunCounts");

export type RunCounts = z.infer<typeof RunCountsSchema>;

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
    id: z.string().min(1).openapi({
      description: "Checkpoint id (`ckpt_` and 24 hex characters).",
    }),
    workspace_id: z.string().min(1),
    run_id: z
      .string()
      .min(1)
      .openapi({ description: "The run that saved it." }),
    attempt: z
      .number()
      .int()
      .min(1)
      .openapi({ description: "The attempt that saved it." }),
    step: z
      .number()
      .int()
      .min(0)
      .openapi({ description: "Optimizer step it was saved at." }),
    eval_score: z.number().nullable().openapi({
      description:
        "Held-out score at this step; null when it wasn't evaluated.",
    }),
    format: nullable(ArtifactFormatSchema).openapi({
      description:
        "Artifact format when this checkpoint is exportable (promotable); null for training state only.",
    }),
    sha256: Sha256HexSchema.openapi({
      description: "SHA-256 of the checkpoint bundle.",
    }),
    size_bytes: z
      .number()
      .int()
      .min(0)
      .openapi({ description: "Bundle size in bytes." }),
    metadata: z.record(z.string(), z.unknown()),
    best: z.boolean().openapi({
      description:
        'True for the checkpoint `select="best"` picks; it never expires.',
    }),
    final: z.boolean().openapi({
      description: "True for the run's last checkpoint; it never expires.",
    }),
    expires_at: IsoTimestampSchema.nullable().openapi({
      description:
        "When it expires (after `checkpoint_ttl_days`, 30 by default); null for checkpoints that never expire, such as the best and final.",
    }),
    created_at: IsoTimestampSchema,
  })
  .openapi("Checkpoint");

export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const PromoteCheckpointRequestSchema = z
  .object({
    name: SlugSchema.optional(),
  })
  .openapi("PromoteCheckpointRequest");

export const ArtifactProvenanceSchema = z
  .object({
    source: z.enum(["run", "upload", "import"]).openapi({
      description:
        "run: trained by a grad run; upload: files uploaded with `grad artifacts upload`; import: pulled from the Hugging Face Hub with `grad artifacts import`.",
    }),
    run_id: z.string().nullable().openapi({
      description: "source=run: the run that trained it.",
    }),
    uploader: z.string().nullable().openapi({
      description: "source=upload: the API key (principal) that uploaded it.",
    }),
    uri: z.string().nullable().openapi({
      description:
        "source=import: `hf://owner/name@<40-hex commit>`, the pinned revision it was imported from.",
    }),
  })
  .openapi("ArtifactProvenance");

export type ArtifactProvenance = z.infer<typeof ArtifactProvenanceSchema>;

export const ArtifactPinSchema = z
  .object({
    artifact_id: z.string().min(1),
    holder: z.string().min(1),
    reason: z.string(),
    created_at: IsoTimestampSchema,
  })
  .openapi("ArtifactPin");

export type ArtifactPin = z.infer<typeof ArtifactPinSchema>;

export const ArtifactSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .openapi({ description: "Artifact id: `name@version`." }),
    workspace_id: z.string().min(1),
    name: SlugSchema.openapi({
      description: "Artifact name, usually the run name.",
    }),
    version: z.string().min(1).openapi({
      description:
        "Version, `YYYY-MM-DD-N`: the release date and its sequence that day.",
    }),
    run_id: z.string().nullable().openapi({
      description: "The run that trained it; null for uploads and imports.",
    }),
    checkpoint_id: z.string().nullable().openapi({
      description:
        "The checkpoint it was promoted from; null when it is a run's final artifact or was uploaded or imported.",
    }),
    base_model: z
      .string()
      .min(1)
      .openapi({ description: "The base model the weights apply to." }),
    recipe_kind: RecipeKindSchema,
    format: ArtifactFormatSchema,
    sha256: Sha256HexSchema.openapi({
      description: "SHA-256 of the bundle; downloads verify it.",
    }),
    size_bytes: z
      .number()
      .int()
      .min(0)
      .openapi({ description: "Bundle size in bytes." }),
    manifest: z.record(z.string(), z.unknown()).openapi({
      description:
        "The bundle's manifest.json: format, base model, adapter and training settings.",
    }),
    provenance: ArtifactProvenanceSchema,
    eval_report: nullable(EvalReportSchema),
    pins: z.array(ArtifactPinSchema).openapi({
      description:
        "Holders keeping it (a published model version, say), oldest first. A pinned artifact can't be deleted.",
    }),
    created_at: IsoTimestampSchema.openapi({
      description: "When it was released.",
    }),
  })
  .openapi("Artifact");

export type Artifact = z.infer<typeof ArtifactSchema>;

const eventBase = {
  run_id: z.string().min(1),
  seq: z.number().int().min(0).openapi({
    description:
      "Position in the run's event sequence (the SSE event id; pass it as Last-Event-ID or `cursor` to resume). `completed` repeats the last stored seq.",
  }),
  attempt: z.number().int().min(1),
  timestamp: IsoTimestampSchema,
};

export const PhaseEventSchema = z
  .object({
    type: z.literal("phase"),
    ...eventBase,
    phase: RunPhaseSchema,
    step: z.number().int().min(0).openapi({
      description:
        "Training step when the phase began (0 before training; the resume step on a resumed attempt).",
    }),
    workers_online: z.number().int().min(0).nullable().openapi({
      description:
        "queued and waiting_for_compute: workers of this job kind holding a lease (all busy; an idle worker would have claimed the run).",
    }),
    autoscaling: z.boolean().nullable().openapi({
      description:
        "queued and waiting_for_compute: true when workers scale from zero (KEDA), so one is starting rather than missing.",
    }),
    queue_position: z.number().int().min(0).nullable().openapi({
      description:
        "queued and waiting_for_compute: about how many runs start before this one when the phase began (fair share across workspaces). Run.queue_position is the live value.",
    }),
    message: z.string().nullable().openapi({
      description:
        'queued and waiting_for_compute: why the run waits, ready to show ("Queued behind 3 runs", "Queued: workspace concurrency limit (8 running)", "Waiting for a GPU with ≥46 GB; online workers have 24 GB"); null when it is next in line. stopping: what the run waits for. Null for other phases.',
    }),
    gpu: nullable(GpuInfoSchema).openapi({
      description:
        "starting: the claiming worker's GPU (null without one, e.g. the reference backend). Never the worker id or host.",
    }),
  })
  .openapi("PhaseEvent");

export const MetricEventSchema = z
  .object({
    type: z.literal("metric"),
    ...eventBase,
    step: z.number().int().min(0),
    metric: MetricPointSchema,
  })
  .openapi("MetricEvent");

export const CheckpointEventSchema = z
  .object({
    type: z.literal("checkpoint"),
    ...eventBase,
    step: z.number().int().min(0),
    checkpoint_id: z.string().min(1),
    eval_score: z.number().nullable(),
    format: CheckpointSchema.shape.format,
  })
  .openapi("CheckpointEvent");

export const AttemptEventSchema = z
  .object({
    type: z.literal("attempt"),
    ...eventBase,
    event: z.enum(["started", "interrupted", "gave_up"]).openapi({
      description:
        "started: a worker claimed attempt N (resume_step: the checkpoint it resumes from). interrupted: attempt N ended without a result at `step` (resume_step: where the next attempt resumes). gave_up: no attempts left; the run failed.",
    }),
    reason: nullable(InterruptionReasonSchema),
    step: z.number().int().min(0).nullable(),
    resume_step: z.number().int().min(0).nullable().openapi({
      description: "Checkpoint step to resume from; null starts from scratch.",
    }),
    max_attempts: z.number().int().min(1),
    message: z.string(),
  })
  .openapi("AttemptEvent");

export const WarningEventSchema = z
  .object({
    type: z.literal("warning"),
    ...eventBase,
    step: z.number().int().min(0).nullable(),
    message: z.string(),
  })
  .openapi("WarningEvent");

export const LogEventSchema = z
  .object({
    type: z.literal("log"),
    ...eventBase,
    step: z.number().int().min(0).nullable(),
    message: z.string(),
  })
  .openapi("LogEvent");

export const CompletedEventSchema = z
  .object({
    type: z.literal("completed"),
    ...eventBase,
    status: RunStatusSchema,
    run: RunSchema,
  })
  .openapi("CompletedEvent");

export const RunEventSchema = z
  .discriminatedUnion("type", [
    PhaseEventSchema,
    MetricEventSchema,
    CheckpointEventSchema,
    AttemptEventSchema,
    WarningEventSchema,
    LogEventSchema,
    CompletedEventSchema,
  ])
  .openapi("RunEvent", {
    description:
      "One event of a run's lifecycle, discriminated by `type`. `completed` is always last.",
  });

export type RunEvent = z.infer<typeof RunEventSchema>;
export type CompletedEvent = z.infer<typeof CompletedEventSchema>;

export const RUN_EVENT_TYPES = [
  "phase",
  "metric",
  "checkpoint",
  "attempt",
  "warning",
  "log",
] as const;

export const RunEventsPageSchema = z
  .object({
    run_id: z.string(),
    status: RunStatusSchema,
    data: z.array(RunEventSchema),
    next_cursor: NextCursorSchema,
    tail_cursor: z.string().openapi({
      description:
        "Cursor after the newest event returned so far; pass it back as `cursor` to poll for later events.",
    }),
  })
  .openapi("RunEventsPage");

export type RunEventsPage = z.infer<typeof RunEventsPageSchema>;
