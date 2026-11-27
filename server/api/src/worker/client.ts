import { gunzipSync } from "node:zlib";

import type { z } from "@hono/zod-openapi";

import type {
  ClaimJobResponseSchema,
  CompleteJobRequestSchema,
  DatasetRecord,
  HeartbeatResponseSchema,
  PostEvalOutputsRequestSchema,
  PostEvalOutputsResponseSchema,
  TrainerJob,
} from "../contracts.js";
import { errorMessage } from "../errors.js";

/**
 * The worker side of grad.trainer-protocol/1, for the TypeScript eval
 * worker. Every write is keyed on the server ((job, attempt), outputs by
 * (eval, model, task, sample)), so a request whose response was lost is
 * simply sent again.
 */

/** This worker no longer holds the job's lease: stop work on it. */
export class LeaseLost extends Error {}

/** grad-server stayed unreachable (or 5xx) through every retry. */
export class ServerUnavailable extends Error {}

export interface WorkerClientOptions {
  serverUrl: string;
  apiKey?: string | undefined;
  workerId: string;
  fetch?: typeof fetch;
  /** Waits between retries of a failed request (default about 30 s in total). */
  retryDelaysMs?: readonly number[];
  timeoutMs?: number;
}

export interface AttemptRef {
  id: string;
  attempt: number;
}

type Complete = Omit<
  z.input<typeof CompleteJobRequestSchema>,
  "worker_id" | "attempt"
>;
type OutputsBody = Omit<
  z.input<typeof PostEvalOutputsRequestSchema>,
  "worker_id" | "attempt"
>;

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
export const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface WorkerClient {
  workerId: string;
  claim(
    kinds: readonly string[],
    leaseSeconds: number,
  ): Promise<TrainerJob | null>;
  heartbeat(
    job: AttemptRef,
    stats?: Record<string, unknown>,
  ): Promise<z.infer<typeof HeartbeatResponseSchema>>;
  /** The job's pinned dataset version: every record, before merging. */
  datasetRecords(downloadUrl: string): Promise<DatasetRecord[]>;
  postOutputs(
    job: AttemptRef,
    body: OutputsBody,
  ): Promise<z.infer<typeof PostEvalOutputsResponseSchema>>;
  complete(job: AttemptRef, body: Complete): Promise<Record<string, unknown>>;
}

export const createWorkerClient = (
  options: WorkerClientOptions,
): WorkerClient => {
  const base = options.serverUrl.trim().replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const { workerId } = options;

  const send = async (
    path: string,
    init: { method?: string; body?: unknown } = {},
    retry = true,
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    let last = "";
    for (let i = 0; ; i += 1) {
      let res: Response | null = null;
      try {
        res = await fetchImpl(`${base}${path}`, {
          method: init.method ?? (init.body === undefined ? "GET" : "POST"),
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
          ...(init.body !== undefined
            ? { body: JSON.stringify(init.body) }
            : {}),
        });
      } catch (error) {
        last = errorMessage(error);
      }
      if (res?.ok) return res;
      if (res) {
        const detail = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
        // lease_lost, or a job this key can no longer see.
        if (res.status === 409 || res.status === 404) {
          throw new LeaseLost(`${path}: ${detail}`);
        }
        if (!RETRYABLE.has(res.status)) {
          throw new Error(`grad-server refused ${path}: ${detail}`);
        }
        last = detail;
      }
      if (!retry || i >= delays.length) {
        throw new ServerUnavailable(`grad-server ${path}: ${last}`);
      }
      await sleep(delays[i] as number);
    }
  };

  const json = async <T>(
    path: string,
    body: unknown,
    retry = true,
  ): Promise<T> => (await (await send(path, { body }, retry)).json()) as T;

  const ref = (job: AttemptRef) => ({
    worker_id: workerId,
    attempt: job.attempt,
  });

  return {
    workerId,

    claim: async (kinds, leaseSeconds) =>
      (
        await json<z.infer<typeof ClaimJobResponseSchema>>(
          "/v1/trainer-jobs/claim",
          { worker_id: workerId, lease_seconds: leaseSeconds, kinds },
        )
      ).job,

    // One try: the next beat retries, and a lease that really expired shows up then.
    heartbeat: (job, stats) =>
      json(
        `/v1/trainer-jobs/${job.id}/heartbeat`,
        { ...ref(job), ...(stats ? { stats } : {}) },
        false,
      ),

    datasetRecords: async (downloadUrl) => {
      const url = /^https?:\/\//.test(downloadUrl)
        ? downloadUrl
        : downloadUrl.replace(/^\/?/, "/");
      const res = /^https?:\/\//.test(url)
        ? await fetchImpl(url)
        : await send(url);
      if (!res.ok) throw new Error(`dataset download: HTTP ${res.status}`);
      const text = gunzipSync(Buffer.from(await res.arrayBuffer())).toString(
        "utf8",
      );

      return text
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as DatasetRecord);
    },

    postOutputs: (job, body) =>
      json(`/v1/trainer-jobs/${job.id}/outputs`, { ...ref(job), ...body }),

    complete: (job, body) =>
      json(`/v1/trainer-jobs/${job.id}/complete`, { ...ref(job), ...body }),
  };
};
