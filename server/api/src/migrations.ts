import pg from "pg";

import { migrate, pendingMigrations } from "./store/migrate.js";
import { postgresConnection } from "./store/postgres/tls.js";

interface MigrationOptions {
  schema?: string | undefined;
  dir?: string;
}

const withPool = async <T>(
  connectionString: string,
  fn: (pool: pg.Pool) => Promise<T>,
): Promise<T> => {
  const pool = new pg.Pool({
    ...postgresConnection(connectionString),
    max: 1,
  });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
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

  return withPool(connectionString, (pool) => migrate(pool, options));
};

/** With MIGRATE_ON_BOOT=false, refuse to serve an unmigrated database. */
export const assertMigrated = async (
  connectionString: string,
  options: MigrationOptions = {},
): Promise<void> => {
  const pending = await withPool(connectionString, (pool) =>
    pendingMigrations(pool, options),
  );
  if (pending.length > 0) {
    throw new Error(
      `MIGRATE_ON_BOOT=false but migrations ${pending.join(", ")} are not applied. Run \`node dist/main.js migrate\` (the Helm chart's migrations Job) first, or set MIGRATE_ON_BOOT=true.`,
    );
  }
};
