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

export type RunPhase =
  | "queued"
  | "waiting_for_compute"
  | "starting"
  | "loading_model"
  | "training"
  | "evaluating"
  | "checkpointing"
  | "uploading"
  | "completing";

export interface RunInterruption {
  attempt: number;
  reason: string;
  step: number;
  resumeStep: number | null;
  at: string;
  message: string;
}

/** Lifecycle fields (phase, interruptions, workers online) a server may add to Run. */
export interface RunLifecycle {
  phase: RunPhase | null;
  phaseSince: string | null;
  lastInterruption: RunInterruption | null;
  workersOnline: number | null;
  autoscaling: boolean | null;
  /** While queued: about how many runs start first (fair share across workspaces). */
  queuePosition: number | null;
  /** While queued: why it waits ("Queued behind 3 runs", a workspace cap, a GPU nobody has). */
  queueMessage: string | null;
}

const pick = (run: Record<string, unknown>, camel: string, wire: string): unknown => run[camel] ?? run[wire] ?? null;

/** Reads the lifecycle fields whether the client codec renamed them yet or not. */
export const lifecycleOf = (run: Run): RunLifecycle => {
  const r = run as unknown as Record<string, unknown>;
  const li = pick(r, "lastInterruption", "last_interruption") as Record<string, unknown> | null;
  return {
    phase: (r.phase as RunPhase | undefined) ?? null,
    phaseSince: (pick(r, "phaseSince", "phase_since") as string | null) ?? null,
    lastInterruption: li
      ? {
          attempt: Number(li.attempt ?? 0),
          reason: String(li.reason ?? ""),
          step: Number(li.step ?? 0),
          resumeStep: (li.resumeStep ?? li.resume_step ?? null) as number | null,
          at: String(li.at ?? ""),
          message: String(li.message ?? ""),
        }
      : null,
    workersOnline: (pick(r, "workersOnline", "workers_online") as number | null) ?? null,
    autoscaling: (r.autoscaling as boolean | null | undefined) ?? null,
    queuePosition: (pick(r, "queuePosition", "queue_position") as number | null) ?? null,
    queueMessage: (pick(r, "queueMessage", "queue_message") as string | null) ?? null,
  };
};

export const TERMINAL_RUN = new Set(["completed", "failed", "cancelled", "stopped_budget", "stopped_balance"]);
export const isTerminalRun = (run: Pick<Run, "status">): boolean => TERMINAL_RUN.has(run.status);
