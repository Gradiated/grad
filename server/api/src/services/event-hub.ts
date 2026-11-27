import { AsyncResource } from "node:async_hooks";

import type { Clock } from "../clock.js";
import type { JobEvent, JobStatus, Store } from "../store/types.js";
import { log } from "../telemetry/log.js";
import { metrics } from "../telemetry/metrics.js";

/**
 * One reader of grad_job_events per API replica, fanned out to every SSE
 * stream the replica holds (r9-sse). Streams subscribe by job id with their
 * last seq; the hub fetches new events for all subscribed jobs in one query
 * (per JOBS_PER_QUERY jobs) and queues them on each subscription.
 *
 * It fetches when Postgres NOTIFYs `grad_job_events` with a job id (migration
 * 0004's triggers fire on every event insert and on job status/worker
 * changes), and on a safety poll of every subscribed job (`pollMs`), which
 * delivers whatever a missed notification (a dropped LISTEN connection, a
 * transaction-mode pooler) would have. Postgres stays the source of truth, so
 * events written through any replica reach streams on every replica.
 */

/** Statuses after which a released job writes no more events. */
const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "completed",
  "failed",
  "cancelled",
  "stopped_budget",
  "stopped_balance",
]);
/** Rows per job per fetch; a subscription with this many queued is skipped until it drains. */
export const HUB_BATCH = 500;
/** Jobs per fetch query (bounds one fetch to JOBS_PER_QUERY * HUB_BATCH rows). */
export const JOBS_PER_QUERY = 100;
/** Fetches start at most this often, however fast notifications arrive. */
const MIN_FETCH_GAP_MS = 25;
const RELISTEN_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
export const CHANNEL = "grad_job_events";

export interface HubBatch {
  /** New events of every type, ascending by seq. */
  events: JobEvent[];
  /**
   * The job was terminal and released (or gone) when last checked and every
   * event up to then is in `events` or was returned before: the caller reads
   * the final state and ends the stream.
   */
  settled: boolean;
}

export interface Subscription {
  /** The next batch; `{events: [], settled: false}` after `timeoutMs` with nothing new; null once closed. */
  next(timeoutMs: number): Promise<HubBatch | null>;
  close(): void;
}

export interface EventHub {
  /** Follows `jobId` from after `afterSeq` (0: its whole history). */
  subscribe(jobId: string, afterSeq: number): Subscription;
  /** Jobs and subscriptions held (tests: nothing leaks after disconnects). */
  size(): { jobs: number; subscriptions: number };
  /** Ends every subscription (their `next` returns null) and stops listening. */
  close(): Promise<void>;
}

interface Sub {
  jobId: string;
  cursor: number;
  queue: JobEvent[];
  settled: boolean;
  closed: boolean;
  wake: (() => void) | null;
}

export interface EventHubOptions {
  /** Safety poll interval (SSE_POLL_MS). */
  pollMs: number;
  clock: Clock;
}

export const createEventHub = (
  store: Pick<Store, "jobs" | "listen">,
  options: EventHubOptions,
): EventHub => {
  const jobs = new Map<string, Set<Sub>>();
  const dirty = new Set<string>();
  // Highest seq fetched per job: rows above it are live (timed on
  // grad_sse_dispatch_latency_seconds), rows below are a backfill.
  const fetched = new Map<string, number>();
  // Ticks and the listener run in the hub's own async context, not in that
  // of the request whose subscription started them.
  const detached = new AsyncResource("grad-event-hub");
  let closed = false;
  let running = false;
  let again = false;
  let againFull = false;
  let timer: NodeJS.Timeout | null = null;
  let lastFetch = 0;
  let poller: NodeJS.Timeout | null = null;
  let unlisten: (() => Promise<void>) | null = null;
  let listening = false;
  let relistens = 0;
  let relistenTimer: NodeJS.Timeout | null = null;

  const wake = (sub: Sub) => {
    const fn = sub.wake;
    sub.wake = null;
    fn?.();
  };

  const schedule = (full: boolean) => {
    if (closed) return;
    againFull ||= full;
    if (running) {
      again = true;
      return;
    }
    if (timer) return;
    const delay = Math.max(0, lastFetch + MIN_FETCH_GAP_MS - Date.now());
    timer = setTimeout(() => detached.runInAsyncScope(() => void run()), delay);
    timer.unref();
  };

  const run = async () => {
    timer = null;
    running = true;
    again = false;
    const full = againFull;
    againFull = false;
    lastFetch = Date.now();
    const ids = full ? [...jobs.keys()] : [...dirty];
    dirty.clear();
    let ok = true;
    for (let i = 0; i < ids.length && !closed; i += JOBS_PER_QUERY) {
      const chunk = ids.slice(i, i + JOBS_PER_QUERY);
      try {
        await fetchChunk(chunk, full ? "poll" : "notify");
      } catch (error) {
        // Retried on the next notification or safety poll, never in a loop.
        ok = false;
        for (const id of chunk) if (jobs.has(id)) dirty.add(id);
        log("warn", "event hub fetch failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    running = false;
    if (again || (ok && dirty.size > 0)) schedule(againFull);
  };

  const fetchChunk = async (ids: string[], reason: "notify" | "poll") => {
    const cursors: Array<{ jobId: string; afterSeq: number }> = [];
    for (const id of ids) {
      const ready = [...(jobs.get(id) ?? [])].filter(
        (s) => s.queue.length < HUB_BATCH,
      );
      if (ready.length === 0) continue;
      cursors.push({
        jobId: id,
        afterSeq: Math.min(...ready.map((s) => s.cursor)),
      });
    }
    if (cursors.length === 0) return;
    metrics.sseHubFetches.inc({ reason });

    // State first: a job seen terminal here wrote its last event before, so
    // the events read next include it.
    const states = new Map(
      (await store.jobs.jobStates(cursors.map((c) => c.jobId))).map((s) => [
        s.id,
        s,
      ]),
    );
    const rows = await store.jobs.listEventsSince(cursors, HUB_BATCH);
    const byJob = new Map<string, JobEvent[]>();
    const now = options.clock.now().getTime();
    for (const { job_id: jobId, ...event } of rows) {
      const list = byJob.get(jobId) ?? [];
      list.push(event);
      byJob.set(jobId, list);
      const high = fetched.get(jobId);
      if (high === undefined || event.seq <= high) continue;
      metrics.sseDispatchLatency.observe(
        Math.max(0, now - Date.parse(event.created_at)) / 1000,
      );
    }
    for (const { jobId } of cursors) {
      const events = byJob.get(jobId) ?? [];
      // A job's first caught-up fetch ends its backfill.
      if (events.length < HUB_BATCH || fetched.has(jobId)) {
        const last = events.at(-1)?.seq ?? 0;
        fetched.set(jobId, Math.max(fetched.get(jobId) ?? 0, last));
      }
    }

    for (const { jobId, afterSeq } of cursors) {
      const subs = jobs.get(jobId);
      if (!subs) continue;
      const events = byJob.get(jobId) ?? [];
      const full = events.length >= HUB_BATCH;
      const state = states.get(jobId);
      const settled =
        !full &&
        (!state || (TERMINAL.has(state.status) && state.worker_id === null));
      if (full) dirty.add(jobId);
      for (const sub of subs) {
        // A subscription that arrived (or filled up) during the fetch, behind
        // its cursor, waits for the next fetch: it would miss rows otherwise.
        if (sub.cursor < afterSeq || sub.queue.length >= HUB_BATCH) continue;
        let woke = false;
        for (const event of events) {
          if (event.seq <= sub.cursor) continue;
          sub.queue.push(event);
          sub.cursor = event.seq;
          woke = true;
        }
        if (settled) sub.settled = true;
        if (woke || settled) wake(sub);
      }
    }
  };

  const relisten = () => {
    if (closed || relistenTimer) return;
    const delay =
      RELISTEN_MS[Math.min(relistens, RELISTEN_MS.length - 1)] ?? 30_000;
    relistens += 1;
    relistenTimer = setTimeout(() => {
      relistenTimer = null;
      detached.runInAsyncScope(() => void startListening());
    }, delay);
    relistenTimer.unref();
  };

  const startListening = async () => {
    if (closed) return;
    try {
      const close = await store.listen(
        CHANNEL,
        (jobId) => {
          metrics.sseHubNotifications.inc();
          if (!jobs.has(jobId)) return;
          dirty.add(jobId);
          schedule(false);
        },
        (error) => {
          listening = false;
          unlisten = null;
          metrics.sseHubListening.set(0);
          log("warn", "event hub LISTEN connection lost", {
            error: error.message,
          });
          relisten();
        },
      );
      if (closed) {
        await close();
        return;
      }
      unlisten = close;
      listening = true;
      relistens = 0;
      metrics.sseHubListening.set(1);
      // Whatever was written while not listening.
      schedule(true);
    } catch (error) {
      log("warn", "event hub LISTEN failed; streams use the safety poll", {
        error: error instanceof Error ? error.message : String(error),
      });
      relisten();
    }
  };

  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    poller = setInterval(() => {
      if (jobs.size > 0) detached.runInAsyncScope(() => schedule(true));
    }, options.pollMs);
    poller.unref();
    detached.runInAsyncScope(() => void startListening());
  };

  const remove = (sub: Sub) => {
    if (sub.closed) return;
    sub.closed = true;
    sub.queue = [];
    const subs = jobs.get(sub.jobId);
    subs?.delete(sub);
    if (subs && subs.size === 0) {
      jobs.delete(sub.jobId);
      dirty.delete(sub.jobId);
      fetched.delete(sub.jobId);
    }
    wake(sub);
  };

  return {
    subscribe: (jobId, afterSeq) => {
      const sub: Sub = {
        jobId,
        cursor: afterSeq,
        queue: [],
        settled: false,
        closed,
        wake: null,
      };
      if (!closed) {
        start();
        const subs = jobs.get(jobId) ?? new Set<Sub>();
        subs.add(sub);
        jobs.set(jobId, subs);
        dirty.add(jobId);
        detached.runInAsyncScope(() => schedule(false));
      }

      return {
        next: (timeoutMs) =>
          new Promise<HubBatch | null>((resolve) => {
            const take = () => {
              if (sub.closed) return resolve(null);
              const events = sub.queue;
              const settled = sub.settled;
              sub.queue = [];
              sub.settled = false;
              // It was skipped while full: fetch the rest now.
              if (events.length >= HUB_BATCH) {
                dirty.add(jobId);
                schedule(false);
              }
              resolve({ events, settled });
            };
            if (sub.closed || sub.queue.length > 0 || sub.settled) {
              take();
              return;
            }
            const timeout = setTimeout(() => {
              sub.wake = null;
              resolve({ events: [], settled: false });
            }, timeoutMs);
            sub.wake = () => {
              clearTimeout(timeout);
              take();
            };
          }),
        close: () => remove(sub),
      };
    },
    size: () => ({
      jobs: jobs.size,
      subscriptions: [...jobs.values()].reduce((n, s) => n + s.size, 0),
    }),
    close: async () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      if (poller) clearInterval(poller);
      if (relistenTimer) clearTimeout(relistenTimer);
      for (const subs of [...jobs.values()])
        for (const sub of [...subs]) remove(sub);
      dirty.clear();
      if (listening) metrics.sseHubListening.set(0);
      listening = false;
      await unlisten?.();
      unlisten = null;
    },
  };
};
