import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BillingAdapter } from "../src/adapters.js";
import type { Store } from "../src/store/types.js";
import { makeTestApp, TRAINER_KEY, type TestApp } from "./fixtures/app.js";
import { ManualClock } from "./fixtures/clock.js";
import {
  createIsolatedPostgresStore,
  postgresUrl,
} from "./fixtures/postgres.js";
import { sftRecords } from "./fixtures/worker.js";

/** Billing whose start check can be held open (in-flight) or made to throw (5xx). */
const gatedBilling = () => {
  let gate: Promise<void> | null = null;
  let open = () => undefined as void;
  let failures = 0;
  let checks = 0;
  const adapter: BillingAdapter = {
    checkCanStartRun: async () => {
      checks += 1;
      if (failures > 0) {
        failures -= 1;
        throw new Error("billing backend down");
      }
      await gate;
      return { allowed: true };
    },
    recordRunUsage: async () => undefined,
  };

  return {
    adapter,
    checks: () => checks,
    hold: () => {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release: () => open(),
    failNext: (n: number) => {
      failures = n;
    },
  };
};

const runBody = (name = "support-sft") => ({
  dataset: "support",
  name,
  recipe: { kind: "sft", model: "test/tiny-qwen3", batch_size: 4 },
});

const withKey = (key: string) => ({ "Idempotency-Key": key });

type StoreFactory = (
  clock: ManualClock,
) => Promise<{ store: Store; dispose: () => Promise<void> }>;

const describeIdempotency = (mode: string, factory: StoreFactory) =>
  describe(`Idempotency-Key (${mode})`, () => {
    let t: TestApp;
    let billing: ReturnType<typeof gatedBilling>;
    let dispose: () => Promise<void>;

    beforeEach(async () => {
      const clock = new ManualClock();
      const made = await factory(clock);
      dispose = made.dispose;
      billing = gatedBilling();
      t = await makeTestApp({
        clock,
        store: made.store,
        billing: billing.adapter,
      });
      await t.json("/v1/datasets/support/records", {
        body: { records: sftRecords(8) },
      });
    });

    afterEach(async () => {
      await t.close();
      await dispose();
    });

    const runCount = async () =>
      ((await t.json<{ data: unknown[] }>("/v1/runs")).body.data ?? []).length;

    it("replays the stored response for a retry with the same key and body", async () => {
      const first = await t.json("/v1/runs", {
        body: runBody(),
        headers: withKey("k-1"),
      });
      expect(first.status).toBe(202);
      expect(first.headers.get("Idempotent-Replayed")).toBeNull();

      const retry = await t.json("/v1/runs", {
        body: runBody(),
        headers: withKey("k-1"),
      });
      expect(retry.status).toBe(202);
      expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
      expect(retry.headers.get("content-type")).toMatch(/application\/json/);
      expect(retry.headers.get("x-request-id")).not.toBe(
        first.headers.get("x-request-id"),
      );
      expect(retry.body).toEqual(first.body);
      expect(await runCount()).toBe(1);
      expect(billing.checks()).toBe(1);

      const fresh = await t.json("/v1/runs", {
        body: runBody(),
        headers: withKey("k-2"),
      });
      expect(fresh.status).toBe(202);
      expect(await runCount()).toBe(2);
    });

    it("rejects the same key with a different body or query", async () => {
      expect(
        (await t.json("/v1/runs", { body: runBody(), headers: withKey("k-1") }))
          .status,
      ).toBe(202);
      const reused = await t.json("/v1/runs", {
        body: runBody("other"),
        headers: withKey("k-1"),
      });
      expect(reused.status).toBe(422);
      expect(reused.body).toMatchObject({ code: "idempotency_key_reused" });
      expect(reused.headers.get("content-type")).toMatch(/problem\+json/);
      const query = await t.json("/v1/runs?x=1", {
        body: runBody(),
        headers: withKey("k-1"),
      });
      expect(query.body).toMatchObject({ code: "idempotency_key_reused" });
      expect(await runCount()).toBe(1);
    });

    it("answers 409 with Retry-After while the first request is in flight, then replays", async () => {
      billing.hold();
      const first = t.json("/v1/runs", {
        body: runBody(),
        headers: withKey("k-1"),
      });
      for (let i = 0; i < 50 && billing.checks() === 0; i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(billing.checks()).toBe(1);

      const concurrent = await t.json("/v1/runs", {
        body: runBody(),
        headers: withKey("k-1"),
      });
      expect(concurrent.status).toBe(409);
      expect(concurrent.body).toMatchObject({
        code: "idempotency_in_progress",
      });
      expect(concurrent.headers.get("Retry-After")).toBe("1");

      billing.release();
      expect((await first).status).toBe(202);
      const after = await t.json("/v1/runs", {
        body: runBody(),
        headers: withKey("k-1"),
      });
      expect(after.headers.get("Idempotent-Replayed")).toBe("true");
      expect(await runCount()).toBe(1);
    });

    it("lets exactly one of two simultaneous requests run", async () => {
      billing.hold();
      const both = [
        t.json("/v1/runs", { body: runBody(), headers: withKey("k-1") }),
        t.json("/v1/runs", { body: runBody(), headers: withKey("k-1") }),
      ];
      const loser = await Promise.race(both);
      expect(loser.status).toBe(409);
      billing.release();
      const statuses = (await Promise.all(both)).map((r) => r.status).sort();
      expect(statuses).toEqual([202, 409]);
      expect(billing.checks()).toBe(1);
      expect(await runCount()).toBe(1);
    });

    it("does not store 5xx responses, so the retry runs again", async () => {
      billing.failNext(1);
      const failed = await t.json("/v1/runs", {
        body: runBody(),
        headers: withKey("k-1"),
      });
      expect(failed.status).toBe(500);
      const retry = await t.json("/v1/runs", {
        body: runBody(),
        headers: withKey("k-1"),
      });
      expect(retry.status).toBe(202);
      expect(retry.headers.get("Idempotent-Replayed")).toBeNull();
      expect(await runCount()).toBe(1);
    });

    it("stores 4xx responses and scopes keys per caller and path", async () => {
      const invalid = await t.json("/v1/runs", {
        body: { dataset: "support" },
        headers: withKey("k-1"),
      });
      expect(invalid.status).toBe(422);
      const replayed = await t.json("/v1/runs", {
        body: { dataset: "support" },
        headers: withKey("k-1"),
      });
      expect(replayed.status).toBe(422);
      expect(replayed.headers.get("Idempotent-Replayed")).toBe("true");

      const other = await t.mintKey("ws_a", [
        "runs:read",
        "runs:write",
        "datasets:read",
      ]);
      const otherCaller = await t.json("/v1/runs", {
        body: runBody(),
        headers: withKey("k-1"),
        token: other,
      });
      expect(otherCaller.status).toBe(202);
      const otherPath = await t.json("/v1/datasets", {
        body: { name: "fresh" },
        headers: withKey("k-1"),
      });
      expect(otherPath.status).toBe(201);
    });

    it("rejects malformed keys before running the handler", async () => {
      for (const key of ["x".repeat(256), "has space"]) {
        const res = await t.json("/v1/runs", {
          body: runBody(),
          headers: withKey(key),
        });
        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({ code: "idempotency_key_invalid" });
      }
      expect(
        (
          await t.json("/v1/runs", {
            body: runBody(),
            headers: withKey("x".repeat(255)),
          })
        ).status,
      ).toBe(202);
      expect(billing.checks()).toBe(1);
    });

    it("expires keys after 24 hours and maintenance purges them", async () => {
      expect(
        (
          await t.json("/v1/datasets", {
            body: { name: "once" },
            headers: withKey("k-1"),
          })
        ).status,
      ).toBe(201);
      t.clock.advanceSeconds(24 * 3600 - 1);
      expect(
        (
          await t.json("/v1/datasets", {
            body: { name: "once" },
            headers: withKey("k-1"),
          })
        ).headers.get("Idempotent-Replayed"),
      ).toBe("true");
      t.clock.advanceSeconds(2);
      const expired = await t.json("/v1/datasets", {
        body: { name: "once" },
        headers: withKey("k-1"),
      });
      expect(expired.status).toBe(409);
      expect(expired.headers.get("Idempotent-Replayed")).toBeNull();

      t.clock.advanceDays(2);
      expect((await t.services.maintenance.tick()).deletedIdempotencyKeys).toBe(
        1,
      );
    });

    it("ignores keys on internal worker routes", async () => {
      const claim = () =>
        t.json("/v1/trainer-jobs/claim", {
          token: TRAINER_KEY,
          body: { worker_id: "w1", lease_seconds: 60 },
          headers: withKey("k-1"),
        });
      expect((await claim()).status).toBe(200);
      const again = await claim();
      expect(again.status).toBe(200);
      expect(again.headers.get("Idempotent-Replayed")).toBeNull();
    });
  });

describeIdempotency("memory", async (clock) => {
  const { createMemoryStore } = await import("../src/store/memory.js");
  return { store: createMemoryStore(clock), dispose: async () => undefined };
});

if (postgresUrl()) {
  describeIdempotency("postgres", (clock) =>
    createIsolatedPostgresStore(clock),
  );
}

describe("installIdempotency", () => {
  it("returns the real response when storing it fails", async () => {
    const { createMemoryStore } = await import("../src/store/memory.js");
    const clock = new ManualClock();
    const store = createMemoryStore(clock);
    const failing: Store = {
      ...store,
      idempotency: {
        ...store.idempotency,
        complete: async () => {
          throw new Error("db down");
        },
      },
    };
    const t = await makeTestApp({ clock, store: failing });
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const res = await t.json("/v1/datasets", {
        body: { name: "once" },
        headers: withKey("k-1"),
      });
      expect(res.status).toBe(201);
      expect(JSON.stringify(errors)).toContain(
        "idempotency response not stored",
      );
      const retry = await t.json("/v1/datasets", {
        body: { name: "once" },
        headers: withKey("k-1"),
      });
      expect(retry.body).toMatchObject({ code: "idempotency_in_progress" });
    } finally {
      console.error = original;
      await t.close();
    }
  });

  it("refuses routes that declare their own headers and keeps route middleware", async () => {
    const { OpenAPIHono, createRoute, z } = await import("@hono/zod-openapi");
    const { installIdempotency } = await import("../src/idempotency.js");
    const { createMemoryStore } = await import("../src/store/memory.js");
    const clock = new ManualClock();
    const app = new OpenAPIHono();
    installIdempotency(
      app as never,
      createMemoryStore(clock).idempotency,
      clock,
    );
    const ok = { 200: { description: "ok" } };

    expect(() =>
      app.openapi(
        createRoute({
          method: "post",
          path: "/x",
          request: { headers: z.object({ "x-a": z.string() }) },
          responses: ok,
        }),
        (c) => c.body(null, 200),
      ),
    ).toThrow(/declares headers/);

    const seen: string[] = [];
    app.openapi(
      createRoute({
        method: "post",
        path: "/y",
        middleware: [
          async (_c, next) => {
            seen.push("route");
            await next();
          },
        ] as const,
        responses: ok,
      }),
      (c) => c.body(null, 200),
    );
    expect((await app.request("/y", { method: "POST" })).status).toBe(200);
    expect(seen).toEqual(["route"]);
  });
});
