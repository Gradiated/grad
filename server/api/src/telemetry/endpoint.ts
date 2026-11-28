import { createHash, timingSafeEqual } from "node:crypto";

import type { Hono, MiddlewareHandler } from "hono";

import { parseBearer } from "../errors.js";
import { registry } from "./metrics.js";
import type { TelemetrySampler } from "./sampler.js";

export interface MetricsEndpointOptions {
  /** When set, scrapes must send `Authorization: Bearer <token>`. */
  token?: string | undefined;
  sampler: TelemetrySampler;
  /** Reads the database when nothing was sampled yet (first scrape after boot). */
  now: () => Date;
}

const digest = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

const bearer = (token: string | undefined): MiddlewareHandler => {
  const expected = token ? digest(token) : null;

  return async (c, next) => {
    if (expected) {
      const sent = parseBearer(c.req.header("authorization"));
      if (!sent || !timingSafeEqual(digest(sent), expected)) {
        return c.text("unauthorized\n", 401, {
          "WWW-Authenticate": 'Bearer realm="metrics"',
        });
      }
    }
    await next();
  };
};

const WORKER_KINDS = new Set(["train", "import", "eval"]);

/**
 * `GET /metrics` (Prometheus text format) and `GET /metrics/queue?kinds=...`
 * (queue depth JSON for KEDA's metrics-api trigger), behind an optional
 * bearer token. Neither reads the database except the queue depth before
 * the first maintenance tick.
 */
export const registerMetricsEndpoints = (
  app: Hono,
  options: MetricsEndpointOptions,
): void => {
  const auth = bearer(options.token);

  app.get("/metrics", auth, async (c) =>
    c.body(await registry.metrics(), 200, {
      "Content-Type": registry.contentType,
    }),
  );

  app.get("/metrics/queue", auth, async (c) => {
    const kinds = (c.req.query("kinds") ?? "train,import")
      .split(",")
      .map((k) => k.trim())
      .filter((k) => WORKER_KINDS.has(k));
    if (!options.sampler.sampled())
      await options.sampler.refresh(options.now());

    return c.json(options.sampler.queueDepth(kinds), 200);
  });
};
