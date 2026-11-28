import { z } from "@hono/zod-openapi";

export const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);

export const ModelIdSchema = z
  .string()
  .min(1)
  .max(160)
  .transform((value) => value.trim().toLowerCase());

export const IsoTimestampSchema = z.string().datetime({ offset: true });

export const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Must be a lowercase hex SHA-256 digest.");

export const ProblemSchema = z
  .object({
    type: z.string().url(),
    title: z.string().min(1).max(200),
    status: z.number().int().min(400).max(599),
    detail: z.string().min(1).max(4000),
    code: z.string().min(1).max(80),
    request_id: z.string().min(1),
  })
  .openapi("Problem");

export const MAX_PAGE_LIMIT = 200;

/**
 * `limit` query parameter of a list endpoint: values above `max` are clamped
 * to `max` (never a 422), values below 1 are rejected. The documented
 * `maximum` is what codegen emits as each SDK's page-size constant.
 */
export const pageLimitSchema = (max: number, fallback: number) =>
  z.coerce
    .number()
    .int()
    .min(1)
    .default(fallback)
    .transform((value) => Math.min(value, max))
    .openapi({
      type: "integer",
      minimum: 1,
      maximum: max,
      default: fallback,
      description: `Page size (default ${fallback}). Values above ${max} are clamped to ${max}.`,
    });

export const PageQuerySchema = z.object({
  limit: pageLimitSchema(MAX_PAGE_LIMIT, 50),
  cursor: z.string().min(1).max(512).optional(),
});

/** `?status=queued,running`: a comma-separated subset of `values`. */
export const statusFilterSchema = <
  const T extends readonly [string, ...string[]],
>(
  values: T,
) =>
  z
    .string()
    .max(200)
    .transform((s) => [
      ...new Set(
        s
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
      ),
    ])
    .pipe(z.array(z.enum(values)).min(1))
    .optional()
    .openapi({
      type: "string",
      example: values.slice(0, 2).join(","),
      description: `Only these statuses, comma-separated: ${values.join(", ")}.`,
    });

/** `?q=`: a case-insensitive substring of the name, or an exact id. */
export const SearchQuerySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .optional()
  .openapi({
    description:
      "Only items whose name contains this text (any case), or whose id is exactly this.",
  });

export const NextCursorSchema = z.string().nullable().openapi({
  description:
    "Pass back as `cursor` for the next page; null on the last page (every list endpoint).",
});

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item),
    next_cursor: NextCursorSchema,
  });

export const ChatMessageSchema = z
  .looseObject({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z
      .union([z.string(), z.array(z.record(z.string(), z.unknown()))])
      .nullable()
      .optional(),
    tool_calls: z.array(z.record(z.string(), z.unknown())).optional(),
    tool_call_id: z.string().optional(),
    name: z.string().optional(),
    train: z.boolean().optional(),
  })
  .openapi("ChatMessage");

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const messageText = (message: ChatMessage): string => {
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
};
