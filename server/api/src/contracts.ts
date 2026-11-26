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

export const IsoTimestampSchema = z.string().datetime();

export const ProblemSchema = z
  .object({
    type: z.string().url(),
    title: z.string().min(1).max(200),
    status: z.number().int().min(400).max(599),
    detail: z.string().min(1).max(2000),
    code: z.string().min(1).max(80),
    request_id: z.string().min(1),
  })
  .openapi("Problem");

export type Problem = z.infer<typeof ProblemSchema>;

export const MessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string().nullable().optional(),
    tool_calls: z.array(z.record(z.string(), z.unknown())).optional(),
    tool_call_id: z.string().optional(),
    name: z.string().optional(),
    train: z.boolean().optional(),
  })
  .openapi("ChatMessage");

export type ChatMessage = z.infer<typeof MessageSchema>;

export const DatasetRecordSchema = z
  .object({
    id: z.string().min(1).max(160).optional(),
    session_id: z.string().min(1).max(160).optional(),
    group_id: z.string().min(1).max(160).optional(),
    messages: z.array(MessageSchema).optional(),
    tools: z.array(z.record(z.string(), z.unknown())).optional(),
    prompt: z.union([z.string(), z.array(MessageSchema)]).optional(),
    chosen: z.union([z.string(), z.array(MessageSchema)]).optional(),
    rejected: z.union([z.string(), z.array(MessageSchema)]).optional(),
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
    record_count: z.number().int().min(0),
    storage_key: z.string().min(1),
    metadata: z.record(z.string(), z.unknown()).default({}),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
  })
  .openapi("Dataset");

export type Dataset = z.infer<typeof DatasetSchema>;

export const PushDatasetRequestSchema = z
  .object({
    records: z.array(DatasetRecordSchema).min(1).max(50_000),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("PushDatasetRequest");

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
    examples: z.array(RenderedExampleSchema),
  })
  .openapi("RenderDatasetResponse");

export const AdapterSpecSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("lora"),
      rank: z.number().int().min(1).max(256).default(32),
      alpha: z.number().int().min(1).max(512).default(32),
      merge_on_export: z.boolean().default(false),
    }),
    z.object({
      kind: z.literal("prefix_kv"),
      num_tokens: z.number().int().min(16).max(4096).default(256),
    }),
    z.object({
      kind: z.literal("frozen_head"),
    }),
  ])
  .openapi("AdapterSpec");

export type AdapterSpec = z.infer<typeof AdapterSpecSchema>;

export const SplitSpecSchema = z
  .object({
    strategy: z
      .enum(["by_session", "by_group", "random"])
      .default("by_session"),
    eval_fraction: z.number().min(0).max(0.5).optional(),
    seed: z.number().int().default(42),
  })
  .openapi("SplitSpec");

export type SplitSpec = z.infer<typeof SplitSpecSchema>;

export const V0_RECIPE_KINDS = [
  "sft",
  "dpo",
  "router",
  "decision",
  "cartridge",
  "embedding",
] as const;

export const ALL_RECIPE_KINDS = [
  ...V0_RECIPE_KINDS,
  "distill",
  "reward",
  "grpo",
] as const;

export const RecipeKindSchema = z.enum(ALL_RECIPE_KINDS).openapi("RecipeKind");
export type RecipeKind = z.infer<typeof RecipeKindSchema>;

export const RecipeSpecSchema = z
  .object({
    kind: RecipeKindSchema,
    model: ModelIdSchema.optional(),
    adapter: AdapterSpecSchema.optional(),
    lr: z.union([z.literal("auto"), z.number().positive()]).default("auto"),
    lr_scale: z.number().positive().max(100).default(1.0),
    batch_size: z.number().int().min(1).max(4096).optional(),
    epochs: z.number().int().min(1).max(20).default(1),
    schedule: z.enum(["linear", "cosine", "constant"]).default("linear"),
    warmup: z.number().min(0).max(0.5).default(0.03),
    train_on: z.enum(["last", "all_assistant"]).default("last"),
    thinking: z.enum(["auto", "on", "off"]).default("auto"),
    preserve_thinking: z.boolean().default(false),
    reduction: z.enum(["per_example", "per_token"]).default("per_example"),
    select: z.enum(["best", "last"]).default("best"),
    checkpoint_ttl_days: z.number().int().min(1).max(365).default(30),
    beta: z.number().positive().optional(),
    models: z.array(ModelIdSchema).optional(),
    max_quality_drop: z.number().min(0).max(0.5).optional(),
    context_text: z.string().optional(),
    context_uri: z.string().optional(),
    num_tokens: z.number().int().min(16).max(4096).optional(),
    temp: z.number().positive().optional(),
    teacher: ModelIdSchema.optional(),
    env_name: SlugSchema.optional(),
    group_size: z.number().int().min(2).max(64).optional(),
  })
  .openapi("RecipeSpec");

export type RecipeSpec = z.infer<typeof RecipeSpecSchema>;

export const PlanRunRequestSchema = z
  .object({
    dataset: SlugSchema,
    name: SlugSchema,
    recipe: RecipeSpecSchema,
    split: SplitSpecSchema.optional(),
    max_cost_usd: z.number().positive().optional(),
  })
  .openapi("PlanRunRequest");

export type PlanRunRequest = z.infer<typeof PlanRunRequestSchema>;

export const ResolvedRunConfigSchema = z
  .object({
    rule_version: z.string(),
    dataset: SlugSchema,
    name: SlugSchema,
    recipe_kind: RecipeKindSchema,
    model: z.string(),
    template_revision: z.string(),
    adapter: z.union([
      AdapterSpecSchema,
      z.object({ kind: z.literal("encoder_full") }),
    ]),
    lr: z.number().positive(),
    lr_source: z.string(),
    batch_size: z.number().int().min(1),
    epochs: z.number().int().min(1),
    schedule: z.enum(["linear", "cosine", "constant"]),
    warmup: z.number(),
    train_on: z.enum(["last", "all_assistant"]),
    thinking: z.enum(["auto", "on", "off"]),
    preserve_thinking: z.boolean(),
    reduction: z.enum(["per_example", "per_token"]),
    select: z.enum(["best", "last"]),
    checkpoint_every_steps: z.number().int().min(1),
    checkpoint_ttl_days: z.number().int().min(1),
    split: z.object({
      strategy: z.enum(["by_session", "by_group", "random"]),
      eval_fraction: z.number(),
      seed: z.number().int(),
      train_records: z.number().int().min(0),
      eval_records: z.number().int().min(0),
    }),
    recipe_params: z.record(z.string(), z.unknown()),
  })
  .openapi("ResolvedRunConfig");

export type ResolvedRunConfig = z.infer<typeof ResolvedRunConfigSchema>;

export const PlanRunResponseSchema = z
  .object({
    resolved_config: ResolvedRunConfigSchema,
    estimated_steps: z.number().int().min(0),
    estimated_tokens: z.number().int().min(0),
    estimated_cost_usd: z.number().min(0),
    trained_token_fraction: z.number().min(0).max(1),
    warnings: z.array(z.string()),
  })
  .openapi("PlanRunResponse");

export type PlanRunResponse = z.infer<typeof PlanRunResponseSchema>;

export const RunStatusSchema = z
  .enum([
    "queued",
    "running",
    "paused",
    "completed",
    "failed",
    "cancelled",
    "stopped_budget",
  ])
  .openapi("RunStatus");

export type RunStatus = z.infer<typeof RunStatusSchema>;

export const MetricPointSchema = z
  .object({
    step: z.number().int().min(0),
    loss: z.number(),
    eval_loss: z.number().optional(),
    eval_metric: z.number().optional(),
    grad_norm: z.number().optional(),
    lr: z.number().optional(),
    tokens_per_sec: z.number().optional(),
    tokens: z.number().int().min(0),
    cost_usd: z.number().min(0),
    timestamp: IsoTimestampSchema,
  })
  .openapi("MetricPoint");

export type MetricPoint = z.infer<typeof MetricPointSchema>;

export const RunSchema = z
  .object({
    id: z.string().min(1),
    workspace_id: z.string().min(1),
    name: SlugSchema,
    dataset_id: z.string().min(1),
    dataset_name: SlugSchema,
    recipe_kind: RecipeKindSchema,
    status: RunStatusSchema,
    resolved_config: ResolvedRunConfigSchema,
    max_cost_usd: z.number().positive().nullable(),
    tokens_processed: z.number().int().min(0),
    cost_usd: z.number().min(0),
    current_step: z.number().int().min(0),
    total_steps: z.number().int().min(0),
    metrics_history: z.array(MetricPointSchema),
    eval_report: z.record(z.string(), z.unknown()).nullable(),
    artifact_id: z.string().nullable(),
    error: z.string().nullable(),
    worker_id: z.string().nullable(),
    lease_expires_at: IsoTimestampSchema.nullable(),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
  })
  .openapi("Run");

export type Run = z.infer<typeof RunSchema>;

export const ResumeRunRequestSchema = z
  .object({
    max_cost_usd: z.number().positive().optional(),
  })
  .openapi("ResumeRunRequest");

export const CheckpointSchema = z
  .object({
    id: z.string().min(1),
    workspace_id: z.string().min(1),
    run_id: z.string().min(1),
    step: z.number().int().min(0),
    eval_score: z.number().nullable(),
    storage_key: z.string().min(1),
    sha256: z.string().length(64),
    size_bytes: z.number().int().min(0),
    metadata: z.record(z.string(), z.unknown()),
    expires_at: IsoTimestampSchema.nullable(),
    created_at: IsoTimestampSchema,
  })
  .openapi("Checkpoint");

export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const PromoteCheckpointRequestSchema = z
  .object({
    name: SlugSchema.optional(),
  })
  .openapi("PromoteCheckpointRequest");

export const ArtifactFormatSchema = z
  .enum([
    "peft_lora",
    "cartridge",
    "encoder_safetensors",
    "router_bundle",
    "decision_bundle",
  ])
  .openapi("ArtifactFormat");

export type ArtifactFormat = z.infer<typeof ArtifactFormatSchema>;

export const ArtifactSchema = z
  .object({
    id: z.string().min(1),
    workspace_id: z.string().min(1),
    name: SlugSchema,
    version: z.string().min(1),
    run_id: z.string().nullable(),
    checkpoint_id: z.string().nullable(),
    base_model: z.string().min(1),
    recipe_kind: RecipeKindSchema,
    format: ArtifactFormatSchema,
    storage_key: z.string().min(1),
    sha256: z.string().length(64),
    size_bytes: z.number().int().min(0),
    manifest: z.record(z.string(), z.unknown()),
    eval_report: z.record(z.string(), z.unknown()).nullable(),
    created_at: IsoTimestampSchema,
  })
  .openapi("Artifact");

export type Artifact = z.infer<typeof ArtifactSchema>;

export const DeployArtifactRequestSchema = z
  .object({
    artifact: z.string().min(1),
    name: SlugSchema.optional(),
    fallback: ModelIdSchema.optional(),
    explore_rate: z.number().min(0).max(0.5).default(0),
  })
  .openapi("DeployArtifactRequest");

export const DeploymentSchema = z
  .object({
    id: z.string().min(1),
    workspace_id: z.string().min(1),
    name: SlugSchema,
    model_id: z.string().min(1),
    active_artifact_id: z.string().min(1),
    previous_artifact_id: z.string().nullable(),
    fallback_model: z.string().nullable(),
    explore_rate: z.number().min(0).max(0.5),
    status: z.enum(["active", "disabled"]),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
  })
  .openapi("Deployment");

export type Deployment = z.infer<typeof DeploymentSchema>;

export const RouteRequestSchema = z
  .object({
    deployment: SlugSchema,
    messages: z.array(MessageSchema).min(1),
    tools: z.array(z.record(z.string(), z.unknown())).optional(),
    session_id: z.string().min(1).max(160).optional(),
  })
  .openapi("RouteRequest");

export const RouteResponseSchema = z
  .object({
    inference_id: z.string().min(1),
    deployment: SlugSchema,
    artifact_id: z.string().min(1),
    model: z.string().min(1),
    is_exploration: z.boolean(),
    confidence: z.number().min(0).max(1),
    scores: z.record(z.string(), z.number()),
  })
  .openapi("RouteResponse");

export const EmbedRequestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(z.string()).min(1).max(256)]),
  })
  .openapi("EmbedRequest");

export const EmbedResponseSchema = z
  .object({
    model: z.string().min(1),
    data: z.array(
      z.object({
        index: z.number().int().min(0),
        embedding: z.array(z.number()),
      }),
    ),
    usage: z.object({
      prompt_tokens: z.number().int().min(0),
      total_tokens: z.number().int().min(0),
    }),
  })
  .openapi("EmbedResponse");

export const FeedbackEventInputSchema = z
  .object({
    inference_id: z.string().min(1).max(160).optional(),
    session_id: z.string().min(1).max(160).optional(),
    deployment_name: SlugSchema.optional(),
    idempotency_key: z.string().min(1).max(200),
    score: z.number().min(0).max(1).optional(),
    expected_output: z.unknown().optional(),
    metrics: z.record(z.string(), z.number()).optional(),
  })
  .openapi("FeedbackEventInput");

export const RecordFeedbackRequestSchema = z
  .object({
    events: z.array(FeedbackEventInputSchema).min(1).max(1000),
  })
  .openapi("RecordFeedbackRequest");

export const FeedbackRecordSchema = z
  .object({
    id: z.string().min(1),
    workspace_id: z.string().min(1),
    inference_id: z.string().nullable(),
    session_id: z.string().nullable(),
    deployment_name: z.string().nullable(),
    idempotency_key: z.string().min(1),
    score: z.number().nullable(),
    expected_output: z.unknown().nullable(),
    metrics: z.record(z.string(), z.number()),
    created_at: IsoTimestampSchema,
  })
  .openapi("FeedbackRecord");

export type FeedbackRecord = z.infer<typeof FeedbackRecordSchema>;

export const ApiKeyScopeSchema = z
  .enum([
    "admin",
    "datasets:read",
    "datasets:write",
    "runs:read",
    "runs:write",
    "artifacts:read",
    "artifacts:write",
    "deployments:write",
    "feedback:write",
    "env:serve",
    "trainer:worker",
  ])
  .openapi("ApiKeyScope");

export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;

export const CreateApiKeyRequestSchema = z
  .object({
    name: SlugSchema,
    scopes: z.array(ApiKeyScopeSchema).min(1),
  })
  .openapi("CreateApiKeyRequest");

export const ApiKeySchema = z
  .object({
    id: z.string().min(1),
    workspace_id: z.string().min(1),
    name: SlugSchema,
    prefix: z.string().min(1),
    scopes: z.array(ApiKeyScopeSchema),
    created_at: IsoTimestampSchema,
    revoked_at: IsoTimestampSchema.nullable(),
  })
  .openapi("ApiKey");

export type ApiKey = z.infer<typeof ApiKeySchema>;

export const TrainableModelSchema = z
  .object({
    id: z.string(),
    adapters: z.array(z.string()),
    default_for: z.array(RecipeKindSchema),
    price_per_million_tokens_usd: z.number().positive(),
    max_context_tokens: z.number().int().positive(),
    template_revision: z.string(),
    calibrated_lrs: z.record(z.string(), z.number().positive()),
  })
  .openapi("TrainableModel");

export type TrainableModel = z.infer<typeof TrainableModelSchema>;

export const ClaimJobRequestSchema = z
  .object({
    worker_id: z.string().min(1).max(160),
    lease_seconds: z.number().int().min(30).max(3600).default(180),
  })
  .openapi("ClaimJobRequest");

export const ReportRunProgressSchema = z
  .object({
    worker_id: z.string().min(1),
    metric: MetricPointSchema,
    lease_seconds: z.number().int().min(30).max(3600).default(180),
  })
  .openapi("ReportRunProgress");

const MAX_BASE64_PAYLOAD_CHARS = 32 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const Base64PayloadSchema = z
  .string()
  .min(1)
  .max(MAX_BASE64_PAYLOAD_CHARS)
  .refine(
    (value) => value.length % 4 === 0 && BASE64_RE.test(value),
    "Must be a valid Base64-encoded payload.",
  );

export const RegisterCheckpointRequestSchema = z
  .object({
    worker_id: z.string().min(1),
    step: z.number().int().min(0),
    eval_score: z.number().nullable().optional(),
    payload_base64: Base64PayloadSchema,
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .openapi("RegisterCheckpointRequest");

export const CompleteRunRequestSchema = z
  .object({
    worker_id: z.string().min(1),
    status: z.enum(["completed", "failed", "stopped_budget"]),
    format: ArtifactFormatSchema.optional(),
    artifact_base64: Base64PayloadSchema.optional(),
    manifest: z.record(z.string(), z.unknown()).optional(),
    eval_report: z.record(z.string(), z.unknown()).optional(),
    tokens_processed: z.number().int().min(0).optional(),
    cost_usd: z.number().min(0).optional(),
    error: z.string().max(4000).optional(),
  })
  .openapi("CompleteRunRequest");

export const EnvWorkerRegisterSchema = z
  .object({
    name: SlugSchema,
    worker_id: z.string().min(1).max(160),
    concurrency: z.number().int().min(1).max(512).default(4),
  })
  .openapi("EnvWorkerRegister");

export const EnvTaskDispatchSchema = z
  .object({
    env_name: SlugSchema,
    task: z.record(z.string(), z.unknown()),
    model_id: z.string().min(1),
    system_prompt: z.string().optional(),
    timeout_s: z.number().int().min(1).max(3600).default(120),
  })
  .openapi("EnvTaskDispatch");

export const EnvTaskResultSchema = z
  .object({
    worker_id: z.string().min(1),
    score: z.number().nullable().optional(),
    scores: z.record(z.string(), z.number()).default({}),
    trajectory: z.record(z.string(), z.unknown()).optional(),
    error: z.string().max(4000).optional(),
  })
  .openapi("EnvTaskResult");

export const BenchmarkSpecSchema = z
  .object({
    name: z.enum([
      "ifeval",
      "gsm8k",
      "mmlu-pro",
      "gpqa-diamond",
      "humaneval",
      "livecodebench",
    ]),
    limit: z.number().int().min(1).max(10_000).default(200),
  })
  .openapi("BenchmarkSpec");

const NESTED_QUANTIFIER_RE = /\([^)]*[+*][^)]*\)[+*?]|\([^)]*\|[^)]*\)[+*]{2,}/;

export const EvalRubricItemSchema = z
  .object({
    name: z.string().min(1).max(80),
    kind: z.enum(["regex", "validator", "code", "judge"]),
    weight: z.number().positive().default(1.0),
    pattern: z.string().max(256).optional(),
    validator: z.enum(["json", "non_empty", "exact_match"]).optional(),
    model: ModelIdSchema.optional(),
    prompt: z.string().max(4000).optional(),
  })
  .superRefine((item, ctx) => {
    if (item.kind === "judge" && !item.model) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["model"],
        message: "Judge rubric items require an explicit 'model'.",
      });
    }
    if (item.kind === "regex") {
      if (!item.pattern) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pattern"],
          message: "Regex rubric items require 'pattern'.",
        });
      } else if (NESTED_QUANTIFIER_RE.test(item.pattern)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["pattern"],
          message:
            "Regex pattern contains nested quantifiers and is rejected to prevent ReDoS.",
        });
      } else {
        try {
          new RegExp(item.pattern);
        } catch (err) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["pattern"],
            message: `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }
  })
  .openapi("EvalRubricItem");

export type EvalRubricItem = z.infer<typeof EvalRubricItemSchema>;

export const PlanEvalRequestSchema = z
  .object({
    name: SlugSchema.default("eval-run"),
    models: z.array(z.string().min(1)).min(1).max(16),
    baseline: z.string().min(1).optional(),
    dataset: SlugSchema.optional(),
    env_name: SlugSchema.optional(),
    tasks: z.array(z.record(z.string(), z.unknown())).optional(),
    benchmarks: z.array(BenchmarkSpecSchema).min(1).optional(),
    rubric: z
      .array(EvalRubricItemSchema)
      .min(1)
      .default([
        {
          name: "non_empty",
          kind: "validator",
          weight: 1.0,
          validator: "non_empty",
        },
      ]),
    samples: z.number().int().min(1).max(32).default(1),
    pass_threshold: z.number().min(0).max(1).default(0.8),
    max_cost_usd: z.number().positive().optional(),
  })
  .openapi("PlanEvalRequest");

export type PlanEvalRequest = z.infer<typeof PlanEvalRequestSchema>;

export const PlanEvalResponseSchema = z
  .object({
    task_source_kind: z.enum(["dataset", "env", "benchmarks"]),
    estimated_tasks: z.number().int().min(0),
    estimated_model_calls: z.number().int().min(0),
    estimated_judge_calls: z.number().int().min(0),
    estimated_cost_usd: z.number().min(0),
    judge_models: z.array(z.string()),
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
    tokens_per_task: z.number(),
    cost_per_1k_tasks_usd: z.number(),
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

export const EvalRunSchema = z
  .object({
    id: z.string().min(1),
    workspace_id: z.string().min(1),
    name: SlugSchema,
    status: z.enum(["completed", "failed"]),
    models: z.array(z.string()),
    baseline: z.string().nullable(),
    task_source: z.record(z.string(), z.unknown()),
    rubric: z.array(EvalRubricItemSchema),
    samples: z.number().int().min(1),
    pass_threshold: z.number().min(0).max(1),
    judge_models: z.array(z.string()),
    summary: z.array(EvalModelSummarySchema),
    results: z.array(EvalTaskOutcomeSchema),
    total_cost_usd: z.number().min(0),
    created_at: IsoTimestampSchema,
  })
  .openapi("EvalRun");

export type EvalRun = z.infer<typeof EvalRunSchema>;
