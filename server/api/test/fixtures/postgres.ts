import { randomBytes } from "node:crypto";
import pg from "pg";
import { inject } from "vitest";

import type { Clock } from "../../src/clock.js";
import { createPostgresStore } from "../../src/store/postgres.js";
import type { Store } from "../../src/store/types.js";

/** Connection URL from the global setup, or null when Postgres is unavailable. */
export const postgresUrl = (): string | null => inject("postgresUrl");

export const postgresSkipReason = (): string | null =>
  inject("postgresSkipReason");

export const freshSchemaName = (): string =>
  `t_${randomBytes(6).toString("hex")}`;

export interface IsolatedPostgresStore {
  store: Store;
  schema: string;
  /** Closes the pool and drops the schema. */
  dispose: () => Promise<void>;
}

/** Store over a brand-new, migrated schema so tests never share state. */
export const createIsolatedPostgresStore = async (
  clock: Clock,
  url = postgresUrl(),
): Promise<IsolatedPostgresStore> => {
  if (!url) throw new Error("Postgres is not available for this test run.");
  const schema = freshSchemaName();
  const store = createPostgresStore({ connectionString: url, clock, schema });
  await store.migrate();

  return {
    store,
    schema,
    dispose: async () => {
      await store.close();
      await dropSchema(url, schema);
    },
  };
};

export const dropSchema = async (url: string, schema: string) => {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
};
