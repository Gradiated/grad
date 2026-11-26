import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import {
  ApiKeySchema,
  CreateApiKeyRequestSchema,
  TrainableModelSchema,
} from "../contracts.js";
import { TRAINABLE_MODELS } from "../planner.js";
import {
  defaultErrors,
  jsonResponse,
  requireScope,
  respondProblem,
  type AppDependencies,
  type AppEnv,
} from "./helpers.js";

export const registerModelsAndKeysRoutes = (
  app: OpenAPIHono<AppEnv>,
  deps: AppDependencies,
): void => {
  const listModelsRoute = createRoute({
    method: "get",
    path: "/v1/models",
    operationId: "listModels",
    summary: "List trainable base models",
    tags: ["Models"],
    responses: {
      200: jsonResponse(
        z.object({ data: z.array(TrainableModelSchema) }),
        "Trainable catalog models.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(listModelsRoute, (c) =>
    c.json({ data: [...TRAINABLE_MODELS] }, 200),
  );

  const createKeyRoute = createRoute({
    method: "post",
    path: "/v1/keys",
    operationId: "createApiKey",
    summary: "Create a scoped API key",
    tags: ["Keys"],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: CreateApiKeyRequestSchema } },
      },
    },
    responses: {
      201: jsonResponse(
        z.object({ key: ApiKeySchema, secret: z.string() }),
        "Created API key (secret returned once).",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(createKeyRoute, async (c) => {
    const denied = requireScope(c, "admin");
    if (denied) return denied;

    const body = c.req.valid("json");
    const principal = c.get("principal");
    if (body.scopes.includes("trainer:worker") && !principal.isPlatformAdmin) {
      return respondProblem(
        c,
        403,
        "forbidden_scope",
        "Platform scope restricted",
        "Only platform administrators may mint keys with the 'trainer:worker' scope.",
      );
    }

    const created = await deps.store.createApiKey({
      workspaceId: principal.workspaceId,
      name: body.name,
      scopes: body.scopes,
    });

    return c.json(created, 201);
  });

  const listKeysRoute = createRoute({
    method: "get",
    path: "/v1/keys",
    operationId: "listApiKeys",
    summary: "List scoped API keys",
    tags: ["Keys"],
    responses: {
      200: jsonResponse(
        z.object({ data: z.array(ApiKeySchema) }),
        "Workspace keys.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(listKeysRoute, async (c) => {
    const denied = requireScope(c, "admin");
    if (denied) return denied;

    const data = await deps.store.listApiKeys(c.get("principal").workspaceId);

    return c.json({ data }, 200);
  });

  const revokeKeyRoute = createRoute({
    method: "delete",
    path: "/v1/keys/{id}",
    operationId: "revokeApiKey",
    summary: "Revoke a scoped API key",
    tags: ["Keys"],
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: {
      200: jsonResponse(ApiKeySchema, "Revoked API key."),
      ...defaultErrors,
    },
  });

  app.openapi(revokeKeyRoute, async (c) => {
    const denied = requireScope(c, "admin");
    if (denied) return denied;

    const { id } = c.req.valid("param");
    const revoked = await deps.store.revokeApiKey(
      c.get("principal").workspaceId,
      id,
    );
    if (!revoked) {
      return respondProblem(
        c,
        404,
        "key_not_found",
        "Key not found",
        `API key '${id}' was not found.`,
      );
    }

    return c.json(revoked, 200);
  });
};
