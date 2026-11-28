import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";

import {
  pageOf,
  PageQuerySchema,
  SecretNameParamSchema,
  SecretSchema,
  SetSecretRequestSchema,
} from "../contracts.js";
import type { Services } from "../services/index.js";
import {
  defaultErrors,
  jsonBody,
  jsonResponse,
  notImplementedError,
  workspaceOf,
  type AppEnv,
} from "./helpers.js";

/** Workspace secrets: written and listed, never read back (values reach workers only). */
export const registerSecretRoutes = (
  app: OpenAPIHono<AppEnv>,
  services: Services,
): void => {
  const secretTags = ["Secrets"];

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/secrets",
      operationId: "setSecret",
      summary: "Create or replace a workspace secret (the value is write-only)",
      tags: secretTags,
      request: jsonBody(SetSecretRequestSchema),
      responses: {
        200: jsonResponse(
          SecretSchema,
          "The secret's metadata (never the value).",
        ),
        ...defaultErrors,
        ...notImplementedError,
      },
    }),
    async (c) => {
      const input = c.req.valid("json");

      return c.json(
        await services.secrets.set(
          workspaceOf(c, "secrets:write"),
          input.name,
          input.value,
          input.allowed_hosts,
        ),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/secrets",
      operationId: "listSecrets",
      summary: "List workspace secrets (names and metadata only)",
      tags: secretTags,
      request: { query: PageQuerySchema },
      responses: {
        200: jsonResponse(pageOf(SecretSchema), "Secrets."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await services.secrets.list(
          workspaceOf(c, "secrets:read"),
          c.req.valid("query"),
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/secrets/{name}",
      operationId: "getSecret",
      summary: "Get a secret's metadata (never the value)",
      tags: secretTags,
      request: { params: SecretNameParamSchema },
      responses: {
        200: jsonResponse(SecretSchema, "Secret metadata."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await services.secrets.get(
          workspaceOf(c, "secrets:read"),
          c.req.valid("param").name,
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/secrets/{name}",
      operationId: "deleteSecret",
      summary: "Delete a secret (409 while a source uses it)",
      tags: secretTags,
      request: { params: SecretNameParamSchema },
      responses: {
        204: { description: "Deleted." },
        ...defaultErrors,
      },
    }),
    async (c) => {
      await services.secrets.delete(
        workspaceOf(c, "secrets:write"),
        c.req.valid("param").name,
      );

      return c.body(null, 204);
    },
  );
};
