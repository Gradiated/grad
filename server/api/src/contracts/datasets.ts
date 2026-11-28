import { z } from "@hono/zod-openapi";

import { BENCHMARK_NAMES } from "../benchmarks.js";
import {
  ChatMessageSchema,
  IsoTimestampSchema,
  ModelIdSchema,
  NextCursorSchema,
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
    id: z
      .string()
      .min(1)
      .openapi({ description: "Dataset id (`ds_` and 24 hex characters)." }),
    workspace_id: z.string().min(1),
    name: SlugSchema.openapi({
      description: "Dataset name, unique in the workspace.",
    }),
    version: z.number().int().min(0).openapi({
      description:
        "Current version. Every push, import, score or sync that changes records adds one; runs and evals pin a version.",
    }),
    record_count: z.number().int().min(0).openapi({
      description:
        "Records in the current version after merging: score updates fold into their records, and a full source sync restarts the count. A record pushed again with an id it already has counts again.",
    }),
    metadata: z
      .record(z.string(), z.unknown())
      .openapi({ description: "Free-form metadata you set at creation." }),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
  })
  .openapi("Dataset");

export type Dataset = z.infer<typeof DatasetSchema>;

export const CreateDatasetRequestSchema = z
  .object({
    name: SlugSchema.openapi({
      description:
        "Dataset name: lowercase letters, digits, `.`, `_` and `-`, unique in the workspace.",
    }),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .openapi({ description: "Free-form metadata stored on the dataset." }),
  })
  .openapi("CreateDatasetRequest");

export const MAX_PUSH_RECORDS = 50_000;

export const PushDatasetRequestSchema = z
  .object({
    records: z.array(DatasetRecordSchema).min(1).max(MAX_PUSH_RECORDS).openapi({
      description:
        "Records to append; together they become the next dataset version.",
    }),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .openapi({ description: "Keys merged into the dataset's metadata." }),
  })
  .openapi("PushDatasetRequest");

export const DatasetRecordsPageSchema = z
  .object({
    dataset: SlugSchema,
    version: z.number().int().min(0),
    total: z.number().int().min(0),
    data: z.array(DatasetRecordSchema),
    next_cursor: NextCursorSchema,
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

export type RenderDatasetRequest = z.infer<typeof RenderDatasetRequestSchema>;

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
    token_counts: z.literal("estimated").openapi({
      description:
        "Token counts (total, trained and per span) are estimates (about 4 characters per token); the trainer tokenizes with the model's pinned tokenizer, and the run's metrics report the exact tokens.",
    }),
    examples: z.array(RenderedExampleSchema),
  })
  .openapi("RenderDatasetResponse");

export type RenderDatasetResponse = z.infer<typeof RenderDatasetResponseSchema>;

// --- Uploads ---------------------------------------------------------------

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export const UploadTicketSchema = z
  .object({
    upload_id: z.string().min(1).openapi({
      description:
        "The file's sha256: uploads are content-addressed, so re-uploading the same bytes is harmless.",
    }),
    method: z.literal("PUT"),
    url: z.string().min(1).openapi({
      description:
        "Presigned S3 PUT URL; send exactly `headers` (they bind the length and sha256).",
    }),
    headers: z.record(z.string(), z.string()),
    expires_at: IsoTimestampSchema,
  })
  .openapi("UploadTicket");

export type UploadTicket = z.infer<typeof UploadTicketSchema>;

export const CreateUploadRequestSchema = z
  .object({
    purpose: z.enum(["dataset_import", "artifact_import"]).openapi({
      description:
        "dataset_import (needs datasets:write) or artifact_import (artifacts:write).",
    }),
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

/** A Hugging Face Hub repo id ('owner/name'): never a path on the worker. */
export const HfRepoSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9](?:[\w-]|\.(?!\.))*(\/[A-Za-z0-9](?:[\w-]|\.(?!\.))*)?$/,
    "Expected 'owner/name'.",
  );

/** A Hub revision: a branch, tag, commit or `refs/pr/<n>`; never `..` or URL syntax. */
export const HfRevisionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]*$/,
    "Expected a branch, tag or commit.",
  );

export const ImportSourceSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("upload"),
      upload_id: z.string().min(1).max(160),
      format: z.enum(["auto", "jsonl", "json", "parquet"]).default("auto"),
    }),
    z.object({
      kind: z.literal("hf"),
      repo: HfRepoSchema,
      split: z.string().min(1).max(64).default("train"),
      config: z.string().min(1).max(128).optional(),
      revision: HfRevisionSchema.optional(),
      columns: HfColumnMappingSchema.default({}),
      limit: z.number().int().min(1).max(10_000_000).optional(),
      secret: SlugSchema.optional().openapi({
        description:
          "Name of a workspace secret holding a Hugging Face token, for gated or private datasets. The worker receives the token at claim time.",
      }),
    }),
    z.object({
      kind: z.literal("benchmark"),
      benchmark: z.enum(BENCHMARK_NAMES).openapi({
        description:
          "A built-in benchmark, imported from Hugging Face at a pinned revision with fixed prompts; evals on the dataset default to its answer check.",
      }),
      limit: z.number().int().min(1).max(10_000_000).optional().openapi({
        description: "Import the first N problems (the same ones every time).",
      }),
    }),
  ])
  .openapi("ImportSource");

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
    id: z.string().min(1).openapi({
      description: "Import job id (`imp_` and 24 hex characters).",
    }),
    workspace_id: z.string().min(1),
    dataset: SlugSchema.openapi({
      description: "The dataset the records go into.",
    }),
    status: ImportStatusSchema,
    source: z.record(z.string(), z.unknown()).openapi({
      description:
        "Where the records come from: an upload, a Hugging Face dataset, a benchmark, or a source sync.",
    }),
    connector: z.enum(CONNECTOR_NAMES).openapi({
      description:
        "The parser requested for the records (`auto` detects it from the file).",
    }),
    attempt: z
      .number()
      .int()
      .min(0)
      .openapi({ description: "Attempts started so far." }),
    imported_count: z.number().int().min(0).openapi({
      description:
        "Records this import added to the dataset (score updates for existing records add none).",
    }),
    dropped_count: z.number().int().min(0).openapi({
      description: "Rows that couldn't be imported; `drop_reasons` says why.",
    }),
    detected_scores: z
      .array(z.string())
      .openapi({ description: "Score names found on the imported records." }),
    drop_reasons: z.array(z.string()).openapi({
      description:
        "Why rows were dropped, one line per row (`line 12: invalid JSON`), capped at 100 entries.",
    }),
    dataset_version: z.number().int().min(0).nullable().openapi({
      description: "The dataset version this import produced; null until then.",
    }),
    error: z
      .string()
      .nullable()
      .openapi({ description: "Why the import failed; null otherwise." }),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
  })
  .openapi("ImportJob");

export type ImportJob = z.infer<typeof ImportJobSchema>;

// --- Filtered views ---------------------------------------------------------

export const MAX_FILTER_IDS = 200_000;

const TimeBoundSchema = z.union([IsoTimestampSchema, z.iso.date()]);

export const DatasetFilterSchema = z
  .object({
    scores: z
      .record(
        z.string().min(1).max(128),
        z.union([z.string().min(1).max(64), z.number()]),
      )
      .optional()
      .openapi({
        description:
          'Conditions on stored scores, `{name: "<op><number>"}` with op one of >=, <=, >, <, ==, != (a bare number means ==). A record without the score does not match.',
        example: { resolved: ">=0.8" },
      }),
    metadata: z
      .record(
        z.string().min(1).max(128),
        z.union([z.string(), z.number(), z.boolean()]),
      )
      .optional()
      .openapi({ description: "Exact matches on `metadata` fields." }),
    created_after: TimeBoundSchema.optional().openapi({
      description:
        "Records whose `timestamp` is at or after this time (a timestamp with offset, or a UTC date `YYYY-MM-DD`).",
    }),
    created_before: TimeBoundSchema.optional().openapi({
      description: "Records whose `timestamp` is before this time.",
    }),
    ids: z
      .array(z.string().min(1).max(160))
      .max(MAX_FILTER_IDS)
      .optional()
      .openapi({
        description:
          "Keep only these record ids (what the SDKs send for a filter function they ran locally).",
      }),
  })
  .openapi("DatasetFilter");

export type DatasetFilter = z.infer<typeof DatasetFilterSchema>;

export const FilterDatasetRequestSchema = DatasetFilterSchema.extend({
  version: z.number().int().min(1).optional().openapi({
    description: "Source version to filter (default: the current version).",
  }),
  name: SlugSchema.optional().openapi({
    description:
      "Name of the view. Default: `<dataset>-f-<hash of source, version and filter>`, so the same filter returns the same view.",
  }),
}).openapi("FilterDatasetRequest");

export type FilterDatasetRequest = z.infer<typeof FilterDatasetRequestSchema>;
