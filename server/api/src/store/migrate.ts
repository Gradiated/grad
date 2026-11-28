import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

/** Arbitrary constant shared by every replica: serializes concurrent boots. */
const MIGRATION_LOCK_KEY = 7_241_903_118;

const MIGRATION_FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** `server/api/migrations`, from both `src/store` (tsx) and `dist/store`. */
export const defaultMigrationsDir = (): string =>
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../migrations",
  );

interface MigrationFile {
  version: string;
  name: string;
  sql: string;
}

export const loadMigrations = async (
  dir = defaultMigrationsDir(),
): Promise<MigrationFile[]> => {
  const names = (await readdir(dir))
    .filter((n) => MIGRATION_FILE_RE.test(n))
    .sort();

  const versions = names.map((n) => n.slice(0, 4));
  const duplicate = versions.find((v, i) => versions.indexOf(v) !== i);
  if (duplicate) {
    throw new Error(
      `Two migrations share version ${duplicate} in ${dir}; renumber one so neither is skipped.`,
    );
  }

  return Promise.all(
    names.map(async (name) => ({
      version: name.slice(0, 4),
      name,
      sql: await readFile(path.join(dir, name), "utf8"),
    })),
  );
};

const quoteIdent = (ident: string): string => `"${ident.replace(/"/g, '""')}"`;

interface MigrateOptions {
  schema?: string | undefined;
  dir?: string;
  /** How long one DDL statement may wait for a table lock (default 5 s). */
  lockTimeoutMs?: number;
  /** Tries per migration when its locks time out (default 12, ~1.5 min). */
  lockAttempts?: number;
}

const LOCK_NOT_AVAILABLE = "55P03";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One migration in its own transaction. A DDL statement waiting for a table
 * lock (behind a long query of a live replica) blocks every later query on
 * that table, so it gives up after lock_timeout, rolls back and tries again.
 */
const applyOne = async (
  client: PoolClient,
  migration: MigrationFile,
  attempts: number,
): Promise<void> => {
  for (let attempt = 1; ; attempt++) {
    await client.query("BEGIN");
    try {
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO grad_schema_migrations (version, name) VALUES ($1, $2)",
        [migration.version, migration.name],
      );
      await client.query("COMMIT");
      return;
    } catch (error) {
      await client.query("ROLLBACK");
      const code = (error as { code?: unknown }).code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === LOCK_NOT_AVAILABLE && attempt < attempts) {
        await sleep(Math.min(250 * 2 ** attempt, 10_000));
        continue;
      }
      throw new Error(
        code === LOCK_NOT_AVAILABLE
          ? `Migration ${migration.name} could not take its table locks in ${attempts} tries (${message}): a long transaction holds them; find it in pg_stat_activity, then run the migration again.`
          : `Migration ${migration.name} failed: ${message}`,
      );
    }
  }
};

const applyPending = async (
  client: PoolClient,
  migrations: readonly MigrationFile[],
  schema: string | undefined,
  attempts: number,
): Promise<string[]> => {
  if (schema) {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    await client.query(`SET search_path TO ${quoteIdent(schema)}`);
  }

  await client.query(
    `CREATE TABLE IF NOT EXISTS grad_schema_migrations (
       version TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  );

  const applied = new Set(
    (
      await client.query<{ version: string }>(
        "SELECT version FROM grad_schema_migrations",
      )
    ).rows.map((r) => r.version),
  );

  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    await applyOne(client, migration, attempts);
    ran.push(migration.version);
  }

  return ran;
};

/** Versions in `dir` not yet applied to the database (all of them on a fresh one). */
export const pendingMigrations = async (
  pool: Pool,
  options: MigrateOptions = {},
): Promise<string[]> => {
  const migrations = await loadMigrations(options.dir);
  const table = options.schema
    ? `${quoteIdent(options.schema)}.grad_schema_migrations`
    : "grad_schema_migrations";
  const { rows } = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [table],
  );
  if (!rows[0]?.exists) return migrations.map((m) => m.version);
  const applied = new Set(
    (
      await pool.query<{ version: string }>(`SELECT version FROM ${table}`)
    ).rows.map((r) => r.version),
  );

  return migrations.map((m) => m.version).filter((v) => !applied.has(v));
};

/**
 * Applies pending migrations in order, each in its own transaction, under a
 * session advisory lock so concurrently booting replicas never race. Re-running
 * is a no-op. Returns the versions applied by this call.
 */
export const migrate = async (
  pool: Pool,
  options: MigrateOptions = {},
): Promise<string[]> => {
  const migrations = await loadMigrations(options.dir);
  const client = await pool.connect();
  try {
    // An API replica's pool (MIGRATE_ON_BOOT) caps statements at 30 s; a
    // migration rewriting a big table, or a replica waiting here for another
    // to finish, may take longer, and would then fail on every boot.
    await client.query(
      "SET statement_timeout = 0; SET idle_in_transaction_session_timeout = 0; SET lock_timeout = 0",
    );
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    // Only table locks time out, never the wait for another replica above.
    await client.query(
      `SET lock_timeout = ${Math.max(1, Math.trunc(options.lockTimeoutMs ?? 5_000))}`,
    );
    try {
      return await applyPending(
        client,
        migrations,
        options.schema,
        options.lockAttempts ?? 12,
      );
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
      if (options.schema) await client.query("RESET search_path");
    }
  } finally {
    await client
      .query(
        "RESET statement_timeout; RESET idle_in_transaction_session_timeout; RESET lock_timeout",
      )
      .catch(() => undefined);
    client.release();
  }
};
