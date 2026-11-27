import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import {
  CreateSourceRequestSchema,
  ImportJobSchema,
  pageOf,
  PageQuerySchema,
  SecretNameParamSchema,
  SecretSchema,
  SetSecretRequestSchema,
  SlugSchema,
  SourceSchema,
  SyncSourceRequestSchema,
} from "../contracts.js";
import {
  SourcePageRequestSchema,
  SourcePageResponseSchema,
} from "../contracts/trainer-jobs.js";
import type { AppDependencies } from "../deps.js";
import { idempotencyOf, replayAware } from "../idempotency.js";
import type { Services } from "../services/index.js";
import {
  defaultErrors,
  IdParamSchema,
  jsonResponse,
  notImplementedError,
  requireScope,
  requireSecretUse,
  workspaceOf,
  type AppEnv,
} from "./helpers.js";

const jsonBody = <T extends z.ZodType>(schema: T) => ({
  body: { required: true, content: { "application/json": { schema } } },
});

const optionalJsonBody = <T extends z.ZodType>(schema: T) => ({
  body: { required: false, content: { "application/json": { schema } } },
});

export const registerSourceRoutes = (
  app: OpenAPIHono<AppEnv>,
  _deps: AppDependencies,
  services: Services,
): void => {
  const secretTags = ["Secrets"];
  const tags = ["Sources"];

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
      // A replace is idempotent by name, so a retried key needs no record.
      await idempotencyOf(c);

      return c.json(
        await services.sources.setSecret(
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
        await services.sources.listSecrets(
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
        await services.sources.getSecret(
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
      await services.sources.deleteSecret(
        workspaceOf(c, "secrets:write"),
        c.req.valid("param").name,
      );

      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/datasets/{name}/sources",
      operationId: "createDatasetSource",
      summary: "Connect an observability provider to a dataset",
      tags,
      request: {
        params: z.object({ name: SlugSchema }),
        ...jsonBody(CreateSourceRequestSchema),
      },
      responses: {
        201: jsonResponse(SourceSchema, "Created source."),
        ...defaultErrors,
        ...notImplementedError,
      },
    }),
    async (c) => {
      const workspaceId = workspaceOf(c, "sources:write");
      const body = c.req.valid("json");
      requireSecretUse(c, [body.provider.secret]);
      const created = await services.sources.create(
        workspaceId,
        c.req.valid("param").name,
        body,
        await idempotencyOf(c),
      );

      return c.json(replayAware(c, created), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/sources",
      operationId: "listSources",
      summary: "List sources (newest first), optionally for one dataset",
      tags,
      request: {
        query: PageQuerySchema.extend({ dataset: SlugSchema.optional() }),
      },
      responses: {
        200: jsonResponse(pageOf(SourceSchema), "Sources."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const { dataset, ...page } = c.req.valid("query");

      return c.json(
        await services.sources.list(
          workspaceOf(c, "sources:read"),
          { dataset },
          page,
        ),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/sources/{id}",
      operationId: "getSource",
      summary: "Get a source and its latest sync",
      tags,
      request: { params: IdParamSchema },
      responses: {
        200: jsonResponse(SourceSchema, "Source."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await services.sources.get(
          workspaceOf(c, "sources:read"),
          c.req.valid("param").id,
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/sources/{id}",
      operationId: "deleteSource",
      summary: "Remove a source (its dataset and versions stay)",
      tags,
      request: { params: IdParamSchema },
      responses: {
        204: { description: "Removed." },
        ...defaultErrors,
      },
    }),
    async (c) => {
      await services.sources.remove(
        workspaceOf(c, "sources:write"),
        c.req.valid("param").id,
      );

      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/sources/{id}/sync",
      operationId: "syncSource",
      summary:
        "Sync now: queue an import of new traces and scores (returns the running one if a sync is in progress)",
      description:
        "A source starts at most one sync per minute. Within a minute of the last sync's start this returns that sync with a `Retry-After` header (seconds until a new one may start), so a retried or repeated call is safe. A full sync asked for while an incremental one is queued or running returns the running one and starts right after it (`pending_full` on the source). Syncing a paused source resumes it.",
      tags,
      request: {
        params: IdParamSchema,
        ...optionalJsonBody(SyncSourceRequestSchema),
      },
      responses: {
        202: {
          ...jsonResponse(
            ImportJobSchema,
            "The sync's import job: new, running, or the last one when it started under a minute ago.",
          ),
          headers: z.object({
            "Retry-After": z.string().optional().openapi({
              description:
                "Seconds until a new sync may start; set when the returned job is the last one, not a new one.",
            }),
          }),
        },
        ...defaultErrors,
        ...notImplementedError,
      },
    }),
    async (c) => {
      const workspaceId = workspaceOf(c, "sources:write");
      // At most one sync per source is queued or running, so a retry is safe.
      await idempotencyOf(c);
      const text = await c.req.text();
      const input = SyncSourceRequestSchema.parse(
        text.trim() ? JSON.parse(text) : {},
      );

      const { job, retryAfter } = await services.sources.sync(
        workspaceId,
        c.req.valid("param").id,
        input.full,
      );
      if (retryAfter !== null) c.header("Retry-After", String(retryAfter));

      return c.json(job, 202);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/trainer-jobs/{id}/source-page",
      operationId: "pullTrainerSourcePage",
      summary:
        "A gradiated source sync's next page of Cloud gateway traces (for the job's workspace)",
      tags: ["TrainerJobs"],
      "x-internal": true,
      request: { params: IdParamSchema, ...jsonBody(SourcePageRequestSchema) },
      responses: {
        200: jsonResponse(SourcePageResponseSchema, "One page."),
        ...defaultErrors,
        ...notImplementedError,
      },
    }),
    async (c) => {
      const principal = requireScope(c, "trainer:worker");
      const input = c.req.valid("json");

      return c.json(
        await services.sources.pullTracesFor(
          principal,
          c.req.valid("param").id,
          input,
        ),
        200,
      );
    },
  );
};
