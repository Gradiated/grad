import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";

import {
  ApiKeySchema,
  CreateApiKeyRequestSchema,
  CreatedApiKeySchema,
  pageOf,
  PageQuerySchema,
  TrainableModelSchema,
} from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { ApiError, notFound } from "../errors.js";
import { createOnce, idempotencyOf } from "../idempotency.js";
import {
  defaultErrors,
  IdParamSchema,
  jsonResponse,
  workspaceOf,
  type AppEnv,
} from "./helpers.js";

export const registerModelsAndKeysRoutes = (
  app: OpenAPIHono<AppEnv>,
  deps: AppDependencies,
): void => {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/base-models",
      operationId: "listBaseModels",
      summary:
        "List trainable base models (the server catalog and price source)",
      tags: ["Models"],
      responses: {
        200: jsonResponse(
          z.object({ data: z.array(TrainableModelSchema) }),
          "Trainable catalog models.",
        ),
        ...defaultErrors,
      },
    }),
    (c) => c.json({ data: [...deps.catalog.list()] }, 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/keys",
      operationId: "createApiKey",
      summary:
        "Create a scoped workspace API key (trainer worker keys are platform config, not keys)",
      tags: ["Keys"],
      request: {
        body: {
          required: true,
          content: {
            "application/json": { schema: CreateApiKeyRequestSchema },
          },
        },
      },
      responses: {
        201: jsonResponse(
          CreatedApiKeySchema,
          "Created API key (secret returned once).",
        ),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const workspaceId = workspaceOf(c, "admin");
      const input = c.req.valid("json");
      const idempotency = await idempotencyOf(c);
      const created = await createOnce(
        idempotency,
        (key) => deps.store.apiKeys.findIdempotent(workspaceId, key),
        () => {
          // The secret is never stored, so a replay cannot return it.
          throw new ApiError(
            409,
            "idempotency_replay_unavailable",
            "Response not replayable",
            "The first request with this Idempotency-Key created the key, but its secret is shown only once. List the keys to find it, or revoke it and create a new one.",
          );
        },
        async () =>
          deps.store.apiKeys.create({
            workspaceId,
            name: input.name,
            scopes: [...new Set(input.scopes)],
            idempotency,
          }),
      );

      return c.json(created.value, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/keys",
      operationId: "listApiKeys",
      summary: "List workspace API keys",
      tags: ["Keys"],
      request: { query: PageQuerySchema },
      responses: {
        200: jsonResponse(pageOf(ApiKeySchema), "Workspace keys."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await deps.store.apiKeys.list(
          workspaceOf(c, "admin"),
          c.req.valid("query"),
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/keys/{id}",
      operationId: "revokeApiKey",
      summary: "Revoke a workspace API key",
      tags: ["Keys"],
      request: { params: IdParamSchema },
      responses: {
        200: jsonResponse(ApiKeySchema, "Revoked API key."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const revoked = await deps.store.apiKeys.revoke(
        workspaceOf(c, "admin"),
        id,
      );
      if (!revoked) throw notFound("key", id);

      return c.json(revoked, 200);
    },
  );
};
