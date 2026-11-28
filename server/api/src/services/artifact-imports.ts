import type { z } from "@hono/zod-openapi";

import type { AuthPrincipal } from "../adapters.js";
import {
  IMPORTED_RECIPE_KIND,
  type Artifact,
  type ArtifactImport,
  type CreateArtifactImportRequestSchema,
  type TrainerJob,
} from "../contracts.js";
import type { CompleteJobRequestSchema } from "../contracts/trainer-jobs.js";
import type { AppDependencies } from "../deps.js";
import { conflict, invalid, notFound } from "../errors.js";
import { createOnce, type Created } from "../idempotency.js";
import { HF_HOST } from "../secret-hosts.js";
import type {
  ArtifactImportPayload,
  IdempotencyInput,
  ImportJobRecord,
} from "../store/types.js";
import { leaseLost, RELEASE, fenceOf } from "./jobs.js";
import { holdBlob, toPublicArtifact } from "./artifacts.js";
import type { SecretService, SecretUse } from "./secrets.js";
import {
  artifactKey,
  stagingKey,
  uploadIncomplete,
  type UploadService,
} from "./uploads.js";

type CreateBody = z.infer<typeof CreateArtifactImportRequestSchema>;
type CompleteBody = z.infer<typeof CompleteJobRequestSchema>;

const HF_USE: SecretUse = { url: `https://${HF_HOST}`, use: "HF import" };
const COMMIT_RE = /^[0-9a-f]{40}$/;

/** An HF import's default name: the repo's name as a slug. */
const nameFromRepo = (repo: string): string =>
  (repo.split("/").pop() ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64) || "import";

export const toPublicArtifactImport = (
  job: ImportJobRecord & { artifact: ArtifactImportPayload },
): ArtifactImport => {
  const { artifact } = job;
  const source = artifact.source;

  return {
    id: job.id,
    workspace_id: job.workspace_id,
    status: job.status,
    name: artifact.name,
    base_model: artifact.base_model,
    format: artifact.format,
    source: {
      kind: source.kind,
      upload_id: source.kind === "upload" ? source.upload_id : null,
      repo: source.kind === "hf" ? source.repo : null,
      revision: source.kind === "hf" ? source.revision : null,
    },
    artifact_id: artifact.artifact_id,
    error: job.error,
    error_code: artifact.error_code,
    attempt: job.attempt,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };
};

const isArtifactImport = (
  job: ImportJobRecord | null,
): job is ImportJobRecord & { artifact: ArtifactImportPayload } =>
  job?.artifact != null;

/**
 * `grad artifacts upload` and `grad artifacts import`: an import job (kind
 * `import`, `payload.artifact`) that a CPU import worker runs. The worker
 * validates the files against docs/ARTIFACT_FORMATS.md and the base model's
 * config, bundles them as grad.artifact/1 and uploads the bundle to
 * `artifacts/<ws>/<sha256>`; completing the job releases it as
 * `name@YYYY-MM-DD-n`, like a trained artifact.
 */
export interface ArtifactImportService {
  create(
    principal: AuthPrincipal,
    body: CreateBody,
    idempotency?: IdempotencyInput,
  ): Promise<Created<ArtifactImport>>;
  get(workspaceId: string, id: string): Promise<ArtifactImport>;
  /** The worker's claim for an artifact import. */
  claim(job: ImportJobRecord): Promise<TrainerJob>;
  /** Releases the uploaded bundle and completes the job. */
  publish(
    job: ImportJobRecord,
    body: CompleteBody,
  ): Promise<{ job: ImportJobRecord; artifact: Artifact }>;
}

export const createArtifactImportService = (
  deps: AppDependencies,
  collaborators: {
    uploads: UploadService;
    secrets: SecretService;
  },
): ArtifactImportService => {
  const { store, catalog, clock, settings } = deps;
  const { uploads, secrets } = collaborators;

  const load = async (workspaceId: string, id: string) => {
    const job = await store.imports.get(workspaceId, id);
    if (!isArtifactImport(job)) throw notFound("artifact_import", id);

    return job;
  };

  const checkBase = (baseModel: string, format: CreateBody["format"]) => {
    const model = catalog.find(baseModel);
    if (!model) {
      throw invalid(
        "unknown_model",
        `Base model '${baseModel}' is not in the catalog; pass a model id from GET /v1/base-models.`,
      );
    }
    const encoder = format === "encoder_safetensors";
    if (encoder !== (model.family === "encoder")) {
      throw invalid(
        "format_base_mismatch",
        encoder
          ? `Format encoder_safetensors needs an encoder base model; '${model.id}' is a causal LM.`
          : `Format ${format} needs a causal LM base model; '${model.id}' is an encoder (use encoder_safetensors).`,
      );
    }

    return model;
  };

  return {
    create: async (principal, body, idempotency) => {
      const workspaceId = principal.workspaceId;
      const model = checkBase(body.base_model, body.format);

      return createOnce(
        idempotency,
        (key) => store.jobs.findIdempotent(workspaceId, key),
        async (id) => toPublicArtifactImport(await load(workspaceId, id)),
        async () => {
          const common = {
            workspaceId,
            maxAttempts: settings.maxAttempts,
            maxQueued: settings.queue.maxQueued,
            idempotency,
          };
          if (body.source.kind === "hf") {
            if (body.source.secret !== undefined) {
              await secrets.require(workspaceId, body.source.secret, HF_USE);
            }
            const created = await store.imports.createArtifactImport({
              ...common,
              uploadKey: null,
              artifact: {
                name: body.name ?? nameFromRepo(body.source.repo),
                base_model: model.id,
                format: body.format,
                source: {
                  kind: "hf",
                  repo: body.source.repo,
                  revision: body.source.revision ?? null,
                  secret: body.source.secret ?? null,
                },
                provenance: {
                  source: "import",
                  run_id: null,
                  uploader: null,
                  uri: null,
                },
                artifact_id: null,
                error_code: null,
              },
            });
            return toPublicArtifactImport(
              created as ImportJobRecord & { artifact: ArtifactImportPayload },
            );
          }

          if (body.name === undefined) {
            throw invalid(
              "name_required",
              "Uploads need an artifact name (`name`); the SDKs default it to the file or directory name.",
            );
          }
          const blob = await uploads.commit(body.source.upload_id, (sha) =>
            stagingKey(workspaceId, sha),
          );
          const created = await store.imports.createArtifactImport({
            ...common,
            uploadKey: blob.key,
            artifact: {
              name: body.name,
              base_model: model.id,
              format: body.format,
              source: {
                kind: "upload",
                upload_id: blob.sha256,
                size_bytes: blob.sizeBytes,
              },
              provenance: {
                source: "upload",
                run_id: null,
                uploader: principal.actor,
                uri: null,
              },
              artifact_id: null,
              error_code: null,
            },
          });

          return toPublicArtifactImport(
            created as ImportJobRecord & { artifact: ArtifactImportPayload },
          );
        },
      );
    },

    get: async (workspaceId, id) =>
      toPublicArtifactImport(await load(workspaceId, id)),

    claim: async (job) => {
      const artifact = job.artifact as ArtifactImportPayload;
      const { source } = artifact;
      const claimed =
        source.kind === "upload"
          ? {
              kind: "upload",
              sha256: source.upload_id,
              size_bytes: source.size_bytes,
              download_url: await uploads.downloadUrl(job.upload_key as string),
            }
          : {
              kind: "hf",
              repo: source.repo,
              revision: source.revision,
              ...(source.secret !== null
                ? {
                    token: await secrets.reveal(
                      job.workspace_id,
                      source.secret,
                      HF_USE,
                    ),
                  }
                : {}),
            };

      return {
        id: job.id,
        kind: "import",
        attempt: job.attempt,
        lease_seconds: job.lease_seconds,
        lease_expires_at: job.lease_expires_at as string,
        run: null,
        import: null,
        eval: null,
        artifact_import: {
          id: job.id,
          workspace_id: job.workspace_id,
          name: artifact.name,
          base_model: artifact.base_model,
          format: artifact.format,
          provenance: artifact.provenance,
          source: claimed,
        },
        price_per_million_tokens: null,
        max_cost_usd: null,
        dataset: null,
        resume: null,
        base: null,
      } satisfies TrainerJob;
    },

    publish: async (job, body) => {
      const artifact = job.artifact as ArtifactImportPayload;
      const manifest = body.manifest;
      if (!body.upload_id) {
        throw invalid(
          "artifact_required",
          "A completed artifact import must reference the uploaded bundle (upload_id).",
        );
      }
      if (
        manifest.format !== artifact.format ||
        manifest.base_model !== artifact.base_model
      ) {
        throw conflict(
          "manifest_mismatch",
          `The bundle's manifest is ${String(manifest.format)} on ${String(manifest.base_model)}; this import is ${artifact.format} on ${artifact.base_model}.`,
        );
      }
      let provenance = artifact.provenance;
      let source = artifact.source;
      if (source.kind === "hf") {
        // The worker pins the commit it imported: hf://owner/name@<sha>.
        const uri = String(
          (manifest.provenance as { uri?: unknown } | undefined)?.uri ?? "",
        );
        const revision = uri.slice(`hf://${source.repo}@`.length);
        if (
          !uri.startsWith(`hf://${source.repo}@`) ||
          !COMMIT_RE.test(revision)
        ) {
          throw invalid(
            "invalid_manifest",
            `An HF import's manifest.provenance.uri must be hf://${source.repo}@<40-hex commit>, not '${uri}'.`,
          );
        }
        provenance = { ...provenance, uri };
        source = { ...source, revision };
      }
      const blob = await uploads.commit(body.upload_id, (sha) =>
        artifactKey(job.workspace_id, sha),
      );
      const now = clock.now().toISOString();

      return store.transaction(async () => {
        if (!(await holdBlob(deps, blob.key))) {
          throw uploadIncomplete(blob.sha256);
        }
        const release = await store.artifacts.createRelease({
          workspaceId: job.workspace_id,
          name: artifact.name,
          runId: null,
          sourceId: null,
          baseModel: artifact.base_model,
          recipeKind:
            IMPORTED_RECIPE_KIND[
              artifact.format as keyof typeof IMPORTED_RECIPE_KIND
            ],
          format: artifact.format,
          storageKey: blob.key,
          sha256: blob.sha256,
          sizeBytes: blob.sizeBytes,
          manifest: { ...manifest, provenance, import_id: job.id },
          evalReport: null,
        });
        const updated = await store.imports.update(
          job.id,
          {
            ...RELEASE,
            status: "completed",
            finished_at: now,
            error: null,
            artifact: {
              ...artifact,
              source,
              provenance,
              artifact_id: release.id,
              error_code: null,
            },
          },
          fenceOf(job, ["running"]),
        );
        if (!updated) throw leaseLost(job.id);

        return { job: updated, artifact: toPublicArtifact(release) };
      });
    },
  };
};
