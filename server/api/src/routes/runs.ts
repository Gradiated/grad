import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";

import {
  MetricsPageSchema,
  pageLimitSchema,
  pageOf,
  PageQuerySchema,
  PlanRunRequestSchema,
  PlanRunResponseSchema,
  ResumeRunRequestSchema,
  RunEventsPageSchema,
  RunSchema,
} from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { notFound } from "../errors.js";
import type { JobEvent } from "../store/types.js";
import { idempotencyOf, replayAware } from "../idempotency.js";
import type { Services } from "../services/index.js";
import { toRunEvent } from "../services/run-events.js";
import { toMetricPoint, toPublicRun } from "../services/runs.js";
import { createSseLimits } from "./sse-limits.js";
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
  "stopped_balance",
]);
const SSE_PING_MS = 15_000;

/** Where a reconnecting client resumes (its Last-Event-ID; 0: from the start). */
const lastEventIdOf = (c: {
  req: { header: (name: string) => string | undefined };
}): number => {
  const id = Number(c.req.header("last-event-id"));

  return Number.isInteger(id) && id > 0 ? id : 0;
};

const jsonBody = <T extends z.ZodType>(schema: T, required = true) => ({
  body: { required, content: { "application/json": { schema } } },
});

export const registerRunRoutes = (
  app: OpenAPIHono<AppEnv>,
  deps: AppDependencies,
  services: Services,
): void => {
  const tags = ["Runs"];
  const reserveStream = createSseLimits(deps.settings.sseStreamsPerKey ?? 20);

  /**
   * Streams a job's events from the replica's event hub: its history after
   * `afterSeq` first, then live events. When the hub reports the job settled,
   * `finish` reads the final state, writes the closing event and returns true
   * (false: it was resumed meanwhile, keep following). An idle stream gets a
   * comment ping every SSE_PING_MS; the hub closing (SIGTERM) ends it, and the
   * client resumes on another replica with Last-Event-ID.
   */
  const follow = async (
    stream: SSEStreamingApi,
    jobId: string,
    afterSeq: number,
    on: {
      write: (row: JobEvent) => Promise<void>;
      finish: (lastSeq: number) => Promise<boolean>;
    },
  ): Promise<void> => {
    const sub = services.events.subscribe(jobId, afterSeq);
    stream.onAbort(() => sub.close());
    let lastSeq = afterSeq;
    try {
      while (!stream.aborted) {
        const batch = await sub.next(SSE_PING_MS);
        if (!batch) break;
        for (const row of batch.events) {
          lastSeq = row.seq;
          await on.write(row);
        }
        if (batch.settled && (await on.finish(lastSeq))) break;
        if (batch.events.length === 0 && !batch.settled) {
          await stream.write(": ping\n\n");
        }
      }
    } finally {
      sub.close();
    }
  };

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

      return streamSSE(
        c,
        reserveStream(c, (stream) =>
          follow(stream, id, lastEventIdOf(c), {
            write: async (row) => {
              if (row.type !== "metric") return;
              const point = toMetricPoint(row);
              await stream.writeSSE({
                event: "metric",
                id: String(point.seq),
                data: JSON.stringify(point),
              });
            },
            finish: async () => {
              const current = await deps.store.runs.get(workspaceId, id);
              if (!current) return true;
              if (!TERMINAL.has(current.status) || current.worker_id !== null)
                return false;
              await stream.writeSSE({
                event: "status",
                data: JSON.stringify(toPublicRun(current)),
              });

              return true;
            },
          }),
        ),
      ) as never;
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/runs/{id}/events",
      operationId: "listRunEvents",
      summary:
        "A run's lifecycle events (phases, metrics, checkpoints, attempts, warnings, logs)",
      description:
        "Every event is a RunEvent discriminated by `type`; a terminal run's stream ends with one `completed` event. With `Accept: text/event-stream` the response is a Server-Sent Events stream: the SSE event name is the event's `type` and its id is `seq` (none on `completed`); reconnect with `Last-Event-ID` to resume. Otherwise returns a JSON page: `next_cursor` pages through the events written so far, `tail_cursor` polls for later ones.",
      tags,
      request: {
        params: IdParamSchema,
        query: z.object({
          cursor: z.string().min(1).max(512).optional(),
          limit: pageLimitSchema(5000, 1000),
        }),
      },
      responses: {
        200: {
          description: "Run events.",
          content: {
            "application/json": { schema: RunEventsPageSchema },
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
        const result = await services.runs.events(workspaceId, id, query);

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

      return streamSSE(
        c,
        reserveStream(c, (stream) =>
          follow(stream, id, lastEventIdOf(c), {
            write: async (row) => {
              const event = toRunEvent(id, row);
              if (!event) return;
              await stream.writeSSE({
                event: event.type,
                id: String(event.seq),
                data: JSON.stringify(event),
              });
            },
            finish: async (lastSeq) => {
              const current = await deps.store.runs.get(workspaceId, id);
              const done = current
                ? await services.runs.completedEvent(current, lastSeq)
                : null;
              if (current && !done) return false;
              if (done) {
                await stream.writeSSE({
                  event: done.type,
                  data: JSON.stringify(done),
                });
              }

              return true;
            },
          }),
        ),
      ) as never;
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
      description:
        "A run that is already queued or running is returned as it is, so a retried resume is a no-op.",
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
