import {
  parseUsageBound,
  type UsageQuery,
  type UsageRecord,
  type UsageSummary,
  type UsageSummaryQuery,
} from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { invalid } from "../errors.js";
import { metrics } from "../telemetry/metrics.js";
import type { JobRow, LedgerRow, Page, Repositories } from "../store/types.js";

/** A usage row's key: the attempt and the token count it bills through. */
export const usageKey = (
  kind: LedgerRow["kind"],
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

const monthStart = (at: Date, offset = 0): Date =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + offset, 1));

const assertNonEmpty = (from: Date, to: Date): void => {
  if (from >= to) {
    throw invalid(
      "invalid_period",
      `The period is empty: from (${from.toISOString()}) must be before to (${to.toISOString()}).`,
    );
  }
};

/** `from`/`to` query bounds as `[from, to)`; validated by the query schema. */
const boundsOf = (query: {
  from?: string | undefined;
  to?: string | undefined;
}) => {
  const from = query.from ? parseUsageBound(query.from, "from") : null;
  const to = query.to ? parseUsageBound(query.to, "to") : null;
  if (from && to) assertNonEmpty(from, to);

  return { from: from ?? undefined, to: to ?? undefined };
};

/**
 * A summary's period: `to` defaults to the end of the current UTC month (or
 * of `from`'s month, if later) and `from` to the start of the month `to` ends
 * in, so no bounds is this month.
 */
export const summaryPeriod = (
  query: { from?: string | undefined; to?: string | undefined },
  now: Date,
): { from: Date; to: Date } => {
  const bounds = boundsOf(query);
  const latest = bounds.from && bounds.from > now ? bounds.from : now;
  const to = bounds.to ?? monthStart(latest, 1);
  const from = bounds.from ?? monthStart(new Date(to.getTime() - 1));
  assertNonEmpty(from, to);

  return { from, to };
};

export interface UsageService {
  /** The workspace's billed usage matching `query`, newest first. */
  list(workspaceId: string, query: UsageQuery): Promise<Page<UsageRecord>>;
  /** Totals, kinds, the top runs and evals, and groups over a period (default: this month). */
  summary(workspaceId: string, query: UsageSummaryQuery): Promise<UsageSummary>;
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
    list: (workspaceId, query) =>
      store.usage.list(
        workspaceId,
        {
          ...boundsOf(query),
          runId: query.run_id,
          evalId: query.eval_id,
          kind: query.kind,
        },
        { limit: query.limit, cursor: query.cursor },
      ),

    summary: (workspaceId, query) =>
      store.usage.summarize(
        workspaceId,
        summaryPeriod(query, clock.now()),
        query.group_by,
      ),

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
      const costUsd = Number(
        Math.max(0, total.costUsd - state.billed_cost).toFixed(8),
      );
      await tx.usage.record({
        idempotencyKey: usageKey(kind, job.id, job.attempt, total.tokens),
        workspaceId: job.workspace_id,
        kind,
        refId: job.id,
        attempt: job.attempt,
        tokensFrom: state.billed_through,
        tokensThrough: total.tokens,
        costUsd,
        priceVersion: catalog.priceVersion,
      });
      metrics.billedTokens.inc({ kind }, tokens);
      metrics.billedCost.inc({ kind }, costUsd);
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
