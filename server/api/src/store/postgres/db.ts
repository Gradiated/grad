import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";

import { metrics, secondsSince } from "../../telemetry/metrics.js";
import { SpanKind, withSpan } from "../../telemetry/tracing.js";

export type Row = Record<string, unknown>;

/**
 * Query executor bound to a pool. Inside `atomic`, every query (including
 * queries issued through the top-level repositories) runs on the ambient
 * transaction's client; a nested `atomic` joins it under a savepoint, so an
 * inner failure rolls back only the inner block.
 */
export interface Db {
  query<R extends Row = Row>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<R[]>;
  atomic<T>(fn: () => Promise<T>): Promise<T>;
}

export const createDb = (pool: Pool): Db => {
  const ambient = new AsyncLocalStorage<PoolClient>();
  let savepoints = 0;

  return {
    query: async <R extends Row = Row>(
      sql: string,
      params: readonly unknown[] = [],
    ) => {
      const client = ambient.getStore();
      const start = performance.now();
      try {
        const result = await withSpan(
          "db.query",
          {
            "db.system.name": "postgresql",
            "db.query.text": sql.length > 2000 ? sql.slice(0, 2000) : sql,
          },
          () => (client ?? pool).query(sql, params as unknown[]),
          { kind: SpanKind.CLIENT },
        );

        return result.rows as R[];
      } catch (error) {
        metrics.dbQueryErrors.inc();
        throw error;
      } finally {
        metrics.dbQueryDuration.observe(secondsSince(start));
      }
    },
    atomic: async (fn) => {
      const outer = ambient.getStore();
      if (outer) {
        // Nested: join the outer transaction, but roll back only this block on error.
        savepoints += 1;
        const name = `grad_sp_${savepoints}`;
        await outer.query(`SAVEPOINT ${name}`);
        try {
          const value = await fn();
          await outer.query(`RELEASE SAVEPOINT ${name}`);

          return value;
        } catch (error) {
          await outer
            .query(`ROLLBACK TO SAVEPOINT ${name}`)
            .catch(() => undefined);
          throw error;
        }
      }

      const client = await pool.connect();
      // A client whose ROLLBACK failed (its connection died or timed out) is
      // destroyed, never handed to the next transaction.
      let broken: Error | undefined;
      try {
        await client.query("BEGIN");
        const value = await ambient.run(client, fn);
        await client.query("COMMIT");

        return value;
      } catch (error) {
        await client.query("ROLLBACK").catch((rollback: unknown) => {
          broken =
            rollback instanceof Error ? rollback : new Error(String(rollback));
        });
        throw error;
      } finally {
        client.release(broken);
      }
    },
  };
};

const UNAVAILABLE_ERRNO = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EPIPE",
  "EHOSTUNREACH",
]);

/**
 * True when an error means the database is unreachable or overloaded right
 * now (retry shortly), not that the request is wrong: connection failures,
 * SQLSTATE class 08, admin shutdown / cannot connect now (57P0x), too many
 * connections (53300), statement timeout (57014) and pool or connection
 * timeouts.
 */
export const isDatabaseUnavailable = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    if (UNAVAILABLE_ERRNO.has(code)) return true;
    if (code.startsWith("08") || code.startsWith("57P")) return true;
    if (code === "53300" || code === "57014") return true;
  }

  return /timeout exceeded when trying to connect|Connection terminated|connection error and is not queryable|Query read timeout/i.test(
    error.message,
  );
};

/** Placeholder allocator for building parameterized SQL. */
export class Params {
  readonly values: unknown[] = [];

  add = (value: unknown): string => {
    this.values.push(value);
    return `$${this.values.length}`;
  };
}

const COLUMN_RE = /^[a-z_]+$/;

export interface ColumnTypes {
  json: ReadonlySet<string>;
  timestamps: ReadonlySet<string>;
}

/** `SET` clause for a patch object whose keys are column names. */
export const setClause = (
  patch: Readonly<Record<string, unknown>>,
  types: ColumnTypes,
  params: Params,
): string[] =>
  Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([column, value]) => {
      if (!COLUMN_RE.test(column)) {
        throw new Error(`Invalid column '${column}'.`);
      }
      if (types.json.has(column)) {
        return `${column} = ${params.add(jsonParam(value))}::jsonb`;
      }
      if (types.timestamps.has(column)) {
        return `${column} = ${params.add(value)}::timestamptz`;
      }

      return `${column} = ${params.add(value)}`;
    });

/** Conditions for `JobExpectation` (status / worker / attempt CAS). */
export const expectClause = (
  expect:
    | {
        status?: readonly string[];
        workerId?: string | null;
        attempt?: number;
        leaseExpiredBefore?: string;
      }
    | undefined,
  params: Params,
): string => {
  if (!expect) return "";
  const parts: string[] = [];
  if (expect.status) {
    parts.push(`status = ANY(${params.add([...expect.status])}::text[])`);
  }
  if (expect.workerId !== undefined) {
    parts.push(
      `worker_id IS NOT DISTINCT FROM ${params.add(expect.workerId)}::text`,
    );
  }
  if (expect.attempt !== undefined) {
    parts.push(`attempt = ${params.add(expect.attempt)}`);
  }
  if (expect.leaseExpiredBefore !== undefined) {
    parts.push(
      `lease_expires_at < ${params.add(expect.leaseExpiredBefore)}::timestamptz`,
    );
  }

  return parts.map((p) => ` AND ${p}`).join("");
};

export const jsonParam = (value: unknown): string | null =>
  value === undefined || value === null ? null : JSON.stringify(value);
