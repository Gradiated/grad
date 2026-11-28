import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";

import {
  MetricsPageSchema,
  pageLimitSchema,
  pageOf,
  PageQuerySchema,
  SearchQuerySchema,
  statusFilterSchema,
  PlanRunRequestSchema,
  PlanRunResponseSchema,
  ResumeRunRequestSchema,
  RunEventsPageSchema,
  RUN_STATUSES,
  RunCountsSchema,
  RunSchema,
} from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { idempotencyOf, replayAware } from "../idempotency.js";
import type { Services } from "../services/index.js";
import { toRunEvent } from "../services/run-events.js";
import type { JobEvent } from "../store/types.js";
import { createSseLimits } from "./sse-limits.js";
import {
  defaultErrors,
  IdParamSchema,
  jsonBody,
  jsonResponse,
  optionalJson,
  requireSecretUse,
  workspaceOf,
  type AppEnv,
} from "./helpers.js";

const SSE_PING_MS = 15_000;

/** Where a reconnecting client resumes (its Last-Event-ID; 0: from the start). */
const lastEventIdOf = (c: {
  req: { header: (name: string) => string | undefined };
}): number => {
  const id = Number(c.req.header("last-event-id"));

  return Number.isInteger(id) && id > 0 ? id : 0;
};

export const registerRunRoutes = (
  app: OpenAPIHono<AppEnv>,
  deps: AppDependencies,
  services: Services,
): void => {
  const tags = ["Runs"];
  const reserveStream = createSseLimits(deps.settings.sseStreamsPerKey);

  // The hub hands every stream following a run the same event objects, so
  // each event's SSE frame is built and encoded once, not once per stream
  // (p1-scale: 20 streams a run made serialization most of the fan-out).
  const encoder = new TextEncoder();
  const frames = new WeakMap<JobEvent, Uint8Array | null>();
  const frameOf = (runId: string, row: JobEvent): Uint8Array | null => {
    let frame = frames.get(row);
    if (frame === undefined) {
      const event = toRunEvent(runId, row);
      frame = event
        ? encoder.encode(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\nid: ${event.seq}\n\n`,
          )
        : null;
      frames.set(row, frame);
    }

    return frame;
  };

  /**
   * Streams a run's events from the replica's event hub: its history after
   * `afterSeq` first, then live events. Once the hub reports the run settled,
   * the closing `completed` event ends the stream (it keeps following a run
   * resumed meanwhile). An idle stream gets a comment ping every
   * SSE_PING_MS; the hub closing (SIGTERM) ends it, and the client resumes on
   * another replica with Last-Event-ID.
   */
  const follow = async (
    stream: SSEStreamingApi,
    workspaceId: string,
    runId: string,
    afterSeq: number,
  ): Promise<void> => {
    const sub = services.events.subscribe(runId, afterSeq);
    stream.onAbort(() => sub.close());
    let lastSeq = afterSeq;
    try {
      while (!stream.aborted) {
        const batch = await sub.next(SSE_PING_MS);
        if (!batch) break;
        for (const row of batch.events) {
          lastSeq = row.seq;
          const frame = frameOf(runId, row);
          if (frame) await stream.write(frame);
        }
        if (batch.settled) {
          const end = await services.runs.streamEnd(
            workspaceId,
            runId,
            lastSeq,
          );
          if (end.event) {
            await stream.writeSSE({
              event: end.event.type,
              data: JSON.stringify(end.event),
            });
          }
          if (end.done) break;
        } else if (batch.events.length === 0) {
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
      request: {
        query: PageQuerySchema.extend({
          status: statusFilterSchema(RUN_STATUSES),
          q: SearchQuerySchema,
        }),
      },
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

  // Before /v1/runs/{id}, so "counts" is never read as a run id.
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/runs/counts",
      operationId: "countRuns",
      summary: "Count the workspace's runs per status",
      description:
        "One count per status (the web console's status tabs), narrowed by `q` like `GET /v1/runs`.",
      tags,
      request: { query: z.object({ q: SearchQuerySchema }) },
      responses: {
        200: jsonResponse(RunCountsSchema, "Runs per status."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await services.runs.counts(
          workspaceOf(c, "runs:read"),
          c.req.valid("query").q,
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
      summary: "Training step metrics as JSON pages",
      description:
        "`next_cursor` pages through the points written so far (null on the last page, like every list), and `tail_cursor` polls for points written later. To follow a run live, stream its events (`GET /v1/runs/{id}/events`, `metric` events).",
      tags,
      request: {
        params: IdParamSchema,
        query: z.object({
          cursor: z.string().min(1).max(512).optional(),
          after_step: z.coerce.number().int().min(-1).optional(),
          limit: pageLimitSchema(5000, 1000),
          max_points: z.coerce
            .number()
            .int()
            .min(2)
            .max(5000)
            .optional()
            .openapi({
              description:
                "Return the whole curve after `cursor` as one page, thinned to at most this many points spaced evenly from the newest (plus as many eval points, thinned the same way). Points a resumed attempt replayed are left out, so steps only increase. `limit` is ignored and `next_cursor` is null. Compare runs or draw a long run without paging every point.",
            }),
        }),
      },
      responses: {
        200: jsonResponse(MetricsPageSchema, "Metric points."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await services.runs.metrics(
          workspaceOf(c, "runs:read"),
          c.req.valid("param").id,
          c.req.valid("query"),
        ),
        200,
      ),
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
        return c.json(await services.runs.events(workspaceId, id, query), 200);
      }

      await services.runs.get(workspaceId, id);
      // nginx (ingress-nginx) buffers responses by default, holding events back.
      c.header("X-Accel-Buffering", "no");

      return streamSSE(
        c,
        reserveStream(c, (stream) =>
          follow(stream, workspaceId, id, lastEventIdOf(c)),
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
        "A run that is already queued or running is returned as it is, so a retried resume is a no-op. A resume queues the run again, so it counts toward the workspace's queued cap (429 `queue_limit`) like a new run.",
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
      const input = await optionalJson(c, ResumeRunRequestSchema);

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
