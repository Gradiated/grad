export type ProblemStatus =
  | 400
  | 401
  | 403
  | 404
  | 409
  | 410
  | 413
  | 422
  | 429
  | 500
  | 501
  | 502
  | 503;

/**
 * Domain error rendered by the global error handler as
 * `application/problem+json`. Services throw these; routes stay thin.
 */
export class ApiError extends Error {
  constructor(
    readonly status: ProblemStatus,
    readonly code: string,
    readonly title: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = "ApiError";
  }
}

export const notFound = (resource: string, id: string): ApiError =>
  new ApiError(
    404,
    `${resource}_not_found`,
    `${resource[0]?.toUpperCase() ?? ""}${resource.slice(1).replace(/_/g, " ")} not found`,
    `${resource.replace(/_/g, " ")} '${id}' was not found.`,
  );

export const conflict = (code: string, detail: string): ApiError =>
  new ApiError(409, code, "Conflict", detail);

export const invalid = (code: string, detail: string): ApiError =>
  new ApiError(422, code, "Unprocessable request", detail);

export const forbidden = (code: string, detail: string): ApiError =>
  new ApiError(403, code, "Forbidden", detail);

export const unavailable = (code: string, detail: string): ApiError =>
  new ApiError(501, code, "Not available on this server", detail);

export const unauthorized = (detail: string): ApiError =>
  new ApiError(401, "unauthorized", "Authentication required", detail);

export const validationFailed = (detail: string): ApiError =>
  new ApiError(422, "validation_error", "Validation failed", detail);

/** A zod error's issues as `path: message; ...` (`root` names an empty path). */
export const issuesOf = (
  error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> },
  root = "",
): string =>
  error.issues
    .slice(0, 20)
    .map((i) => `${i.path.map(String).join(".") || root}: ${i.message}`)
    .join("; ");

/** The token of an `Authorization: Bearer <token>` header. */
export const parseBearer = (header: string | undefined): string | undefined =>
  header?.match(/^Bearer\s+(\S+)$/i)?.[1];

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** 403: Gradiated Cloud suspended or deleted the workspace. */
export const workspaceInactive = (state: string): ApiError =>
  state === "deleted"
    ? forbidden(
        "workspace_deleted",
        "This workspace was deleted; its data is being removed.",
      )
    : forbidden(
        "workspace_suspended",
        "This workspace is suspended, so it cannot start new jobs; running jobs stop at their next checkpoint. Contact the workspace's admin or Gradiated support.",
      );

/** 429: the workspace already has `limit` queued jobs (GRAD_MAX_QUEUED_PER_WORKSPACE). */
export const queueLimit = (limit: number): ApiError =>
  new ApiError(
    429,
    "queue_limit",
    "Too many queued jobs",
    `This workspace already has ${limit} queued jobs (runs, imports and evals), the most it may queue at once. Wait for some to start, or cancel queued ones, then retry.`,
  );
