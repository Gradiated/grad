import { randomBytes } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";

import type { Clock } from "../../src/clock.js";
import { migrate } from "../../src/store/migrate.js";
import { createPostgresStore } from "../../src/store/postgres/index.js";
import { toLedgerRow } from "../../src/store/postgres/mappers.js";
import type { LedgerRow, Store } from "../../src/store/types.js";

/** Connection URL from the global setup. */
export const postgresUrl = (): string => inject("postgresUrl");

export const freshSchemaName = (): string =>
  `t_${randomBytes(6).toString("hex")}`;

export const dropSchema = async (url: string, schema: string) => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
};

// vitest loads this module once per test file, so this is one schema per file.
let fileSchema: Promise<{ schema: string; truncate: string }> | null = null;

const migrateFileSchema = async () => {
  const schema = freshSchemaName();
  const pool = new pg.Pool({ connectionString: postgresUrl(), max: 1 });
  try {
    await migrate(pool, { schema });
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
        WHERE schemaname = $1 AND tablename <> 'grad_schema_migrations'`,
      [schema],
    );
    const tables = rows.map((r) => `"${schema}"."${r.tablename}"`).join(", ");
    return { schema, truncate: `TRUNCATE ${tables} RESTART IDENTITY CASCADE` };
  } finally {
    await pool.end();
  }
};

/** This test file's schema (migrated on first use). */
export const fileSchemaName = async (): Promise<string> =>
  (await (fileSchema ??= migrateFileSchema())).schema;

/** Drops this file's schema (registered as afterAll in fixtures/setup.ts). */
export const dropFileSchema = async () => {
  if (!fileSchema) return;
  const { schema } = await fileSchema;
  fileSchema = null;
  await dropSchema(postgresUrl(), schema);
};

export interface TestStore {
  store: Store;
  dispose: () => Promise<void>;
}

/** A store over this test file's schema, emptied first. */
export const createTestStore = async (clock: Clock): Promise<TestStore> => {
  fileSchema ??= migrateFileSchema();
  const { schema, truncate } = await fileSchema;
  const store = createPostgresStore({
    connectionString: postgresUrl(),
    clock,
    schema,
  });
  const client = new pg.Client({ connectionString: postgresUrl() });
  await client.connect();
  try {
    await client.query(truncate);
  } finally {
    await client.end();
  }

  return { store, dispose: () => store.close() };
};

/** Runs raw SQL in this test file's schema (what no repository does). */
export const sql = async (
  text: string,
  params: unknown[] = [],
): Promise<Array<Record<string, unknown>>> => {
  const schema = await fileSchemaName();
  const client = new pg.Client({ connectionString: postgresUrl() });
  await client.connect();
  try {
    await client.query(`SET search_path TO "${schema}"`);
    return (await client.query(text, params)).rows;
  } finally {
    await client.end();
  }
};

/** A run's or eval's usage ledger rows, oldest first. */
export const ledgerOf = async (refId: string): Promise<LedgerRow[]> =>
  (
    await sql("SELECT * FROM grad_usage WHERE ref_id = $1 ORDER BY seq", [
      refId,
    ])
  ).map(toLedgerRow);
