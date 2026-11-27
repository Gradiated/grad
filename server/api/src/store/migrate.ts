import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

/** Arbitrary constant shared by every replica: serializes concurrent boots. */
export const MIGRATION_LOCK_KEY = 7_241_903_118;

const MIGRATION_FILE_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** `server/api/migrations`, from both `src/store` (tsx) and `dist/store`. */
export const defaultMigrationsDir = (): string =>
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../migrations",
  );

export interface MigrationFile {
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

const applyPending = async (
  client: PoolClient,
  migrations: readonly MigrationFile[],
  schema: string | undefined,
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

    await client.query("BEGIN");
    try {
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO grad_schema_migrations (version, name) VALUES ($1, $2)",
        [migration.version, migration.name],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(
        `Migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    ran.push(migration.version);
  }

  return ran;
};

/**
 * Applies pending migrations in order, each in its own transaction, under a
 * session advisory lock so concurrently booting replicas never race. Re-running
 * is a no-op. Returns the versions applied by this call.
 */
export const migrate = async (
  pool: Pool,
  options: { schema?: string | undefined; dir?: string } = {},
): Promise<string[]> => {
  const migrations = await loadMigrations(options.dir);
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      return await applyPending(client, migrations, options.schema);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
      if (options.schema) await client.query("RESET search_path");
    }
  } finally {
    client.release();
  }
};
