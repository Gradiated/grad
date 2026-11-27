import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import {
  CreateDatasetRequestSchema,
  CreateImportRequestSchema,
  CreateUploadRequestSchema,
  DatasetRecordsPageSchema,
  DatasetSchema,
  EvalRunSchema,
  FilterDatasetRequestSchema,
  ImportJobSchema,
  pageLimitSchema,
  pageOf,
  PageQuerySchema,
  PushDatasetRequestSchema,
  RenderDatasetRequestSchema,
  RenderDatasetResponseSchema,
  ScoreDatasetRequestSchema,
  SlugSchema,
  UploadTicketSchema,
} from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { invalid } from "../errors.js";
import { idempotencyOf, replayAware } from "../idempotency.js";
import { renderMessages } from "../planner.js";
import { recordConversation } from "../records.js";
import type { Services } from "../services/index.js";
import { stagingKey } from "../services/uploads.js";
import {
  defaultErrors,
  IdParamSchema,
  jsonResponse,
  requireSecretUse,
  workspaceOf,
  type AppEnv,
} from "./helpers.js";

const NameParamSchema = z.object({ name: SlugSchema });

const jsonBody = <T extends z.ZodType>(schema: T) => ({
  body: { required: true, content: { "application/json": { schema } } },
});

export const registerDatasetRoutes = (
  app: OpenAPIHono<AppEnv>,
  deps: AppDependencies,
  services: Services,
): void => {
  const tags = ["Datasets"];

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/datasets",
      operationId: "listDatasets",
      summary: "List datasets (newest first)",
      tags,
      request: { query: PageQuerySchema },
      responses: {
        200: jsonResponse(pageOf(DatasetSchema), "Datasets."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await services.datasets.list(
          workspaceOf(c, "datasets:read"),
          c.req.valid("query"),
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/datasets",
      operationId: "createDataset",
      summary: "Create an empty dataset",
      tags,
      request: jsonBody(CreateDatasetRequestSchema),
      responses: {
        201: jsonResponse(DatasetSchema, "Created dataset (version 0)."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const created = await services.datasets.create(
        workspaceOf(c, "datasets:write"),
        input.name,
        input.metadata ?? {},
        await idempotencyOf(c),
      );

      return c.json(replayAware(c, created), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/datasets/{name}",
      operationId: "getDataset",
      summary: "Get a dataset by name",
      tags,
      request: { params: NameParamSchema },
      responses: {
        200: jsonResponse(DatasetSchema, "Dataset metadata."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await services.datasets.get(
          workspaceOf(c, "datasets:read"),
          c.req.valid("param").name,
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/datasets/{name}/records",
      operationId: "pushDatasetRecords",
      summary:
        "Append records as a new dataset version (creates the dataset if needed)",
      tags,
      request: {
        params: NameParamSchema,
        ...jsonBody(PushDatasetRequestSchema),
      },
      responses: {
        200: jsonResponse(DatasetSchema, "Updated dataset."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const pushed = await services.datasets.push(
        workspaceOf(c, "datasets:write"),
        c.req.valid("param").name,
        input.records,
        input.metadata,
        await idempotencyOf(c),
      );

      return c.json(replayAware(c, pushed), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/datasets/{name}/records",
      operationId: "listDatasetRecords",
      summary: "Read records of a dataset version",
      tags,
      request: {
        params: NameParamSchema,
        query: z.object({
          version: z.coerce.number().int().min(0).optional(),
          limit: pageLimitSchema(1000, 100),
          cursor: z.string().min(1).max(512).optional(),
        }),
      },
      responses: {
        200: jsonResponse(DatasetRecordsPageSchema, "Dataset records page."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await services.datasets.listRecords(
          workspaceOf(c, "datasets:read"),
          c.req.valid("param").name,
          c.req.valid("query"),
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/datasets/{name}/score",
      operationId: "scoreDataset",
      summary:
        "Score a dataset's records with a rubric (async; the scores become the next version)",
      description:
        "Runs the rubric (judges, validators, regexes, code scorers) on each record's own answer, skipping records that already have every score. It is an eval with `mode: \"score\"`: poll it at /v1/evals/{id}, and it is billed like one. On completion the scores are appended as a score-update part, so the dataset's next version (`scored_dataset_version`) carries them in `record.scores`.",
      tags,
      request: {
        params: NameParamSchema,
        ...jsonBody(ScoreDatasetRequestSchema),
      },
      responses: {
        202: jsonResponse(EvalRunSchema, "Queued scoring job."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      // A scoring job writes a dataset version and is a billed eval.
      workspaceOf(c, "runs:write");

      const created = await services.evals.scoreDataset(
        workspaceOf(c, "datasets:write"),
        c.req.valid("param").name,
        c.req.valid("json"),
        await idempotencyOf(c),
      );

      return c.json(replayAware(c, created), 202);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/datasets/{name}/filter",
      operationId: "filterDataset",
      summary: "Save a filtered view of a dataset version",
      description:
        "Keeps the records whose stored scores, metadata, timestamp or id match, and saves them as a dataset named `<dataset>-f-<hash>` (or `name`). The same filter on the same version returns the same view (200) without recomputing; a new threshold is a new view (201). Filtering calls no model and costs nothing.",
      tags,
      request: {
        params: NameParamSchema,
        ...jsonBody(FilterDatasetRequestSchema),
      },
      responses: {
        200: jsonResponse(DatasetSchema, "The existing view."),
        201: jsonResponse(DatasetSchema, "Created view."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const { dataset, created } = await services.datasets.filter(
        workspaceOf(c, "datasets:write"),
        c.req.valid("param").name,
        c.req.valid("json"),
      );

      return created ? c.json(dataset, 201) : c.json(dataset, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/datasets/{name}/render",
      operationId: "renderDataset",
      summary:
        "Preview chat-template rendering and loss masks (estimated token counts)",
      tags,
      request: {
        params: NameParamSchema,
        ...jsonBody(RenderDatasetRequestSchema),
      },
      responses: {
        200: jsonResponse(RenderDatasetResponseSchema, "Rendered examples."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const workspaceId = workspaceOf(c, "datasets:read");
      const { name } = c.req.valid("param");
      const input = c.req.valid("json");
      const model = deps.catalog.find(input.model);
      if (!model || model.family !== "llm") {
        throw invalid(
          "render_unsupported_model",
          `Model '${input.model}' is not a chat model in the catalog; run \`grad models list\` (GET /v1/base-models).`,
        );
      }

      const { version } = await services.datasets.resolve(workspaceId, name);
      const records = await services.datasets.readRecords(version);
      const examples = records
        .map((record, index) => ({
          record,
          index,
          messages: recordConversation(record),
        }))
        .filter((entry) => entry.messages.length > 0)
        .slice(0, input.limit)
        .map(({ record, index, messages }) =>
          renderMessages(record.id ?? `rec_${index + 1}`, messages, {
            templateRevision: model.template_revision,
            train_on: input.train_on,
            thinking: input.thinking,
            preserve_thinking: input.preserve_thinking,
          }),
        );

      return c.json(
        {
          dataset: name,
          model: model.id,
          template_revision: model.template_revision,
          token_counts: "estimated" as const,
          examples,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/uploads",
      operationId: "createUpload",
      summary:
        "Get an upload URL for a file to import (PUT the bytes, then create an import)",
      tags,
      request: jsonBody(CreateUploadRequestSchema),
      responses: {
        201: jsonResponse(UploadTicketSchema, "Upload ticket."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const ticket = await services.uploads.ticket(
        stagingKey(workspaceOf(c, "datasets:write"), input.sha256),
        input.size_bytes,
        { forClient: true },
      );

      return c.json(ticket, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/datasets/{name}/imports",
      operationId: "createDatasetImport",
      summary:
        "Import an uploaded file or a Hugging Face dataset into a dataset (async job)",
      tags,
      request: {
        params: NameParamSchema,
        ...jsonBody(CreateImportRequestSchema),
      },
      responses: {
        202: jsonResponse(ImportJobSchema, "Queued import job."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const workspaceId = workspaceOf(c, "datasets:write");
      const body = c.req.valid("json");
      requireSecretUse(c, [
        body.source.kind === "hf" ? body.source.secret : undefined,
      ]);
      const created = await services.imports.create(
        workspaceId,
        c.req.valid("param").name,
        body,
        await idempotencyOf(c),
      );

      return c.json(replayAware(c, created), 202);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/imports",
      operationId: "listImports",
      summary: "List dataset import jobs (newest first)",
      tags,
      request: { query: PageQuerySchema },
      responses: {
        200: jsonResponse(pageOf(ImportJobSchema), "Import jobs."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await services.imports.list(
          workspaceOf(c, "datasets:read"),
          c.req.valid("query"),
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/imports/{id}",
      operationId: "getImport",
      summary: "Get a dataset import job",
      tags,
      request: { params: IdParamSchema },
      responses: {
        200: jsonResponse(ImportJobSchema, "Import job."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await services.imports.get(
          workspaceOf(c, "datasets:read"),
          c.req.valid("param").id,
        ),
        200,
      ),
  );
};
