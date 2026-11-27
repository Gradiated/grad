import { describe, expect, it } from "vitest";

import { assertMigrated, runMigrations } from "../src/migrations.js";
import { loadMigrations } from "../src/store/migrate.js";
import {
  dropSchema,
  freshSchemaName,
  postgresUrl,
} from "./fixtures/postgres.js";

describe("migrate command and MIGRATE_ON_BOOT=false", () => {
  it("refuses an unmigrated database until `migrate` has run once", async () => {
    const url = postgresUrl();
    const schema = freshSchemaName();
    try {
      const versions = (await loadMigrations()).map((m) => m.version);
      await expect(assertMigrated(url, { schema })).rejects.toThrow(
        new RegExp(
          `migrations ${versions.join(", ")} are not applied.*migrate`,
        ),
      );
      expect(await runMigrations(url, { schema })).toEqual(versions);
      await expect(assertMigrated(url, { schema })).resolves.toBeUndefined();
      expect(await runMigrations(url, { schema })).toEqual([]);
    } finally {
      await dropSchema(url, schema);
    }
  });

  it("names a missing DATABASE_URL", async () => {
    await expect(runMigrations(undefined)).rejects.toThrow(/DATABASE_URL/);
    await expect(runMigrations("  ")).rejects.toThrow(/DATABASE_URL/);
  });
});
