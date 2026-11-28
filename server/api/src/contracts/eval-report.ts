import { z } from "@hono/zod-openapi";
import { nullable } from "./common.js";

const score = z.number().nullable();
const count = z.number().int().min(0);
const recipes = (names: string) => ({ description: `Written by: ${names}.` });

export const RouterParetoSummarySchema = z
  .looseObject({
    target_max_drop: z.number(),
    routed_quality: score,
    quality_drop: score,
    quality_drop_ci95: z
      .array(z.number())
      .nullable()
      .openapi({ description: "95% bootstrap interval [low, high]." }),
    offload_rate: score,
    cost_savings_pct: score,
    ece: score,
    threshold: score,
    temperature: z.number(),
  })
  .openapi("RouterParetoSummary", {
    description:
      "Router quality vs. cost on the held-out report fold, against the fallback model. Values are null when no report prompt was scored for every candidate.",
  });

export const DecisionHeadReportSchema = z
  .looseObject({
    type: z.enum(["choice", "noul", "score"]),
    examples: count,
    accuracy: score,
    ece: score,
    temperature: z.number(),
    brier: z.number().optional().openapi(recipes("noul heads")),
    mae: z.number().optional().openapi(recipes("score heads")),
    macro_f1: score.optional(),
    per_option: z
      .record(
        z.string(),
        z.object({
          precision: score,
          recall: score,
          f1: score,
          support: count,
        }),
      )
      .optional(),
    confusion_matrix: z
      .object({
        labels: z.array(z.string()),
        matrix: z.array(z.array(count)),
      })
      .optional(),
  })
  .openapi("DecisionHeadReport");

export const RetrievalMetricsSchema = z
  .looseObject({
    recall_at_1: score,
    recall_at_5: score,
    recall_at_10: score,
    mrr: score,
  })
  .openapi("RetrievalMetrics");

/**
 * Held-out evaluation report written by the trainer (`eval_report.json`): a
 * common core from the shared training loop plus recipe-specific fields.
 * Unknown keys are kept so newer trainers stay readable.
 */
export const EvalReportSchema = z
  .looseObject({
    metric_name: z.string().openapi({
      description:
        "Selection metric: eval_loss (sft, router, decision, off-policy distill, pointwise-only reward), preference_accuracy (dpo, reward), eval_kl (cartridge, on-policy distill), recall_at_10 (embedding).",
    }),
    metric_mode: z.enum(["min", "max"]).optional().openapi({
      description:
        "Direction of metric_name: min (lower is better: eval_loss, eval_kl) or max (higher is better: preference_accuracy, recall_at_10). best_step and the pinned best checkpoint follow it.",
    }),
    selected_step: count,
    best_step: count.nullable(),
    final_step: count,
    train_records: count,
    eval_records: count,
    warnings: z.array(z.string()),

    eval_loss: score
      .optional()
      .openapi(recipes("sft, dpo, router, decision, distill, reward")),
    eval_token_accuracy: score.optional().openapi(recipes("sft, distill")),
    trained_token_fraction: z.number().optional().openapi(recipes("sft")),
    train_examples: count.optional().openapi(recipes("sft, distill")),
    eval_examples: count
      .optional()
      .openapi(recipes("sft, router, decision, distill")),
    selection_examples: count.optional().openapi(recipes("router, decision")),
    truncated: count.optional().openapi(recipes("sft, dpo")),

    preference_accuracy: score.optional().openapi({
      description:
        "Share of held-out pairs whose chosen answer outscores the rejected one. Written by: dpo, reward.",
    }),
    reward_margin: score.optional().openapi(recipes("dpo, reward")),
    beta: z.number().optional().openapi(recipes("dpo")),
    train_pairs: count.optional().openapi(recipes("dpo, embedding, reward")),
    eval_pairs: count.optional().openapi(recipes("dpo, embedding, reward")),
    dropped_records: count
      .optional()
      .openapi(recipes("dpo, embedding, reward")),
    train_points: count.optional().openapi(recipes("reward (pointwise)")),
    eval_points: count.optional().openapi(recipes("reward (pointwise)")),
    pointwise_brier: score.optional().openapi({
      description:
        "Mean squared error of sigmoid(reward) against the held-out scores. Written by: reward (pointwise).",
    }),

    eval_kl: score.optional().openapi(recipes("cartridge, distill")),
    base_kl: score.optional().openapi({
      description:
        "Held-out KL of the untrained student to the teacher. Written by: distill (on-policy).",
    }),
    no_context_kl: score.optional().openapi(recipes("cartridge")),
    kl_reduction: score.optional().openapi(recipes("cartridge, distill")),
    num_tokens: count.optional().openapi(recipes("cartridge")),
    teacher: z.string().optional().openapi(recipes("cartridge, distill")),
    rollout: z
      .enum(["on_policy", "off_policy"])
      .optional()
      .openapi(recipes("distill")),

    candidates: z.array(z.string()).optional().openapi(recipes("router")),
    fallback_model: z.string().optional().openapi(recipes("router")),
    fallback_quality: score.optional().openapi(recipes("router")),
    routes_any_traffic: z.boolean().optional().openapi(recipes("router")),
    pareto_summary: RouterParetoSummarySchema.optional(),

    ece: score.optional().openapi(recipes("decision")),
    heads: z
      .record(z.string(), nullable(DecisionHeadReportSchema))
      .optional()
      .openapi(recipes("decision (one entry per question)")),

    recall_at_1: score.optional().openapi(recipes("embedding")),
    recall_at_5: score.optional().openapi(recipes("embedding")),
    recall_at_10: score.optional().openapi(recipes("embedding")),
    mrr: score.optional().openapi(recipes("embedding")),
    corpus_size: count.optional().openapi(recipes("embedding")),
    baseline: nullable(RetrievalMetricsSchema).optional().openapi({
      description:
        "Retrieval metrics of the untrained base encoder. Written by: embedding.",
    }),
  })
  .openapi("EvalReport");

export type EvalReport = z.infer<typeof EvalReportSchema>;
