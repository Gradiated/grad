import type { AppDependencies } from "../deps.js";
import { errorMessage } from "../errors.js";
import type { BillingOutbox } from "./billing-outbox.js";
import type { EvalService } from "./evals/service.js";
import type { ImportService } from "./imports.js";
import type { RunLifecycle } from "./runs.js";
import type { UploadService } from "./uploads.js";

export interface MaintenanceReport {
  expiredRuns: number;
  expiredImports: number;
  recoveredEvals: number;
  deletedCheckpoints: number;
  deletedUploads: number;
  billingSent: number;
  billingFailed: number;
}

export interface Maintenance {
  /** One pass: lease expiry, TTL garbage collection, billing outbox. */
  tick(): Promise<MaintenanceReport>;
  start(intervalMs: number): void;
  stop(): Promise<void>;
}

export const createMaintenance = (
  deps: AppDependencies,
  services: {
    runs: RunLifecycle;
    imports: ImportService;
    billing: BillingOutbox;
    evals: EvalService;
    uploads: UploadService;
  },
): Maintenance => {
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<unknown> | null = null;

  const tick = async (): Promise<MaintenanceReport> => {
    const now = deps.clock.now();
    const expiredRuns = await services.runs.expireLeases(now);
    const expiredImports = await services.imports.expireLeases(now);
    const recoveredEvals = await services.evals.recoverExpired(now);
    const deletedCheckpoints =
      await services.runs.collectExpiredCheckpoints(now);
    const deletedUploads = await services.uploads.collectExpired(now);
    const billing = await services.billing.drain();

    return {
      expiredRuns,
      expiredImports,
      recoveredEvals,
      deletedCheckpoints,
      deletedUploads,
      billingSent: billing.sent,
      billingFailed: billing.failed,
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
            console.error(
              JSON.stringify({
                level: "error",
                msg: "maintenance tick failed",
                error: errorMessage(error),
              }),
            );
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
