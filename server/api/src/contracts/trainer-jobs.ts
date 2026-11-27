import { z } from "@hono/zod-openapi";

import { IsoTimestampSchema, Sha256HexSchema } from "./common.js";
import { EvalReportSchema } from "./eval-report.js";
import {
  CONNECTOR_NAMES,
  DatasetRecordSchema,
  ImportJobSchema,
  MAX_UPLOAD_BYTES,
} from "./datasets.js";
import {
  ArtifactFormatSchema,
  ArtifactSchema,
  CheckpointSchema,
  MetricPointInputSchema,
  RecipeKindSchema,
  ResolvedRunConfigSchema,
  RunSchema,
  RunStatusSchema,
} from "./runs.js";

export const TRAINER_PROTOCOL_VERSION = "grad.trainer-protocol/1";

export const JobKindSchema = z.enum(["train", "import"]).openapi("JobKind");
export type JobKind = z.infer<typeof JobKindSchema>;

const WorkerIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._:-]+$/);

const LeaseSecondsSchema = z.number().int().min(30).max(3600);

const AttemptRefShape = {
  worker_id: WorkerIdSchema,
  attempt: z.number().int().min(1),
};

export const ClaimJobRequestSchema = z
  .object({
    worker_id: WorkerIdSchema,
    lease_seconds: LeaseSecondsSchema.default(180),
    kinds: z.array(JobKindSchema).min(1).default(["train", "import"]),
    recipes: z.array(RecipeKindSchema).min(1).optional().openapi({
      description:
        "Recipe kinds this worker can run; train jobs for other recipes are left queued.",
    }),
  })
  .openapi("ClaimJobRequest");

export const SignedDownloadSchema = z.object({
  download_url: z.string().min(1).openapi({
    description:
      "Absolute presigned URL, or a path relative to the API base URL that requires the worker's bearer key.",
  }),
});

export const TrainerJobSchema = z
  .object({
    id: z.string().min(1),
    kind: JobKindSchema,
    attempt: z.number().int().min(1),
    lease_seconds: LeaseSecondsSchema,
    lease_expires_at: IsoTimestampSchema,
    run: z
      .object({
        id: z.string().min(1),
        workspace_id: z.string().min(1),
        name: z.string().min(1),
        recipe_kind: RecipeKindSchema,
        resolved_config: ResolvedRunConfigSchema,
        total_steps: z.number().int().min(0),
      })
      .nullable(),
    import: z
      .object({
        id: z.string().min(1),
        workspace_id: z.string().min(1),
        dataset: z.string().min(1),
        source: z.record(z.string(), z.unknown()),
        connector: z.enum(CONNECTOR_NAMES),
      })
      .nullable(),
    price_per_million_tokens: z.number().positive().nullable(),
    max_cost_usd: z.number().min(0).nullable().openapi({
      description:
        "Remaining budget for this attempt (the run cap minus cost billed by earlier attempts).",
    }),
    dataset: z
      .object({
        version: z.number().int().min(0),
        record_count: z.number().int().min(0),
        download_url: z.string().min(1),
      })
      .nullable(),
    resume: z
      .object({
        checkpoint_id: z.string().min(1),
        step: z.number().int().min(0),
        download_url: z.string().min(1),
      })
      .nullable(),
    base: z
      .object({
        artifact_id: z.string().min(1),
        sha256: Sha256HexSchema,
        download_url: z.string().min(1),
      })
      .nullable()
      .openapi({
        description:
          "Continued training: the starting artifact's bundle (a PEFT LoRA adapter) to load before training.",
      }),
  })
  .openapi("TrainerJob");

export type TrainerJob = z.infer<typeof TrainerJobSchema>;

export const ClaimJobResponseSchema = z
  .object({
    protocol: z.literal(TRAINER_PROTOCOL_VERSION),
    job: TrainerJobSchema.nullable(),
  })
  .openapi("ClaimJobResponse");

export const HeartbeatRequestSchema = z
  .object({
    ...AttemptRefShape,
    lease_seconds: LeaseSecondsSchema.optional(),
  })
  .openapi("TrainerHeartbeatRequest");

export const HeartbeatResponseSchema = z
  .object({
    status: z.string(),
    should_stop: z.boolean(),
    stop_reason: z.enum(["cancelled", "budget"]).nullable(),
    lease_expires_at: IsoTimestampSchema,
  })
  .openapi("TrainerHeartbeatResponse");

export const ReportProgressRequestSchema = z
  .object({
    ...AttemptRefShape,
    metric: MetricPointInputSchema,
  })
  .openapi("ReportTrainerProgressRequest");

export const ReportProgressResponseSchema = z
  .object({
    status: RunStatusSchema,
    should_stop: z.boolean(),
    stop_reason: z.enum(["cancelled", "budget"]).nullable(),
    cost_usd: z.number().min(0),
  })
  .openapi("ReportTrainerProgressResponse");

export const WorkerUploadRequestSchema = z
  .object({
    ...AttemptRefShape,
    kind: z.enum(["checkpoint", "artifact"]),
    sha256: Sha256HexSchema,
    size_bytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  })
  .openapi("TrainerUploadRequest");

export const RegisterCheckpointRequestSchema = z
  .object({
    ...AttemptRefShape,
    step: z.number().int().min(0),
    eval_score: z.number().nullable().optional(),
    upload_id: z.string().min(1).max(160),
    format: ArtifactFormatSchema.nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .openapi("RegisterTrainerCheckpointRequest");

export const PostImportRecordsRequestSchema = z
  .object({
    ...AttemptRefShape,
    seq: z.number().int().min(0).openapi({
      description:
        "This attempt's batch number (0, 1, 2, ...). A batch is stored once per (job, attempt, seq), so retrying a batch whose response was lost is safe.",
    }),
    records: z.array(z.unknown()).min(1).max(10_000),
  })
  .openapi("PostImportRecordsRequest");

export const PostImportRecordsResponseSchema = z
  .object({
    accepted: z.number().int().min(0),
    rejected: z.number().int().min(0),
    errors: z.array(
      z.object({ index: z.number().int().min(0), error: z.string() }),
    ),
  })
  .openapi("PostImportRecordsResponse");

export const COMPLETION_STATUSES = [
  "completed",
  "stopped_budget",
  "failed",
  "cancelled",
  "abandoned",
] as const;

export const CompleteJobRequestSchema = z
  .object({
    ...AttemptRefShape,
    status: z.enum(COMPLETION_STATUSES).openapi({
      description:
        "`abandoned` releases the lease (worker shutdown) and requeues the job without counting a failure.",
    }),
    upload_id: z.string().min(1).max(160).optional(),
    format: ArtifactFormatSchema.optional(),
    manifest: z.record(z.string(), z.unknown()).default({}),
    eval_report: EvalReportSchema.nullable().optional(),
    tokens_processed: z.number().int().min(0).default(0),
    error: z.string().max(4000).optional(),
    import_summary: z
      .object({
        dropped_count: z.number().int().min(0).default(0),
        detected_scores: z.array(z.string().max(160)).max(1000).default([]),
        drop_reasons: z.array(z.string().max(1000)).max(101).default([]),
      })
      .optional(),
  })
  .openapi("CompleteTrainerJobRequest");

export const CompleteJobResponseSchema = z
  .object({
    job_id: z.string(),
    kind: JobKindSchema,
    status: z.string(),
    run: RunSchema.nullable(),
    artifact: ArtifactSchema.nullable(),
    import: ImportJobSchema.nullable(),
  })
  .openapi("CompleteTrainerJobResponse");

export const RegisterCheckpointResponseSchema = CheckpointSchema;

export const ImportRecordsSchema = z.array(DatasetRecordSchema);
