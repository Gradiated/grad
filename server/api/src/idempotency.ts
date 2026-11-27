import { createHash } from "node:crypto";
import { z, type OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";

import { addSeconds, type Clock } from "./clock.js";
import { ApiError, errorMessage } from "./errors.js";
import { problemBody, respondProblem, type AppEnv } from "./routes/helpers.js";
import type {
  IdempotencyClaim,
  IdempotencyRepository,
  IdempotencyScope,
  Store,
  StoredResponse,
} from "./store/types.js";

export const IDEMPOTENCY_HEADER = "Idempotency-Key";
export const REPLAYED_HEADER = "Idempotent-Replayed";
/** Stored responses are replayed for 24 h; claims and maintenance purge older rows. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
/**
 * An intent committed before an external call that never recorded its
 * response (crashed replica) may be retried after this long.
 */
export const IDEMPOTENCY_INTENT_SECONDS = 60;
/** How long a duplicate waits for a concurrent transaction holding its key. */
export const DEFAULT_IDEMPOTENCY_WAIT_MS = 5_000;
const IN_PROGRESS_RETRY_AFTER_SECONDS = 1;
const KEY_RE = /^[\x21-\x7e]{1,255}$/;
const STORED_HEADERS = ["content-type", "location"] as const;

/**
 * How a keyed POST is made exactly-once:
 * - `transaction` (default): the key row, the handler's writes and the stored
 *   response commit in one DB transaction; a crash or 5xx rolls all of it back.
 *   Handlers may read external systems and write new immutable objects (an
 *   aborted transaction only orphans them) but have no other side effects.
 * - `intent`: the handler calls an external system with side effects, so no
 *   transaction may span it. The key is committed first as an intent (expiring
 *   after IDEMPOTENCY_INTENT_SECONDS), the handler passes the key on to the
 *   external call, and the response is recorded afterwards.
 * - `read`: read-only; retries are harmless, nothing is stored.
 */
export type IdempotencyMode = "transaction" | "intent" | "read";

export interface IdempotencyPolicy {
  mode: IdempotencyMode;
  /** false: the response carries a secret, so a replay answers 409 instead. */
  replayable: boolean;
}

export const IDEMPOTENCY_POLICIES: Readonly<
  Record<string, Partial<IdempotencyPolicy>>
> = {
  planRun: { mode: "read" },
  planEval: { mode: "read" },
  renderDataset: { mode: "read" },
  deployArtifact: { mode: "intent" },
  rollbackDeployment: { mode: "intent" },
  routeRequest: { mode: "intent" },
  createEmbeddings: { mode: "intent" },
  createApiKey: { replayable: false },
};

export const policyFor = (
  operationId: string | undefined,
): IdempotencyPolicy => ({
  mode: "transaction",
  replayable: true,
  ...(operationId === undefined ? {} : IDEMPOTENCY_POLICIES[operationId]),
});

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
      "The key is stored in the same transaction as the request's writes; responses are kept for 24 hours, " +
      "and 5xx and 429 responses are not stored.",
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

const isStorable = (status: number): boolean => status < 500 && status !== 429;

/** What is kept for a replay: the response itself, or a 409 when it held a secret. */
const toStored = (
  c: Context<AppEnv>,
  policy: IdempotencyPolicy,
  status: number,
  headers: Headers,
  body: string,
): StoredResponse =>
  policy.replayable
    ? { status, headers: storedHeaders(headers), body }
    : {
        status: 409,
        headers: { "content-type": "application/problem+json" },
        body: JSON.stringify(
          problemBody(
            409,
            "idempotency_replay_unavailable",
            "Response not replayable",
            "The first request with this Idempotency-Key succeeded, but its response held a secret that is never stored. List the resources to find what it created.",
            c.get("requestId") ?? "req_unknown",
          ),
        ),
      };

const replay = (c: Context<AppEnv>, response: StoredResponse): Response => {
  for (const [name, value] of Object.entries(response.headers)) {
    c.header(name, value);
  }
  c.header(REPLAYED_HEADER, "true");

  return c.body(response.body, response.status as 200);
};

/** The answer to a claim someone else holds or already completed. */
const answerExisting = (
  c: Context<AppEnv>,
  scope: IdempotencyScope,
  claim: Exclude<IdempotencyClaim, { outcome: "claimed" }>,
): Response => {
  if (claim.outcome === "completed") return replay(c, claim.response);
  if (claim.outcome === "mismatch") {
    return respondProblem(
      c,
      422,
      "idempotency_key_reused",
      "Idempotency-Key reused",
      `Idempotency-Key '${scope.key}' was already used for a different request to ${scope.method} ${scope.path}; use a new key for a new request.`,
    );
  }
  c.header("Retry-After", String(IN_PROGRESS_RETRY_AFTER_SECONDS));
  return respondProblem(
    c,
    409,
    "idempotency_in_progress",
    "Request in progress",
    `A request with Idempotency-Key '${scope.key}' is still being processed; retry after ${IN_PROGRESS_RETRY_AFTER_SECONDS}s to get its response.`,
  );
};

/** Thrown inside the transaction to roll it back without failing the request. */
class Rollback extends Error {}

/** Reads the handler's response so it can be stored, and keeps it sendable. */
const takeResponse = async (
  c: Context<AppEnv>,
): Promise<{ status: number; headers: Headers; body: string }> => {
  const res = c.res;
  const body = await res.text();
  c.res = new Response(body, res);

  return { status: res.status, headers: res.headers, body };
};

export interface IdempotencyOptions {
  /** How long a duplicate waits for a concurrent transaction (default 5 s). */
  waitMs?: number | undefined;
}

/**
 * `Idempotency-Key` handling for one route (see IdempotencyMode). Hono renders
 * handler errors through onError, so `next` resolves with the error response.
 */
export const idempotencyMiddleware = (
  store: Store,
  clock: Clock,
  policy: IdempotencyPolicy,
  options: IdempotencyOptions = {},
): MiddlewareHandler<AppEnv> => {
  const waitMs = options.waitMs ?? DEFAULT_IDEMPOTENCY_WAIT_MS;

  const intent = async (
    c: Context<AppEnv>,
    next: () => Promise<void>,
    repo: IdempotencyRepository,
    scope: IdempotencyScope,
    claim: Extract<IdempotencyClaim, { outcome: "claimed" }>,
  ): Promise<void> => {
    await next();
    if (!isStorable(c.res.status)) {
      await repo.release(scope, claim.claimId);
      return;
    }

    const res = await takeResponse(c);
    try {
      await repo.complete(
        scope,
        claim.claimId,
        toStored(c, policy, res.status, res.headers, res.body),
        clock.now(),
      );
    } catch (error) {
      // The side effect happened: answer with it. The intent expires and a
      // retry repeats the call under the same key, which the far side dedupes.
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

  return async (c, next) => {
    if (policy.mode === "read") return next();

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
    const at = {
      now,
      expiredBefore: addSeconds(now, -IDEMPOTENCY_TTL_SECONDS),
      abandonedBefore: addSeconds(now, -IDEMPOTENCY_INTENT_SECONDS),
    };

    if (policy.mode === "intent") {
      const claim = await store.idempotency.claim(scope, requestHash, at);
      if (claim.outcome !== "claimed") return answerExisting(c, scope, claim);
      return intent(c, next, store.idempotency, scope, claim);
    }

    let answer: Response | undefined;
    try {
      await store.transaction(async (tx) => {
        const claim = await tx.idempotency.claim(scope, requestHash, at, {
          waitMs,
        });
        if (claim.outcome !== "claimed") {
          answer = answerExisting(c, scope, claim);
          throw new Rollback();
        }

        await next();
        if (!isStorable(c.res.status)) throw new Rollback();

        const res = await takeResponse(c);
        await tx.idempotency.complete(
          scope,
          claim.claimId,
          toStored(c, policy, res.status, res.headers, res.body),
          clock.now(),
        );
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    return answer;
  };
};

/**
 * Makes every route registered after this call that `acceptsIdempotencyKey`
 * document the reusable `Idempotency-Key` header and run the middleware with
 * the route's policy.
 */
export const installIdempotency = (
  app: OpenAPIHono<AppEnv>,
  store: Store,
  clock: Clock,
  options: IdempotencyOptions = {},
): void => {
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

    const middleware = idempotencyMiddleware(
      store,
      clock,
      policyFor(route.operationId),
      options,
    );
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
