import { z } from "@hono/zod-openapi";

import {
  IsoTimestampSchema,
  ModelIdSchema,
  Sha256HexSchema,
  SlugSchema,
} from "./common.js";
import { HfRepoSchema, HfRevisionSchema } from "./datasets.js";
import {
  ArtifactFormatSchema,
  type ArtifactFormat,
  type RecipeKind,
} from "./runs.js";

/** Formats an upload or import may declare: every ARTIFACT_FORMATS format. */
export const IMPORTABLE_FORMATS = [
  "peft_lora",
  "merged_safetensors",
  "cartridge",
  "encoder_safetensors",
  "router_bundle",
  "decision_bundle",
  "reward_bundle",
] as const satisfies readonly ArtifactFormat[];

/**
 * The recipe_kind an uploaded or imported artifact records: the format's own
 * recipe (a LoRA is continued like an SFT adapter).
 */
export const IMPORTED_RECIPE_KIND: Record<
  (typeof IMPORTABLE_FORMATS)[number],
  RecipeKind
> = {
  peft_lora: "sft",
  merged_safetensors: "sft",
  cartridge: "cartridge",
  encoder_safetensors: "embedding",
  router_bundle: "router",
  decision_bundle: "decision",
  reward_bundle: "reward",
};

export const ImportableFormatSchema = z
  .enum(IMPORTABLE_FORMATS)
  .openapi("ImportableArtifactFormat");

export const ArtifactImportSourceSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("upload"),
      upload_id: Sha256HexSchema.openapi({
        description:
          "A tar (optionally gzip) of the artifact's files, uploaded with POST /v1/uploads.",
      }),
    }),
    z.object({
      kind: z.literal("hf"),
      repo: HfRepoSchema,
      revision: HfRevisionSchema.optional().openapi({
        description:
          "Branch, tag or commit (default main). The import pins the commit it resolves.",
      }),
      secret: SlugSchema.optional().openapi({
        description:
          "Name of a workspace secret holding a Hugging Face token, for gated or private repos.",
      }),
    }),
  ])
  .openapi("ArtifactImportSource");

export const CreateArtifactImportRequestSchema = z
  .object({
    source: ArtifactImportSourceSchema,
    base_model: ModelIdSchema.openapi({
      description:
        "The catalog base model (GET /v1/base-models) the files were trained on.",
    }),
    format: ImportableFormatSchema.default("peft_lora"),
    name: SlugSchema.optional().openapi({
      description:
        "The artifact name (name@YYYY-MM-DD-n). Required for uploads; HF imports default to the repo's name.",
    }),
  })
  .openapi("CreateArtifactImportRequest");

export const ArtifactImportStatusSchema = z
  .enum(["queued", "running", "completed", "failed"])
  .openapi("ArtifactImportStatus");

export const ArtifactImportSchema = z
  .object({
    id: z.string().min(1),
    workspace_id: z.string().min(1),
    status: ArtifactImportStatusSchema,
    name: SlugSchema,
    base_model: z.string().min(1),
    format: ArtifactFormatSchema,
    source: z.object({
      kind: z.enum(["upload", "hf"]),
      upload_id: z.string().nullable(),
      repo: z.string().nullable(),
      revision: z.string().nullable().openapi({
        description:
          "HF imports: the requested revision, then the pinned commit once imported.",
      }),
    }),
    artifact_id: z.string().nullable().openapi({
      description: "The artifact (name@version) once the import completed.",
    }),
    error: z.string().nullable().openapi({
      description:
        "Why it failed. Validation failures name the file and the problem (`adapter_config.json: ...`).",
    }),
    error_code: z.string().nullable().openapi({
      description:
        "invalid_artifact (the files don't match the format spec or the base model), source_unavailable, or null.",
    }),
    attempt: z.number().int().min(0),
    created_at: IsoTimestampSchema,
    updated_at: IsoTimestampSchema,
  })
  .openapi("ArtifactImport");

export type ArtifactImport = z.infer<typeof ArtifactImportSchema>;

/** Holders look like `inference:model-version:mv_123` (no '/'). */
export const PinHolderSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/, "Letters, digits and . _ : @ -.");

export const PinArtifactRequestSchema = z
  .object({
    holder: PinHolderSchema,
    reason: z.string().min(1).max(500),
  })
  .openapi("PinArtifactRequest");

export const ArtifactPinSchema = z
  .object({
    artifact_id: z.string().min(1),
    holder: z.string().min(1),
    reason: z.string(),
    created_at: IsoTimestampSchema,
  })
  .openapi("ArtifactPin");

export type ArtifactPin = z.infer<typeof ArtifactPinSchema>;

export const ArtifactDownloadUrlSchema = z
  .object({
    url: z.string().url().openapi({
      description:
        "A presigned GET of the bundle (.grad.tar.gz) straight from storage; no Authorization header. Verify its SHA-256.",
    }),
    expires_at: IsoTimestampSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size_bytes: z.number().int().min(0),
    filename: z.string().min(1),
  })
  .openapi("ArtifactDownloadUrl");

export type ArtifactDownloadUrl = z.infer<typeof ArtifactDownloadUrlSchema>;
