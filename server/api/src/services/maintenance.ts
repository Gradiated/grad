import { addSeconds } from "../clock.js";
import type { AppDependencies } from "../deps.js";
import { errorMessage } from "../errors.js";
import { IDEMPOTENCY_TTL_SECONDS } from "../idempotency.js";
import type { BillingOutbox } from "./billing-outbox.js";
import type { EvalService } from "./evals/service.js";
import type { ImportService } from "./imports.js";
import type { RunLifecycle } from "./runs.js";
import type { UploadService } from "./uploads.js";

export interface MaintenanceReport {
  expiredRuns: number;
  expiredImports: number;
  recoveredEvals: number;
  settledEvals: number;
  deletedCheckpoints: number;
  deletedUploads: number;
  deletedIdempotencyKeys: number;
  billingSent: number;
  billingFailed: number;
}

export interface Maintenance {
  /** One pass: lease expiry, TTL garbage collection (incl. idempotency keys), billing outbox. */
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

  /** One step's failure (an S3 outage, say) is logged and never stops the others. */
  const step = async (name: string, fn: () => Promise<number>) => {
    try {
      return await fn();
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          msg: "maintenance step failed",
          step: name,
          error: errorMessage(error),
        }),
      );
      return 0;
    }
  };

  const tick = async (): Promise<MaintenanceReport> => {
    const now = deps.clock.now();
    const expiredRuns = await step("expire_runs", () =>
      services.runs.expireLeases(now),
    );
    const expiredImports = await step("expire_imports", () =>
      services.imports.expireLeases(now),
    );
    const recoveredEvals = await step("recover_evals", () =>
      services.evals.recoverExpired(now),
    );
    const settledEvals = await step("settle_evals", () =>
      services.evals.settleAwaitingScores(now),
    );
    const deletedCheckpoints = await step("gc_checkpoints", () =>
      services.runs.collectExpiredCheckpoints(now),
    );
    const deletedUploads = await step("gc_uploads", () =>
      services.uploads.collectExpired(now),
    );
    const deletedIdempotencyKeys = await step("gc_idempotency_keys", () =>
      deps.store.idempotency.deleteExpired(
        addSeconds(now, -IDEMPOTENCY_TTL_SECONDS),
      ),
    );
    let billingFailed = 0;
    const billingSent = await step("billing", async () => {
      const billing = await services.billing.drain();
      billingFailed = billing.failed;
      return billing.sent;
    });

    return {
      expiredRuns,
      expiredImports,
      recoveredEvals,
      settledEvals,
      deletedCheckpoints,
      deletedUploads,
      deletedIdempotencyKeys,
      billingSent,
      billingFailed,
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
