import type { Context } from "hono";
import { z } from "@hono/zod-openapi";

import { hasScope, type AuthPrincipal } from "../adapters.js";
import { ProblemSchema, type Scope } from "../contracts.js";
import { ApiError, type ProblemStatus } from "../errors.js";
import { metrics } from "../telemetry/metrics.js";

export type AppEnv = {
  Variables: {
    principal: AuthPrincipal;
    requestId: string;
  };
};

export const problemContent = {
  "application/problem+json": { schema: ProblemSchema },
} as const;

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
export const problemBody = (
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

export const respondProblem = <S extends ProblemStatus>(
  c: Context<AppEnv>,
  status: S,
  code: string,
  title: string,
  detail: string,
) =>
  c.json(
    problemBody(
      status,
      code,
      title,
      detail,
      c.get("requestId") ?? "req_unknown",
    ),
    status,
    { "Content-Type": "application/problem+json" },
  );

/** Throws 403 unless the authenticated principal holds `scope`. */
export const requireScope = (
  c: Context<AppEnv>,
  scope: Scope,
): AuthPrincipal => {
  const principal = c.get("principal");
  if (!hasScope(principal, scope)) {
    throw new ApiError(
      403,
      "forbidden",
      "Insufficient scope",
      `This endpoint requires the '${scope}' scope.`,
    );
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
  throw new ApiError(
    403,
    "forbidden",
    "Insufficient scope",
    `Using workspace secret '${named[0]}' needs the 'secrets:read' scope (or admin) as well.`,
  );
};

/** Workspace id of a workspace-scoped caller (after a scope check). */
export const workspaceOf = (c: Context<AppEnv>, scope: Scope): string =>
  requireScope(c, scope).workspaceId;

export const IdParamSchema = z.object({ id: z.string().min(1).max(200) });
