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
    recordEvalUsage: async () => undefined,
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

const until = async (ready: () => boolean) => {
  for (let i = 0; i < 200 && !ready(); i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(ready()).toBe(true);
};

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

    it("a duplicate waits for the in-flight request and replays its response", async () => {
      billing.hold();
      const first = t.json("/v1/runs", {
        body: runBody(),
        headers: withKey("k-1"),
      });
      await until(() => billing.checks() === 1);
      const second = t.json("/v1/runs", {
        body: runBody(),
        headers: withKey("k-1"),
      });
      await new Promise((r) => setTimeout(r, 20));
      billing.release();

      const [a, b] = await Promise.all([first, second]);
      expect([a.status, b.status]).toEqual([202, 202]);
      expect(a.headers.get("Idempotent-Replayed")).toBeNull();
      expect(b.headers.get("Idempotent-Replayed")).toBe("true");
      expect(b.body).toEqual(a.body);
      expect(billing.checks()).toBe(1);
      expect(await runCount()).toBe(1);
    });

    it("lets exactly one of two simultaneous requests run", async () => {
      const both = await Promise.all([
        t.json("/v1/runs", { body: runBody(), headers: withKey("k-1") }),
        t.json("/v1/runs", { body: runBody(), headers: withKey("k-1") }),
      ]);
      expect(both.map((r) => r.status)).toEqual([202, 202]);
      expect(
        both.filter((r) => r.headers.get("Idempotent-Replayed") === "true"),
      ).toHaveLength(1);
      expect(billing.checks()).toBe(1);
      expect(await runCount()).toBe(1);
    });

    it("rolls the request's writes back when its response cannot be stored", async () => {
      const repo = t.deps.store.idempotency;
      const complete = repo.complete;
      repo.complete = async () => {
        throw new Error("db down");
      };
      const silenced = console.error;
      console.error = () => undefined;
      try {
        const failed = await t.json("/v1/datasets", {
          body: { name: "once" },
          headers: withKey("k-1"),
        });
        expect(failed.status).toBe(500);
      } finally {
        repo.complete = complete;
        console.error = silenced;
      }
      expect((await t.json("/v1/datasets/once")).status).toBe(404);
      const retry = await t.json("/v1/datasets", {
        body: { name: "once" },
        headers: withKey("k-1"),
      });
      expect(retry.status).toBe(201);
      expect(retry.headers.get("Idempotent-Replayed")).toBeNull();
    });

    it("never stores a response that holds a secret", async () => {
      const create = () =>
        t.json<{ secret?: string; code?: string }>("/v1/keys", {
          body: { name: "ci", scopes: ["datasets:read"] },
          headers: withKey("k-key"),
        });
      const first = await create();
      expect(first.status).toBe(201);
      expect(first.body.secret).toMatch(/^grad_/);
      const again = await create();
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({
        code: "idempotency_replay_unavailable",
      });
      expect(JSON.stringify(again.body)).not.toContain(first.body.secret);
      const keys = await t.json<{ data: Array<{ name: string }> }>("/v1/keys");
      expect(keys.body.data.filter((k) => k.name === "ci")).toHaveLength(1);
    });

    it("runs read-only POSTs again instead of storing them", async () => {
      const plan = (name: string) =>
        t.json("/v1/runs/plan", {
          body: runBody(name),
          headers: withKey("k-plan"),
        });
      const a = await plan("a");
      const b = await plan("b");
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(b.headers.get("Idempotent-Replayed")).toBeNull();
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

if (postgresUrl()) {
  describe("Idempotency-Key (postgres): bounded wait", () => {
    it("a duplicate stops waiting after waitMs with 409 and Retry-After", async () => {
      const clock = new ManualClock();
      const { store, dispose } = await createIsolatedPostgresStore(clock);
      const billing = gatedBilling();
      const t = await makeTestApp({
        clock,
        store,
        billing: billing.adapter,
        settings: {
          allowWave2Recipes: false,
          maxAttempts: 3,
          evalConcurrency: 1,
          idempotencyWaitMs: 50,
        },
      });
      try {
        await t.json("/v1/datasets/support/records", {
          body: { records: sftRecords(8) },
        });
        billing.hold();
        const first = t.json("/v1/runs", {
          body: runBody(),
          headers: withKey("k-1"),
        });
        await until(() => billing.checks() === 1);
        const busy = await t.json("/v1/runs", {
          body: runBody(),
          headers: withKey("k-1"),
        });
        expect(busy.status).toBe(409);
        expect(busy.body).toMatchObject({ code: "idempotency_in_progress" });
        expect(busy.headers.get("Retry-After")).toBe("1");
        billing.release();
        expect((await first).status).toBe(202);
        const replay = await t.json("/v1/runs", {
          body: runBody(),
          headers: withKey("k-1"),
        });
        expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
      } finally {
        billing.release();
        await t.close();
        await dispose();
      }
    });
  });
}

/** A bare app with one keyed route in the given operation's policy, over a memory store. */
const intentApp = async (operationId: string) => {
  const { OpenAPIHono, createRoute } = await import("@hono/zod-openapi");
  const { installIdempotency } = await import("../src/idempotency.js");
  const { createMemoryStore } = await import("../src/store/memory.js");
  const clock = new ManualClock();
  const store = createMemoryStore(clock);
  const app = new OpenAPIHono();
  app.use("*", async (c, next) => {
    c.set("principal" as never, { workspaceId: "ws", actor: "key_1" } as never);
    await next();
  });
  installIdempotency(app as never, store, clock);
  let gate: Promise<void> = Promise.resolve();
  let open = () => undefined as void;
  const state = { calls: 0, status: 200 };
  app.openapi(
    createRoute({
      method: "post",
      path: "/side-effect",
      operationId,
      responses: { 200: { description: "ok" } },
    }),
    async (c) => {
      state.calls += 1;
      await gate;
      return c.json({ call: state.calls }, state.status as 200);
    },
  );
  const post = (key = "k-1") =>
    app.request("/side-effect", {
      method: "POST",
      body: "{}",
      headers: { "Idempotency-Key": key },
    });

  return {
    store,
    clock,
    state,
    post,
    hold: () => {
      gate = new Promise<void>((r) => {
        open = r;
      });
    },
    release: () => open(),
  };
};

describe("Idempotency-Key intent mode (external side effects)", () => {
  it("commits the intent first: a duplicate gets 409 at once, then the replay", async () => {
    const h = await intentApp("deployArtifact");
    h.hold();
    const first = h.post();
    await until(() => h.state.calls === 1);
    const busy = await h.post();
    expect(busy.status).toBe(409);
    expect(busy.headers.get("Retry-After")).toBe("1");
    h.release();
    expect((await first).status).toBe(200);
    const replay = await h.post();
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await replay.json()).toEqual({ call: 1 });
    expect(h.state.calls).toBe(1);
  });

  it("releases the key on 5xx so the retry repeats the call", async () => {
    const h = await intentApp("routeRequest");
    h.state.status = 502;
    expect((await h.post()).status).toBe(502);
    h.state.status = 200;
    expect((await h.post()).status).toBe(200);
    expect(h.state.calls).toBe(2);
  });

  it("answers with the side effect when recording fails; the intent expires after 60 s", async () => {
    const h = await intentApp("createEmbeddings");
    const complete = h.store.idempotency.complete;
    h.store.idempotency.complete = async () => {
      throw new Error("db down");
    };
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      expect((await h.post()).status).toBe(200);
    } finally {
      console.error = original;
      h.store.idempotency.complete = complete;
    }
    expect(JSON.stringify(errors)).toContain("idempotency response not stored");
    expect((await h.post()).status).toBe(409);
    h.clock.advanceSeconds(61);
    expect((await h.post()).status).toBe(200);
    expect(h.state.calls).toBe(2);
  });
});

describe("installIdempotency", () => {
  it("refuses routes that declare their own headers and keeps route middleware", async () => {
    const { OpenAPIHono, createRoute, z } = await import("@hono/zod-openapi");
    const { installIdempotency } = await import("../src/idempotency.js");
    const { createMemoryStore } = await import("../src/store/memory.js");
    const clock = new ManualClock();
    const app = new OpenAPIHono();
    installIdempotency(app as never, createMemoryStore(clock), clock);
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

  it("has a policy for operations that exist", async () => {
    const { buildOpenApiDocument } = await import("../src/app.js");
    const { IDEMPOTENCY_POLICIES } = await import("../src/idempotency.js");
    const t = await makeTestApp();
    const ids = new Set(
      Object.values(buildOpenApiDocument(t.app).paths ?? {}).flatMap((item) =>
        Object.values(item as Record<string, { operationId?: string }>).map(
          (op) => op.operationId,
        ),
      ),
    );
    for (const id of Object.keys(IDEMPOTENCY_POLICIES)) {
      expect(ids.has(id), id).toBe(true);
    }
    await t.close();
  });
});
