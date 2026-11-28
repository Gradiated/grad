import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { ManualClock } from "./fixtures/clock.js";
import { createSecretsCipher } from "../src/secrets.js";
import {
  defaultMigrationsDir,
  loadMigrations,
  migrate,
} from "../src/store/migrate.js";
import { isDatabaseUnavailable } from "../src/store/postgres/db.js";
import { S3ObjectStore } from "../src/storage/s3.js";
import { createPostgresStore } from "../src/store/postgres.js";
import type { Store } from "../src/store/types.js";
import { makeTestApp, type TestApp } from "./fixtures/app.js";
import { createSftRun, FakeWorker, sftRecords } from "./fixtures/worker.js";
import {
  dropSchema,
  fileSchemaName,
  freshSchemaName,
  postgresUrl,
  sql,
} from "./fixtures/postgres.js";
import { s3Target } from "./fixtures/s3.js";
import { startTcpProxy, type TcpProxy } from "./fixtures/tcp-proxy.js";

/**
 * Chaos round 2, server side: one dependency (Postgres, S3) or one replica
 * misbehaves, and the API must neither hang nor double-apply anything.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Settles `p` or reports "hung" after `ms`. */
const within = async <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p.then(
      (value) => ({ outcome: "ok" as const, value }),
      (error: unknown) => ({ outcome: "error" as const, error }),
    ),
    sleep(ms).then(() => ({ outcome: "hung" as const })),
  ]);

describe("Postgres black-holed (a failover that leaves dead peers, no RST)", () => {
  let proxy: TcpProxy;
  let store: Store;

  afterEach(async () => {
    proxy.heal();
    await store.close().catch(() => undefined);
    await proxy.close();
  });

  const open = async () => {
    const url = new URL(postgresUrl());
    proxy = await startTcpProxy(url.hostname, Number(url.port));
    url.host = proxy.address;
    store = createPostgresStore({
      connectionString: url.toString(),
      clock: new ManualClock(),
      schema: await fileSchemaName(),
      queryTimeoutMs: 1_000,
    });
  };

  it("a query or transaction on a dead connection fails within the query timeout, and the pool recovers", async () => {
    await open();
    // Several pooled connections, all alive.
    await Promise.all(Array.from({ length: 4 }, () => store.dbNow()));

    proxy.blackhole();
    const query = await within(store.dbNow(), 5_000);
    expect(query.outcome).toBe("error");
    if (query.outcome === "error") {
      expect(isDatabaseUnavailable(query.error), String(query.error)).toBe(
        true,
      );
    }
    const tx = await within(
      store.transaction(async (repos) => {
        await repos.jobs.jobStates(["job_x"]);
        return "committed";
      }),
      8_000,
    );
    expect(tx.outcome).toBe("error");

    // Healed: no connection the black hole corrupted is handed out again.
    proxy.heal();
    const after: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const r = await within(
        store.transaction(async (repos) => {
          await repos.jobs.jobStates(["job_x"]);
          return "ok";
        }),
        5_000,
      );
      after.push(r.outcome);
    }
    expect(after).toEqual(Array(8).fill("ok"));
  }, 40_000);

  it("a LISTEN connection behind the black hole counts as lost (the SSE hub listens again)", async () => {
    const url = new URL(postgresUrl());
    proxy = await startTcpProxy(url.hostname, Number(url.port));
    url.host = proxy.address;
    store = createPostgresStore({
      connectionString: url.toString(),
      clock: new ManualClock(),
      schema: await fileSchemaName(),
      queryTimeoutMs: 1_000,
      listenPingMs: 300,
    });
    let lostAt = 0;
    const stop = await store.listen(
      "grad_chaos_probe",
      () => undefined,
      () => {
        lostAt = Date.now();
      },
    );
    await sleep(700);
    expect(lostAt).toBe(0); // a healthy LISTEN stays up
    const holed = Date.now();
    proxy.blackhole();
    for (let i = 0; i < 40 && lostAt === 0; i += 1) await sleep(100);
    expect(lostAt).toBeGreaterThan(0);
    expect(lostAt - holed).toBeLessThan(2_000);
    await stop();
  });
});

describe("migrations under the pool's statement_timeout (MIGRATE_ON_BOOT)", () => {
  it("a slow migration and a replica waiting on the migration lock both succeed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "grad-chaos-migrations-"));
    const schema = freshSchemaName();
    // Like an API replica's pool, with a statement timeout far below the
    // migration's run time (a table rewrite on a big ledger, say).
    const pool = () =>
      new pg.Pool({
        connectionString: postgresUrl(),
        options:
          "-c statement_timeout=200 -c idle_in_transaction_session_timeout=400",
      });
    const pools = [pool(), pool()];
    try {
      await writeFile(
        path.join(dir, "0001_slow.sql"),
        "CREATE TABLE slow (id INT); SELECT pg_sleep(0.6);",
      );
      const results = await Promise.allSettled(
        pools.map((p) => migrate(p, { schema, dir })),
      );
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(
        results.flatMap((r) => (r.status === "fulfilled" ? r.value : [])),
      ).toEqual(["0001"]);
      // The replica's session timeouts are back for its next checkout.
      const { rows } = await pools[0]!.query<{ statement_timeout: string }>(
        "SHOW statement_timeout",
      );
      expect(rows[0]?.statement_timeout).toBe("200ms");
    } finally {
      await Promise.all(pools.map((p) => p.end()));
      await dropSchema(postgresUrl(), schema);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("an upgrade from alpha.3 (0006 onwards) started by two pods at once", () => {
  it("one applies the new migrations and the other waits, then finds none", async () => {
    const schema = freshSchemaName();
    const old = await mkdtemp(path.join(tmpdir(), "grad-chaos-0005-"));
    const pools = [0, 1].map(
      () => new pg.Pool({ connectionString: postgresUrl(), max: 1 }),
    );
    try {
      const names = (await loadMigrations()).map((m) => m.name);
      for (const name of names) {
        if (name < "0006") {
          await copyFile(
            path.join(defaultMigrationsDir(), name),
            path.join(old, name),
          );
        }
      }
      await migrate(pools[0]!, { schema, dir: old });
      const ran = await Promise.all(pools.map((p) => migrate(p, { schema })));
      expect(ran.map((r) => r.join(",")).sort()).toEqual([
        "",
        names
          .filter((n) => n >= "0006")
          .map((n) => n.slice(0, 4))
          .join(","),
      ]);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
      await dropSchema(postgresUrl(), schema);
      await rm(old, { recursive: true, force: true });
    }
  });
});

describe("S3 slower than its request timeout", () => {
  it("a download stream read for longer than the request timeout still completes", async () => {
    const target = s3Target();
    const store = new S3ObjectStore({
      bucket: target.bucket,
      region: target.region,
      endpoint: target.endpoint,
      credentials: {
        accessKeyId: target.accessKeyId,
        secretAccessKey: target.secretAccessKey,
      },
      requestTimeoutMs: 800,
    });
    const key = `chaos/${randomBytes(6).toString("hex")}/bundle.bin`;
    const body = randomBytes(4 * 1024 * 1024);
    await store.put(key, body);
    try {
      // A client on a slow link: the body takes ~2 s to drain.
      const reader = (await store.getStream(key)).getReader();
      let bytes = 0;
      let failure: unknown = null;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          await sleep(20);
        }
      } catch (error) {
        failure = error;
      }
      expect(String(failure ?? "")).toBe("");
      expect(bytes).toBe(body.byteLength);
    } finally {
      await store.delete(key);
    }
  }, 20_000);
});

describe("source schedules on a tick", () => {
  let t: TestApp;
  afterEach(async () => t.close());

  it("one source that can't enqueue does not stop the others' schedules", async () => {
    t = await makeTestApp({
      secrets: createSecretsCipher({ key: randomBytes(32).toString("base64") }),
    });
    const keyB = await t.mintKey("ws_b", ["admin"]);
    const add = async (token: string | undefined, dataset: string) => {
      await t.json("/v1/secrets", {
        body: { name: "lf", value: "pk-lf-a:sk-lf-b" },
        ...(token ? { token } : {}),
      });
      const res = await t.json<{ id: string }>(
        `/v1/datasets/${dataset}/sources`,
        {
          body: {
            provider: {
              kind: "langfuse",
              host: "https://cloud.langfuse.com",
              secret: "lf",
            },
            schedule: "*/5 * * * *",
          },
          ...(token ? { token } : {}),
        },
      );
      expect(res.status).toBe(201);
      return res.body.id;
    };
    const poisoned = await add(keyB, "b-traces");
    const healthy = await add(undefined, "a-traces");
    // ws_b was suspended while its source stayed active (a create racing
    // the suspension's pause): its enqueue answers 403 workspace_suspended.
    await sql(
      `INSERT INTO grad_workspace_states (workspace_id, state, updated_at)
       VALUES ('ws_b', 'suspended', now())`,
    );
    t.clock.advanceSeconds(3600);
    await sql(
      `UPDATE grad_sources SET next_sync_at = $2::timestamptz - interval '1 minute' WHERE id = $1`,
      [poisoned, t.clock.now().toISOString()],
    );
    await sql(
      `UPDATE grad_sources SET next_sync_at = $2::timestamptz WHERE id = $1`,
      [healthy, t.clock.now().toISOString()],
    );

    const first = await t.services.sources
      .tick(t.clock.now())
      .catch((error: unknown) => error);
    expect(first).not.toBeInstanceOf(Error);
    const jobs = await sql(
      "SELECT workspace_id FROM grad_jobs WHERE kind = 'import' ORDER BY workspace_id",
    );
    expect(jobs.map((j) => j.workspace_id)).toEqual(["ws_a"]);
  });
});

describe("many sources due in one cron minute", () => {
  let t: TestApp;
  afterEach(async () => t.close());

  it("one tick starts more than one batch of them", async () => {
    t = await makeTestApp({
      secrets: createSecretsCipher({ key: randomBytes(32).toString("base64") }),
    });
    await t.json("/v1/secrets", {
      body: { name: "lf", value: "pk-lf-a:sk-lf-b" },
    });
    const n = 130;
    for (let i = 0; i < n; i += 10) {
      await Promise.all(
        Array.from({ length: 10 }, (_, j) =>
          t.json(`/v1/datasets/traces-${i + j}/sources`, {
            body: {
              provider: {
                kind: "langfuse",
                host: "https://cloud.langfuse.com",
                secret: "lf",
              },
              schedule: "0 * * * *",
            },
          }),
        ),
      );
    }
    t.clock.advanceSeconds(3600);

    expect(await t.services.sources.tick(t.clock.now())).toBe(n);
    const [row] = await sql(
      "SELECT count(*)::int AS n FROM grad_jobs WHERE kind = 'import'",
    );
    expect(row?.n).toBe(n);
  }, 60_000);
});

describe("a replica killed after the commit: the client's retry", () => {
  let t: TestApp;
  afterEach(async () => t.close());

  /** The same request twice, as an SDK retry after a lost response does. */
  const twice = async (
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> },
  ) => [await t.json(path, init), await t.json(path, init)];

  it("cancel, promote, deletes and syncs answer a retry as the first request was answered", async () => {
    t = await makeTestApp({
      secrets: createSecretsCipher({ key: randomBytes(32).toString("base64") }),
    });
    const worker = new FakeWorker(t);
    const run = await createSftRun(t);
    const job = (await worker.claim())!;
    await worker.checkpoint(job, 5, "ckpt-five", { format: "peft_lora" });
    const [ckpt] = (
      await t.json<{ data: Array<{ id: string }> }>(
        `/v1/runs/${run.id}/checkpoints`,
      )
    ).body.data;

    // Concurrent promotes (two replicas behind a retrying proxy): one release.
    const promotes = await Promise.all(
      Array.from({ length: 6 }, () =>
        t.json<{ id: string }>(`/v1/checkpoints/${ckpt!.id}/promote`, {
          body: { name: "best" },
        }),
      ),
    );
    expect(promotes.map((p) => p.status)).toEqual(Array(6).fill(201));
    expect(new Set(promotes.map((p) => p.body.id)).size).toBe(1);

    const statuses: Record<string, number[]> = {};
    const record = (name: string, rs: Array<{ status: number }>) => {
      statuses[name] = rs.map((r) => r.status);
    };
    record(
      "cancel run",
      await twice(`/v1/runs/${run.id}/cancel`, { body: {} }),
    );
    record(
      "delete artifact",
      await twice(`/v1/artifacts/${promotes[0]!.body.id}`, {
        method: "DELETE",
      }),
    );

    await t.json("/v1/secrets", {
      body: { name: "lf", value: "pk-lf-a:sk-lf-b" },
    });
    const sourceBody = {
      provider: {
        kind: "langfuse",
        host: "https://cloud.langfuse.com",
        secret: "lf",
      },
    };
    const sources = await twice("/v1/datasets/traces/sources", {
      body: sourceBody,
      headers: { "Idempotency-Key": "src-1" },
    });
    record("create source (same key)", sources);
    const sourceId = (sources[0]!.body as { id: string }).id;
    expect((sources[1]!.body as { id: string }).id).toBe(sourceId);
    const syncs = await twice(`/v1/sources/${sourceId}/sync`, { body: {} });
    record("sync source", syncs);
    expect((syncs[1]!.body as { id: string }).id).toBe(
      (syncs[0]!.body as { id: string }).id,
    );
    record(
      "delete source",
      await twice(`/v1/sources/${sourceId}`, { method: "DELETE" }),
    );
    record(
      "delete secret",
      await twice("/v1/secrets/lf", { method: "DELETE" }),
    );
    const key = await t.json<{ key: { id: string } }>("/v1/keys", {
      body: { name: "ci-key", scopes: ["runs:read"] },
    });
    record(
      "revoke key",
      await twice(`/v1/keys/${key.body.key.id}`, { method: "DELETE" }),
    );

    // A retried DELETE finds nothing left: 404, the same end state (the
    // SDKs retry DELETEs; a 404 on a retry means the first one landed).
    expect(statuses).toEqual({
      "cancel run": [200, 200],
      "delete artifact": [204, 404],
      "create source (same key)": [201, 201],
      "sync source": [202, 202],
      "delete source": [204, 404],
      "delete secret": [204, 404],
      "revoke key": [200, 200],
    });
  });

  it("identical concurrent pushes without a key store one version", async () => {
    t = await makeTestApp();
    const records = sftRecords(5);
    const pushes = await Promise.all(
      Array.from({ length: 6 }, () =>
        t.json<{ version: number }>("/v1/datasets/dup/records", {
          body: { records },
        }),
      ),
    );
    expect(new Set(pushes.map((p) => p.status))).toEqual(new Set([200]));
    const dataset = await t.json<{ version: number; record_count: number }>(
      "/v1/datasets/dup",
    );
    expect([dataset.body.version, dataset.body.record_count]).toEqual([1, 5]);
  });
});

describe("the maintenance tick on several replicas at once", () => {
  const apps: TestApp[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0).reverse()) await app.close();
  });

  it("requeues an expired lease once, starts a due sync once, and fails no step", async () => {
    const secrets = createSecretsCipher({
      key: randomBytes(32).toString("base64"),
    });
    const first = await makeTestApp({ secrets });
    apps.push(first);
    // Two more replicas on the same database, bucket and clock.
    for (let i = 0; i < 2; i += 1) {
      apps.push(
        await makeTestApp({
          secrets,
          store: first.deps.store,
          storage: first.deps.storage,
          clock: first.clock,
        }),
      );
    }
    const worker = new FakeWorker(first);
    const run = await createSftRun(first);
    expect((await worker.claim())?.id).toBe(run.id);
    await first.json("/v1/secrets", {
      body: { name: "lf", value: "pk-lf-a:sk-lf-b" },
    });
    const source = await first.json<{ id: string }>(
      "/v1/datasets/traces/sources",
      {
        body: {
          provider: {
            kind: "langfuse",
            host: "https://cloud.langfuse.com",
            secret: "lf",
          },
          schedule: "*/5 * * * *",
        },
      },
    );
    expect(source.status).toBe(201);
    first.clock.advanceSeconds(3600);

    const errorsBefore = await maintenanceErrors();
    const reports = await Promise.all(
      apps.map((app) => app.services.maintenance.tick()),
    );
    const sum = (k: "expiredJobs" | "syncedSources") =>
      reports.reduce((n, r) => n + r[k], 0);
    expect(sum("expiredJobs")).toBe(1);
    expect(sum("syncedSources")).toBe(1);
    expect(await maintenanceErrors()).toBe(errorsBefore);

    const rows = await sql(
      "SELECT kind, status, attempt FROM grad_jobs ORDER BY kind",
    );
    expect(rows).toEqual([
      { kind: "import", status: "queued", attempt: 0 },
      { kind: "train", status: "queued", attempt: 1 },
    ]);
  });
});

const maintenanceErrors = async (): Promise<number> => {
  const { metrics } = await import("../src/telemetry/metrics.js");
  const values = (await metrics.maintenanceErrors.get()).values;

  return values.reduce((n, v) => n + v.value, 0);
};

describe("S3 down", () => {
  let t: TestApp;
  afterEach(async () => t.close());

  it("answers 503 storage_unavailable with Retry-After, not a 500", async () => {
    // A bucket endpoint nothing listens on (refused), or one answering 5xx.
    const fake = await startFakeS3(503);
    t = await makeTestApp();
    const outcomes: Array<[string, number, string]> = [];
    for (const endpoint of ["http://127.0.0.1:9", fake.url]) {
      const app = await makeTestApp({
        store: t.deps.store,
        clock: t.clock,
        storage: new S3ObjectStore({
          bucket: "grad",
          region: "us-east-1",
          endpoint,
          credentials: { accessKeyId: "x", secretAccessKey: "y" },
          requestTimeoutMs: 2_000,
        }),
      });
      const res = await app.request("/v1/datasets/s3down/records", {
        body: { records: sftRecords(2) },
      });
      const body = (await res.json()) as { code: string };
      outcomes.push([
        endpoint === fake.url ? "5xx" : "refused",
        res.status,
        `${body.code} retry-after=${res.headers.get("retry-after")}`,
      ]);
      await app.close();
    }
    await fake.close();
    expect(outcomes).toEqual([
      ["refused", 503, "storage_unavailable retry-after=1"],
      ["5xx", 503, "storage_unavailable retry-after=1"],
    ]);
  }, 30_000);
});

/** An S3 endpoint that answers every request with `status`. */
const startFakeS3 = async (status: number) => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(status, { "Content-Type": "application/xml" });
    res.end(
      `<?xml version="1.0"?><Error><Code>SlowDown</Code><Message>busy</Message></Error>`,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
};
