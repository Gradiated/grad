import { createHash } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";

import { assertMigrated, runMigrations } from "../src/migrations.js";
import { defaultMigrationsDir, loadMigrations } from "../src/store/migrate.js";
import {
  dropSchema,
  freshSchemaName,
  postgresUrl,
} from "./fixtures/postgres.js";

/**
 * Migrations a release has shipped. A database records a version as applied
 * and never reads its file again, so editing a shipped migration silently
 * skips the edit on every database it already ran on (0001 lost two usage
 * indexes that way between alpha.3 and alpha.4). Change the schema with a new
 * migration; add each one here once a release carries it.
 */
const RELEASED: Record<string, string> = {
  // v0.2.0-alpha.2 and alpha.3 (alpha.1 shipped an earlier 0001).
  "0001_initial.sql":
    "22b2e35357b26157566a0c54f5198eb24e32a58eee5b2ac996173563e9040bf2",
  // v0.2.0-alpha.4.
  "0002_dedupe_and_blob_keys.sql":
    "4eb896cf17d4e2c60d7d1e6225fe2462afe56dc350f3de25f9b95d2379976069",
  "0003_source_limits_and_versions.sql":
    "6a8a89da345d34758e2a5971f3bc62bc7489f863d458c68be74782cd6625d759",
  "0004_job_event_notify.sql":
    "e4857099cfb4a2d05cb782480cc5c37f672eb20357c37b98163dc812c90671ad",
  "0005_fair_queue.sql":
    "8f6bbbd53b0cfbd9f2751023e0ab45c6c2800af5b79d17773c77ea6064aef39e",
  "0006_artifact_registry.sql":
    "d240ddd1642ca20eb340711358192559ffc957f6a236aed67fabeff4a81f6836",
  "0007_worker_tokens.sql":
    "a2786c4dc81e59ad95521be763b783b60af9ad13dbaa613f797fd2ebb420137e",
  "0008_cloud.sql":
    "23f717da8100e130a973ce07da0a7b44d825c2ea8c94ea454804dc4a305e7a36",
  "0009_usage_report_indexes.sql":
    "621b49ed31a976991848a9ecd3c26579a3869bb8d7ece0cf03fcf42b737699a5",
  // v0.2.0-alpha.5.
  "0010_usage_parked.sql":
    "46632b8b53b1b84cb8a5fca48085b1b22c45faaafa531a1996cd1f4d8b1277d7",
};

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** A migrations directory holding only `names` (an older release's set). */
const subsetDir = async (names: string[]): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "grad-migrations-"));
  for (const name of names) {
    await copyFile(
      path.join(defaultMigrationsDir(), name),
      path.join(dir, name),
    );
  }
  return dir;
};

/** Tables, columns, constraints, indexes, triggers and functions of `schema`. */
const describeSchema = async (
  client: pg.Client,
  schema: string,
): Promise<string[]> => {
  const q = async (sql: string) =>
    (await client.query<{ d: string }>(sql, [schema])).rows.map((r) =>
      r.d.replaceAll(`"${schema}".`, "").replaceAll(`${schema}.`, ""),
    );
  const queries = [
    `SELECT format('column %s.%s %s %s %s', table_name, column_name, data_type,
              is_nullable, coalesce(column_default, '')) AS d
         FROM information_schema.columns WHERE table_schema = $1`,
    `SELECT format('constraint %s %s %s', conrelid::regclass::text, conname,
              pg_get_constraintdef(oid)) AS d
         FROM pg_constraint WHERE connamespace = $1::regnamespace`,
    `SELECT format('index %s', indexdef) AS d FROM pg_indexes WHERE schemaname = $1`,
    `SELECT format('trigger %s', pg_get_triggerdef(t.oid)) AS d
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relnamespace = $1::regnamespace AND NOT t.tgisinternal`,
    `SELECT format('function %s %s', proname, md5(prosrc)) AS d
         FROM pg_proc WHERE pronamespace = $1::regnamespace`,
  ];
  // One client runs one query at a time.
  const out: string[] = [];
  for (const sql of queries) out.push(...(await q(sql)));
  return out.sort();
};

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

  it("waits out a database that is not reachable yet, then gives up", async () => {
    const real = new URL(postgresUrl());
    const free = createServer();
    await new Promise<void>((resolve) => free.listen(0, "127.0.0.1", resolve));
    const { port } = free.address() as AddressInfo;
    await new Promise((resolve) => free.close(resolve));
    const late = new URL(real);
    late.hostname = "127.0.0.1";
    late.port = String(port);

    // Nothing listens: refused until the deadline, then the error surfaces.
    const started = Date.now();
    await expect(
      runMigrations(late.toString(), {
        schema: freshSchemaName(),
        waitMs: 800,
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(800);

    // The database comes up 1 s into the wait (a forwarder to the real one).
    const schema = freshSchemaName();
    const forwarder = createServer((client) => {
      const upstream = connect(Number(real.port), real.hostname);
      client.pipe(upstream).pipe(client);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });
    const opened = setTimeout(() => forwarder.listen(port, "127.0.0.1"), 1_000);
    try {
      const versions = (await loadMigrations()).map((m) => m.version);
      expect(
        await runMigrations(late.toString(), { schema, waitMs: 20_000 }),
      ).toEqual(versions);
    } finally {
      clearTimeout(opened);
      await new Promise((resolve) => forwarder.close(resolve));
      await dropSchema(postgresUrl(), schema);
    }
  });

  it("names a missing DATABASE_URL", async () => {
    await expect(runMigrations(undefined)).rejects.toThrow(/DATABASE_URL/);
    await expect(runMigrations("  ")).rejects.toThrow(/DATABASE_URL/);
  });
});

describe("migration files", () => {
  it("are numbered 0001, 0002, ... with no gap or duplicate", async () => {
    const versions = (await loadMigrations()).map((m) => m.version);
    expect(versions).toEqual(
      versions.map((_, i) => String(i + 1).padStart(4, "0")),
    );
  });

  it("never change once a release has shipped them", async () => {
    const files = new Map((await loadMigrations()).map((m) => [m.name, m.sql]));
    for (const [name, digest] of Object.entries(RELEASED)) {
      expect(files.has(name), `${name} was renamed or removed`).toBe(true);
      expect(
        sha256(files.get(name) ?? ""),
        `${name} shipped in a release; add a new migration instead of editing it`,
      ).toBe(digest);
    }
  });

  it("an unreleased migration only expands the schema, unless a line says why a contract step is safe", async () => {
    // The migrations Job runs before the rollout, so the previous release
    // keeps serving on the new schema until its pods are replaced (and is
    // what a rollback runs). Dropping or renaming what it reads breaks it;
    // rewriting or scanning a big table under ACCESS EXCLUSIVE stalls every
    // replica. Do those in a later release, or mark the line `-- contract: why`.
    const UNSAFE = [
      /\bDROP\s+(TABLE|COLUMN)\b/i,
      /\bRENAME\b/i,
      /\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i,
      /\bSET\s+NOT\s+NULL\b/i,
    ];
    for (const m of await loadMigrations()) {
      if (m.name in RELEASED) continue;
      for (const line of m.sql.split("\n")) {
        const code = line.replace(/--.*$/, "");
        const unsafe = UNSAFE.find((re) => re.test(code));
        expect(
          unsafe && !/--\s*contract:\s*\S/.test(line) ? line.trim() : null,
          `${m.name}: a contract step (${String(unsafe)}) breaks the release still serving during the upgrade`,
        ).toBeNull();
      }
    }
  });

  it("upgrade an alpha.3 (0001), 0001-0005 or alpha.4 (0001-0009) database to the schema a fresh one gets", async () => {
    const url = postgresUrl();
    const all = (await loadMigrations()).map((m) => m.name);
    const fresh = freshSchemaName();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const cleanup: string[] = [fresh];
    try {
      await runMigrations(url, { schema: fresh });
      const want = await describeSchema(client, fresh);
      expect(want.length).toBeGreaterThan(200);

      for (const upTo of ["0001", "0005", "0009"]) {
        const schema = freshSchemaName();
        cleanup.push(schema);
        const dir = await subsetDir(all.filter((n) => n.slice(0, 4) <= upTo));
        try {
          await runMigrations(url, { schema, dir });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
        // Rows the later migrations rewrite: duplicate pushed parts (0002
        // keeps the oldest's push key) and a billed usage row (0008 prices
        // it in nano-USD).
        await client.query(`SET search_path TO "${schema}"`);
        await client.query(
          `INSERT INTO grad_datasets (id, workspace_id, name, created_at, updated_at)
           VALUES ('ds_1', 'ws', 'support', now(), now())`,
        );
        if (upTo === "0001") {
          await client.query(
            `INSERT INTO grad_dataset_parts (dataset_id, version, count, sha256, created_at)
             VALUES ('ds_1', 1, 2, 'abc', now()), ('ds_1', 2, 2, 'abc', now())`,
          );
        }
        // alpha.4 (0008 on) writes nano-USD itself.
        await client.query(
          upTo < "0008"
            ? `INSERT INTO grad_usage (idempotency_key, workspace_id, kind, ref_id, attempt,
                 tokens_from, tokens_through, tokens, cost_usd, price_version, created_at)
               VALUES ('run-usage:run_1:1:10', 'ws', 'run', 'run_1', 1, 0, 10, 10, 0.25, 'v1', now())`
            : `INSERT INTO grad_usage (idempotency_key, workspace_id, kind, ref_id, attempt,
                 tokens_from, tokens_through, tokens, cost_usd, amount_nano_usd, price_version, created_at)
               VALUES ('run-usage:run_1:1:10', 'ws', 'run', 'run_1', 1, 0, 10, 10, 0.25, 250000000, 'v1', now())`,
        );
        await client.query("RESET search_path");

        const applied = await runMigrations(url, { schema });
        expect(applied).toEqual(
          all.map((n) => n.slice(0, 4)).filter((v) => v > upTo),
        );
        expect(await describeSchema(client, schema)).toEqual(want);

        await client.query(`SET search_path TO "${schema}"`);
        const usage = await client.query(
          "SELECT amount_nano_usd::text AS nano, billed_by, parked_code, parked_at FROM grad_usage",
        );
        // 0010: existing rows are not parked.
        expect(usage.rows).toEqual([
          {
            nano: "250000000",
            billed_by: "grad",
            parked_code: null,
            parked_at: null,
          },
        ]);
        if (upTo === "0001") {
          const parts = await client.query(
            "SELECT version, push_sha256 FROM grad_dataset_parts ORDER BY id",
          );
          expect(parts.rows).toEqual([
            { version: 1, push_sha256: "abc" },
            { version: 2, push_sha256: null },
          ]);
        }
        await client.query("RESET search_path");
      }
    } finally {
      await client.query("RESET search_path").catch(() => undefined);
      await client.end();
      for (const schema of cleanup) await dropSchema(url, schema);
    }
  });
});
