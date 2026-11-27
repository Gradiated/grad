import { AsyncLocalStorage } from "node:async_hooks";

import { currentTraceId } from "./tracing.js";

/**
 * Structured JSON logs, one object per line on stdout. Every line carries `time`, `level`, `component` (api,
 * eval-worker, migrate) and the ambient request_id, job_id, workspace_id and
 * (when tracing is on) trace_id, so a log line joins its request and trace.
 * An Error passed as `error` is logged with its message and stack.
 * Credentials that slip into a message (bearer tokens, grad keys, presigned
 * URL signatures) are masked before the line is written.
 */

export interface LogContext {
  request_id?: string;
  job_id?: string;
  workspace_id?: string;
  attempt?: number;
  worker_id?: string;
}

const ambient = new AsyncLocalStorage<LogContext>();

let component = "api";

/** Names the process in every log line (`api` by default). */
export const setLogComponent = (name: string): void => {
  component = name;
};

/** Runs `fn` with these fields added to every log line it writes. */
export const withLogContext = <T>(fields: LogContext, fn: () => T): T =>
  ambient.run({ ...ambient.getStore(), ...fields }, fn);

export const logContext = (): LogContext & { trace_id?: string } => {
  const traceId = currentTraceId();

  return { ...ambient.getStore(), ...(traceId ? { trace_id: traceId } : {}) };
};

const SECRETS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1***"],
  // Workspace keys (grad_ + 48 hex) and lease tokens (gradwt_ + 43 base64url).
  [/\bgrad_[0-9a-f]{48}\b/g, "grad_***"],
  [/\bgradwt_[A-Za-z0-9_-]{40,}/g, "gradwt_***"],
  [/(X-Amz-(?:Signature|Credential|Security-Token)=)[^&"\s\\]+/gi, "$1***"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-***"],
];

/** `text` with credential-shaped substrings masked. */
export const redactSecrets = (text: string): string =>
  SECRETS.reduce((out, [re, sub]) => out.replace(re, sub), text);

const renderError = (error: unknown): Record<string, unknown> =>
  error instanceof Error
    ? {
        error: error.message,
        error_type: error.name,
        ...(error.stack ? { stack: error.stack } : {}),
      }
    : { error: String(error) };

export const log = (
  level: "info" | "warn" | "error",
  msg: string,
  extra: Record<string, unknown> = {},
): void => {
  const { error, ...fields } = extra;
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    component,
    msg,
    ...logContext(),
    ...fields,
    ...(error === undefined ? {} : renderError(error)),
  });
  // stdout for every level: collectors read one stream, `level` sorts them.
  console.log(redactSecrets(line));
};
