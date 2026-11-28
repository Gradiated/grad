import type { QueueCaps, Store, TelemetrySnapshot } from "../store/types.js";
import { metrics, type MetricJobKind } from "./metrics.js";

const KINDS: readonly MetricJobKind[] = ["train", "import", "sync", "eval"];
const STATES = [
  "queued",
  "blocked",
  "waiting_for_compute",
  "running",
  "awaiting_scores",
] as const;
const WORKER_KINDS = ["train", "import", "eval"] as const;

/** Worker `kinds` (claim vocabulary) -> metric kinds: imports include syncs. */
const METRIC_KINDS: Record<string, readonly MetricJobKind[]> = {
  train: ["train"],
  import: ["import", "sync"],
  eval: ["eval"],
};

interface QueueDepth {
  /** Claimable queued plus leased jobs (KEDA's target value). */
  open: number;
  queued: number;
  waiting_for_compute: number;
  running: number;
  /** When the numbers were read (RFC 3339), null before the first read. */
  sampled_at: string | null;
}

export interface TelemetrySampler {
  /** Reads the database once and sets every DB-derived gauge. */
  refresh(now: Date): Promise<void>;
  /** Queue depth for these worker kinds from the last read. */
  queueDepth(kinds: readonly string[]): QueueDepth;
  /** True once a read succeeded. */
  sampled(): boolean;
}

/**
 * The DB-derived gauges (queue, workers, usage lag), read in the maintenance
 * tick and cached, so a scrape never touches the database.
 */
export const createTelemetrySampler = (
  store: Pick<Store, "telemetry">,
  options: { workspaceLabel?: boolean; maxRunning?: QueueCaps } = {},
): TelemetrySampler => {
  let last: TelemetrySnapshot | null = null;
  let sampledAt: string | null = null;

  const apply = (snap: TelemetrySnapshot) => {
    const jobs = new Map<string, number>();
    const open = new Map<string, number>();
    const oldest = new Map<string, number>();
    for (const row of snap.jobs) {
      const key = `${row.kind}|${row.state}`;
      jobs.set(key, (jobs.get(key) ?? 0) + row.count);
      open.set(row.kind, (open.get(row.kind) ?? 0) + row.open);
      if (row.oldest_queued_seconds !== null) {
        oldest.set(
          row.kind,
          Math.max(oldest.get(row.kind) ?? 0, row.oldest_queued_seconds),
        );
      }
    }
    // Jobs a workspace's running cap holds back don't need a worker: take
    // them out of the open count KEDA scales on (an import's from imports
    // first, then syncs).
    for (const row of snap.queue) {
      let rest = row.over_limit;
      for (const kind of METRIC_KINDS[row.kind] ?? []) {
        const take = Math.min(rest, open.get(kind) ?? 0);
        open.set(kind, (open.get(kind) ?? 0) - take);
        rest -= take;
      }
    }
    for (const kind of KINDS) {
      for (const status of STATES) {
        metrics.jobs.set({ kind, status }, jobs.get(`${kind}|${status}`) ?? 0);
      }
      metrics.jobsOpen.set({ kind }, open.get(kind) ?? 0);
      metrics.oldestQueuedAge.set({ kind }, oldest.get(kind) ?? 0);
    }
    for (const kind of WORKER_KINDS) {
      const q = snap.queue.find((r) => r.kind === kind);
      metrics.jobsOverLimit.set({ kind }, q?.over_limit ?? 0);
      metrics.fairShareWait.set({ kind }, q?.fair_share_wait_seconds ?? 0);
    }
    metrics.jobsUnfit.set(snap.unfit);

    if (options.workspaceLabel) {
      metrics.workspaceJobs.reset();
      for (const row of snap.jobs) {
        if (
          !row.workspace_id ||
          !(STATES as readonly string[]).includes(row.state)
        )
          continue;
        metrics.workspaceJobs.inc(
          { workspace: row.workspace_id, kind: row.kind, status: row.state },
          row.count,
        );
      }
    }

    let flushLag = 0;
    for (const kind of WORKER_KINDS) {
      const w = snap.workers.find((r) => r.kind === kind);
      metrics.workersOnline.set({ kind }, w?.online ?? 0);
      metrics.workerTokensPerSecond.set({ kind }, w?.tokens_per_second ?? 0);
      metrics.workerGpuMemory.set({ kind }, w?.gpu_memory_used_bytes ?? 0);
      metrics.workerGpuUtilization.set({ kind }, w?.gpu_utilization ?? 0);
      flushLag = Math.max(flushLag, w?.flush_lag_seconds ?? 0);
    }
    metrics.usageFlushLag.set(flushLag);

    metrics.sources.reset();
    metrics.sourcesPaused.reset();
    metrics.sourceFailures.reset();
    metrics.sourceSyncLag.reset();
    for (const row of snap.sources) {
      const labels = { provider: row.provider };
      metrics.sources.set(labels, row.count);
      metrics.sourceSyncLag.set(labels, row.sync_lag_seconds);
      metrics.sourcesPaused.set(labels, row.paused);
      metrics.sourceFailures.set(labels, row.max_consecutive_failures);
    }

    metrics.workerPhase.reset();
    for (const row of snap.phases) {
      metrics.workerPhase.set({ kind: row.kind, phase: row.phase }, row.count);
    }
  };

  // Zeros until the first read, so every series exists from boot.
  apply({
    jobs: [],
    workers: [],
    phases: [],
    sources: [],
    queue: [],
    unfit: 0,
  });

  return {
    refresh: async (now) => {
      const snap = await store.telemetry.snapshot(now, {
        byWorkspace: options.workspaceLabel === true,
        maxRunning: options.maxRunning,
      });
      apply(snap);
      last = snap;
      sampledAt = now.toISOString();
    },

    queueDepth: (kinds) => {
      const wanted = new Set(kinds.flatMap((k) => METRIC_KINDS[k] ?? []));
      const depth: QueueDepth = {
        open: 0,
        queued: 0,
        waiting_for_compute: 0,
        running: 0,
        sampled_at: sampledAt,
      };
      for (const row of last?.jobs ?? []) {
        if (!wanted.has(row.kind as MetricJobKind)) continue;
        depth.open += row.open;
        if (row.state === "queued") depth.queued += row.count;
        if (row.state === "waiting_for_compute") {
          depth.waiting_for_compute += row.count;
        }
        if (row.state === "running") depth.running += row.count;
      }
      const held = (last?.queue ?? [])
        .filter((r) => kinds.includes(r.kind))
        .reduce((sum, r) => sum + r.over_limit, 0);
      depth.open = Math.max(0, depth.open - held);

      return depth;
    },

    sampled: () => last !== null,
  };
};
