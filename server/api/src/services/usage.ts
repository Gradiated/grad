import {
  parseUsageBound,
  type UsageQuery,
  type UsageRecord,
  type UsageSummary,
  type UsageSummaryQuery,
} from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { invalid } from "../errors.js";
import { UsageRefusedError, type UsageEvent } from "../adapters.js";
import { log } from "../telemetry/log.js";
import { metrics } from "../telemetry/metrics.js";
import type {
  ExportableUsage,
  JobRow,
  LedgerRow,
  Page,
  ParkedUsage,
} from "../store/types.js";

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

/** Billing ingest takes at most 500 events per request. */
const EXPORT_BATCH = 500;
/** Batches per tick: a backlog drains at 10k rows per tick. */
const EXPORT_BATCHES_PER_TICK = 20;
/** After a failed push: retry in 15 s, doubling up to 5 min. */
const EXPORT_BACKOFF_MS = 15_000;
const EXPORT_BACKOFF_MAX_MS = 300_000;
/**
 * One-row refusals naming no event_id a tick narrows before it gives up:
 * past that, billing is refusing the envelope (a contract break), not rows,
 * so the push backs off and retries instead of parking every row.
 */
export const MAX_UNNAMED_REFUSALS = 20;

/** Billing refused more than MAX_UNNAMED_REFUSALS single rows without naming one. */
class UnnamedRefusalsError extends Error {}

/** nano-USD for `tokens` at `nanoPerMtok`, rounded half up (billing recomputes it the same way). */
export const amountNanoUsd = (tokens: number, nanoPerMtok: number): number =>
  Number((BigInt(tokens) * BigInt(nanoPerMtok) + 500_000n) / 1_000_000n);

/** The usage event billing ingests for a ledger row (`event_id` = its key). */
export const usageEventOf = (row: ExportableUsage): UsageEvent => ({
  event_id: `training:${row.idempotency_key}`,
  workspace_id: row.workspace_id,
  product: "training",
  sku: row.sku ?? `${row.kind}:unknown`,
  quantity: row.tokens,
  amount_nano_usd: row.amount_nano_usd,
  price_version: row.price_version,
  occurred_at: row.created_at,
  subject_id: row.ref_id,
  tags: {
    attempt: String(row.attempt),
    ...(row.recipe_kind ? { recipe_kind: row.recipe_kind } : {}),
  },
});

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
    job: Pick<JobRow, "id" | "kind" | "workspace_id" | "attempt">,
    total: AttemptUsage,
    final: boolean,
  ): Promise<void>;
  /**
   * Cloud: pushes new ledger rows to billing in batches (idempotent by
   * event_id), from whichever replica holds the cursor; returns how many
   * billing took. A failed push backs off and keeps the rows (training goes
   * on); a row billing refuses for good (422/409) is parked instead, and the
   * rest go on.
   */
  exportPending(): Promise<number>;
}

/** An open attempt's usage so far, and what it bills at. */
export interface AttemptUsage {
  tokens: number;
  costUsd: number;
  /** Runs: the SKU and the pinned price (nano-USD per million tokens). */
  sku?: string | undefined;
  priceNanoPerMtok?: number | undefined;
  priceVersion?: string | undefined;
}

export const createUsageService = (deps: AppDependencies): UsageService => {
  const { store, clock, catalog } = deps;
  const push = deps.billing.pushUsage;
  let nextExportAt = 0;
  let exportFailures = 0;

  const reportBacklog = async () => {
    const backlog = await store.usage.exportBacklog();
    metrics.usageExportPending.set(backlog.rows);
    metrics.usageParkedRows.set(backlog.parked);
    metrics.usageExportLag.set(
      backlog.oldest
        ? Math.max(0, (clock.now().getTime() - backlog.oldest.getTime()) / 1000)
        : 0,
    );
  };

  /**
   * Pushes `rows`; returns the ones billing refused for good. A refusal that
   * names no row of the batch is narrowed down by pushing them one by one.
   */
  const pushOrPark = async (
    send: (events: UsageEvent[]) => Promise<void>,
    rows: readonly ExportableUsage[],
    tick: { unnamed: number },
  ): Promise<ParkedUsage[]> => {
    if (rows.length === 0) return [];
    try {
      await send(rows.map(usageEventOf));
      return [];
    } catch (error) {
      if (!(error instanceof UsageRefusedError)) throw error;
      if (rows.length === 1 && error.eventId === undefined) {
        tick.unnamed += 1;
        if (tick.unnamed > MAX_UNNAMED_REFUSALS) {
          throw new UnnamedRefusalsError(
            `billing refused ${tick.unnamed} single usage rows without naming an event_id (last: ${error.code}: ${error.message}); treating it as an ingest contract break, not bad rows`,
          );
        }
      }
      const refused =
        rows.length === 1
          ? rows[0]
          : rows.find((r) => usageEventOf(r).event_id === error.eventId);
      if (!refused) {
        const parked: ParkedUsage[] = [];
        for (const row of rows) {
          parked.push(...(await pushOrPark(send, [row], tick)));
        }
        return parked;
      }
      log(
        "warn",
        "billing refused a usage row; parked it, exporting the rest",
        {
          event_id: usageEventOf(refused).event_id,
          code: error.code,
          error,
        },
      );

      return [
        { seq: refused.seq, code: error.code },
        ...(await pushOrPark(
          send,
          rows.filter((r) => r !== refused),
          tick,
        )),
      ];
    }
  };

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

    flush: async (job, total, final) => {
      const state = await store.jobs.getById(job.id);
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
      const advanced = await store.jobs.advanceBilling({
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
      await store.usage.record({
        idempotencyKey: usageKey(kind, job.id, job.attempt, total.tokens),
        workspaceId: job.workspace_id,
        kind,
        refId: job.id,
        attempt: job.attempt,
        tokensFrom: state.billed_through,
        tokensThrough: total.tokens,
        costUsd,
        amountNanoUsd:
          total.priceNanoPerMtok === undefined
            ? Math.round(costUsd * 1e9)
            : amountNanoUsd(tokens, total.priceNanoPerMtok),
        priceVersion: total.priceVersion ?? catalog.priceVersion,
        sku: total.sku ?? null,
        billedBy:
          kind === "eval" && deps.billing.gatewayBillsEvals
            ? "gateway"
            : "grad",
      });
      metrics.billedTokens.inc({ kind }, tokens);
      metrics.billedCost.inc({ kind }, costUsd);
    },

    exportPending: async () => {
      if (!push) return 0;
      const now = clock.now().getTime();
      if (now < nextExportAt) {
        await reportBacklog().catch(() => undefined);
        return 0;
      }
      let sent = 0;
      const tick = { unnamed: 0 };
      try {
        for (let i = 0; i < EXPORT_BATCHES_PER_TICK; i += 1) {
          let parked = 0;
          const n = await store.usage.exportBatch(
            EXPORT_BATCH,
            async (rows) => {
              const refused = await pushOrPark(push, rows, tick);
              parked = refused.length;
              return refused;
            },
          );
          // null: another replica holds the cursor this tick.
          if (n === null) return sent;
          sent += n - parked;
          if (n < EXPORT_BATCH) break;
        }
        exportFailures = 0;
      } catch (error) {
        exportFailures += 1;
        nextExportAt =
          now +
          Math.min(
            EXPORT_BACKOFF_MAX_MS,
            EXPORT_BACKOFF_MS * 2 ** (exportFailures - 1),
          );
        metrics.usageExportFailures.inc();
        log(
          // Every row refused unnamed: an envelope or contract break.
          error instanceof UnnamedRefusalsError ? "error" : "warn",
          "usage export to Gradiated Cloud failed; rows stay in the ledger",
          {
            error,
            retry_in_s: Math.round((nextExportAt - now) / 1000),
          },
        );
      } finally {
        await reportBacklog().catch(() => undefined);
      }

      return sent;
    },
  };
};
