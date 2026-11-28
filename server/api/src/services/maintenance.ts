import { addSeconds } from "../clock.js";
import type { AppDependencies } from "../deps.js";
import { log } from "../telemetry/log.js";
import { metrics, secondsSince } from "../telemetry/metrics.js";
import type { TelemetrySampler } from "../telemetry/sampler.js";
import type { EvalService } from "./evals/service.js";
import type { JobQueue } from "./jobs.js";
import type { CheckpointService } from "./checkpoints.js";
import type { RunLifecycle } from "./runs.js";
import type { SourceService } from "./sources.js";
import { deleteUnreferencedBlob } from "./artifacts.js";
import { ARTIFACTS_PREFIX, type UploadService } from "./uploads.js";
import type { UsageService } from "./usage.js";
import type { WorkspaceLifecycle } from "./workspaces.js";

/** Keys checked per tick while a pass over the bucket is in progress. */
const ORPHAN_PAGE = 1000;
/** A finished pass waits this long before the next one starts. */
const ORPHAN_PASS_INTERVAL_MS = 3_600_000;
/** Swept for orphans: job blobs under `ws/`, released bundles under `artifacts/`. */
const ORPHAN_PREFIXES = ["ws", ARTIFACTS_PREFIX];

export interface MaintenanceReport {
  expiredJobs: number;
  waitingForCompute: number;
  settledEvals: number;
  deletedCheckpoints: number;
  deletedUploads: number;
  deletedEvents: number;
  deletedOrphanBlobs: number;
  /** Workers unseen for a day (and holding no lease) forgotten. */
  prunedWorkers: number;
  deletedWorkerTokens: number;
  /** Cloud: 1 when the price list is current (polled when due). */
  refreshedPrices: number;
  exportedUsage: number;
  syncedSources: number;
  /** KMS mode: secrets re-sealed under the current key. */
  resealedSecrets: number;
  /** Cloud: deleted workspaces purged this tick. */
  purgedWorkspaces: number;
  /** 1 when the metric gauges were refreshed. */
  sampledMetrics: number;
}

export interface Maintenance {
  /** One pass: lease expiry, eval settling, retention sweeps, usage export, source schedules. */
  tick(): Promise<MaintenanceReport>;
  start(intervalMs: number): void;
  stop(): Promise<void>;
}

export const createMaintenance = (
  deps: AppDependencies,
  services: {
    queue: JobQueue;
    runs: RunLifecycle;
    checkpoints: CheckpointService;
    evals: EvalService;
    uploads: UploadService;
    usage: UsageService;
    sources: SourceService;
    workspaces?: WorkspaceLifecycle | undefined;
    telemetry?: TelemetrySampler;
  },
): Maintenance => {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;

  // The orphaned-blob sweep pages through `ws/` and `artifacts/`, a page of
  // each per tick (this replica's cursors), then rests. Deletes are
  // idempotent, so replicas sweeping the same keys is harmless.
  const orphanCursors = new Map<string, string | undefined>();
  let nextOrphanPass = 0;

  /**
   * The backstop for best-effort blob deletes: deletes job blobs (worker
   * uploads, staged import parts) and released bundles older than
   * ORPHAN_BLOB_DAYS that no artifact or dataset part references (an upload
   * never registered, a delete a crash skipped). A pinned artifact's row
   * can't be deleted, so its bundle is always referenced. Dataset parts are
   * content-addressed and reused by an identical later write, so they are
   * left alone.
   */
  const sweepOrphanBlobs = async (now: Date): Promise<number> => {
    if (orphanCursors.size === 0) {
      if (now.getTime() < nextOrphanPass) return 0;
      for (const prefix of ORPHAN_PREFIXES)
        orphanCursors.set(prefix, undefined);
    }
    const days = deps.settings.orphanBlobDays;
    let deleted = 0;
    for (const [prefix, cursor] of [...orphanCursors]) {
      const keys = await deps.storage.listOlder(
        prefix,
        addSeconds(now, -days * 86_400),
        ORPHAN_PAGE,
        cursor,
      );
      if (keys.length < ORPHAN_PAGE) orphanCursors.delete(prefix);
      else orphanCursors.set(prefix, keys.at(-1));
      const orphans = await deps.store.unreferencedKeys(
        keys.filter(
          (key) =>
            key.startsWith(`${ARTIFACTS_PREFIX}/`) ||
            /^ws\/[^/]+\/jobs\//.test(key),
        ),
      );
      // Each re-checked under its blob lock: a release created on it since
      // the check above keeps it.
      for (const key of orphans) {
        if (await deleteUnreferencedBlob(deps, key)) deleted += 1;
      }
    }
    if (orphanCursors.size === 0) {
      nextOrphanPass = now.getTime() + ORPHAN_PASS_INTERVAL_MS;
    }

    return deleted;
  };

  /** One step's failure (an S3 outage, say) is logged and never stops the others. */
  const step = async (name: string, fn: () => Promise<number>) => {
    const start = performance.now();
    try {
      return await fn();
    } catch (error) {
      metrics.maintenanceErrors.inc({ step: name });
      log("error", "maintenance step failed", {
        step: name,
        error,
      });
      return 0;
    } finally {
      metrics.maintenanceDuration.observe({ step: name }, secondsSince(start));
    }
  };

  const tick = async (): Promise<MaintenanceReport> => {
    const now = deps.clock.now();
    const retentionDays = deps.settings.jobEventRetentionDays;

    const report: MaintenanceReport = {
      expiredJobs: await step("expire_jobs", () =>
        services.queue.expireLeases(now),
      ),
      waitingForCompute: await step("waiting_for_compute", () =>
        services.runs.markWaitingForCompute(now),
      ),
      settledEvals: await step("settle_evals", () =>
        services.evals.settleAwaitingScores(now),
      ),
      deletedCheckpoints: await step("gc_checkpoints", () =>
        services.checkpoints.collectExpired(now),
      ),
      deletedUploads: await step("gc_staged_uploads", () =>
        services.uploads.sweepStaging(now),
      ),
      deletedEvents: await step("gc_job_events", () =>
        deps.store.jobs.deleteEventsBefore(
          addSeconds(now, -retentionDays * 86_400),
          1000,
        ),
      ),
      deletedOrphanBlobs: await step("gc_orphan_blobs", () =>
        sweepOrphanBlobs(now),
      ),
      prunedWorkers: await step("gc_workers", () =>
        deps.store.jobs.pruneWorkers(addSeconds(now, -86_400)),
      ),
      deletedWorkerTokens: await step("gc_worker_tokens", () =>
        deps.store.workerTokens.deleteExpired(now, 1000),
      ),
      refreshedPrices: await step("refresh_prices", async () =>
        (await deps.prices?.refresh()) ? 1 : 0,
      ),
      exportedUsage: await step("export_usage", () =>
        services.usage.exportPending(),
      ),
      syncedSources: await step("sync_sources", () =>
        services.sources.tick(now),
      ),
      resealedSecrets: await step("reseal_secrets", () =>
        services.sources.resealSecrets(),
      ),
      purgedWorkspaces: await step(
        "purge_workspaces",
        async () => (await services.workspaces?.purgeDue(now)) ?? 0,
      ),
      // Last: the gauges then reflect this tick's expiries and syncs.
      sampledMetrics: await step("sample_metrics", async () => {
        await services.telemetry?.refresh(deps.clock.now());
        return services.telemetry ? 1 : 0;
      }),
    };
    // A stale timestamp means the loop is stuck (GradMaintenanceStalled).
    metrics.maintenanceLastTick.set(Date.now() / 1000);

    return report;
  };

  return {
    tick,
    start: (intervalMs) => {
      if (timer) return;
      timer = setInterval(() => {
        if (running) return;
        running = tick()
          .catch((error: unknown) => {
            log("error", "maintenance tick failed", {
              error,
            });
          })
          .finally(() => {
            running = null;
          });
      }, intervalMs);
      timer.unref();
    },
    stop: async () => {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
};
