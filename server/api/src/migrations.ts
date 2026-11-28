import pg from "pg";

import { migrate, pendingMigrations } from "./store/migrate.js";
import { isDatabaseUnavailable } from "./store/postgres/db.js";
import { postgresConnection } from "./store/postgres/tls.js";
import { log } from "./telemetry/log.js";

interface MigrationOptions {
  schema?: string | undefined;
  dir?: string;
  /** How long to wait for an unreachable database (default DATABASE_WAIT_MS). */
  waitMs?: number;
}

/** How long `migrate` and a booting replica wait out an unreachable database. */
const DATABASE_WAIT_MS = 120_000;

/**
 * Runs `fn` on a one-connection pool. While the database is unreachable (not
 * up yet, restarting, a DNS blip) it retries for `waitMs`, so a migrations
 * Job or a booting replica rides out a short outage instead of failing the
 * rollout (a Job has few retries; a crashing pod backs off for minutes).
 */
const withPool = async <T>(
  connectionString: string,
  fn: (pool: pg.Pool) => Promise<T>,
  waitMs = DATABASE_WAIT_MS,
): Promise<T> => {
  const deadline = Date.now() + waitMs;
  for (let attempt = 1; ; attempt++) {
    const pool = new pg.Pool({
      ...postgresConnection(connectionString),
      max: 1,
    });
    pool.on("error", () => undefined);
    try {
      return await fn(pool);
    } catch (error) {
      if (!isDatabaseUnavailable(error) || Date.now() >= deadline) throw error;
      log("warn", "database unavailable, retrying", { attempt, error });
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(500 * attempt, 5_000)),
      );
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
};

/**
 * `node dist/main.js migrate`: apply pending migrations and exit. Helm runs it
 * as a pre-install/pre-upgrade Job, and the API replicas start with
 * MIGRATE_ON_BOOT=false. It needs only DATABASE_URL.
 */
export const runMigrations = async (
  connectionString: string | undefined,
  options: MigrationOptions = {},
): Promise<string[]> => {
  if (!connectionString?.trim()) {
    throw new Error("DATABASE_URL is required (a Postgres connection string)");
  }

  return withPool(
    connectionString,
    (pool) => migrate(pool, options),
    options.waitMs,
  );
};

/** With MIGRATE_ON_BOOT=false, refuse to serve an unmigrated database. */
export const assertMigrated = async (
  connectionString: string,
  options: MigrationOptions = {},
): Promise<void> => {
  const pending = await withPool(
    connectionString,
    (pool) => pendingMigrations(pool, options),
    options.waitMs,
  );
  if (pending.length > 0) {
    throw new Error(
      `MIGRATE_ON_BOOT=false but migrations ${pending.join(", ")} are not applied. Run \`node dist/main.js migrate\` (the Helm chart's migrations Job) first, or set MIGRATE_ON_BOOT=true.`,
    );
  }
};
