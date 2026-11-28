import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import {
  ArtifactDownloadUrlSchema,
  ArtifactImportSchema,
  ArtifactPinSchema,
  ArtifactSchema,
  CreateArtifactImportRequestSchema,
  pageOf,
  PageQuerySchema,
  SearchQuerySchema,
  PinArtifactRequestSchema,
  PinHolderSchema,
  SlugSchema,
} from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { forbidden } from "../errors.js";
import { addSeconds } from "../clock.js";
import { idempotencyOf, replayAware } from "../idempotency.js";
import { toPublicArtifact } from "../services/artifacts.js";
import type { Services } from "../services/index.js";
import { attachmentDisposition } from "../storage/types.js";
import {
  defaultErrors,
  IdParamSchema,
  jsonBody,
  jsonResponse,
  requireScope,
  requireSecretUse,
  workspaceOf,
  type AppEnv,
} from "./helpers.js";

/** What a downloaded bundle is called: `support-router-2026-11-27-1.grad.tar.gz`. */
const bundleFilename = (a: { name: string; version: string }): string =>
  `${a.name}-${a.version}.grad.tar.gz`;

/** Holders Gradiated Cloud's inference side pins with (model versions). */
const INFERENCE_HOLDER_PREFIX = "inference:";

export const registerArtifactRoutes = (
  app: OpenAPIHono<AppEnv>,
  deps: AppDependencies,
  services: Services,
): void => {
  const tags = ["Artifacts"];

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifacts",
      operationId: "listArtifacts",
      summary: "List immutable artifacts (newest first)",
      tags,
      request: {
        query: PageQuerySchema.extend({
          name: SlugSchema.optional(),
          q: SearchQuerySchema,
        }),
      },
      responses: {
        200: jsonResponse(pageOf(ArtifactSchema), "Artifacts."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const workspaceId = workspaceOf(c, "artifacts:read");
      const { name, q, limit, cursor } = c.req.valid("query");
      const result = await deps.store.artifacts.list(
        workspaceId,
        { name, q },
        { limit, cursor },
      );

      return c.json(
        {
          data: result.data.map(toPublicArtifact),
          next_cursor: result.next_cursor,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifacts/{id}",
      operationId: "getArtifact",
      summary: "Get an artifact by id or name@latest",
      tags,
      request: { params: IdParamSchema },
      responses: {
        200: jsonResponse(ArtifactSchema, "Artifact metadata."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        toPublicArtifact(
          await services.artifacts.get(
            workspaceOf(c, "artifacts:read"),
            c.req.valid("param").id,
          ),
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifacts/{id}/download-url",
      operationId: "getArtifactDownloadUrl",
      summary:
        "A short-lived presigned URL of an artifact bundle (browsers download straight from storage)",
      tags,
      request: { params: IdParamSchema },
      responses: {
        200: jsonResponse(ArtifactDownloadUrlSchema, "Presigned download."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const artifact = await services.artifacts.get(
        workspaceOf(c, "artifacts:read"),
        c.req.valid("param").id,
      );
      const seconds = 900;
      const filename = bundleFilename(artifact);

      return c.json(
        {
          url: await deps.storage.presignDownload(
            artifact.storage_key,
            seconds,
            { forClient: true, filename },
          ),
          expires_at: addSeconds(deps.clock.now(), seconds).toISOString(),
          sha256: artifact.sha256,
          size_bytes: artifact.size_bytes,
          filename,
        },
        200,
        { "Cache-Control": "no-store" },
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifacts/{id}/download",
      operationId: "downloadArtifact",
      summary:
        "Download an artifact bundle (.grad.tar.gz); verify X-Artifact-Sha256",
      tags,
      request: { params: IdParamSchema },
      responses: {
        200: {
          description: "Artifact bundle.",
          content: {
            "application/octet-stream": {
              schema: z.string().openapi({ format: "binary" }),
            },
          },
        },
        ...defaultErrors,
      },
    }),
    async (c) => {
      const artifact = await services.artifacts.get(
        workspaceOf(c, "artifacts:read"),
        c.req.valid("param").id,
      );
      const stream = await deps.storage.getStream(artifact.storage_key);

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(artifact.size_bytes),
          "X-Content-Type-Options": "nosniff",
          "X-Artifact-Sha256": artifact.sha256,
          "Content-Disposition": attachmentDisposition(
            bundleFilename(artifact),
          ),
        },
      });
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/artifacts/{id}",
      operationId: "deleteArtifact",
      summary:
        "Delete a released artifact and its bundle (409 artifact_pinned while a holder pins it)",
      tags,
      request: { params: IdParamSchema },
      responses: {
        204: { description: "Deleted." },
        ...defaultErrors,
      },
    }),
    async (c) => {
      await services.artifacts.delete(
        workspaceOf(c, "artifacts:write"),
        c.req.valid("param").id,
      );

      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifacts/{id}/pins",
      operationId: "pinArtifact",
      summary:
        "Pin an artifact for a holder (artifacts:pin): a pinned artifact is never deleted",
      description:
        "Gradiated Cloud pins the artifact a published model version references. Pinning again with the same holder returns the existing pin (200).",
      tags,
      "x-internal": true,
      request: { params: IdParamSchema, ...jsonBody(PinArtifactRequestSchema) },
      responses: {
        200: jsonResponse(ArtifactPinSchema, "Existing pin."),
        201: jsonResponse(ArtifactPinSchema, "Pinned."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const { workspaceId } = requireScope(c, "artifacts:pin");
      const body = c.req.valid("json");
      const { pin, created } = await services.artifacts.pin(
        workspaceId,
        c.req.valid("param").id,
        body.holder,
        body.reason,
      );

      return created ? c.json(pin, 201) : c.json(pin, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/artifacts/{id}/pins/{holder}",
      operationId: "unpinArtifact",
      summary: "Remove a holder's pin (artifacts:pin)",
      description:
        "On Gradiated Cloud, `inference:` holders (published model versions) are removed only by Cloud itself: this answers 403 `pin_managed_by_cloud` for them.",
      tags,
      "x-internal": true,
      request: {
        params: IdParamSchema.extend({ holder: PinHolderSchema }),
      },
      responses: {
        204: { description: "Unpinned." },
        ...defaultErrors,
      },
    }),
    async (c) => {
      const { workspaceId } = requireScope(c, "artifacts:pin");
      const { id, holder } = c.req.valid("param");
      // A published model version's pin: removing it here would let the
      // artifact be deleted under a live version.
      if (
        deps.settings.inferencePinsManagedByCloud &&
        holder.startsWith(INFERENCE_HOLDER_PREFIX)
      ) {
        throw forbidden(
          "pin_managed_by_cloud",
          `Pin '${holder}' belongs to a published model version on Gradiated Cloud; it goes away when that version is retired in the Gradiated console or API, not through this endpoint.`,
        );
      }
      await services.artifacts.unpin(workspaceId, id, holder);

      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/artifact-imports",
      operationId: "createArtifactImport",
      summary:
        "Register uploaded files or a Hugging Face repo as an artifact (async import job)",
      description:
        "An import worker validates the files against docs/ARTIFACT_FORMATS.md and the base model's config.json, bundles them as grad.artifact/1 and releases them as name@YYYY-MM-DD-n. A validation failure fails the import with error_code invalid_artifact and an error that names the file.",
      tags,
      request: jsonBody(CreateArtifactImportRequestSchema),
      responses: {
        202: jsonResponse(ArtifactImportSchema, "Queued import."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const principal = requireScope(c, "artifacts:write");
      const body = c.req.valid("json");
      requireSecretUse(c, [
        body.source.kind === "hf" ? body.source.secret : undefined,
      ]);
      const created = await services.artifactImports.create(
        principal,
        body,
        await idempotencyOf(c),
      );

      return c.json(replayAware(c, created), 202);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifact-imports/{id}",
      operationId: "getArtifactImport",
      summary: "Get an artifact import",
      tags,
      request: { params: IdParamSchema },
      responses: {
        200: jsonResponse(ArtifactImportSchema, "Artifact import."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await services.artifactImports.get(
          workspaceOf(c, "artifacts:read"),
          c.req.valid("param").id,
        ),
        200,
      ),
  );
};
