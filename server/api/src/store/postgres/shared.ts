import { decodeCursor, toPage } from "../cursor.js";
import type { Page, PageRequest } from "../types.js";
import { Params, type Db, type Row } from "./db.js";

/**
 * Newest-first keyset page over `table` ordered by (created_at DESC,
 * id COLLATE "C" DESC), matching the cursor encoding.
 */
export const listNewest = async <T extends { created_at: string; id: string }>(
  db: Db,
  input: {
    table: string;
    where: string;
    params: Params;
    page: PageRequest;
    map: (row: Row) => T;
  },
): Promise<Page<T>> => {
  const { params, page } = input;
  const after = decodeCursor(page.cursor, 2);
  let where = input.where;
  if (after) {
    where += ` AND (created_at, id COLLATE "C") < (${params.add(after[0])}::timestamptz, ${params.add(String(after[1]))}::text)`;
  }
  const rows = await db.query(
    `SELECT * FROM ${input.table} WHERE ${where}
     ORDER BY created_at DESC, id COLLATE "C" DESC
     LIMIT ${params.add(page.limit + 1)}`,
    params.values,
  );

  return toPage(rows.map(input.map), page.limit, (r) => [r.created_at, r.id]);
};

export const nowIso = (clock: { now(): Date }): string =>
  clock.now().toISOString();

export const addSecondsIso = (at: Date, seconds: number): string =>
  new Date(at.getTime() + seconds * 1000).toISOString();

export const first = <T>(rows: readonly T[]): T | null => rows[0] ?? null;
