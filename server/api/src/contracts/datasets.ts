import { z } from "@hono/zod-openapi";

import {
  ChatMessageSchema,
  IsoTimestampSchema,
  ModelIdSchema,
  Sha256HexSchema,
  SlugSchema,
} from "./common.js";

const TextOrMessagesSchema = z.union([z.string(), z.array(ChatMessageSchema)]);

export const TRAJECTORY_ROLES = [
  "chosen",
  "rejected",
  "anchor",
  "positive",
  "negative",
  "desirable",
  "undesirable",
  "rollout",
] as const;

export const TrajectoryInputSchema = z
  .looseObject({
    messages: z.array(ChatMessageSchema).optional(),
    tools: z.array(z.record(z.string(), z.unknown())).optional(),
    media: z.array(z.record(z.string(), z.unknown())).optional(),
    features: z.record(z.string(), z.unknown()).optional(),
    payload: z.unknown().optional(),
  })
  .openapi("TrajectoryInput");

export const TrajectoryOutputSchema = z
  .looseObject({
    turns: z.array(ChatMessageSchema).optional(),
    payload: z.unknown().optional(),
  })
  .openapi("TrajectoryOutput");

/**
 * One dataset record. Plain chat records (`messages`), preference pairs
 * (`prompt`/`chosen`/`rejected`), retrieval triples (`query`/`positive`/
 * `negatives`), decision records (`state`/`questions`/`expected_output`) and
 * `grad.trajectory/1` objects (`schema`/`input`/`output`/`role`) all validate.
 * Unknown top-level keys are rejected rather than silently dropped; put custom
 * fields under `metadata`.
 */
export const DatasetRecordSchema = z
  .strictObject({
    schema: z.literal("grad.trajectory/1").optional(),
    id: z.string().min(1).max(160).optional(),
    session_id: z.string().min(1).max(160).nullable().optional(),
    group_id: z.string().min(1).max(160).nullable().optional(),
    role: z.enum(TRAJECTORY_ROLES).nullable().optional(),
    source: z.string().max(80).nullable().optional(),
    timestamp: z.string().max(64).nullable().optional(),
    messages: z.array(ChatMessageSchema).optional(),
    tools: z.array(z.record(z.string(), z.unknown())).optional(),
    input: TrajectoryInputSchema.optional(),
    output: TrajectoryOutputSchema.nullable().optional(),
    prompt: TextOrMessagesSchema.optional(),
    completion: TextOrMessagesSchema.optional(),
    chosen: TextOrMessagesSchema.optional(),
    rejected: TextOrMessagesSchema.optional(),
    query: z.string().optional(),
    positive: z.string().optional(),
    negatives: z.array(z.string()).optional(),
    state: z.unknown().optional(),
    questions: z.record(z.string(), z.unknown()).optional(),
    expected_output: z.unknown().optional(),
    scores: z.record(z.string(), z.number()).optional(),
    metrics: z.record(z.string(), z.number()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("DatasetRecord");

export type DatasetRecord = z.infer<typeof DatasetRecordSchema>;

export const DatasetSchema = z
  .object({
    id: z.string().min(1),
    workspace_id: z.string().min(1),
    name: SlugSchema,
    version: z.number().int().min(0),
    record_count: z.number().int().min(0),
    metadata: z.record(z.string(), z.unknown()),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
  })
  .openapi("Dataset");

export type Dataset = z.infer<typeof DatasetSchema>;

export const CreateDatasetRequestSchema = z
  .object({
    name: SlugSchema,
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("CreateDatasetRequest");

export const MAX_PUSH_RECORDS = 50_000;

export const PushDatasetRequestSchema = z
  .object({
    records: z.array(DatasetRecordSchema).min(1).max(MAX_PUSH_RECORDS),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("PushDatasetRequest");

export const DatasetRecordsPageSchema = z
  .object({
    dataset: SlugSchema,
    version: z.number().int().min(0),
    total: z.number().int().min(0),
    data: z.array(DatasetRecordSchema),
    next_cursor: z.string().nullable(),
  })
  .openapi("DatasetRecordsPage");

export const RenderDatasetRequestSchema = z
  .object({
    model: ModelIdSchema.default("qwen/qwen3-8b"),
    train_on: z.enum(["last", "all_assistant"]).default("last"),
    thinking: z.enum(["auto", "on", "off"]).default("auto"),
    preserve_thinking: z.boolean().default(false),
    limit: z.number().int().min(1).max(20).default(3),
  })
  .openapi("RenderDatasetRequest");

export const RenderedSpanSchema = z.object({
  text: z.string(),
  trained: z.boolean(),
  tokens: z.number().int().min(0),
});

export const RenderedExampleSchema = z.object({
  record_id: z.string(),
  template_revision: z.string(),
  total_tokens: z.number().int().min(0),
  trained_tokens: z.number().int().min(0),
  trained_fraction: z.number().min(0).max(1),
  spans: z.array(RenderedSpanSchema),
});

export const RenderDatasetResponseSchema = z
  .object({
    dataset: SlugSchema,
    model: z.string(),
    template_revision: z.string(),
    token_counts: z.literal("estimated"),
    examples: z.array(RenderedExampleSchema),
  })
  .openapi("RenderDatasetResponse");

// --- Uploads ---------------------------------------------------------------

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export const UploadTicketSchema = z
  .object({
    upload_id: z.string().min(1),
    method: z.literal("PUT"),
    url: z.string().min(1).openapi({
      description:
        "Absolute presigned URL, or a path relative to the API base URL (local storage).",
    }),
    headers: z.record(z.string(), z.string()),
    expires_at: IsoTimestampSchema,
  })
  .openapi("UploadTicket");

export type UploadTicket = z.infer<typeof UploadTicketSchema>;

export const CreateUploadRequestSchema = z
  .object({
    purpose: z.literal("dataset_import"),
    filename: z.string().min(1).max(255),
    size_bytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
    sha256: Sha256HexSchema,
  })
  .openapi("CreateUploadRequest");

// --- Imports ----------------------------------------------------------------

export const CONNECTOR_NAMES = [
  "auto",
  "grad_trajectories",
  "openai_chat",
  "gradiated",
  "otel",
  "langfuse",
  "posthog",
  "braintrust",
  "langsmith",
] as const;

export const HfColumnMappingSchema = z
  .object({
    messages: z.string().min(1).max(128).optional(),
    prompt: z.string().min(1).max(128).optional(),
    completion: z.string().min(1).max(128).optional(),
    chosen: z.string().min(1).max(128).optional(),
    rejected: z.string().min(1).max(128).optional(),
    answer: z.string().min(1).max(128).optional(),
    query: z.string().min(1).max(128).optional(),
    positive: z.string().min(1).max(128).optional(),
  })
  .openapi("HfColumnMapping");

export const ImportSourceSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("upload"),
      upload_id: z.string().min(1).max(160),
      format: z.enum(["auto", "jsonl", "json", "parquet"]).default("auto"),
    }),
    z.object({
      kind: z.literal("hf"),
      repo: z
        .string()
        .min(1)
        .max(200)
        .regex(/^[A-Za-z0-9][\w.-]*(\/[\w.-]+)?$/, "Expected 'owner/name'."),
      split: z.string().min(1).max(64).default("train"),
      config: z.string().min(1).max(128).optional(),
      revision: z.string().min(1).max(128).optional(),
      columns: HfColumnMappingSchema.default({}),
      limit: z.number().int().min(1).max(10_000_000).optional(),
    }),
  ])
  .openapi("ImportSource");

export type ImportSource = z.infer<typeof ImportSourceSchema>;

export const CreateImportRequestSchema = z
  .object({
    source: ImportSourceSchema,
    connector: z.enum(CONNECTOR_NAMES).default("auto"),
  })
  .openapi("CreateImportRequest");

export const ImportStatusSchema = z
  .enum(["queued", "running", "completed", "failed"])
  .openapi("ImportStatus");

export type ImportStatus = z.infer<typeof ImportStatusSchema>;

export const ImportJobSchema = z
  .object({
    id: z.string().min(1),
    workspace_id: z.string().min(1),
    dataset: SlugSchema,
    status: ImportStatusSchema,
    source: z.record(z.string(), z.unknown()),
    connector: z.enum(CONNECTOR_NAMES),
    attempt: z.number().int().min(0),
    imported_count: z.number().int().min(0),
    dropped_count: z.number().int().min(0),
    detected_scores: z.array(z.string()),
    dataset_version: z.number().int().min(0).nullable(),
    error: z.string().nullable(),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
  })
  .openapi("ImportJob");

export type ImportJob = z.infer<typeof ImportJobSchema>;
