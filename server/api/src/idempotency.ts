import { createHash } from "node:crypto";
import { z, type OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";

import { ApiError } from "./errors.js";
import type { AppEnv } from "./routes/helpers.js";
import type { IdempotencyInput, IdempotentHit } from "./store/types.js";

/**
 * Idempotency without a generic table: a create endpoint stores the caller's
 * Idempotency-Key and the hash of the request on the row it creates, unique
 * per workspace. A retry with the same key and body gets that row back
 * (`Idempotent-Replayed: true`); the same key with another body is a 422.
 * Everything else is naturally idempotent (cancel, scores, worker writes on
 * natural keys) or read-only.
 */

const IDEMPOTENCY_HEADER = "Idempotency-Key";
const REPLAYED_HEADER = "Idempotent-Replayed";
const KEY_RE = /^[\x21-\x7e]{1,255}$/;

const IdempotencyKeySchema = z
  .string()
  .regex(KEY_RE)
  .openapi({
    param: { name: IDEMPOTENCY_HEADER, in: "header", required: false },
    description:
      "Up to 255 visible ASCII characters (SDKs send a UUIDv4 and reuse it across retries). " +
      "A create retried with the same key and body returns what the first request created, with `Idempotent-Replayed: true`; " +
      "the same key with a different body is rejected with 422 `idempotency_key_reused`. " +
      "The key is stored on the created resource, in the same transaction.",
    example: "5f0c8d1e-3b8a-4c39-9a4e-2f1f0b6f4a21",
  });

const invalidKey = (): ApiError =>
  new ApiError(
    422,
    "idempotency_key_invalid",
    "Invalid Idempotency-Key",
    "Idempotency-Key must be 1 to 255 visible ASCII characters (a UUID is recommended).",
  );

const validateKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header(IDEMPOTENCY_HEADER);
  if (key !== undefined && !KEY_RE.test(key)) throw invalidKey();
  await next();
};

/** The request's key and body hash, or undefined without a key. */
export const idempotencyOf = async (
  c: Context<AppEnv>,
): Promise<IdempotencyInput | undefined> => {
  const key = c.req.header(IDEMPOTENCY_HEADER);
  if (key === undefined) return undefined;
  if (!KEY_RE.test(key)) throw invalidKey();
  const hash = createHash("sha256")
    .update(`${c.req.method} ${c.req.path}${new URL(c.req.url).search}\n`)
    .update(await c.req.text())
    .digest("hex");

  return { key, hash };
};

export interface Created<T> {
  value: T;
  replayed: boolean;
}

/** Sets `Idempotent-Replayed` and returns the value. */
export const replayAware = <T>(c: Context<AppEnv>, created: Created<T>): T => {
  if (created.replayed) c.header(REPLAYED_HEADER, "true");

  return created.value;
};

/**
 * Creates once per key: a hit returns the stored row (after checking the
 * request hash). A concurrent duplicate fails its insert (the unique key, or
 * a unique name it races on) and is then answered the same way.
 */
export const createOnce = async <T>(
  idempotency: IdempotencyInput | undefined,
  find: (key: string) => Promise<IdempotentHit | null>,
  load: (id: string) => Promise<T>,
  create: () => Promise<T>,
): Promise<Created<T>> => {
  const replay = async (): Promise<Created<T> | null> => {
    if (!idempotency) return null;
    const hit = await find(idempotency.key);
    if (!hit) return null;
    if (hit.request_hash !== idempotency.hash) {
      throw new ApiError(
        422,
        "idempotency_key_reused",
        "Idempotency-Key reused",
        `Idempotency-Key '${idempotency.key}' was already used for a different request; use a new key for a new request.`,
      );
    }

    return { value: await load(hit.id), replayed: true };
  };

  const earlier = await replay();
  if (earlier) return earlier;
  try {
    return { value: await create(), replayed: false };
  } catch (error) {
    const raced = await replay();
    if (!raced) throw error;

    return raced;
  }
};

/** Every public POST takes a key; internal worker protocols use natural keys. */
const acceptsIdempotencyKey = (route: RouteConfig): boolean =>
  route.method === "post" &&
  (route as { "x-internal"?: unknown })["x-internal"] !== true;

/**
 * Documents the reusable `Idempotency-Key` header on every route registered
 * after this call that `acceptsIdempotencyKey`. Handlers read it with
 * `idempotencyOf`.
 */
export const documentIdempotencyHeader = (app: OpenAPIHono<AppEnv>): void => {
  // Documents the header only: Hono hands validators lowercase header names,
  // so this optional field never matches; idempotencyOf validates the key.
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
        // Validates the key before the body, with its own error code.
        middleware: [
          validateKey,
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
