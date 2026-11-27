import type { Clock } from "../../clock.js";
import { decodeCursor, toPage } from "../cursor.js";
import type { UsageRepository } from "../types.js";
import type { Db } from "./db.js";
import { toUsage } from "./mappers.js";
import { first, nowIso } from "./shared.js";

export const createUsageRepository = (
  db: Db,
  clock: Clock,
): UsageRepository => ({
  record: async (input) => {
    const inserted = first(
      await db.query(
        `INSERT INTO grad_usage
           (idempotency_key, workspace_id, kind, ref_id, attempt, tokens_from, tokens_through,
            tokens, cost_usd, price_version, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::bigint, $7::bigint, $7::bigint - $6::bigint, $8, $9, $10::timestamptz)
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

    return toUsage(row ?? {});
  },
  list: async (workspaceId, page) => {
    const after = decodeCursor(page.cursor, 1);
    const rows = await db.query(
      `SELECT * FROM grad_usage WHERE workspace_id = $1 AND ($2::bigint IS NULL OR seq < $2::bigint)
       ORDER BY seq DESC LIMIT $3`,
      [workspaceId, after ? Number(after[0]) : null, page.limit + 1],
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
  listAfter: async (afterSeq, before, limit) =>
    (
      await db.query(
        `SELECT * FROM grad_usage WHERE seq > $1 AND created_at <= $2::timestamptz
         ORDER BY seq LIMIT $3`,
        [afterSeq, before.toISOString(), limit],
      )
    ).map((r) => ({
      ...toUsage(r),
      seq: Number(r.seq),
      workspace_id: String(r.workspace_id),
    })),
  listByRef: async (refId) =>
    (
      await db.query(
        "SELECT * FROM grad_usage WHERE ref_id = $1 ORDER BY seq",
        [refId],
      )
    ).map(toUsage),
});
