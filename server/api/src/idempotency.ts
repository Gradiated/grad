import { createHash } from "node:crypto";
import { z, type OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";

import { addSeconds, type Clock } from "./clock.js";
import { ApiError, errorMessage } from "./errors.js";
import { respondProblem, type AppEnv } from "./routes/helpers.js";
import type {
  IdempotencyRepository,
  IdempotencyScope,
  StoredResponse,
} from "./store/types.js";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const REPLAYED_HEADER = "Idempotent-Replayed";
/** Stored responses are replayed for 24 h, then purged by maintenance. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
/** An in-progress claim older than this is treated as abandoned (crashed replica). */
export const IDEMPOTENCY_LOCK_SECONDS = 5 * 60;
const IN_PROGRESS_RETRY_AFTER_SECONDS = 1;
const KEY_RE = /^[\x21-\x7e]{1,255}$/;
const STORED_HEADERS = ["content-type", "location"] as const;

const IdempotencyKeySchema = z
  .string()
  .regex(KEY_RE)
  .openapi({
    param: { name: IDEMPOTENCY_HEADER, in: "header", required: false },
    description:
      "Up to 255 visible ASCII characters (SDKs send a UUIDv4 and reuse it across retries). " +
      "A retry with the same key and body replays the stored response with `Idempotent-Replayed: true`; " +
      "the same key with a different body is rejected with 422 `idempotency_key_reused`; " +
      "a retry while the first request is still running gets 409 `idempotency_in_progress` with Retry-After. " +
      "Responses are kept for 24 hours; 5xx and 429 responses are not stored.",
    example: "5f0c8d1e-3b8a-4c39-9a4e-2f1f0b6f4a21",
  });

/** Every public POST takes a key; internal worker protocols have their own retry semantics. */
export const acceptsIdempotencyKey = (route: RouteConfig): boolean =>
  route.method === "post" &&
  (route as { "x-internal"?: unknown })["x-internal"] !== true;

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

const storedHeaders = (headers: Headers): Record<string, string> =>
  Object.fromEntries(
    STORED_HEADERS.flatMap((name) => {
      const value = headers.get(name);
      return value === null ? [] : [[name, value]];
    }),
  );

const replay = (c: Context<AppEnv>, response: StoredResponse): Response => {
  for (const [name, value] of Object.entries(response.headers)) {
    c.header(name, value);
  }
  c.header(REPLAYED_HEADER, "true");

  return c.body(response.body, response.status as 200);
};

const isStorable = (status: number): boolean => status < 500 && status !== 429;

/**
 * `Idempotency-Key` handling for one route: claims the key, runs the handler
 * once, stores its response (unless 5xx or 429) and replays it for retries.
 * The store's unique key makes concurrent claims safe across API replicas.
 */
export const idempotencyMiddleware =
  (repo: IdempotencyRepository, clock: Clock): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const key = c.req.header(IDEMPOTENCY_HEADER);
    if (key === undefined) return next();
    if (!KEY_RE.test(key)) {
      throw new ApiError(
        422,
        "idempotency_key_invalid",
        "Invalid Idempotency-Key",
        "Idempotency-Key must be 1 to 255 visible ASCII characters (a UUID is recommended).",
      );
    }

    const principal = c.get("principal");
    const scope: IdempotencyScope = {
      workspaceId: principal.workspaceId,
      principal: principal.actor,
      method: c.req.method,
      path: c.req.path,
      key,
    };
    const requestHash = sha256(
      `${new URL(c.req.url).search}\n${await c.req.text()}`,
    );
    const now = clock.now();
    const claim = await repo.claim(scope, requestHash, {
      now,
      expiredBefore: addSeconds(now, -IDEMPOTENCY_TTL_SECONDS),
      abandonedBefore: addSeconds(now, -IDEMPOTENCY_LOCK_SECONDS),
    });

    if (claim.outcome === "completed") return replay(c, claim.response);
    if (claim.outcome === "mismatch") {
      return respondProblem(
        c,
        422,
        "idempotency_key_reused",
        "Idempotency-Key reused",
        `Idempotency-Key '${key}' was already used for a different request to ${scope.method} ${scope.path}; use a new key for a new request.`,
      );
    }
    if (claim.outcome === "in_progress") {
      c.header("Retry-After", String(IN_PROGRESS_RETRY_AFTER_SECONDS));
      return respondProblem(
        c,
        409,
        "idempotency_in_progress",
        "Request in progress",
        `A request with Idempotency-Key '${key}' is still being processed; retry after ${IN_PROGRESS_RETRY_AFTER_SECONDS}s to get its response.`,
      );
    }

    // Hono renders handler errors through onError, so `next` resolves with
    // the error response (5xx releases the claim below).
    await next();

    const res = c.res;
    if (!isStorable(res.status)) {
      await repo.release(scope, claim.claimId);
      return;
    }

    const body = await res.text();
    c.res = new Response(body, res);
    try {
      await repo.complete(
        scope,
        claim.claimId,
        { status: res.status, headers: storedHeaders(res.headers), body },
        clock.now(),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "idempotency response not stored",
          request_id: c.get("requestId"),
          path: scope.path,
          error: errorMessage(error),
        }),
      );
    }
  };

/**
 * Makes every route registered after this call that `acceptsIdempotencyKey`
 * document the reusable `Idempotency-Key` header and run the middleware.
 */
export const installIdempotency = (
  app: OpenAPIHono<AppEnv>,
  repo: IdempotencyRepository,
  clock: Clock,
): void => {
  const middleware = idempotencyMiddleware(repo, clock);
  // Documents the header only: Hono hands validators lowercase header names,
  // so this optional field never matches; the middleware validates the key.
  const headers = z.object({
    [IDEMPOTENCY_HEADER]: app.openAPIRegistry
      .registerParameter("IdempotencyKey", IdempotencyKeySchema)
      .optional(),
  });
  const register = app.openapi.bind(app) as (
    route: RouteConfig,
    ...rest: unknown[]
  ) => unknown;

  app.openapi = ((route: RouteConfig, ...rest: unknown[]) => {
    if (!acceptsIdempotencyKey(route)) return register(route, ...rest);
    if (route.request?.headers) {
      throw new Error(
        `${route.method.toUpperCase()} ${route.path} declares headers; merge them with the Idempotency-Key header.`,
      );
    }

    const existing = route.middleware;
    return register(
      {
        ...route,
        request: { ...route.request, headers },
        middleware: [
          middleware,
          ...(existing === undefined
            ? []
            : Array.isArray(existing)
              ? existing
              : [existing]),
        ],
      },
      ...rest,
    );
  }) as typeof app.openapi;
};
