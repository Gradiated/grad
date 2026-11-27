import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { isDatabaseUnavailable } from "../src/store/postgres/db.js";
import { makeTestApp, type TestApp } from "./fixtures/app.js";
import { postgresUrl } from "./fixtures/postgres.js";

// Tag this file's connections so the test terminates only its own backends.
const APP_NAME = `grad-db-resets-${process.pid}`;
const previousAppName = process.env.PGAPPNAME;
process.env.PGAPPNAME = APP_NAME;
afterAll(() => {
  if (previousAppName === undefined) delete process.env.PGAPPNAME;
  else process.env.PGAPPNAME = previousAppName;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const terminate = async (where: string, params: unknown[]) => {
  const admin = new pg.Client({
    connectionString: postgresUrl(),
    application_name: "grad-db-resets-admin",
  });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(pg_terminate_backend(pid))::text AS n FROM pg_stat_activity WHERE ${where}`,
      params,
    );

    return Number(rows[0]?.n ?? 0);
  } finally {
    await admin.end();
  }
};

describe("Postgres connection resets (r8 P1-2)", () => {
  let t: TestApp;

  beforeEach(async () => {
    t = await makeTestApp();
  });

  afterEach(async () => {
    await t.close();
  });

  it("a transaction whose backend dies between two queries rejects as database_unavailable", async () => {
    // r8 crash-repro.ts: this exited the process with an unhandled 'error' (57P01).
    const outcome = await t.deps.store
      .transaction(async () => {
        await t.deps.store.ping();
        const killed = await terminate(
          "application_name = $1 AND state = 'idle in transaction'",
          [APP_NAME],
        );
        expect(killed).toBe(1);
        await sleep(300); // the 'error' event arrives while no query runs
        await t.deps.store.ping();
        return "committed";
      })
      .catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect(isDatabaseUnavailable(outcome), String(outcome)).toBe(true);
    // The pool dropped the dead client; the next transaction works.
    expect(await t.deps.store.transaction(async () => "ok")).toBe("ok");
  });

  it("the API stays up and answers 503 or success while its backends are reset", async () => {
    const statuses: number[] = [];
    const requests = Array.from({ length: 40 }, async (_, i) => {
      await sleep(i * 15);
      const res = await t.request(`/v1/datasets/resets-${i % 4}/records`, {
        body: {
          records: [
            {
              id: `r${i}`,
              messages: [
                { role: "user", content: `q ${i}` },
                { role: "assistant", content: `a ${i}` },
              ],
            },
          ],
        },
      });
      statuses.push(res.status);
      await res.arrayBuffer();
    });
    let killed = 0;
    for (let round = 0; round < 12; round += 1) {
      killed += await terminate("application_name = $1", [APP_NAME]);
      await sleep(50);
    }
    await Promise.all(requests);
    expect(killed).toBeGreaterThan(0);
    expect(statuses.every((s) => s === 503 || (s >= 200 && s < 300))).toBe(
      true,
    );
    expect(statuses.filter((s) => s === 503).length).toBeGreaterThan(0);
    expect((await t.request("/v1/datasets/resets-0")).status).toBe(200);
  });
});
