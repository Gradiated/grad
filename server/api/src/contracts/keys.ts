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
  "artifacts:pin",
  "secrets:read",
  "secrets:write",
  "sources:read",
  "sources:write",
  "deployments:write",
  "feedback:write",
  "env:serve",
] as const;

/** Platform scopes are never implied by `admin` and cannot be minted via `/v1/keys`. */
export const PLATFORM_SCOPES = ["trainer:worker"] as const;

export const ApiKeyScopeSchema = z
  .enum(WORKSPACE_SCOPES)
  .openapi("ApiKeyScope", {
    description:
      "`x:write` implies `x:read`; `admin` implies every workspace scope. `artifacts:pin` (pin and unpin artifacts; Gradiated Cloud's publishing calls it) is implied by `admin` only. `deployments:write`, `feedback:write` and `env:serve` are Gradiated Cloud scopes: grad-server accepts them on a key but none of its endpoints checks them.",
  });

export type ApiKeyScope = z.infer<typeof ApiKeyScopeSchema>;

export type PlatformScope = (typeof PLATFORM_SCOPES)[number];

export type Scope = ApiKeyScope | PlatformScope;

export const CreateApiKeyRequestSchema = z
  .object({
    name: SlugSchema.openapi({ description: "Key name." }),
    scopes: z.array(ApiKeyScopeSchema).min(1).openapi({
      description:
        "The scopes the key gets (at least one); a `:write` scope includes its `:read`, and `admin` includes every workspace scope.",
    }),
  })
  .openapi("CreateApiKeyRequest");

export const ApiKeySchema = z
  .object({
    id: z
      .string()
      .min(1)
      .openapi({ description: "Key id (`key_` and 24 hex characters)." }),
    workspace_id: z.string().min(1),
    name: SlugSchema.openapi({ description: "Key name." }),
    prefix: z.string().min(1).openapi({
      description: "The first 12 characters of the secret, to tell keys apart.",
    }),
    scopes: z.array(ApiKeyScopeSchema).openapi({
      description:
        "What the key may do; a `:write` scope includes its `:read`, and `admin` includes every workspace scope.",
    }),
    created_at: IsoTimestampSchema,
    revoked_at: IsoTimestampSchema.nullable().openapi({
      description: "When the key was revoked; null while it works.",
    }),
  })
  .openapi("ApiKey");

export type ApiKey = z.infer<typeof ApiKeySchema>;

export const CreatedApiKeySchema = z
  .object({
    key: ApiKeySchema,
    secret: z.string().openapi({
      description:
        "The full key (`grad_` and 48 hex characters). Shown only in this response.",
    }),
  })
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
    min_gpu_memory_gb: z.number().positive().nullable().openapi({
      description:
        "GPU memory (GB) training this base needs at the recipe defaults, measured on an H100 80 GB. v0 trains on one GPU, and runs.plan refuses (422 model_exceeds_gpu_memory) a run that needs more than 80 GB. Null when unknown.",
    }),
  })
  .openapi("TrainableModel");

export type TrainableModel = z.infer<typeof TrainableModelSchema>;
