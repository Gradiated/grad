import { z } from "@hono/zod-openapi";

import {
  ChatMessageSchema,
  IsoTimestampSchema,
  ModelIdSchema,
  SlugSchema,
} from "./common.js";

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

export const DeploymentStatusSchema = z
  .object({
    deployment: DeploymentSchema,
    feedback_count: z.number().int().min(0),
    average_score: z.number().nullable(),
  })
  .openapi("DeploymentStatus");

export const RouteRequestSchema = z
  .object({
    deployment: SlugSchema,
    messages: z.array(ChatMessageSchema).min(1),
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

export type RouteResponse = z.infer<typeof RouteResponseSchema>;

export const EmbedRequestSchema = z
  .object({
    model: SlugSchema.openapi({
      description: "Name of a deployed embedding artifact.",
    }),
    input: z.union([
      z.string().min(1),
      z.array(z.string().min(1)).min(1).max(256),
    ]),
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

export type EmbedResponse = z.infer<typeof EmbedResponseSchema>;

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

export const RecordFeedbackResponseSchema = z
  .object({
    accepted: z.number().int().min(0),
    deduplicated: z.number().int().min(0),
    records: z.array(FeedbackRecordSchema),
  })
  .openapi("RecordFeedbackResponse");
