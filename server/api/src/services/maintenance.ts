import { addSeconds } from "../clock.js";
import type { AppDependencies } from "../deps.js";
import { errorMessage } from "../errors.js";
import { log } from "../telemetry/log.js";
import { metrics, secondsSince } from "../telemetry/metrics.js";
import type { TelemetrySampler } from "../telemetry/sampler.js";
import type { EvalService } from "./evals/service.js";
import type { JobQueue } from "./jobs.js";
import type { RunLifecycle } from "./runs.js";
import type { SourceService } from "./sources.js";
import type { UploadService } from "./uploads.js";
import type { UsageService } from "./usage.js";

export const DEFAULT_JOB_EVENT_RETENTION_DAYS = 90;

export interface MaintenanceReport {
  expiredJobs: number;
  waitingForCompute: number;
  settledEvals: number;
  deletedCheckpoints: number;
  deletedUploads: number;
  deletedEvents: number;
  exportedUsage: number;
  syncedSources: number;
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
    evals: EvalService;
    uploads: UploadService;
    usage: UsageService;
    sources: SourceService;
    telemetry?: TelemetrySampler;
  },
): Maintenance => {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;

  /** One step's failure (an S3 outage, say) is logged and never stops the others. */
  const step = async (name: string, fn: () => Promise<number>) => {
    const start = performance.now();
    try {
      return await fn();
    } catch (error) {
      metrics.maintenanceErrors.inc({ step: name });
      log("error", "maintenance step failed", {
        step: name,
        error: errorMessage(error),
      });
      return 0;
    } finally {
      metrics.maintenanceDuration.observe({ step: name }, secondsSince(start));
    }
  };

  const tick = async (): Promise<MaintenanceReport> => {
    const now = deps.clock.now();
    const retentionDays =
      deps.settings.jobEventRetentionDays ?? DEFAULT_JOB_EVENT_RETENTION_DAYS;

    return {
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
        services.runs.collectExpiredCheckpoints(now),
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
      exportedUsage: await step("export_usage", () =>
        services.usage.exportPending(),
      ),
      syncedSources: await step("sync_sources", () =>
        services.sources.tick(now),
      ),
      // Last: the gauges then reflect this tick's expiries and syncs.
      sampledMetrics: await step("sample_metrics", async () => {
        await services.telemetry?.refresh(deps.clock.now());
        return services.telemetry ? 1 : 0;
      }),
    };
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
              error: errorMessage(error),
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
