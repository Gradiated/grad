import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createLocalApiKeyAuth,
  hashApiKey,
  trainerKeysOf,
} from "../src/adapters.js";
import { createInternalApp } from "../src/routes/internal.js";
import { buildWorkerAuthenticator } from "../src/worker-auth/index.js";
import {
  ADMIN_KEY,
  makeTestApp,
  TRAINER_KEY,
  WORKSPACE_A,
  type TestApp,
} from "./fixtures/app.js";
import { ManualClock } from "./fixtures/clock.js";
import { createTestStore } from "./fixtures/postgres.js";
import { createSftRun, FakeWorker } from "./fixtures/worker.js";

const FLEET_KEY = "grad_orch_fleet_key";
const IMPORTER_KEY = "grad_orch_importer_key";

describe("lease tokens over HTTP: mint, claim, revoke", () => {
  let t: TestApp;
  let internal: ReturnType<typeof createInternalApp>;
  let clock: ManualClock;
  let dispose: () => Promise<void>;

  beforeEach(async () => {
    clock = new ManualClock();
    const created = await createTestStore(clock);
    const store = created.store;
    dispose = created.dispose;
    const workers = buildWorkerAuthenticator(
      { modes: ["static", "lease"], serviceAccounts: {} },
      {
        staticKeys: trainerKeysOf(hashApiKey(TRAINER_KEY)),
        tokens: store.workerTokens,
        clock,
      },
    );
    t = await makeTestApp({
      clock,
      store,
      auth: createLocalApiKeyAuth({
        adminKeyHash: hashApiKey(ADMIN_KEY),
        workers,
        workspaceId: WORKSPACE_A,
        lookup: store.apiKeys,
      }),
    });
    internal = createInternalApp({
      tokens: store.workerTokens,
      clock,
      orchestratorKeys: [
        { label: "fleet", sha256: hashApiKey(FLEET_KEY), kinds: ["train"] },
        {
          label: "importer",
          sha256: hashApiKey(IMPORTER_KEY),
          kinds: ["import"],
        },
      ],
    });
  });

  afterEach(async () => {
    await t.close();
    await dispose();
  });

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    token: string | null = FLEET_KEY,
  ) => {
    const res = await internal.request(path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      ...(body !== undefined
        ? { body: typeof body === "string" ? body : JSON.stringify(body) }
        : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
      headers: res.headers,
    };
  };

  const inAnHour = () =>
    new Date(clock.now().getTime() + 3_600_000).toISOString();
  const mint = (extra: Record<string, unknown> = {}, token = FLEET_KEY) =>
    call(
      "POST",
      "/internal/v1/worker-tokens",
      {
        host_id: "host-a",
        lease_id: "lease-1",
        kinds: ["train"],
        gpu_memory_gb: 80,
        expires_at: inAnHour(),
        ...extra,
      },
      token,
    );

  it("mint -> claim -> revoke -> rejected", async () => {
    const minted = await mint();
    expect(minted.status).toBe(201);
    expect(minted.headers.get("cache-control")).toBe("no-store");
    const token = minted.body.token as string;
    expect(token).toMatch(/^gradwt_[A-Za-z0-9_-]{43}$/);
    expect(minted.body).toMatchObject({
      host_id: "host-a",
      lease_id: "lease-1",
      kinds: ["train"],
      gpu_memory_gb: 80,
    });
    // Only the hash is stored.
    const row = await t.deps.store.workerTokens.findByHash(hashApiKey(token));
    expect(row).toMatchObject({
      hostId: "host-a",
      createdBy: "orchestrator:fleet",
    });

    const run = await createSftRun(t);
    const worker = new FakeWorker(t, "host-a-3fa9c1", token);
    const job = await worker.claim({
      kinds: ["train"],
      gpu: { name: "H100", memory_gb: 80 },
    });
    expect(job?.run?.id).toBe(run.id);
    expect((await worker.heartbeat(job!)).status).toBe(200);

    // Another credential cannot read this lease's training data.
    const stolen = await t.request(
      `/v1/trainer-jobs/${job!.id}/dataset?attempt=${job!.attempt}`,
      { token: TRAINER_KEY },
    );
    expect(stolen.status).toBe(409);
    const own = await t.request(
      `/v1/trainer-jobs/${job!.id}/dataset?attempt=${job!.attempt}`,
      { token },
    );
    expect(own.status).toBe(200);
    await own.arrayBuffer();

    // Another orchestrator cannot revoke it; its own can, once.
    expect(
      (
        await call(
          "DELETE",
          "/internal/v1/worker-tokens/lease-1",
          undefined,
          IMPORTER_KEY,
        )
      ).body.revoked,
    ).toBe(0);
    expect(
      (await call("DELETE", "/internal/v1/worker-tokens/lease-1")).body,
    ).toEqual({ lease_id: "lease-1", revoked: 1 });
    expect(
      (await call("DELETE", "/internal/v1/worker-tokens/lease-1")).body.revoked,
    ).toBe(0);

    const after = await worker.heartbeat(job!);
    expect(after.status).toBe(401);
    const claim = await t.json("/v1/trainer-jobs/claim", {
      token,
      body: { worker_id: "host-a-3fa9c1" },
    });
    expect(claim.status).toBe(401);
  });

  it("enforces the token's kinds, host binding, GPU bound and expiry", async () => {
    const token = (await mint()).body.token as string;
    const claim = (body: Record<string, unknown>) =>
      t.json<{ code: string }>("/v1/trainer-jobs/claim", { token, body });

    expect(
      (await claim({ worker_id: "host-a", kinds: ["import"] })).body.code,
    ).toBe("job_kind_forbidden");
    const wrongHost = await claim({
      worker_id: "host-b-123456",
      kinds: ["train"],
    });
    expect(wrongHost.status).toBe(403);
    expect(wrongHost.body.code).toBe("worker_host_mismatch");
    const bigGpu = await claim({
      worker_id: "host-a",
      kinds: ["train"],
      gpu: { name: "B200", memory_gb: 180 },
    });
    expect(bigGpu.body.code).toBe("gpu_memory_exceeds_token");
    expect(
      (await claim({ worker_id: "host-a", kinds: ["train"] })).status,
    ).toBe(200);

    clock.advanceSeconds(3601);
    expect(
      (await claim({ worker_id: "host-a", kinds: ["train"] })).status,
    ).toBe(401);

    // Maintenance sweeps the expired row.
    expect((await t.services.maintenance.tick()).deletedWorkerTokens).toBe(1);
    expect(
      await t.deps.store.workerTokens.findByHash(hashApiKey(token)),
    ).toBeNull();
  });

  it("only orchestrator keys reach the internal routes, within their kinds", async () => {
    expect((await mint({}, "")).status).toBe(401);
    for (const token of [ADMIN_KEY, TRAINER_KEY, "grad_wrong"]) {
      const res = await mint({}, token);
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("unauthorized");
    }
    const notMine = await mint({ kinds: ["train"] }, IMPORTER_KEY);
    expect(notMine.status).toBe(403);
    expect(notMine.body.code).toBe("job_kind_forbidden");
    expect((await mint({ kinds: ["import"] }, IMPORTER_KEY)).status).toBe(201);

    for (const extra of [
      { expires_at: new Date(clock.now().getTime() - 1000).toISOString() },
      {
        expires_at: new Date(
          clock.now().getTime() + 8 * 86_400_000,
        ).toISOString(),
      },
      { expires_at: "tomorrow" },
      { host_id: "host:a" },
      { kinds: [] },
      { kinds: ["train", "train"] },
      { gpu_memory_gb: 0 },
      { extra: true },
    ]) {
      const res = await mint(extra);
      expect(res.status, JSON.stringify(extra)).toBe(422);
    }
    expect(
      (await call("POST", "/internal/v1/worker-tokens", "{not json")).status,
    ).toBe(400);
    expect(
      (await call("POST", "/internal/v1/worker-tokens", "x".repeat(20_000)))
        .status,
    ).toBe(413);
    expect(
      (await call("DELETE", "/internal/v1/worker-tokens/bad%20id")).status,
    ).toBe(422);
    expect((await call("GET", "/internal/v1/nope")).status).toBe(404);
    expect((await internal.request("/health/live")).status).toBe(200);
  });

  it("the public API port does not serve the internal routes", async () => {
    for (const token of [FLEET_KEY, ADMIN_KEY]) {
      const res = await t.request("/internal/v1/worker-tokens", {
        method: "POST",
        token,
        body: {
          host_id: "h",
          lease_id: "l",
          kinds: ["train"],
          expires_at: inAnHour(),
        },
      });
      expect(res.status).toBe(404);
    }
  });
});
