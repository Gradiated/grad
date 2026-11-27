import { z } from "@hono/zod-openapi";

import { SOURCE_FILTER_KEYS, type SourceProviderKind } from "../contracts.js";
import { invalid } from "../errors.js";

/**
 * Validates a source's filters and returns the effective ones (single values
 * as lists). The trainer applies them (grad_trainer/providers/filters.py);
 * this is the one place that rejects a key a provider doesn't take, so a typo
 * is a 422 here instead of a filter nobody applies.
 */

const scalar = z
  .union([z.string().min(1).max(500), z.number(), z.boolean()])
  .transform(String);
const list = z
  .union([scalar, z.array(scalar).min(1).max(100)])
  .transform((v) => (Array.isArray(v) ? v : [v]));
const when = z.string().datetime({ offset: true });

const VALUES: Record<string, z.ZodType> = {
  tags: list,
  environment: list,
  model: list,
  version: list,
  release: list,
  name: list,
  user_id: list,
  session_id: list,
  metadata: z
    .record(
      z.string().min(1).max(200),
      z.union([z.string().max(500), z.number(), z.boolean()]),
    )
    .refine((v) => Object.keys(v).length <= 20, "at most 20 keys"),
  from: when,
  to: when,
  has_feedback: z.boolean(),
  min_score: z.union([
    z.number(),
    z
      .record(z.string().min(1).max(160), z.number())
      .refine((v) => Object.keys(v).length > 0, "name at least one score"),
  ]),
  filter: z.string().min(1).max(4000),
  models: list,
  tasks: list,
  versions: list,
};

export const effectiveFilters = (
  kind: SourceProviderKind,
  filters: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  const allowed = SOURCE_FILTER_KEYS[kind];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filters ?? {})) {
    const schema = VALUES[key];
    if (!allowed.includes(key) || !schema) {
      throw invalid(
        "source_filter_unsupported",
        `The ${kind} source has no filter '${key}'. Its filters: ${allowed.join(", ")}.`,
      );
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw invalid(
        "source_filter_invalid",
        `Filter '${key}': ${parsed.error.issues.map((i) => i.message).join("; ")}.`,
      );
    }
    out[key] = parsed.data;
  }
  if (
    typeof out.from === "string" &&
    typeof out.to === "string" &&
    Date.parse(out.from) >= Date.parse(out.to)
  ) {
    throw invalid(
      "source_filter_invalid",
      "Filter 'from' must be before 'to'.",
    );
  }

  return out;
};

/** The filters the Gradiated Cloud pull applies itself. */
export const cloudFilters = (
  filters: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(filters).filter(([key]) =>
      ["models", "tasks", "versions"].includes(key),
    ),
  );
