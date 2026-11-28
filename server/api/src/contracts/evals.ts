import { z } from "@hono/zod-openapi";

import {
  ChatMessageSchema,
  IsoTimestampSchema,
  ModelIdSchema,
  SlugSchema,
} from "./common.js";
import { DatasetRecordSchema } from "./datasets.js";

export const VALIDATOR_NAMES = [
  "json",
  "non_empty",
  "exact_match",
  "final_number",
  "choice",
] as const;

export const BINARY_RUBRIC_KINDS = ["regex", "validator"] as const;

export const MAX_REGEX_PATTERN_LENGTH = 256;

export const EvalRubricItemSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9_.:-]+$/),
    kind: z.enum(["regex", "validator", "code", "judge"]),
    weight: z.number().positive().default(1.0),
    pattern: z.string().max(MAX_REGEX_PATTERN_LENGTH).optional(),
    flags: z
      .string()
      .regex(/^[imsu]*$/)
      .max(4)
      .optional(),
    validator: z.enum(VALIDATOR_NAMES).optional(),
    model: ModelIdSchema.optional(),
    prompt: z.string().max(8000).optional(),
    runtime: z.literal("local").optional().openapi({
      description:
        "Code scorers always run in the SDK process (`local`); the eval waits in `awaiting_scores` until the SDK posts their scores.",
    }),
  })
  .superRefine((item, ctx) => {
    if (item.kind === "judge" && !item.model) {
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message: "Judge rubric items require an explicit 'model'.",
      });
    }
    if (item.kind === "validator" && !item.validator) {
      ctx.addIssue({
        code: "custom",
        path: ["validator"],
        message: `Validator rubric items require 'validator' (${VALIDATOR_NAMES.join(", ")}).`,
      });
    }
    if (item.kind === "regex") {
      if (!item.pattern) {
        ctx.addIssue({
          code: "custom",
          path: ["pattern"],
          message: "Regex rubric items require 'pattern'.",
        });
        return;
      }
      try {
        new RegExp(item.pattern, item.flags ?? "");
      } catch (err) {
        ctx.addIssue({
          code: "custom",
          path: ["pattern"],
          message: `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  })
  .openapi("EvalRubricItem");

export type EvalRubricItem = z.infer<typeof EvalRubricItemSchema>;

export const PlanEvalRequestSchema = z
  .object({
    name: SlugSchema.default("eval-run"),
    models: z.array(z.string().min(1).max(200)).min(1).max(16).openapi({
      description:
        "The models to evaluate: catalog ids, artifacts (`name@version`) or models your inference endpoint serves.",
    }),
    baseline: z.string().min(1).max(200).optional().openapi({
      description:
        "One of `models`; the summary reports every other model's difference from it.",
    }),
    dataset: SlugSchema.openapi({
      description: "The dataset whose records are the tasks.",
    }),
    dataset_version: z.number().int().min(1).optional().openapi({
      description:
        "The version to evaluate. Default: the current one, pinned when the eval is created.",
    }),
    rubric: z.array(EvalRubricItemSchema).min(1).max(32).optional().openapi({
      description:
        "Default: the dataset's own rubric (a benchmark's answer check), else a non_empty validator.",
    }),
    samples: z.number().int().min(1).max(32).default(1).openapi({
      description:
        "Answers per task and model; 3 or more for decisions you will act on.",
    }),
    temperature: z
      .number()
      .min(0)
      .max(2)
      .default(0.7)
      .openapi({ description: "Sampling temperature of the model calls." }),
    max_tokens: z
      .number()
      .int()
      .min(1)
      .max(32_768)
      .default(1024)
      .openapi({ description: "The most tokens each answer may have." }),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .optional()
      .openapi({ description: "Evaluate only the first `limit` tasks." }),
    pass_threshold: z.number().min(0).max(1).nullable().default(null).openapi({
      description:
        "Defaults to 1.0 when every rubric item is binary (regex/validator) and 0.5 otherwise.",
    }),
  })
  .strict()
  .openapi("PlanEvalRequest");

export type PlanEvalRequest = z.infer<typeof PlanEvalRequestSchema>;

export const PlanEvalResponseSchema = z
  .object({
    task_source_kind: z.literal("dataset"),
    dataset_version: z.number().int().min(0),
    estimated_tasks: z.number().int().min(0),
    estimated_model_calls: z.number().int().min(0),
    estimated_judge_calls: z.number().int().min(0),
    estimated_cost_usd: z.number().min(0),
    judge_models: z.array(z.string()),
    local_scorers: z.array(z.string()),
    pass_threshold: z.number().min(0).max(1),
    warnings: z.array(z.string()),
  })
  .openapi("PlanEvalResponse");

export type PlanEvalResponse = z.infer<typeof PlanEvalResponseSchema>;

export const EvalModelSummarySchema = z
  .object({
    model: z
      .string()
      .openapi({ description: "The model this summary is for." }),
    overall: z.number().openapi({
      description: "Mean task score (each task's score averages its samples).",
    }),
    ci_low: z.number().openapi({
      description:
        "Lower bound of the bootstrap 95% confidence interval on `overall`.",
    }),
    ci_high: z.number().openapi({
      description:
        "Upper bound of the bootstrap 95% confidence interval on `overall`.",
    }),
    pass_at_k: z.record(z.string(), z.number()).openapi({
      description:
        "Unbiased pass@k per k (`pass@1`, ...): the chance that one of k samples scores at least `pass_threshold`.",
    }),
    vs_baseline: z
      .object({
        delta: z.number(),
        ci_low: z.number(),
        ci_high: z.number(),
      })
      .nullable()
      .openapi({
        description:
          "The mean paired difference from the baseline over the tasks both answered, with a bootstrap 95% interval; null for the baseline itself or without one.",
      }),
    tasks: z
      .number()
      .int()
      .min(0)
      .openapi({ description: "Tasks this model answered." }),
    errors: z
      .number()
      .int()
      .min(0)
      .openapi({ description: "Model or judge calls that failed." }),
    tokens_per_task: z
      .number()
      .openapi({ description: "Mean tokens per task." }),
    cost_per_1k_tasks_usd: z.number().nullable().openapi({
      description:
        "Cost per 1,000 tasks in USD; null when the model has no price.",
    }),
  })
  .openapi("EvalModelSummary");

export type EvalModelSummary = z.infer<typeof EvalModelSummarySchema>;

export const EvalTaskOutcomeSchema = z
  .object({
    task_id: z.string(),
    model: z.string(),
    score: z.number(),
    passed: z.boolean(),
    sample_scores: z.array(z.number()),
    judge_model: z.string().nullable(),
    record: DatasetRecordSchema,
  })
  .openapi("EvalTaskOutcome");

export type EvalTaskOutcome = z.infer<typeof EvalTaskOutcomeSchema>;

export const EVAL_STATUSES = [
  "queued",
  "running",
  "awaiting_scores",
  "completed",
  "failed",
  "cancelled",
] as const;

export const EvalStatusSchema = z.enum(EVAL_STATUSES).openapi("EvalStatus");
export type EvalStatus = z.infer<typeof EvalStatusSchema>;

export const EvalModeSchema = z.enum(["eval", "score"]).openapi("EvalMode", {
  description:
    "`eval` generates outputs from `models`; `score` (`dataset.score()`) grades each record's own output (model `record`) and writes the scores to the dataset's next version.",
});
export type EvalMode = z.infer<typeof EvalModeSchema>;

/** The model name of a scoring job's outputs: the record's own answer. */
export const RECORD_MODEL = "record";

export const EvalRunSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .openapi({ description: "Eval id (`eval_` and 24 hex characters)." }),
    workspace_id: z.string().min(1),
    name: SlugSchema,
    status: EvalStatusSchema,
    mode: EvalModeSchema,
    models: z.array(z.string()).openapi({
      description:
        "The models evaluated: catalog ids, artifacts (`name@version`) or models the inference endpoint serves.",
    }),
    baseline: z.string().nullable().openapi({
      description:
        "The model the summary compares the others with (`vs_baseline`); null for none.",
    }),
    task_source: z.object({
      kind: z.literal("dataset"),
      dataset: SlugSchema,
      version: z.number().int().min(0),
    }),
    rubric: z.array(EvalRubricItemSchema),
    samples: z
      .number()
      .int()
      .min(1)
      .openapi({ description: "Answers generated per task and model." }),
    temperature: z
      .number()
      .min(0)
      .max(2)
      .openapi({ description: "Sampling temperature of the model calls." }),
    max_tokens: z
      .number()
      .int()
      .min(1)
      .openapi({ description: "The most tokens each answer may have." }),
    pass_threshold: z
      .number()
      .min(0)
      .max(1)
      .openapi({ description: "Score at or above which a task passes." }),
    judge_models: z
      .array(z.string())
      .openapi({ description: "The judge models the rubric calls." }),
    local_scorers: z.array(z.string()).openapi({
      description:
        "Code scorers that run in the SDK process; the eval waits in `awaiting_scores` until they post their scores.",
    }),
    progress: z.object({
      total_outputs: z.number().int().min(0),
      generated: z.number().int().min(0),
      pending_local_scores: z.number().int().min(0),
    }),
    summary: z.array(EvalModelSummarySchema),
    total_cost_usd: z.number().min(0).openapi({
      description: "Cost of the model and judge calls so far, in USD.",
    }),
    scored_dataset_version: z.number().int().min(1).nullable().openapi({
      description:
        "Scoring jobs: the dataset version holding the new scores (the source version when every record was already scored); null until completed.",
    }),
    error: z
      .string()
      .nullable()
      .openapi({ description: "Why the eval failed; null otherwise." }),
    waiting_reason: z
      .enum(["capacity_unavailable", "rate_limited", "inference_unavailable"])
      .nullable()
      .openapi({
        description:
          "While running: the eval's model calls are waiting for capacity (a serving pool at zero that has not woken yet), for a rate limit (a full eval lane), or for an inference endpoint that is down. The worker keeps its lease and retries; this is not counted as a failed attempt. null otherwise.",
      }),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
    completed_at: IsoTimestampSchema.nullable().openapi({
      description: "When the eval reached a final status; null until then.",
    }),
  })
  .openapi("EvalRun");

export const ScoreDatasetRequestSchema = z
  .object({
    rubric: z.array(EvalRubricItemSchema).min(1).max(32),
    version: z.number().int().min(1).optional().openapi({
      description: "Dataset version to score (default: the current version).",
    }),
    name: SlugSchema.optional().openapi({
      description: "Name of the scoring job (default `<dataset>-score`).",
    }),
    limit: z.number().int().min(1).max(100_000).optional(),
  })
  .strict()
  .openapi("ScoreDatasetRequest");

export type ScoreDatasetRequest = z.infer<typeof ScoreDatasetRequestSchema>;

export type EvalRun = z.infer<typeof EvalRunSchema>;

export const EvalOutputSchema = z
  .object({
    id: z.string().min(1),
    eval_id: z.string().min(1),
    task_id: z.string().min(1),
    model: z.string().min(1),
    sample_index: z.number().int().min(0),
    input: z.array(ChatMessageSchema),
    output: z.string().nullable(),
    expected_output: z.unknown().nullable(),
    record: DatasetRecordSchema,
    scores: z.record(z.string(), z.number()),
    error: z.string().nullable(),
    usage: z.object({
      prompt_tokens: z.number().int().min(0),
      completion_tokens: z.number().int().min(0),
    }),
  })
  .openapi("EvalOutput");

export type EvalOutput = z.infer<typeof EvalOutputSchema>;

export const PostEvalScoresRequestSchema = z
  .object({
    scores: z
      .array(
        z.object({
          output_id: z.string().min(1),
          scorer: z.string().min(1).max(80),
          score: z.number().min(0).max(1),
        }),
      )
      .min(1)
      .max(10_000),
  })
  .openapi("PostEvalScoresRequest");

export const PostEvalScoresResponseSchema = z
  .object({
    accepted: z.number().int().min(0),
    status: EvalStatusSchema,
    pending_local_scores: z.number().int().min(0),
  })
  .openapi("PostEvalScoresResponse");
