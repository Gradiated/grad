import type { Clock } from "../../clock.js";
import type { UsageGroupBy, UsageSummary } from "../../contracts.js";
import { decodeCursor, toPage } from "../cursor.js";
import type { UsageRepository } from "../types.js";
import { Params, type Db } from "./db.js";
import { n as num, toLedgerRow, toUsage } from "./mappers.js";
import { first, nowIso } from "./shared.js";

/**
 * Ledger rows with what they paid for: the kind (a run's training, an eval,
 * dataset scoring, or a run's labeling or teacher eval), the ref's name, the
 * run billed (the run itself, or the run whose labeling, teacher or
 * checkpoint eval it is), the model and the recipe. `where` filters
 * grad_usage (alias u) before the joins.
 */
const usageRows = (where: string) => `
  SELECT u.*,
    CASE WHEN u.kind = 'run' THEN 'training'
         WHEN e.mode = 'score' THEN 'scoring'
         WHEN lr.recipe_kind = 'distill' THEN 'teacher'
         WHEN lr.id IS NOT NULL THEN 'labeling'
         ELSE 'eval' END AS usage_kind,
    COALESCE(r.name, e.name) AS ref_name,
    COALESCE(r.id, lr.id, e.run_id) AS run_id,
    COALESCE(r.resolved_config->>'model', em.models) AS model,
    COALESCE(r.recipe_kind, lr.recipe_kind, cr.recipe_kind) AS recipe
  FROM grad_usage u
  LEFT JOIN grad_runs r ON u.kind = 'run' AND r.id = u.ref_id
  LEFT JOIN grad_evals e ON u.kind = 'eval' AND e.id = u.ref_id
  LEFT JOIN grad_runs cr ON cr.id = e.run_id
  LEFT JOIN LATERAL (
    SELECT x.id, x.recipe_kind FROM grad_runs x
    WHERE u.kind = 'eval' AND x.resolved_config->>'label_eval_id' = u.ref_id
    LIMIT 1
  ) lr ON true
  LEFT JOIN LATERAL (
    SELECT string_agg(m, ', ' ORDER BY m) AS models
    FROM jsonb_array_elements_text(e.models) m
  ) em ON true
  WHERE ${where}`;

/** Exact sums: costs add as numeric, once, here. */
const SUMS = `COALESCE(SUM(tokens), 0)::bigint AS tokens,
  ROUND(COALESCE(SUM(cost_usd::numeric), 0), 8) AS cost_usd,
  COUNT(*)::int AS records`;

/** Group keys in UTC, whatever the session time zone. */
const GROUP_KEYS: Record<UsageGroupBy, string> = {
  day: `to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
  week: `to_char(date_trunc('week', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')`,
  month: `to_char(date_trunc('month', created_at AT TIME ZONE 'UTC'), 'YYYY-MM')`,
  model: "model",
  recipe: "recipe",
  kind: "usage_kind",
};

const TIME_GROUPS: ReadonlySet<UsageGroupBy> = new Set([
  "day",
  "week",
  "month",
]);

/** The five costliest refs in `u` matching `where`, as JSON. */
const topRefs = (where: string) => `(
  SELECT COALESCE(json_agg(t ORDER BY t.cost_usd DESC, t.id), '[]'::json) FROM (
    SELECT ref_id AS id, ref_name AS name, usage_kind AS kind, ${SUMS}
    FROM u WHERE ${where} GROUP BY ref_id, ref_name, usage_kind
    ORDER BY cost_usd DESC, ref_id LIMIT 5
  ) t)`;

interface SumRow {
  tokens: unknown;
  cost_usd: unknown;
  records: unknown;
}

const sums = (r: SumRow) => ({
  cost_usd: num(r.cost_usd),
  tokens: num(r.tokens),
  records: num(r.records),
});

export const createUsageRepository = (
  db: Db,
  clock: Clock,
): UsageRepository => ({
  record: async (input) => {
    const inserted = first(
      await db.query(
        `INSERT INTO grad_usage
           (idempotency_key, workspace_id, kind, ref_id, attempt, tokens_from, tokens_through,
            tokens, cost_usd, price_version, created_at, amount_nano_usd, sku, billed_by)
         VALUES ($1, $2, $3, $4, $5, $6::bigint, $7::bigint, $7::bigint - $6::bigint, $8, $9,
                 $10::timestamptz, $11::bigint, $12, $13)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
        [
          input.idempotencyKey,
          input.workspaceId,
          input.kind,
          input.refId,
          input.attempt,
          input.tokensFrom,
          input.tokensThrough,
          input.costUsd,
          input.priceVersion,
          nowIso(clock),
          input.amountNanoUsd ?? Math.round(input.costUsd * 1e9),
          input.sku ?? null,
          input.billedBy ?? "grad",
        ],
      ),
    );
    const row =
      inserted ??
      first(
        await db.query("SELECT * FROM grad_usage WHERE idempotency_key = $1", [
          input.idempotencyKey,
        ]),
      );

    return toLedgerRow(row ?? {});
  },
  list: async (workspaceId, filter, page) => {
    const params = new Params();
    const inner = [`u.workspace_id = ${params.add(workspaceId)}`];
    const outer = ["true"];
    if (filter.from)
      inner.push(
        `u.created_at >= ${params.add(filter.from.toISOString())}::timestamptz`,
      );
    if (filter.to)
      inner.push(
        `u.created_at < ${params.add(filter.to.toISOString())}::timestamptz`,
      );
    if (filter.evalId)
      inner.push(`u.kind = 'eval' AND u.ref_id = ${params.add(filter.evalId)}`);
    if (filter.runId) {
      // The run's own rows and its evals' (checkpoint evals, its labeling or
      // teacher eval), found by ref before the joins.
      const run = params.add(filter.runId);
      inner.push(`u.ref_id IN (SELECT ${run}::text
        UNION ALL SELECT id FROM grad_evals WHERE run_id = ${run}
        UNION ALL SELECT resolved_config->>'label_eval_id' FROM grad_runs WHERE id = ${run})`);
      outer.push(`run_id = ${run}`);
    }
    if (filter.kind) outer.push(`usage_kind = ${params.add(filter.kind)}`);
    const after = decodeCursor(page.cursor, 1);
    if (after) inner.push(`u.seq < ${params.add(Number(after[0]))}::bigint`);

    const rows = await db.query(
      `SELECT * FROM (${usageRows(inner.join(" AND "))}) b
       WHERE ${outer.join(" AND ")}
       ORDER BY seq DESC LIMIT ${params.add(page.limit + 1)}`,
      params.values,
    );

    const page_ = toPage(
      rows.map((r) => ({ record: toUsage(r), seq: Number(r.seq) })),
      page.limit,
      (r) => [r.seq],
    );

    return {
      data: page_.data.map((r) => r.record),
      next_cursor: page_.next_cursor,
    };
  },
  summarize: async (workspaceId, period, groupBy) => {
    const group = groupBy
      ? `(SELECT COALESCE(json_agg(g ORDER BY ${
          TIME_GROUPS.has(groupBy)
            ? "g.key"
            : "g.cost_usd DESC, g.key NULLS LAST"
        }), '[]'::json) FROM (
          SELECT ${GROUP_KEYS[groupBy]} AS key, ${SUMS} FROM u GROUP BY 1
        ) g)`
      : `'[]'::json`;
    const row = first(
      await db.query(
        `WITH u AS (${usageRows(
          "u.workspace_id = $1 AND u.created_at >= $2::timestamptz AND u.created_at < $3::timestamptz",
        )})
         SELECT
           (SELECT row_to_json(t) FROM (SELECT ${SUMS} FROM u) t) AS total,
           (SELECT COALESCE(json_agg(k ORDER BY k.cost_usd DESC, k.kind), '[]'::json) FROM (
              SELECT usage_kind AS kind, ${SUMS} FROM u GROUP BY usage_kind
           ) k) AS by_kind,
           ${topRefs("usage_kind = 'training'")} AS top_runs,
           ${topRefs("usage_kind <> 'training'")} AS top_evals,
           ${group} AS groups`,
        [workspaceId, period.from.toISOString(), period.to.toISOString()],
      ),
    );
    type Ref = SumRow & { id: string; name: string | null; kind: string };
    const refs = (v: unknown) =>
      ((v ?? []) as Ref[]).map((r) => ({
        id: r.id,
        name: r.name,
        kind: r.kind,
        cost_usd: num(r.cost_usd),
        tokens: num(r.tokens),
      }));

    return {
      from: period.from.toISOString(),
      to: period.to.toISOString(),
      ...sums((row?.total ?? {}) as SumRow),
      by_kind: ((row?.by_kind ?? []) as Array<SumRow & { kind: string }>).map(
        (k) => ({ kind: k.kind, ...sums(k) }),
      ),
      top_runs: refs(row?.top_runs),
      top_evals: refs(row?.top_evals),
      group_by: groupBy ?? null,
      groups: (
        (row?.groups ?? []) as Array<SumRow & { key: string | null }>
      ).map((g) => ({ key: g.key, ...sums(g) })),
    } as UsageSummary;
  },
  exportBatch: (limit, push) =>
    db.atomic(async () => {
      await db.query(
        `INSERT INTO grad_usage_export (name, txid, seq) VALUES ('cloud', '0', 0)
         ON CONFLICT (name) DO NOTHING`,
      );
      const cursor = first(
        await db.query(
          `SELECT txid::text AS txid, seq FROM grad_usage_export
            WHERE name = 'cloud' FOR UPDATE SKIP LOCKED`,
        ),
      );
      if (!cursor) return null;
      // Only transactions older than every open one: a slow commit with a
      // lower seq is read later, never skipped.
      const rows = await db.query(
        `SELECT u.seq, u.txid::text AS txid, u.idempotency_key, u.workspace_id, u.kind,
                u.ref_id, u.attempt, u.tokens, u.amount_nano_usd, u.sku, u.price_version,
                u.created_at, r.recipe_kind
           FROM grad_usage u LEFT JOIN grad_runs r ON u.kind = 'run' AND r.id = u.ref_id
          WHERE u.billed_by = 'grad'
            AND (u.txid, u.seq) > ($1::xid8, $2::bigint)
            AND u.txid < pg_snapshot_xmin(pg_current_snapshot())
          ORDER BY u.txid, u.seq LIMIT $3`,
        [cursor.txid, cursor.seq, limit],
      );
      if (rows.length === 0) return 0;
      const parked = await push(
        rows.map((r) => ({
          seq: Number(r.seq),
          idempotency_key: String(r.idempotency_key),
          workspace_id: String(r.workspace_id),
          kind: r.kind === "eval" ? "eval" : "run",
          ref_id: String(r.ref_id),
          attempt: Number(r.attempt),
          tokens: Number(r.tokens),
          amount_nano_usd: Number(r.amount_nano_usd),
          sku: r.sku === null ? null : String(r.sku),
          price_version: String(r.price_version),
          recipe_kind: r.recipe_kind === null ? null : String(r.recipe_kind),
          created_at: new Date(r.created_at as string).toISOString(),
        })),
      );
      if (parked.length > 0) {
        await db.query(
          `UPDATE grad_usage u SET parked_code = p.code, parked_at = $3::timestamptz
             FROM unnest($1::bigint[], $2::text[]) AS p(seq, code)
            WHERE u.seq = p.seq`,
          [parked.map((r) => r.seq), parked.map((r) => r.code), nowIso(clock)],
        );
      }
      const last = rows.at(-1) as { txid: string; seq: unknown };
      await db.query(
        `UPDATE grad_usage_export SET txid = $1::xid8, seq = $2::bigint, updated_at = now()
          WHERE name = 'cloud'`,
        [last.txid, last.seq],
      );

      return rows.length;
    }),
  exportBacklog: async () => {
    const row = first(
      await db.query(
        `SELECT COUNT(*)::int AS rows, MIN(u.created_at) AS oldest,
                (SELECT COUNT(*)::int FROM grad_usage WHERE parked_at IS NOT NULL) AS parked
           FROM grad_usage u
           LEFT JOIN grad_usage_export c ON c.name = 'cloud'
          WHERE u.billed_by = 'grad'
            AND (u.txid, u.seq) > (COALESCE(c.txid, '0'::xid8), COALESCE(c.seq, 0))`,
      ),
    );

    return {
      rows: Number(row?.rows ?? 0),
      oldest: row?.oldest ? new Date(row.oldest as string) : null,
      parked: Number(row?.parked ?? 0),
    };
  },
  listByRef: async (refId) =>
    (
      await db.query(
        "SELECT * FROM grad_usage WHERE ref_id = $1 ORDER BY seq",
        [refId],
      )
    ).map(toLedgerRow),
});
