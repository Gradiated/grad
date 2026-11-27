import { AsyncLocalStorage } from "node:async_hooks";

import { currentTraceId } from "./tracing.js";

/**
 * Structured JSON logs. Every line carries the ambient request_id, job_id and
 * (when tracing is on) trace_id, so a log line joins its request and trace.
 */

export interface LogContext {
  request_id?: string;
  job_id?: string;
}

const ambient = new AsyncLocalStorage<LogContext>();

/** Runs `fn` with these fields added to every log line it writes. */
export const withLogContext = <T>(fields: LogContext, fn: () => T): T =>
  ambient.run({ ...ambient.getStore(), ...fields }, fn);

export const logContext = (): LogContext & { trace_id?: string } => {
  const traceId = currentTraceId();

  return { ...ambient.getStore(), ...(traceId ? { trace_id: traceId } : {}) };
};

export const log = (
  level: "info" | "warn" | "error",
  msg: string,
  extra: Record<string, unknown> = {},
): void =>
  console[level === "info" ? "log" : level](
    JSON.stringify({ level, msg, ...logContext(), ...extra }),
  );
