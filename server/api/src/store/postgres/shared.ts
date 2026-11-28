import { decodeCursor, toPage } from "../cursor.js";
import type { ListFilter, Page, PageRequest } from "../types.js";
import { Params, type Db, type Row } from "./db.js";

/**
 * Newest-first keyset page over `table` ordered by (created_at DESC,
 * id COLLATE "C" DESC), matching the cursor encoding.
 */
export const listNewest = async <T extends { created_at: string; id: string }>(
  db: Db,
  input: {
    table: string;
    /** The select list (default `*`). */
    columns?: string;
    where: string;
    params: Params;
    page: PageRequest;
    map: (row: Row) => T;
  },
): Promise<Page<T>> => {
  const { params, page } = input;
  const after = decodeCursor(page.cursor, ["time", "text"]);
  let where = input.where;
  if (after) {
    where += ` AND (created_at, id COLLATE "C") < (${params.add(after[0])}::timestamptz, ${params.add(after[1])}::text)`;
  }
  const rows = await db.query(
    `SELECT ${input.columns ?? "*"} FROM ${input.table} WHERE ${where}
     ORDER BY created_at DESC, id COLLATE "C" DESC
     LIMIT ${params.add(page.limit + 1)}`,
    params.values,
  );

  return toPage(rows.map(input.map), page.limit, (r) => [r.created_at, r.id]);
};

export const nowIso = (clock: { now(): Date }): string =>
  clock.now().toISOString();

export const first = <T>(rows: readonly T[]): T | null => rows[0] ?? null;

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, "\\$&");

/**
 * `ListFilter` as SQL conditions (each prefixed with " AND "): `status` on a
 * job's status, `q` on `nameColumn` (substring, any case) or the id, and
 * `dataset` on an import's target dataset.
 */
export const filterSql = (
  params: Params,
  filter: ListFilter | undefined,
  nameColumn = "name",
): string => {
  let sql = "";
  if (filter?.status?.length)
    sql += ` AND status = ANY(${params.add(filter.status)}::text[])`;
  if (filter?.q) {
    sql += ` AND (${nameColumn} ILIKE ${params.add(`%${likeEscape(filter.q)}%`)} OR id = ${params.add(filter.q)})`;
  }
  if (filter?.dataset)
    sql += ` AND payload->>'dataset' = ${params.add(filter.dataset)}`;

  return sql;
};
