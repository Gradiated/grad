import { addSeconds } from "../clock.js";
import type { AppDependencies } from "../deps.js";
import { errorMessage } from "../errors.js";
import type { Repositories } from "../store/types.js";

export const usageIdempotencyKey = (runId: string, attempt: number): string =>
  `run-usage:${runId}:${attempt}`;

export interface BillingOutbox {
  /** Records an attempt's usage inside the caller's transaction. */
  enqueueUsage(
    tx: Repositories,
    input: {
      workspaceId: string;
      runId: string;
      attempt: number;
      tokens: number;
      costUsd: number;
    },
  ): Promise<void>;
  /** Sends due usage records; failures are retried with exponential backoff. */
  drain(): Promise<{ sent: number; failed: number }>;
  /** Fire-and-forget drain after a commit (coalesces concurrent calls). */
  kick(): void;
  /** Resolves once any in-flight drain has finished. */
  idle(): Promise<void>;
}

const LOCK_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 3600;

export const createBillingOutbox = (deps: AppDependencies): BillingOutbox => {
  const { store, billing, clock } = deps;
  let inflight: Promise<unknown> | null = null;

  const drain = async (): Promise<{ sent: number; failed: number }> => {
    let sent = 0;
    let failed = 0;

    for (;;) {
      const due = await store.billing.claimDue(clock.now(), 50, LOCK_SECONDS);
      if (due.length === 0) break;

      for (const entry of due) {
        try {
          await billing.recordRunUsage({
            workspaceId: entry.workspace_id,
            runId: entry.run_id,
            attempt: entry.attempt,
            tokensProcessed: entry.tokens,
            costUsd: entry.cost_usd,
            idempotencyKey: entry.idempotency_key,
          });
          await store.billing.markSent(entry.id);
          sent += 1;
        } catch (error) {
          const backoff = Math.min(
            MAX_BACKOFF_SECONDS,
            5 * 2 ** Math.max(0, entry.attempts - 1),
          );
          await store.billing.markFailed(
            entry.id,
            errorMessage(error),
            addSeconds(clock.now(), backoff),
          );
          failed += 1;
        }
      }
      if (due.length < 50) break;
    }

    return { sent, failed };
  };

  return {
    enqueueUsage: async (tx, input) => {
      if (input.tokens <= 0 && input.costUsd <= 0) return;

      await tx.billing.enqueue({
        idempotencyKey: usageIdempotencyKey(input.runId, input.attempt),
        workspaceId: input.workspaceId,
        runId: input.runId,
        attempt: input.attempt,
        tokens: input.tokens,
        costUsd: input.costUsd,
      });
    },
    drain,
    kick: () => {
      if (inflight) return;
      inflight = drain()
        .catch((error: unknown) => {
          console.error(
            JSON.stringify({
              level: "error",
              msg: "billing drain failed",
              error: errorMessage(error),
            }),
          );
        })
        .finally(() => {
          inflight = null;
        });
    },
    idle: async () => {
      await inflight;
    },
  };
};
