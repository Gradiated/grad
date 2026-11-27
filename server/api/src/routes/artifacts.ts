import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import {
  ArtifactSchema,
  pageOf,
  PageQuerySchema,
  SlugSchema,
} from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { notFound } from "../errors.js";
import type { Services } from "../services/index.js";
import { toPublicArtifact } from "../services/runs.js";
import {
  defaultErrors,
  IdParamSchema,
  jsonResponse,
  workspaceOf,
  type AppEnv,
} from "./helpers.js";

export const registerArtifactRoutes = (
  app: OpenAPIHono<AppEnv>,
  deps: AppDependencies,
  _services: Services,
): void => {
  const tags = ["Artifacts"];

  const load = async (workspaceId: string, id: string) => {
    const artifact = await deps.store.artifacts.get(workspaceId, id);
    if (!artifact) throw notFound("artifact", id);

    return artifact;
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/artifacts",
      operationId: "listArtifacts",
      summary: "List immutable artifacts (newest first)",
      tags,
      request: {
        query: PageQuerySchema.extend({ name: SlugSchema.optional() }),
      },
      responses: {
        200: jsonResponse(pageOf(ArtifactSchema), "Artifacts."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const workspaceId = workspaceOf(c, "artifacts:read");
      const { name, ...page } = c.req.valid("query");
      const result = await deps.store.artifacts.list(
        workspaceId,
        { name },
        page,
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
          await load(workspaceOf(c, "artifacts:read"), c.req.valid("param").id),
        ),
        200,
      ),
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
      const artifact = await load(
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
          "Content-Disposition": `attachment; filename="${artifact.name}-${artifact.version}.grad.tar.gz"`,
        },
      });
    },
  );
};
