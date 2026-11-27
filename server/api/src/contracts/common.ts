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

export type Problem = z.infer<typeof ProblemSchema>;

export const MAX_PAGE_LIMIT = 200;

export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

export type PageQuery = z.infer<typeof PageQuerySchema>;

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({
    data: z.array(item),
    next_cursor: z.string().nullable(),
  });

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

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
