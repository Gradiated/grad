import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";

import {
  ArtifactSchema,
  CheckpointSchema,
  pageOf,
  PageQuerySchema,
  PromoteCheckpointRequestSchema,
} from "../contracts.js";
import type { Services } from "../services/index.js";
import {
  defaultErrors,
  IdParamSchema,
  jsonResponse,
  optionalJson,
  workspaceOf,
  type AppEnv,
} from "./helpers.js";

export const registerCheckpointRoutes = (
  app: OpenAPIHono<AppEnv>,
  services: Services,
): void => {
  const tags = ["Checkpoints"];

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/runs/{id}/checkpoints",
      operationId: "listRunCheckpoints",
      summary:
        "List unexpired checkpoints of a run (best and final never expire)",
      tags,
      request: { params: IdParamSchema, query: PageQuerySchema },
      responses: {
        200: jsonResponse(pageOf(CheckpointSchema), "Checkpoints by step."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await services.checkpoints.list(
          workspaceOf(c, "runs:read"),
          c.req.valid("param").id,
          c.req.valid("query"),
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/checkpoints/{id}/promote",
      operationId: "promoteCheckpoint",
      summary:
        "Release an exportable checkpoint as a named, versioned artifact (promoting it again under the same name returns that release)",
      tags,
      request: {
        params: IdParamSchema,
        body: {
          required: false,
          content: {
            "application/json": { schema: PromoteCheckpointRequestSchema },
          },
        },
      },
      responses: {
        201: jsonResponse(ArtifactSchema, "Promoted artifact."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const workspaceId = workspaceOf(c, "artifacts:write");
      const input = await optionalJson(c, PromoteCheckpointRequestSchema);

      return c.json(
        await services.checkpoints.promote(
          workspaceId,
          c.req.valid("param").id,
          input.name,
        ),
        201,
      );
    },
  );
};
