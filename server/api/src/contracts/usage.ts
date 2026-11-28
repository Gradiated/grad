import { z } from "@hono/zod-openapi";

import { IsoTimestampSchema, PageQuerySchema } from "./common.js";

export const USAGE_KINDS = [
  "training",
  "eval",
  "scoring",
  "labeling",
  "teacher",
] as const;

export const UsageKindSchema = z.enum(USAGE_KINDS).openapi("UsageKind", {
  description:
    "What the tokens paid for: `training` (a run's attempts), `eval` (evals, including a run's checkpoint evals), `scoring` (dataset.score), `labeling` (a router run's labeling eval) or `teacher` (an off-policy distill run's teacher answers).",
});

export type UsageKind = z.infer<typeof UsageKindSchema>;

export const USAGE_GROUPS = [
  "day",
  "week",
  "month",
  "model",
  "recipe",
  "kind",
] as const;

export const UsageGroupBySchema = z.enum(USAGE_GROUPS).openapi("UsageGroupBy");

export type UsageGroupBy = z.infer<typeof UsageGroupBySchema>;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/i;

const isCalendarDate = (y: number, m: number, d: number): boolean => {
  const t = new Date(Date.UTC(y, m - 1, d));

  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === m - 1 &&
    t.getUTCDate() === d
  );
};

/**
 * A period bound: `YYYY-MM-DD` (a UTC day) or an ISO 8601 timestamp (UTC when
 * it names no offset). `from` starts at the bound; `to` ends before it, and a
 * date `to` covers that whole day. Null when `value` is neither.
 */
export const parseUsageBound = (
  value: string,
  edge: "from" | "to",
): Date | null => {
  const date = DATE.exec(value);
  const parts = date ?? TIMESTAMP.exec(value);
  if (!parts) return null;

  const [y, m, d] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (!isCalendarDate(y, m, d)) return null;
  if (date) return new Date(Date.UTC(y, m - 1, d + (edge === "to" ? 1 : 0)));

  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
  const at = new Date(zoned);

  return Number.isNaN(at.getTime()) ? null : at;
};

const boundSchema = (edge: "from" | "to") =>
  z
    .string()
    .max(40)
    .refine((v) => parseUsageBound(v, edge) !== null, {
      message:
        "must be a date (YYYY-MM-DD) or an ISO 8601 timestamp, e.g. 2026-11-01 or 2026-11-01T09:30:00Z",
    })
    .optional()
    .openapi({
      description:
        edge === "from"
          ? "Start of the period (inclusive): YYYY-MM-DD (UTC) or an ISO 8601 timestamp."
          : "End of the period: a date YYYY-MM-DD covers that whole UTC day; a timestamp is exclusive.",
    });

const PeriodQuerySchema = z.object({
  from: boundSchema("from"),
  to: boundSchema("to"),
});

export const UsageQuerySchema = PageQuerySchema.extend({
  ...PeriodQuerySchema.shape,
  run_id: z.string().min(1).max(64).optional().openapi({
    description:
      "Only usage billed for this run: its training and the evals it started (labeling, teacher answers, checkpoint evals).",
  }),
  eval_id: z.string().min(1).max(64).optional(),
  // Inline enums: the SDK generators take scalar query parameters only.
  kind: z.enum(USAGE_KINDS).optional(),
});

export type UsageQuery = z.infer<typeof UsageQuerySchema>;

export const UsageSummaryQuerySchema = PeriodQuerySchema.extend({
  group_by: z.enum(USAGE_GROUPS).optional(),
});

export type UsageSummaryQuery = z.infer<typeof UsageSummaryQuerySchema>;

export const UsageRecordSchema = z
  .object({
    id: z.string().min(1).openapi({ description: "Usage row id." }),
    kind: UsageKindSchema,
    ref_id: z.string().min(1).openapi({
      description: "The run (kind `training`) or eval this usage belongs to.",
    }),
    ref_name: z
      .string()
      .nullable()
      .openapi({ description: "The run's or eval's name." }),
    run_id: z.string().nullable().openapi({
      description:
        "The run the usage was billed for: the run itself, or the run whose labeling, teacher or checkpoint eval it is.",
    }),
    attempt: z
      .number()
      .int()
      .min(1)
      .openapi({ description: "The attempt the tokens belong to." }),
    tokens_from: z.number().int().min(0).openapi({
      description:
        "The attempt's tokens this row starts after (usage is billed in increments while an attempt runs).",
    }),
    tokens_through: z.number().int().min(0).openapi({
      description:
        "The attempt's tokens this row ends at; `tokens` is the difference from `tokens_from`.",
    }),
    tokens: z
      .number()
      .int()
      .min(0)
      .openapi({ description: "Tokens billed in this row." }),
    cost_usd: z.number().min(0).openapi({ description: "The charge, in USD." }),
    price_version: z.string().min(1).openapi({
      description:
        "The version of the catalog price the charge was computed with.",
    }),
    billed_by: z.enum(["grad", "gateway"]).openapi({
      description:
        "Who bills this usage: `grad` (training, and evals on a self-hosted server) or `gateway` (on Gradiated Cloud, eval model and judge tokens are billed once by the inference gateway; shown here, not charged twice).",
    }),
    idempotency_key: z.string().min(1).openapi({
      description:
        "`run-usage:{id}:{attempt}:{tokens_through}` (`eval-usage:` for evals); unique, so an increment is never billed twice.",
    }),
    created_at: IsoTimestampSchema.openapi({
      description: "When the increment was billed.",
    }),
  })
  .openapi("UsageRecord");

export type UsageRecord = z.infer<typeof UsageRecordSchema>;

const totals = {
  cost_usd: z.number().min(0),
  tokens: z.number().int().min(0),
};

export const UsageRefTotalSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    kind: UsageKindSchema,
    ...totals,
  })
  .openapi("UsageRefTotal");

export const UsageKindTotalSchema = z
  .object({
    kind: UsageKindSchema,
    ...totals,
    records: z.number().int().min(0),
  })
  .openapi("UsageKindTotal");

export const UsageGroupSchema = z
  .object({
    key: z.string().nullable().openapi({
      description:
        "The group: a UTC day or week start (YYYY-MM-DD), a month (YYYY-MM), a model, a recipe or a kind. Null for usage with no recipe (plain evals, scoring).",
    }),
    ...totals,
    records: z.number().int().min(0),
  })
  .openapi("UsageGroup");

export const UsageSummarySchema = z
  .object({
    from: IsoTimestampSchema.openapi({
      description: "Start of the period (inclusive).",
    }),
    to: IsoTimestampSchema.openapi({
      description: "End of the period (exclusive).",
    }),
    ...totals,
    records: z.number().int().min(0),
    by_kind: z.array(UsageKindTotalSchema).openapi({
      description: "One entry per kind with usage, costliest first.",
    }),
    top_runs: z.array(UsageRefTotalSchema).openapi({
      description: "The costliest runs' training in the period (up to 5).",
    }),
    top_evals: z.array(UsageRefTotalSchema).openapi({
      description:
        "The costliest evals, scoring, labeling and teacher jobs in the period (up to 5).",
    }),
    group_by: UsageGroupBySchema.nullable(),
    groups: z.array(UsageGroupSchema).openapi({
      description:
        "With group_by: one entry per group with usage, oldest first for time groups and costliest first otherwise.",
    }),
  })
  .openapi("UsageSummary");

export type UsageSummary = z.infer<typeof UsageSummarySchema>;
