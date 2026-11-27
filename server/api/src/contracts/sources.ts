import { z } from "@hono/zod-openapi";

import { IsoTimestampSchema, SlugSchema } from "./common.js";

// --- Secrets ------------------------------------------------------------------

export const SecretNameSchema = SlugSchema.openapi({
  description:
    "Lowercase letters, digits, '.', '_' and '-'; unique per workspace.",
});

export const MAX_SECRET_BYTES = 16 * 1024;

export const SetSecretRequestSchema = z
  .object({
    name: SecretNameSchema,
    value: z
      .string()
      .min(1)
      .refine((v) => Buffer.byteLength(v, "utf8") <= MAX_SECRET_BYTES, {
        message: `Secret values are limited to ${MAX_SECRET_BYTES} bytes.`,
      })
      .openapi({
        description:
          "Write-only: stored encrypted and never returned by any endpoint.",
      }),
    allowed_hosts: z
      .array(z.string().min(1).max(260))
      .max(32)
      .optional()
      .openapi({
        description:
          "Hosts (`host[:port]`, or URLs) this secret may be sent to: a source's host, huggingface.co for HF imports, a logger's host. Default: the public hosts of the supported providers (cloud.langfuse.com, us.cloud.langfuse.com, api.smith.langchain.com, eu.api.smith.langchain.com, api.braintrust.dev, us.posthog.com, eu.posthog.com, app.phoenix.arize.com, huggingface.co, api.wandb.ai). A secret for a self-hosted tool must name its host. Replacing a secret replaces its hosts.",
        example: ["langfuse.internal.example.com"],
      }),
  })
  .openapi("SetSecretRequest");

export const SecretSchema = z
  .object({
    name: SecretNameSchema,
    workspace_id: z.string().min(1),
    allowed_hosts: z.array(z.string()).openapi({
      description: "The hosts this secret may be sent to.",
    }),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
  })
  .openapi("Secret", {
    description: "A workspace secret's metadata. The value is never returned.",
  });

export type Secret = z.infer<typeof SecretSchema>;

export const SecretNameParamSchema = z.object({ name: SecretNameSchema });

// --- Sources ------------------------------------------------------------------

/** Providers with a fetcher in `grad_trainer/providers`. */
export const SOURCE_PROVIDERS = [
  "langfuse",
  "langsmith",
  "braintrust",
  "posthog",
  "phoenix",
  "gradiated",
] as const;

export type SourceProviderKind = (typeof SOURCE_PROVIDERS)[number];

export const SourceProviderSchema = z
  .object({
    kind: z
      .string()
      .min(1)
      .max(40)
      .openapi({
        description: `One of ${SOURCE_PROVIDERS.join(", ")}; anything else is 422 source_provider_unsupported.`,
        example: "langfuse",
      }),
    host: z.string().url().max(2048).nullable().optional().openapi({
      description:
        "The provider's API host (https). Optional for providers with one public host; not used by 'gradiated'.",
    }),
    secret: SecretNameSchema.nullable().optional().openapi({
      description:
        "Name of the workspace secret holding the provider key. Not used by 'gradiated'.",
    }),
    project: z.string().min(1).max(200).nullable().optional().openapi({
      description:
        "The provider project to read. Required for braintrust (project id or name) and posthog (numeric project id); optional elsewhere (LangSmith project, Phoenix project).",
    }),
    filters: z.record(z.string(), z.unknown()).optional().openapi({
      description:
        'Provider-specific filters passed to the fetcher, for example `{"tags": ["prod"]}` or, for \'gradiated\', `{"models": [...], "tasks": [...]}`.',
    }),
  })
  .openapi("SourceProvider");

export type SourceProviderInput = z.infer<typeof SourceProviderSchema>;

export const CreateSourceRequestSchema = z
  .object({
    provider: SourceProviderSchema,
    schedule: z.string().min(1).max(120).nullable().optional().openapi({
      description:
        "Five-field cron in UTC (`*/15 * * * *`); minute resolution, so it fires at most once a minute (a seconds field is rejected). Leave it out to sync only on request.",
    }),
  })
  .openapi("CreateSourceRequest");

export const SourceSyncSchema = z
  .object({
    import_id: z.string().min(1),
    status: z.enum(["queued", "running", "completed", "failed"]),
    full: z.boolean(),
    dataset_version: z.number().int().min(0).nullable(),
    error: z.string().nullable(),
    created_at: IsoTimestampSchema,
    finished_at: IsoTimestampSchema.nullable(),
  })
  .openapi("SourceSync");

export const SourceSchema = z
  .object({
    id: z.string().min(1),
    workspace_id: z.string().min(1),
    dataset: SlugSchema,
    provider: z.object({
      kind: z.enum(SOURCE_PROVIDERS),
      host: z.string().nullable(),
      secret: z.string().nullable(),
      project: z.string().nullable(),
      filters: z.record(z.string(), z.unknown()),
    }),
    schedule: z.string().nullable(),
    next_sync_at: IsoTimestampSchema.nullable().openapi({
      description:
        "When the schedule fires next (null without a schedule or while paused). After a failed sync the schedule backs off: twice its interval per consecutive failure, at most an hour.",
    }),
    status: z.enum(["active", "paused"]).openapi({
      description:
        "`paused` after 10 consecutive failed syncs: the schedule stops firing. A manual sync, or setting a new value for the source's secret, resumes it.",
    }),
    paused_reason: z.string().nullable().openapi({
      description: "Why the source is paused (null while active).",
    }),
    last_error: z.string().nullable().openapi({
      description:
        "The error of the last failed sync (provider keys redacted); cleared by a successful sync.",
    }),
    last_error_at: IsoTimestampSchema.nullable(),
    consecutive_failures: z.number().int().min(0).openapi({
      description: "Failed syncs since the last successful one.",
    }),
    pending_full: z.boolean().openapi({
      description:
        "A full sync was requested while another sync ran; it is queued as soon as that one ends.",
    }),
    last_synced_at: IsoTimestampSchema.nullable().openapi({
      description: "When the last successful sync finished.",
    }),
    last_sync: SourceSyncSchema.nullable().openapi({
      description: "The most recent sync, running or finished.",
    }),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
  })
  .openapi("Source", {
    description:
      "An observability provider synced into one dataset. A source feeds exactly one dataset; a dataset can have several sources. Deleting the dataset deletes its sources; removing a source keeps the dataset.",
  });

export type Source = z.infer<typeof SourceSchema>;

export const SyncSourceRequestSchema = z
  .object({
    full: z.boolean().default(false).openapi({
      description:
        "Rebuild the dataset from the provider as a new version (ignores the stored watermark).",
    }),
  })
  .openapi("SyncSourceRequest");
