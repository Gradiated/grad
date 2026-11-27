import {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  defaultSleep,
  type Sleep,
} from "./transport.js";
import { WaitTimeoutError } from "./errors.js";

export interface WaitOptions {
  /** Give up after this long (default: wait as long as it takes). */
  timeoutMs?: number | undefined;
  /** Stop waiting (the server-side resource keeps running). */
  signal?: AbortSignal | undefined;
  /** First poll interval (default 500 ms); it backs off ×1.5 up to `maxPollIntervalMs`. */
  pollIntervalMs?: number | undefined;
  /** Longest poll interval (default 5 s). */
  maxPollIntervalMs?: number | undefined;
}

export interface PollContext {
  sleep: Sleep;
  now: () => number;
}

export const defaultPollContext: PollContext = { sleep: defaultSleep, now: () => Date.now() };

/** Errors worth riding out while polling: no response, timeouts, 408/429/5xx. */
export const isTransient = (error: unknown): boolean => {
  if (error instanceof APIUserAbortError) return false;
  if (error instanceof APIConnectionError) return true;
  if (error instanceof APIError) {
    if (error.code === "deploy_unavailable" || error.code === "inference_unavailable") return false;
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return false;
};

const abortError = (what: string, signal: AbortSignal): APIUserAbortError =>
  new APIUserAbortError(`Stopped waiting for ${what}.`, { code: "aborted", cause: signal.reason });

/**
 * Polls `fetchState` until `isDone` holds, backing off 0.5 s -> 5 s and riding
 * out transient errors. One abort listener per sleep, always removed.
 */
export const pollUntil = async <T>(
  what: string,
  fetchState: (signal: AbortSignal | undefined) => Promise<T>,
  isDone: (state: T) => boolean | Promise<boolean>,
  options: WaitOptions = {},
  ctx: PollContext = defaultPollContext,
  onState?: (state: T) => void | Promise<void>,
): Promise<T> => {
  const started = ctx.now();
  const deadline = options.timeoutMs === undefined ? Number.POSITIVE_INFINITY : started + options.timeoutMs;
  const maxInterval = options.maxPollIntervalMs ?? 5_000;
  let interval = Math.min(options.pollIntervalMs ?? 500, maxInterval);
  const signal = options.signal;

  while (true) {
    if (signal?.aborted) throw abortError(what, signal);
    let state: T | undefined;
    try {
      state = await fetchState(signal);
    } catch (error) {
      if (signal?.aborted) throw abortError(what, signal);
      if (!isTransient(error)) throw error;
    }
    if (state !== undefined) {
      if (onState) await onState(state);
      if (await isDone(state)) return state;
    }
    const remaining = deadline - ctx.now();
    if (remaining <= 0) throw new WaitTimeoutError(what, options.timeoutMs ?? 0);
    try {
      await ctx.sleep(Math.min(interval, remaining), signal);
    } catch {
      if (signal?.aborted) throw abortError(what, signal);
      throw new APIUserAbortError(`Stopped waiting for ${what}.`, { code: "aborted" });
    }
    interval = Math.min(Math.round(interval * 1.5), maxInterval);
  }
};
