import { createContext, useContext } from "react";

import { ApiClient, CODEC } from "@sdk/generated/client.js";
import type { Run } from "@sdk/generated/models.js";
import { APIError, convertKeys, Transport, type TransportLike } from "@sdk/transport.js";

export { APIError, CODEC, convertKeys };
export type { TransportLike };

/** The generated REST client plus its transport (for the run events stream). */
export interface Api {
  client: ApiClient;
  transport: TransportLike;
  baseURL: string;
}

export const createApi = (baseURL: string, apiKey: string | undefined, fetchImpl?: typeof fetch): Api => {
  const transport = new Transport({
    baseURL,
    apiKey,
    // Same-origin browser requests: keep retries short so the UI stays snappy.
    maxRetries: 1,
    timeoutMs: 30_000,
    fetch: fetchImpl ?? ((input, init) => globalThis.fetch(input, init)),
  });
  return { client: new ApiClient(transport), transport, baseURL };
};

export const ApiContext = createContext<Api | null>(null);

export const useApi = (): Api => {
  const api = useContext(ApiContext);
  if (!api) throw new Error("useApi outside <ApiContext.Provider>");
  return api;
};

export const isUnauthorized = (error: unknown): boolean => error instanceof APIError && error.status === 401;

export const errorMessage = (error: unknown): string => {
  if (error instanceof APIError) return error.detail || error.title || error.message;
  if (error instanceof Error) return error.message;
  return String(error);
};

// ------------------------------------------------------------ run lifecycle

export type RunPhase = NonNullable<Run["phase"]>;

export const TERMINAL_RUN = new Set(["completed", "failed", "cancelled", "stopped_budget", "stopped_balance"]);
export const isTerminalRun = (run: Pick<Run, "status">): boolean => TERMINAL_RUN.has(run.status);
