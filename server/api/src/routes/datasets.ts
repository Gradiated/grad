import { randomUUID } from "node:crypto";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import {
  DatasetRecordSchema,
  DatasetSchema,
  PushDatasetRequestSchema,
  RenderDatasetRequestSchema,
  RenderDatasetResponseSchema,
  SlugSchema,
} from "../contracts.js";
import { renderMessages } from "../planner.js";
import {
  defaultErrors,
  jsonResponse,
  readDatasetRecords,
  requireScope,
  respondProblem,
  writeDatasetRecords,
  type AppDependencies,
  type AppEnv,
} from "./helpers.js";

export const registerDatasetRoutes = (
  app: OpenAPIHono<AppEnv>,
  deps: AppDependencies,
): void => {
  const datasetLocks = new Map<string, Promise<unknown>>();
  const withDatasetLock = async <T>(
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const prior = datasetLocks.get(key) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    datasetLocks.set(key, next);
    try {
      return await next;
    } finally {
      if (datasetLocks.get(key) === next) {
        datasetLocks.delete(key);
      }
    }
  };
  const listDatasetsRoute = createRoute({
    method: "get",
    path: "/v1/datasets",
    operationId: "listDatasets",
    summary: "List datasets",
    tags: ["Datasets"],
    responses: {
      200: jsonResponse(
        z.object({ data: z.array(DatasetSchema) }),
        "Datasets.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(listDatasetsRoute, async (c) => {
    const denied = requireScope(c, "datasets:read");
    if (denied) return denied;

    const data = await deps.store.listDatasets(c.get("principal").workspaceId);

    return c.json({ data }, 200);
  });

  const getDatasetRoute = createRoute({
    method: "get",
    path: "/v1/datasets/{name}",
    operationId: "getDataset",
    summary: "Get a dataset by name",
    tags: ["Datasets"],
    request: { params: z.object({ name: SlugSchema }) },
    responses: {
      200: jsonResponse(DatasetSchema, "Dataset metadata."),
      ...defaultErrors,
    },
  });

  app.openapi(getDatasetRoute, async (c) => {
    const denied = requireScope(c, "datasets:read");
    if (denied) return denied;

    const { name } = c.req.valid("param");
    const dataset = await deps.store.getDataset(
      c.get("principal").workspaceId,
      name,
    );
    if (!dataset) {
      return respondProblem(
        c,
        404,
        "dataset_not_found",
        "Dataset not found",
        `Dataset '${name}' was not found.`,
      );
    }

    return c.json(dataset, 200);
  });

  const pushDatasetRoute = createRoute({
    method: "post",
    path: "/v1/datasets/{name}/records",
    operationId: "pushDatasetRecords",
    summary: "Create or append records to a dataset",
    tags: ["Datasets"],
    request: {
      params: z.object({ name: SlugSchema }),
      body: {
        required: true,
        content: { "application/json": { schema: PushDatasetRequestSchema } },
      },
    },
    responses: {
      200: jsonResponse(DatasetSchema, "Updated dataset."),
      ...defaultErrors,
    },
  });

  app.openapi(pushDatasetRoute, async (c) => {
    const denied = requireScope(c, "datasets:write");
    if (denied) return denied;

    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    const workspaceId = c.get("principal").workspaceId;
    const storageKey = `datasets/${workspaceId}/${name}/records.jsonl`;

    const dataset = await withDatasetLock(
      `${workspaceId}:${name}`,
      async () => {
        const existing = await deps.store.getDataset(workspaceId, name);
        const priorRecords = existing
          ? await readDatasetRecords(deps.storage, existing.storage_key)
          : [];

        const stamped = body.records.map((record) => ({
          ...record,
          id: record.id ?? `rec_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        }));
        const combined = [...priorRecords, ...stamped];

        await writeDatasetRecords(deps.storage, storageKey, combined);

        return deps.store.upsertDataset({
          workspaceId,
          name,
          recordCount: combined.length,
          storageKey,
          ...(body.metadata ? { metadata: body.metadata } : {}),
        });
      },
    );

    return c.json(dataset, 200);
  });

  const listDatasetRecordsRoute = createRoute({
    method: "get",
    path: "/v1/datasets/{name}/records",
    operationId: "listDatasetRecords",
    summary: "Read records from a dataset",
    tags: ["Datasets"],
    request: {
      params: z.object({ name: SlugSchema }),
      query: z.object({
        limit: z.coerce.number().int().min(1).max(10_000).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      }),
    },
    responses: {
      200: jsonResponse(
        z.object({
          dataset: SlugSchema,
          total: z.number().int().min(0),
          data: z.array(DatasetRecordSchema),
        }),
        "Dataset records slice.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(listDatasetRecordsRoute, async (c) => {
    const denied = requireScope(c, "datasets:read");
    if (denied) return denied;

    const { name } = c.req.valid("param");
    const { limit, offset } = c.req.valid("query");
    const dataset = await deps.store.getDataset(
      c.get("principal").workspaceId,
      name,
    );
    if (!dataset) {
      return respondProblem(
        c,
        404,
        "dataset_not_found",
        "Dataset not found",
        `Dataset '${name}' was not found.`,
      );
    }

    const records = await readDatasetRecords(deps.storage, dataset.storage_key);

    return c.json(
      {
        dataset: name,
        total: records.length,
        data: records.slice(offset, offset + limit),
      },
      200,
    );
  });

  const renderDatasetRoute = createRoute({
    method: "post",
    path: "/v1/datasets/{name}/render",
    operationId: "renderDataset",
    summary: "Preview chat template rendering and loss masks",
    tags: ["Datasets"],
    request: {
      params: z.object({ name: SlugSchema }),
      body: {
        required: true,
        content: {
          "application/json": { schema: RenderDatasetRequestSchema },
        },
      },
    },
    responses: {
      200: jsonResponse(RenderDatasetResponseSchema, "Rendered examples."),
      ...defaultErrors,
    },
  });

  app.openapi(renderDatasetRoute, async (c) => {
    const denied = requireScope(c, "datasets:read");
    if (denied) return denied;

    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    const dataset = await deps.store.getDataset(
      c.get("principal").workspaceId,
      name,
    );
    if (!dataset) {
      return respondProblem(
        c,
        404,
        "dataset_not_found",
        "Dataset not found",
        `Dataset '${name}' was not found.`,
      );
    }

    const records = await readDatasetRecords(deps.storage, dataset.storage_key);
    const chatRecords = records
      .filter((r) => r.messages && r.messages.length > 0)
      .slice(0, body.limit);

    try {
      const examples = chatRecords.map((record, idx) =>
        renderMessages(record.id ?? `rec_${idx + 1}`, record.messages ?? [], {
          model: body.model,
          train_on: body.train_on,
          thinking: body.thinking,
          preserve_thinking: body.preserve_thinking,
        }),
      );

      return c.json(
        {
          dataset: name,
          model: body.model,
          template_revision: examples[0]?.template_revision ?? "qwen3@3",
          examples,
        },
        200,
      );
    } catch (error) {
      return respondProblem(
        c,
        422,
        "render_conflict",
        "Chat template rendering failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  });
};
