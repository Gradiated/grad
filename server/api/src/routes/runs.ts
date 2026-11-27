import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";

import {
  MetricsPageSchema,
  pageLimitSchema,
  pageOf,
  PageQuerySchema,
  PlanRunRequestSchema,
  PlanRunResponseSchema,
  ResumeRunRequestSchema,
  RunSchema,
} from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { notFound } from "../errors.js";
import { idempotencyOf, replayAware } from "../idempotency.js";
import type { Services } from "../services/index.js";
import { toMetricPoint, toPublicRun } from "../services/runs.js";
import {
  defaultErrors,
  IdParamSchema,
  jsonResponse,
  requireSecretUse,
  workspaceOf,
  type AppEnv,
} from "./helpers.js";

const TERMINAL = new Set([
  "completed",
  "failed",
  "cancelled",
  "stopped_budget",
]);
const SSE_BATCH = 500;
const SSE_PING_MS = 15_000;

const jsonBody = <T extends z.ZodType>(schema: T, required = true) => ({
  body: { required, content: { "application/json": { schema } } },
});

export const registerRunRoutes = (
  app: OpenAPIHono<AppEnv>,
  deps: AppDependencies,
  services: Services,
): void => {
  const tags = ["Runs"];

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/runs/plan",
      operationId: "planRun",
      summary: "Dry-run a training recipe at zero cost",
      tags,
      request: jsonBody(PlanRunRequestSchema),
      responses: {
        200: jsonResponse(
          PlanRunResponseSchema,
          "Resolved defaults and cost estimate.",
        ),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await services.runs.plan(
          workspaceOf(c, "runs:read"),
          c.req.valid("json"),
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/runs",
      operationId: "createRun",
      summary: "Create and enqueue a training run (pins the dataset version)",
      tags,
      request: jsonBody(PlanRunRequestSchema),
      responses: {
        202: jsonResponse(RunSchema, "Enqueued training run."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const workspaceId = workspaceOf(c, "runs:write");
      const body = c.req.valid("json");
      requireSecretUse(
        c,
        (body.recipe.loggers ?? []).map((logger) => logger.secret),
      );
      const created = await services.runs.create(
        workspaceId,
        body,
        await idempotencyOf(c),
      );

      return c.json(replayAware(c, created), 202);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/runs",
      operationId: "listRuns",
      summary: "List training runs (newest first)",
      tags,
      request: { query: PageQuerySchema },
      responses: {
        200: jsonResponse(pageOf(RunSchema), "Training runs."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await services.runs.list(
          workspaceOf(c, "runs:read"),
          c.req.valid("query"),
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/runs/{id}",
      operationId: "getRun",
      summary: "Get a training run",
      tags,
      request: { params: IdParamSchema },
      responses: {
        200: jsonResponse(RunSchema, "Training run."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await services.runs.get(
          workspaceOf(c, "runs:read"),
          c.req.valid("param").id,
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/runs/{id}/metrics",
      operationId: "listRunMetrics",
      summary: "Training step metrics as JSON pages, or a live SSE stream",
      description:
        "With `Accept: text/event-stream` the response is a Server-Sent Events stream of `metric` events (event id = `seq`) followed by one `status` event carrying the final Run; reconnect with `Last-Event-ID` to resume. Otherwise returns a JSON page: `next_cursor` pages through the points written so far (null on the last page, like every list), and `tail_cursor` polls for points written later.",
      tags,
      request: {
        params: IdParamSchema,
        query: z.object({
          cursor: z.string().min(1).max(512).optional(),
          after_step: z.coerce.number().int().min(-1).optional(),
          limit: pageLimitSchema(5000, 1000),
        }),
      },
      responses: {
        200: {
          description: "Metric points.",
          content: {
            "application/json": { schema: MetricsPageSchema },
            "text/event-stream": { schema: z.string() },
          },
        },
        ...defaultErrors,
      },
    }),
    async (c) => {
      const workspaceId = workspaceOf(c, "runs:read");
      const { id } = c.req.valid("param");
      const query = c.req.valid("query");

      if (!(c.req.header("accept") ?? "").includes("text/event-stream")) {
        const result = await services.runs.metrics(workspaceId, id, {
          cursor: query.cursor,
          afterStep: query.after_step,
          limit: query.limit,
        });

        return c.json(
          {
            run_id: result.run.id,
            status: result.run.status,
            data: result.data,
            next_cursor: result.next_cursor,
            tail_cursor: result.tail_cursor,
          },
          200,
        );
      }

      const run = await deps.store.runs.get(workspaceId, id);
      if (!run) throw notFound("run", id);

      const lastEventId = Number(c.req.header("last-event-id"));
      let afterSeq =
        Number.isInteger(lastEventId) && lastEventId > 0 ? lastEventId : 0;
      const pollMs = deps.settings.ssePollMs ?? 1000;

      return streamSSE(c, async (stream) => {
        let sincePing = 0;
        while (!stream.aborted) {
          const points = (
            await deps.store.jobs.listEvents(id, "metric", afterSeq, SSE_BATCH)
          ).map(toMetricPoint);
          for (const point of points) {
            await stream.writeSSE({
              event: "metric",
              id: String(point.seq),
              data: JSON.stringify(point),
            });
            afterSeq = point.seq;
          }
          if (points.length === SSE_BATCH) continue;

          const current = await deps.store.runs.get(workspaceId, id);
          if (
            !current ||
            (TERMINAL.has(current.status) && current.worker_id === null)
          ) {
            if (current) {
              await stream.writeSSE({
                event: "status",
                data: JSON.stringify(toPublicRun(current)),
              });
            }
            break;
          }

          await stream.sleep(pollMs);
          sincePing += pollMs;
          if (sincePing >= SSE_PING_MS) {
            sincePing = 0;
            await stream.write(": ping\n\n");
          }
        }
      }) as never;
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/runs/{id}/cancel",
      operationId: "cancelRun",
      summary:
        "Cancel a training run (a running attempt is stopped and billed)",
      tags,
      request: { params: IdParamSchema },
      responses: {
        200: jsonResponse(RunSchema, "Cancelled training run."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await services.runs.cancel(
          workspaceOf(c, "runs:write"),
          c.req.valid("param").id,
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/runs/{id}/resume",
      operationId: "resumeRun",
      summary:
        "Resume a stopped, failed or cancelled run from its latest checkpoint",
      tags,
      request: {
        params: IdParamSchema,
        ...jsonBody(ResumeRunRequestSchema, false),
      },
      responses: {
        200: jsonResponse(RunSchema, "Re-queued training run."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const workspaceId = workspaceOf(c, "runs:write");
      const input = c.req.valid("json") ?? {};

      return c.json(
        await services.runs.resume(
          workspaceId,
          c.req.valid("param").id,
          input.max_cost_usd,
        ),
        200,
      );
    },
  );
};
