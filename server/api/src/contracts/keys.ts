import { z } from "@hono/zod-openapi";

import { IsoTimestampSchema, SlugSchema } from "./common.js";
import { RecipeKindSchema } from "./runs.js";

export const WORKSPACE_SCOPES = [
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
] as const;

/** Platform scopes are never implied by `admin` and cannot be minted via `/v1/keys`. */
export const PLATFORM_SCOPES = ["trainer:worker"] as const;

export const ApiKeyScopeSchema = z
  .enum(WORKSPACE_SCOPES)
  .openapi("ApiKeyScope");

export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;

export type PlatformScope = (typeof PLATFORM_SCOPES)[number];

export type Scope = ApiKeyScope | PlatformScope;

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

export const CreatedApiKeySchema = z
  .object({ key: ApiKeySchema, secret: z.string() })
  .openapi("CreatedApiKey");

export const TrainableModelSchema = z
  .object({
    id: z.string().min(1).max(160),
    hf_repo: z.string().min(1).max(200).nullable(),
    family: z.enum(["llm", "encoder"]),
    adapters: z.array(
      z.enum(["lora", "prefix_kv", "frozen_head", "encoder_full"]),
    ),
    recipes: z.array(RecipeKindSchema),
    default_for: z.array(RecipeKindSchema),
    price_per_million_tokens_usd: z.number().positive(),
    max_context_tokens: z.number().int().positive(),
    template_revision: z.string().min(1),
    calibrated_lrs: z.record(z.string(), z.number().positive()),
  })
  .openapi("TrainableModel");

export type TrainableModel = z.infer<typeof TrainableModelSchema>;
