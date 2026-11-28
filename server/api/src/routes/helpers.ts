import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "@hono/zod-openapi";

import { hasScope, type AuthPrincipal } from "../adapters.js";
import { ProblemSchema, type Scope } from "../contracts.js";
import {
  ApiError,
  insufficientScope,
  issuesOf,
  validationFailed,
} from "../errors.js";
import {
  ObjectNotFoundError,
  StorageUnavailableError,
} from "../storage/types.js";
import { isDatabaseUnavailable } from "../store/postgres/db.js";
import { log } from "../telemetry/log.js";
import { metrics } from "../telemetry/metrics.js";

export type AppEnv = {
  Variables: {
    principal: AuthPrincipal;
    requestId: string;
  };
};

const problemContent = {
  "application/problem+json": { schema: ProblemSchema },
} as const;

/** A JSON request body (`required` false: the body may be omitted). */
export const jsonBody = <T extends z.ZodType>(schema: T, required = true) => ({
  body: { required, content: { "application/json": { schema } } },
});

export const jsonResponse = <T extends z.ZodType>(
  schema: T,
  description: string,
) => ({
  description,
  content: { "application/json": { schema } },
});

const problem = (description: string) => ({
  description,
  content: problemContent,
});

export const defaultErrors = {
  400: problem("Malformed request."),
  401: problem("Authentication required."),
  403: problem("Insufficient scope."),
  404: problem("Resource not found."),
  409: problem("Conflict."),
  422: problem("Validation failed."),
  500: problem("Internal error."),
  503: problem("Dependency unavailable."),
};

export const notImplementedError = {
  501: problem("Capability not configured on this server."),
};

const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The problem+json body of an error response. Every error response is built
 * here, so it also counts the response on grad_http_errors_total{code}
 * (codes are a fixed vocabulary; anything else is `other`).
 */
const problemBody = (
  status: number,
  code: string,
  title: string,
  detail: string,
  requestId: string,
) => {
  metrics.httpErrors.inc({ code: CODE_RE.test(code) ? code : "other" });

  return {
    type: `https://gradiated.com/problems/${code}`,
    title,
    status,
    detail,
    code,
    request_id: requestId,
  };
};

/** A problem+json response (with `x-request-id`). */
export const problemResponse = (
  requestId: string,
  status: number,
  code: string,
  title: string,
  detail: string,
): Response =>
  new Response(
    JSON.stringify(problemBody(status, code, title, detail, requestId)),
    {
      status,
      headers: {
        "Content-Type": "application/problem+json",
        "x-request-id": requestId,
      },
    },
  );

/**
 * The problem response for an error a handler threw, on the public and the
 * internal listener alike: an ApiError as itself, a malformed request as
 * 400, outages (storage, the database) as 503 with Retry-After, anything
 * else as a logged 500.
 */
export const errorResponse = (
  error: unknown,
  requestId: string,
  path: string,
): Response => {
  if (error instanceof ApiError) {
    return problemResponse(
      requestId,
      error.status,
      error.code,
      error.title,
      error.detail,
    );
  }

  if (error instanceof HTTPException) {
    const status = error.status;
    const malformed = status === 400;

    return problemResponse(
      requestId,
      status,
      malformed ? "malformed_request" : `http_${status}`,
      malformed ? "Malformed request" : "Request failed",
      error.message || "The request could not be processed.",
    );
  }

  if (error instanceof StorageUnavailableError) {
    const res = problemResponse(
      requestId,
      503,
      "storage_unavailable",
      "Storage unavailable",
      "Object storage is unreachable or overloaded; retry shortly.",
    );
    res.headers.set("Retry-After", "1");
    log("warn", "object storage unavailable", {
      request_id: requestId,
      path: path,
      error: error.message,
    });

    return res;
  }

  // A row names an object the bucket doesn't have: the bucket lost data or
  // was restored from a copy older than the database.
  if (error instanceof ObjectNotFoundError) {
    log("error", "object missing from storage", {
      request_id: requestId,
      path: path,
      error: error.message,
    });

    return problemResponse(
      requestId,
      500,
      "storage_object_missing",
      "Stored data missing",
      "Data this request needs is missing from object storage (lost, or restored from a backup older than the database). Quote the request_id when reporting it.",
    );
  }

  if (isDatabaseUnavailable(error)) {
    const res = problemResponse(
      requestId,
      503,
      "database_unavailable",
      "Database unavailable",
      "The database is unreachable or overloaded; retry shortly.",
    );
    res.headers.set("Retry-After", "1");

    return res;
  }

  log("error", "unhandled error", {
    request_id: requestId,
    path: path,
    error,
  });

  return problemResponse(
    requestId,
    500,
    "internal_error",
    "Internal server error",
    "An unexpected error occurred. Quote the request_id when reporting it.",
  );
};

/** The request's JSON body; 400 malformed_request when it isn't JSON. */
export const readJson = async (c: Context): Promise<unknown> => {
  try {
    return await c.req.json();
  } catch {
    throw malformedJson();
  }
};

const malformedJson = (): ApiError =>
  new ApiError(
    400,
    "malformed_request",
    "Malformed request",
    "The body must be JSON.",
  );

/**
 * An optional JSON body (`{}` when empty), validated whatever its
 * Content-Type: the OpenAPI validator skips a body that isn't sent as JSON
 * (`curl -d` sends a form type), which would drop it silently.
 */
export const optionalJson = async <T extends z.ZodType>(
  c: Context,
  schema: T,
): Promise<z.infer<T>> => {
  const text = (await c.req.text()).trim();
  let raw: unknown = {};
  if (text) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw malformedJson();
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw validationFailed(issuesOf(parsed.error, "body"));

  return parsed.data;
};

/** Throws 403 unless the authenticated principal holds `scope`. */
export const requireScope = (
  c: Context<AppEnv>,
  scope: Scope,
): AuthPrincipal => {
  const principal = c.get("principal");
  if (!hasScope(principal, scope)) {
    throw insufficientScope(`This endpoint requires the '${scope}' scope.`);
  }

  return principal;
};

/**
 * A request that names workspace secrets (a source's key, an HF token, a run
 * logger's key) makes the server send their plaintext somewhere, so it needs
 * `secrets:read` (or admin) on top of the endpoint's own scope. Where the
 * value may go is bound separately, by the secret's allowed_hosts.
 */
export const requireSecretUse = (
  c: Context<AppEnv>,
  names: ReadonlyArray<string | null | undefined>,
): void => {
  const named = names.filter((n): n is string => typeof n === "string");
  if (named.length === 0 || hasScope(c.get("principal"), "secrets:read")) {
    return;
  }
  throw insufficientScope(
    `Using workspace secret '${named[0]}' needs the 'secrets:read' scope (or admin) as well.`,
  );
};

/** Workspace id of a workspace-scoped caller (after a scope check). */
export const workspaceOf = (c: Context<AppEnv>, scope: Scope): string =>
  requireScope(c, scope).workspaceId;

export const IdParamSchema = z.object({ id: z.string().min(1).max(200) });
