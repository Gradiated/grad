import { z } from "@hono/zod-openapi";

import {
  ChatMessageSchema,
  IsoTimestampSchema,
  ModelIdSchema,
  SlugSchema,
} from "./common.js";
import { DatasetRecordSchema } from "./datasets.js";

export const VALIDATOR_NAMES = ["json", "non_empty", "exact_match"] as const;

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
    models: z.array(z.string().min(1).max(200)).min(1).max(16),
    baseline: z.string().min(1).max(200).optional(),
    dataset: SlugSchema,
    dataset_version: z.number().int().min(1).optional(),
    rubric: z
      .array(EvalRubricItemSchema)
      .min(1)
      .max(32)
      .default([
        {
          name: "non_empty",
          kind: "validator",
          weight: 1.0,
          validator: "non_empty",
        },
      ]),
    samples: z.number().int().min(1).max(32).default(1),
    temperature: z.number().min(0).max(2).default(0.7),
    max_tokens: z.number().int().min(1).max(32_768).default(1024),
    limit: z.number().int().min(1).max(100_000).optional(),
    pass_threshold: z.number().min(0).max(1).nullable().default(null).openapi({
      description:
        "Defaults to 1.0 when every rubric item is binary (regex/validator) and 0.5 otherwise.",
    }),
    max_cost_usd: z.number().positive().optional().openapi({
      description:
        "Spend cap: evals.create rejects plans estimated above it, and execution stops at it (status stopped_budget).",
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
    model: z.string(),
    overall: z.number(),
    ci_low: z.number(),
    ci_high: z.number(),
    pass_at_k: z.record(z.string(), z.number()),
    vs_baseline: z
      .object({
        delta: z.number(),
        ci_low: z.number(),
        ci_high: z.number(),
      })
      .nullable(),
    tasks: z.number().int().min(0),
    errors: z.number().int().min(0),
    tokens_per_task: z.number(),
    cost_per_1k_tasks_usd: z.number().nullable(),
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
  "stopped_budget",
  "failed",
  "cancelled",
] as const;

export const EvalStatusSchema = z.enum(EVAL_STATUSES).openapi("EvalStatus");
export type EvalStatus = z.infer<typeof EvalStatusSchema>;

export const EvalRunSchema = z
  .object({
    id: z.string().min(1),
    workspace_id: z.string().min(1),
    name: SlugSchema,
    status: EvalStatusSchema,
    models: z.array(z.string()),
    baseline: z.string().nullable(),
    task_source: z.object({
      kind: z.literal("dataset"),
      dataset: SlugSchema,
      version: z.number().int().min(0),
    }),
    rubric: z.array(EvalRubricItemSchema),
    samples: z.number().int().min(1),
    temperature: z.number().min(0).max(2),
    max_tokens: z.number().int().min(1),
    pass_threshold: z.number().min(0).max(1),
    judge_models: z.array(z.string()),
    local_scorers: z.array(z.string()),
    progress: z.object({
      total_outputs: z.number().int().min(0),
      generated: z.number().int().min(0),
      pending_local_scores: z.number().int().min(0),
    }),
    summary: z.array(EvalModelSummarySchema),
    total_cost_usd: z.number().min(0),
    max_cost_usd: z.number().positive().nullable().openapi({
      description:
        "Spend cap. Generation stops once outputs cost this much and the eval ends stopped_budget with partial results.",
    }),
    error: z.string().nullable(),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
    completed_at: IsoTimestampSchema.nullable(),
  })
  .openapi("EvalRun");

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
