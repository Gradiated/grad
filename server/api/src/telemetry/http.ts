import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";

import { log, withLogContext } from "./log.js";
import { metrics, secondsSince, statusClass } from "./metrics.js";
import { contextFromHeaders, SpanKind, withSpan } from "./tracing.js";

/** Requests slower than this are logged (warn). */
const SLOW_REQUEST_SECONDS = 5;

const JOB_PATH =
  /^\/v1\/(?:trainer-jobs|runs|evals)\/((?:run|imp|eval)_[A-Za-z0-9_-]+)/;

/**
 * The route template that served `c` (`/v1/runs/:id`), never the raw path:
 * a bounded label. Middleware-only matches (404s) are `unmatched`.
 */
export const routeTemplate = (c: Context): string =>
  matchedRoutes(c)
    .filter((r) => r.method !== "ALL" && !r.path.includes("*"))
    .at(-1)?.path ?? "unmatched";

/**
 * Per-request telemetry: grad_http_* metrics, a server span joined to an
 * incoming W3C traceparent, a log context (request_id, job_id), and a log
 * line for 5xx and slow requests only.
 */
export const httpTelemetry =
  (): MiddlewareHandler =>
  async (c, next): Promise<void> => {
    const start = performance.now();
    const method = c.req.method;
    const jobId = JOB_PATH.exec(c.req.path)?.[1];
    const requestId = c.get("requestId") as string | undefined;
    metrics.httpInFlight.inc();

    const served = async (span: { setAttributes(a: object): void } | null) => {
      try {
        await next();
      } finally {
        const seconds = secondsSince(start);
        const status = c.res.status;
        const labels = {
          method,
          route: routeTemplate(c),
          status_class: statusClass(status),
        };
        metrics.httpInFlight.dec();
        metrics.httpRequests.inc(labels);
        metrics.httpDuration.observe(labels, seconds);
        span?.setAttributes({
          "http.route": labels.route,
          "http.response.status_code": status,
        });
        if (status >= 500 || seconds >= SLOW_REQUEST_SECONDS) {
          log(status >= 500 ? "error" : "warn", "request", {
            method,
            route: labels.route,
            status,
            duration_ms: Math.round(seconds * 1000),
          });
        }
      }
    };

    await withLogContext(
      {
        ...(requestId ? { request_id: requestId } : {}),
        ...(jobId ? { job_id: jobId } : {}),
      },
      () =>
        withSpan(
          `${method} ${c.req.routePath}`,
          {
            "http.request.method": method,
            "url.path": c.req.path,
            ...(jobId ? { "grad.job_id": jobId } : {}),
          },
          async (span) => {
            await served(span);
            if (!span) return;
            span.updateName(`${method} ${routeTemplate(c)}`);
            if (c.res.status >= 500) span.setStatus({ code: 2 });
          },
          {
            kind: SpanKind.SERVER,
            parent: contextFromHeaders(c.req.raw.headers),
          },
        ),
    );
  };
