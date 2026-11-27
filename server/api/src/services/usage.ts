import type { UsageRecord } from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import type {
  JobRow,
  Page,
  PageRequest,
  Repositories,
} from "../store/types.js";

/** A usage row's key: the attempt and the token count it bills through. */
export const usageKey = (
  kind: UsageRecord["kind"],
  refId: string,
  attempt: number,
  tokensThrough: number,
): string => `${kind}-usage:${refId}:${attempt}:${tokensThrough}`;

/** Defaults: bill an open attempt every 5 minutes or 1M tokens. */
export const DEFAULT_FLUSH_TOKENS = 1_000_000;
export const DEFAULT_FLUSH_SECONDS = 300;

/**
 * Rows younger than this are not exported yet: a transaction that allocated
 * a lower seq may still be committing, and the cursor must not skip it.
 */
export const DEFAULT_EXPORT_LAG_SECONDS = 60;
const EXPORT_BATCH = 200;

export interface UsageService {
  /** The workspace's usage ledger, newest first. */
  list(workspaceId: string, page: PageRequest): Promise<Page<UsageRecord>>;
  /**
   * Bills `total` (the open attempt's usage so far) beyond what it already
   * billed, inside the caller's transaction. Without `final`, only once the
   * unbilled part passes the token or time threshold. The billed mark moves
   * by compare-and-set, so a replayed or concurrent report adds nothing, and
   * an attempt's rows always sum to its last reported usage.
   */
  flush(
    tx: Pick<Repositories, "jobs" | "usage">,
    job: Pick<JobRow, "id" | "kind" | "workspace_id" | "attempt">,
    total: { tokens: number; costUsd: number },
    final: boolean,
  ): Promise<void>;
  /** Cloud: pushes new ledger rows to Cloud billing; returns how many. */
  exportPending(): Promise<number>;
}

export const createUsageService = (deps: AppDependencies): UsageService => {
  const { store, clock, catalog } = deps;
  const exporter = deps.billing.usageExport;
  let cursor: number | null = null;

  return {
    list: (workspaceId, page) => store.usage.list(workspaceId, page),

    flush: async (tx, job, total, final) => {
      const state = await tx.jobs.getById(job.id);
      if (!state || state.attempt !== job.attempt || job.attempt < 1) return;
      const tokens = total.tokens - state.billed_through;
      if (tokens <= 0) return;
      const now = clock.now();
      const due =
        final ||
        tokens >= (deps.settings.usageFlushTokens ?? DEFAULT_FLUSH_TOKENS) ||
        now.getTime() - Date.parse(state.billed_at ?? state.updated_at) >=
          (deps.settings.usageFlushSeconds ?? DEFAULT_FLUSH_SECONDS) * 1000;
      if (!due) return;
      const advanced = await tx.jobs.advanceBilling({
        id: job.id,
        attempt: job.attempt,
        from: state.billed_through,
        through: total.tokens,
        cost: total.costUsd,
        at: now,
      });
      if (!advanced) return;
      const kind = job.kind === "eval" ? "eval" : "run";
      await tx.usage.record({
        idempotencyKey: usageKey(kind, job.id, job.attempt, total.tokens),
        workspaceId: job.workspace_id,
        kind,
        refId: job.id,
        attempt: job.attempt,
        tokensFrom: state.billed_through,
        tokensThrough: total.tokens,
        costUsd: Number(
          Math.max(0, total.costUsd - state.billed_cost).toFixed(8),
        ),
        priceVersion: catalog.priceVersion,
      });
    },

    exportPending: async () => {
      if (!exporter) return 0;
      cursor ??= await exporter.cursor();
      const lag =
        deps.settings.usageExportLagSeconds ?? DEFAULT_EXPORT_LAG_SECONDS;
      const before = new Date(clock.now().getTime() - lag * 1000);
      let sent = 0;
      for (;;) {
        const rows = await store.usage.listAfter(cursor, before, EXPORT_BATCH);
        for (const row of rows) {
          // Keyed by the row: a re-push after a crash is a replay at Cloud.
          await exporter.push(row);
          cursor = row.seq;
          sent += 1;
        }
        if (rows.length < EXPORT_BATCH) return sent;
      }
    },
  };
};
