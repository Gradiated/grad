import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BillingAdapter } from "../src/adapters.js";
import { makeTestApp, TRAINER_KEY, type TestApp } from "./fixtures/app.js";
import { sftRecords } from "./fixtures/worker.js";

/** Billing whose start check can be held open so two creates overlap. */
const gatedBilling = () => {
  let gate: Promise<void> | null = null;
  let open = () => undefined as void;
  let checks = 0;
  const adapter: BillingAdapter = {
    checkCanStartRun: async () => {
      checks += 1;
      await gate;
      return { allowed: true };
    },
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

describe("Idempotency-Key on create endpoints", () => {
  let t: TestApp;
  let billing: ReturnType<typeof gatedBilling>;

  beforeEach(async () => {
    billing = gatedBilling();
    t = await makeTestApp({ billing: billing.adapter });
    await t.json("/v1/datasets/support/records", {
      body: { records: sftRecords(8) },
    });
  });

  afterEach(async () => {
    await t.close();
  });

  const count = async (path: string) =>
    ((await t.json<{ data: unknown[] }>(path)).body.data ?? []).length;

  it("returns the row the first request created, marked Idempotent-Replayed", async () => {
    const first = await t.json<{ id: string }>("/v1/runs", {
      body: runBody(),
      headers: withKey("k-1"),
    });
    expect(first.status).toBe(202);
    expect(first.headers.get("Idempotent-Replayed")).toBeNull();

    const retry = await t.json<{ id: string }>("/v1/runs", {
      body: runBody(),
      headers: withKey("k-1"),
    });
    expect(retry.status).toBe(202);
    expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
    expect(retry.body.id).toBe(first.body.id);
    expect(await count("/v1/runs")).toBe(1);
    expect(billing.checks()).toBe(1);

    const fresh = await t.json("/v1/runs", {
      body: runBody(),
      headers: withKey("k-2"),
    });
    expect(fresh.status).toBe(202);
    expect(await count("/v1/runs")).toBe(2);
    // Without a key every call creates.
    await t.json("/v1/runs", { body: runBody() });
    expect(await count("/v1/runs")).toBe(3);
  });

  it("rejects the same key with a different body, path or query", async () => {
    await t.json("/v1/runs", { body: runBody(), headers: withKey("k-1") });
    const other = await t.json("/v1/runs", {
      body: runBody("other-name"),
      headers: withKey("k-1"),
    });
    expect(other.status).toBe(422);
    expect(other.body).toMatchObject({ code: "idempotency_key_reused" });

    // Keys are one namespace per workspace: an eval can't reuse a run's key.
    const evalReuse = await t.json("/v1/evals", {
      body: { models: ["qwen/qwen3-8b"], dataset: "support" },
      headers: withKey("k-1"),
    });
    expect(evalReuse.status).toBe(422);
    expect(await count("/v1/runs")).toBe(1);
  });

  it("answers a concurrent duplicate with the winner's row", async () => {
    billing.hold();
    const first = t.json<{ id: string }>("/v1/runs", {
      body: runBody(),
      headers: withKey("k-race"),
    });
    const second = t.json<{ id: string }>("/v1/runs", {
      body: runBody(),
      headers: withKey("k-race"),
    });
    await until(() => billing.checks() === 2);
    billing.release();
    const [a, b] = await Promise.all([first, second]);

    expect([a.status, b.status]).toEqual([202, 202]);
    expect(a.body.id).toBe(b.body.id);
    expect(
      [a, b].filter((r) => r.headers.get("Idempotent-Replayed") === "true"),
    ).toHaveLength(1);
    expect(await count("/v1/runs")).toBe(1);
  });

  it("makes dataset creates, pushes and imports replayable", async () => {
    const created = await t.json<{ id: string }>("/v1/datasets", {
      body: { name: "fresh" },
      headers: withKey("ds-1"),
    });
    expect(created.status).toBe(201);
    const again = await t.json<{ id: string }>("/v1/datasets", {
      body: { name: "fresh" },
      headers: withKey("ds-1"),
    });
    expect(again.status).toBe(201);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(again.body.id).toBe(created.body.id);
    // A new logical create of the same name is a conflict.
    expect(
      (await t.json("/v1/datasets", { body: { name: "fresh" } })).status,
    ).toBe(409);

    const push = { records: sftRecords(3) };
    const pushed = await t.json<{ version: number; record_count: number }>(
      "/v1/datasets/support/records",
      { body: push, headers: withKey("push-1") },
    );
    const repushed = await t.json<{ version: number; record_count: number }>(
      "/v1/datasets/support/records",
      { body: push, headers: withKey("push-1") },
    );
    expect(repushed.headers.get("Idempotent-Replayed")).toBe("true");
    expect(repushed.body).toMatchObject({
      version: pushed.body.version,
      record_count: 11,
    });
    expect(
      (
        await t.json("/v1/datasets/support/records", {
          body: { records: sftRecords(1) },
          headers: withKey("push-1"),
        })
      ).status,
    ).toBe(422);

    const importBody = { source: { kind: "hf", repo: "o/n" } };
    const imp = await t.json<{ id: string }>("/v1/datasets/support/imports", {
      body: importBody,
      headers: withKey("imp-1"),
    });
    const reimp = await t.json<{ id: string }>("/v1/datasets/support/imports", {
      body: importBody,
      headers: withKey("imp-1"),
    });
    expect(reimp.status).toBe(202);
    expect(reimp.body.id).toBe(imp.body.id);
    expect(await count("/v1/imports")).toBe(1);
  });

  it("never replays a key's secret", async () => {
    const body = { name: "ci", scopes: ["runs:read"] };
    const first = await t.json<{ secret: string }>("/v1/keys", {
      body,
      headers: withKey("key-1"),
    });
    expect(first.status).toBe(201);
    const retry = await t.json("/v1/keys", { body, headers: withKey("key-1") });
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({
      code: "idempotency_replay_unavailable",
    });
    expect(JSON.stringify(retry.body)).not.toContain(first.body.secret);
    expect(await count("/v1/keys")).toBe(1);
  });

  it("rejects malformed keys before creating anything", async () => {
    for (const key of ["has space", "x".repeat(256)]) {
      const res = await t.json("/v1/runs", {
        body: runBody(),
        headers: withKey(key),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body, JSON.stringify(res.body)).toMatchObject({
        code: "idempotency_key_invalid",
      });
    }
    expect(await count("/v1/runs")).toBe(0);
    const longest = await t.json("/v1/runs", {
      body: runBody(),
      headers: withKey("x".repeat(255)),
    });
    expect(longest.status).toBe(202);
  });

  it("scopes keys per workspace", async () => {
    await t.json("/v1/datasets", {
      body: { name: "a-only" },
      headers: withKey("shared"),
    });
    const other = await t.mintKey("ws_b", ["admin"]);
    const res = await t.json<{ workspace_id: string }>("/v1/datasets", {
      body: { name: "a-only" },
      headers: withKey("shared"),
      token: other,
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("Idempotent-Replayed")).toBeNull();
    expect(res.body.workspace_id).toBe("ws_b");
  });

  it("ignores keys on internal worker routes (they use natural keys)", async () => {
    const res = await t.json("/v1/trainer-jobs/claim", {
      body: { worker_id: "w1" },
      headers: withKey("worker-1"),
      token: TRAINER_KEY,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Idempotent-Replayed")).toBeNull();
  });

  it("stores a hash of the request, never the body", async () => {
    await t.json("/v1/runs", { body: runBody(), headers: withKey("k-h") });
    const hit = await t.deps.store.jobs.findIdempotent("ws_a", "k-h");
    expect(hit?.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hit?.request_hash).not.toBe(
      createHash("sha256").update(JSON.stringify(runBody())).digest("hex"),
    );
  });
});
