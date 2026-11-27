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

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
