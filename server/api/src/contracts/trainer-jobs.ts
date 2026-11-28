import { z } from "@hono/zod-openapi";

import { ArtifactImportSchema } from "./artifacts.js";
import { IsoTimestampSchema, nullable, Sha256HexSchema } from "./common.js";
import { EvalReportSchema } from "./eval-report.js";
import {
  EvalModeSchema,
  EvalRubricItemSchema,
  EvalRunSchema,
} from "./evals.js";
import {
  CONNECTOR_NAMES,
  ImportJobSchema,
  MAX_UPLOAD_BYTES,
} from "./datasets.js";
import {
  ArtifactFormatSchema,
  ArtifactProvenanceSchema,
  ArtifactSchema,
  GpuInfoSchema,
  InterruptionReasonSchema,
  MetricPointInputSchema,
  RecipeKindSchema,
  ResolvedRunConfigSchema,
  RunSchema,
  RunStatusSchema,
  WORKER_PHASES,
} from "./runs.js";

export const TRAINER_PROTOCOL_VERSION = "grad.trainer-protocol/1";

export const JOB_KINDS = ["train", "import", "eval"] as const;

export const JobKindSchema = z.enum(JOB_KINDS).openapi("JobKind", {
  description:
    "train (GPU trainer workers), import (imports and source syncs, on CPU trainer workers), eval (evals and dataset.score(), on `grad-server worker --kinds eval`).",
});
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
    gpu: nullable(GpuInfoSchema).optional().openapi({
      description:
        "The worker's GPU, shown on the run's `starting` phase (never the worker id or host). Its memory_gb also filters train jobs: the worker gets only runs whose min_gpu_memory_gb fits.",
    }),
    device: z.enum(["cpu", "gpu"]).optional().openapi({
      description:
        "What the worker computes on. A GPU worker sends `gpu`; a CPU worker sends `cpu` and no `gpu` (it is not GPU-filtered). Recorded so a run no online worker fits can say so.",
    }),
  })
  .openapi("ClaimJobRequest");

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
    artifact_import: z
      .object({
        id: z.string().min(1),
        workspace_id: z.string().min(1),
        name: z.string().min(1),
        base_model: z.string().min(1),
        format: ArtifactFormatSchema,
        provenance: ArtifactProvenanceSchema,
        source: z.record(z.string(), z.unknown()).openapi({
          description:
            "`{kind: upload, download_url, sha256, size_bytes}` (a tar, optionally gzip) or `{kind: hf, repo, revision, token?}`.",
        }),
      })
      .nullable()
      .optional()
      .openapi({
        description:
          "Import jobs that write an artifact (`grad artifacts upload` / `import`): validate the files, bundle them as grad.artifact/1 and complete with the bundle's upload_id and manifest. `import` is null then.",
      }),
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
    loggers: z.array(z.record(z.string(), z.unknown())).optional().openapi({
      description:
        "Train jobs: the run's recipe.loggers with each workspace secret resolved to `api_key`. A logger whose secret is missing is left out (the plan warned).",
    }),
    eval: z
      .object({
        id: z.string().min(1),
        workspace_id: z.string().min(1),
        name: z.string().min(1),
        mode: EvalModeSchema,
        models: z.array(z.string().min(1)).min(1),
        model_targets: z.record(
          z.string(),
          z.object({ inference_model: z.string().min(1) }),
        ),
        judge_targets: z.record(
          z.string(),
          z.object({ inference_model: z.string().min(1) }),
        ),
        rubric: z.array(EvalRubricItemSchema),
        samples: z.number().int().min(1),
        temperature: z.number(),
        max_tokens: z.number().int().min(1),
        limit: z.number().int().min(1).nullable(),
        done: z.record(z.string(), z.array(z.number().int().min(0))).openapi({
          description:
            "Per model, the outputs earlier attempts stored, as task_index * samples + sample_index: skip them.",
        }),
      })
      .nullable()
      .openapi({
        description:
          "Eval jobs: what to generate and score. The tasks are the usable records of `dataset` (merged, then the planner's task rules).",
      }),
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
    traceparent: z.string().nullable().optional().openapi({
      description:
        "W3C traceparent of the request that created the job (server tracing on): send it as the `traceparent` header on this job's requests so they join that trace.",
    }),
  })
  .openapi("TrainerJob");

export type TrainerJob = z.infer<typeof TrainerJobSchema>;

export const ClaimJobResponseSchema = z
  .object({
    protocol: z.literal(TRAINER_PROTOCOL_VERSION),
    job: nullable(TrainerJobSchema),
  })
  .openapi("ClaimJobResponse");

/** Phases a heartbeat's stats may name; anything else is reported as `other`. */
export const WORKER_STAT_PHASES = [
  "starting",
  "loading_model",
  "training",
  "evaluating",
  "checkpointing",
  "uploading",
  "completing",
  "importing",
  "waiting_for_capacity",
  "waiting_for_rate_limit",
  "waiting_for_inference",
] as const;

export const WorkerStatsSchema = z
  .object({
    phase: z
      .string()
      .max(64)
      .optional()
      .openapi({
        description: `What the worker is doing: ${WORKER_STAT_PHASES.join(", ")}.`,
      }),
    tokens_per_second: z.number().nonnegative().optional(),
    gpu_memory_used_bytes: z.number().nonnegative().optional(),
    gpu_utilization: z.number().min(0).max(1).optional().openapi({
      description: "Mean GPU utilisation since the last heartbeat, 0 to 1.",
    }),
  })
  .openapi("TrainerWorkerStats", {
    description:
      "A few live numbers the server aggregates into grad_worker_* gauges, so workers that can't be scraped still show up.",
  });

export const HeartbeatRequestSchema = z
  .object({
    ...AttemptRefShape,
    lease_seconds: LeaseSecondsSchema.optional(),
    stats: WorkerStatsSchema.optional(),
  })
  .openapi("TrainerHeartbeatRequest");

export const HeartbeatResponseSchema = z
  .object({
    status: z.string(),
    should_stop: z.boolean(),
    stop_reason: z
      .enum(["cancelled", "budget", "insufficient_balance"])
      .nullable()
      .openapi({
        description:
          "Why to stop: cancelled, the run's cap (budget), or the workspace ran out of balance (Cloud). Budget and balance stops complete as stopped_budget with this stop_reason.",
      }),
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
    stop_reason: z
      .enum(["cancelled", "budget", "insufficient_balance"])
      .nullable(),
    cost_usd: z.number().min(0),
  })
  .openapi("ReportTrainerProgressResponse");

export const ReportEventRequestSchema = z
  .discriminatedUnion("type", [
    z.object({
      ...AttemptRefShape,
      type: z.literal("phase"),
      phase: z.enum(WORKER_PHASES),
      step: z.number().int().min(0).default(0).openapi({
        description:
          "Training step when the phase began. Stored once per (attempt, phase, step), so a retry is safe.",
      }),
    }),
    z.object({
      ...AttemptRefShape,
      type: z.enum(["log", "warning"]),
      seq: z.number().int().min(0).openapi({
        description:
          "This attempt's message number (0, 1, 2, ...): stored once per (attempt, seq).",
      }),
      message: z.string().min(1).max(2000),
      step: z.number().int().min(0).nullable().default(null),
    }),
  ])
  .openapi("ReportTrainerEventRequest");

export const WorkerUploadRequestSchema = z
  .object({
    ...AttemptRefShape,
    kind: z.enum(["checkpoint", "artifact", "records"]).openapi({
      description:
        "checkpoint or artifact (train jobs), records (import jobs: a gzip JSONL dataset part, registered with /parts).",
    }),
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
    format: nullable(ArtifactFormatSchema).optional(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .openapi("RegisterTrainerCheckpointRequest");

export const RegisterImportPartRequestSchema = z
  .object({
    ...AttemptRefShape,
    seq: z.number().int().min(0).openapi({
      description:
        "This attempt's part number (0, 1, 2, ...): the part's place in the version. A part is staged once per (job, attempt, seq), so retrying a registration whose response was lost is safe.",
    }),
    upload_id: Sha256HexSchema.openapi({
      description:
        "The uploaded gzip part (its sha256, from a `records` upload ticket).",
    }),
    sha256: Sha256HexSchema.openapi({
      description:
        "sha256 of the part's uncompressed JSONL; every read verifies it.",
    }),
    count: z.number().int().min(0).openapi({
      description:
        "Distinct records the part adds after its last reset marker (score updates and reset markers add none).",
    }),
    resets: z.boolean().default(false).openapi({
      description:
        "The part holds a reset marker (a full source sync): the count restarts.",
    }),
    records: z.number().int().min(1).openapi({
      description: "Lines in the part (records, score updates and markers).",
    }),
    score_updates: z.number().int().min(0).default(0),
    detected_scores: z.array(z.string().max(160)).max(1000).default([]),
  })
  .openapi("RegisterImportPartRequest", {
    description:
      "A dataset part the worker uploaded with a presigned PUT: grad-server checks the object and stages it, without reading the records.",
  });

export const RegisterImportPartResponseSchema = z
  .object({
    staged: z.boolean().openapi({
      description: "False when this (job, attempt, seq) was already staged.",
    }),
  })
  .openapi("RegisterImportPartResponse");

export const MAX_EVAL_OUTPUTS_PER_BATCH = 200;

export const EvalOutputInputSchema = z
  .object({
    model: z.string().min(1),
    task_index: z.number().int().min(0),
    task_id: z.string().min(1),
    sample_index: z.number().int().min(0),
    record: z.record(z.string(), z.unknown()),
    input: z.array(z.record(z.string(), z.unknown())),
    output: z.string().nullable(),
    expected_output: z.unknown().optional(),
    scores: z.record(z.string(), z.number()),
    error: z.string().max(2000).nullable(),
    prompt_tokens: z.number().int().min(0),
    completion_tokens: z.number().int().min(0),
    judge_tokens: z
      .record(z.string(), z.number().int().min(0))
      .default({})
      .openapi({
        description:
          "Tokens each judge used for this output; the server prices them with the judge prices resolved at plan time.",
      }),
  })
  .openapi("TrainerEvalOutput");

/** Why an eval model or judge call failed (grad_eval_inference_errors_total). */
export const INFERENCE_ERROR_REASONS = [
  "rate_limited",
  "capacity_unavailable",
  "timeout",
  "unreachable",
  "server_error",
  "rejected",
  "malformed",
] as const;
export type InferenceErrorReason = (typeof INFERENCE_ERROR_REASONS)[number];

const count = z.number().int().min(0);

const InferenceErrorCountsSchema = z
  .object({
    rate_limited: count.optional(),
    capacity_unavailable: count.optional(),
    timeout: count.optional(),
    unreachable: count.optional(),
    server_error: count.optional(),
    rejected: count.optional(),
    malformed: count.optional(),
  })
  .openapi("TrainerEvalErrorCounts", {
    description:
      "Failed calls by reason: rate_limited (429), capacity_unavailable (the endpoint has no capacity, e.g. a pool waking from zero), timeout, unreachable, server_error (other 5xx), rejected (other 4xx), malformed (an unparsable answer).",
  });

export const EvalCallCountsSchema = z
  .object({
    model_ok: count.default(0),
    model_error: count.default(0),
    judge_ok: count.default(0),
    judge_error: count.default(0),
    model_errors: InferenceErrorCountsSchema.optional(),
    judge_errors: InferenceErrorCountsSchema.optional(),
  })
  .openapi("TrainerEvalCallCounts", {
    description:
      "Model and judge calls since the worker's last batch (grad_eval_outputs_total, grad_eval_judge_calls_total, grad_eval_inference_errors_total).",
  });

export const PostEvalOutputsRequestSchema = z
  .object({
    ...AttemptRefShape,
    outputs: z.array(EvalOutputInputSchema).max(MAX_EVAL_OUTPUTS_PER_BATCH),
    calls: EvalCallCountsSchema.optional(),
  })
  .openapi("PostTrainerEvalOutputsRequest", {
    description:
      "A batch of generated and scored outputs. Stored once per (eval, model, task_index, sample_index), so re-sending a batch whose response was lost is safe; the server prices and bills them.",
  });

export const PostEvalOutputsResponseSchema = z
  .object({
    accepted: z.number().int().min(0).openapi({
      description: "Outputs stored by this request (replays are not counted).",
    }),
    generated: z.number().int().min(0),
    should_stop: z.boolean().openapi({
      description:
        "The eval was cancelled: stop generating, post what is in flight, then complete the attempt.",
    }),
  })
  .openapi("PostTrainerEvalOutputsResponse");

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
        "How the attempt ended. A train attempt ends as completed, stopped_budget, failed or abandoned; an eval or import attempt as completed, failed or abandoned. Any other status is refused (422 unsupported_completion) and changes nothing, except for a job the user cancelled, which closes as cancelled whatever its worker reports. `abandoned` hands the attempt back (shutdown, reclaimed compute, a worker error): the job requeues at once and resumes from its latest checkpoint.",
    }),
    reason: InterruptionReasonSchema.exclude(["lease_lost"])
      .optional()
      .openapi({
        description:
          "Abandoned attempts: compute_reclaimed (SIGTERM or a cloud termination notice; counts toward the server's separate MAX_PREEMPTIONS cap), worker_error (default) or oom (both count toward max_attempts).",
      }),
    upload_id: z.string().min(1).max(160).optional(),
    format: ArtifactFormatSchema.optional(),
    manifest: z.record(z.string(), z.unknown()).default({}),
    eval_report: nullable(EvalReportSchema).optional(),
    tokens_processed: z.number().int().min(0).default(0),
    error: z.string().max(4000).optional(),
    error_code: z
      .enum(["invalid_artifact", "source_unavailable"])
      .optional()
      .openapi({
        description:
          "Failed artifact imports: invalid_artifact (the files break the format spec or don't fit the base model; `error` names the file) or source_unavailable.",
      }),
    stop_reason: z.enum(["budget", "insufficient_balance"]).optional().openapi({
      description:
        "With status stopped_budget: why the run stopped. budget = the run's max_cost_usd (the worker's own check or the heartbeat's stop_reason); insufficient_balance = the heartbeat said the workspace ran out of balance (the run becomes stopped_balance).",
    }),
    import_summary: z
      .object({
        dropped_count: z.number().int().min(0).default(0),
        detected_scores: z.array(z.string().max(160)).max(1000).default([]),
        drop_reasons: z.array(z.string().max(1000)).max(101).default([]),
        watermark: z
          .record(z.string(), z.unknown())
          .nullable()
          .optional()
          .openapi({
            description:
              "Source syncs: where the next sync starts (opaque to the server). Stored only when the import completes; null or absent keeps the previous one.",
          }),
        traces: z.number().int().min(0).optional().openapi({
          description:
            "Source syncs: the new traces taken, which the source's max_records_per_day counts.",
        }),
      })
      .optional(),
  })
  .openapi("CompleteTrainerJobRequest");

export const CompleteJobResponseSchema = z
  .object({
    job_id: z.string(),
    kind: JobKindSchema,
    status: z.string(),
    run: nullable(RunSchema),
    artifact: nullable(ArtifactSchema),
    import: nullable(ImportJobSchema),
    eval: nullable(EvalRunSchema).optional(),
    artifact_import: nullable(ArtifactImportSchema).optional(),
  })
  .openapi("CompleteTrainerJobResponse");

export const SourcePageRequestSchema = z
  .object({
    ...AttemptRefShape,
    cursor: z.string().max(4096).nullable().default(null),
  })
  .openapi("SourcePageRequest");

export const SourcePageResponseSchema = z
  .object({
    records: z.array(z.record(z.string(), z.unknown())),
    cursor: z.string().nullable(),
    has_more: z.boolean(),
  })
  .openapi("SourcePageResponse");
