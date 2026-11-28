import { createHash, randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createJwtVerifier } from "../src/cloud/jwt.js";
import { createInternalApp } from "../src/routes/internal.js";
import { SUSPENDED_STOPPED } from "../src/services/runs.js";
import { createSecretsCipher } from "../src/secrets.js";
import { makeTestApp, WORKSPACE_A, type TestApp } from "./fixtures/app.js";
import { ManualClock } from "./fixtures/clock.js";
import {
  startFakeCloudApi,
  type FakeCloudApi,
} from "./fixtures/fake-cloud-api.js";
import { createSftRun, FakeWorker } from "./fixtures/worker.js";
import { createEval, qaRecords, seedDataset } from "./fixtures/evals.js";
import { PlanEvalRequestSchema } from "../src/contracts.js";

const LANGFUSE = {
  kind: "langfuse",
  host: "https://cloud.langfuse.com",
  secret: "langfuse-prod",
};

describe("Cloud workspace lifecycle on the internal listener", () => {
  let cloud: FakeCloudApi;
  let clock: ManualClock;
  let t: TestApp;
  let internal: ReturnType<typeof createInternalApp>;

  beforeAll(async () => {
    clock = new ManualClock(new Date());
    cloud = await startFakeCloudApi({ clock });
  });
  afterAll(() => cloud.close());
  afterEach(() => t.close());

  const setup = async () => {
    t = await makeTestApp({
      clock,
      secrets: createSecretsCipher({ key: randomBytes(32).toString("base64") }),
      settings: {
        maxAttempts: 3,
        workspacePurgeDelaySeconds: 0,
        inferencePinsManagedByCloud: true,
      },
    });
    internal = createInternalApp({
      tokens: t.deps.store.workerTokens,
      clock,
      orchestratorKeys: [],
      cloud: {
        jwt: createJwtVerifier({
          jwksUrl: cloud.jwksUrl,
          issuer: cloud.issuer,
          audience: "training",
          clock,
        }),
        deps: t.deps,
        services: t.services,
      },
    });
  };

  const setState = (
    state: string,
    token = cloud.serviceJwt(WORKSPACE_A, ["workspaces:admin"]),
    ws = WORKSPACE_A,
  ) =>
    internal.request(`/internal/v1/workspaces/${ws}/state`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state }),
    });

  it("accepts only service JWTs for the path's workspace with workspaces:admin", async () => {
    await setup();
    const get = (token?: string) =>
      internal.request(`/internal/v1/workspaces/${WORKSPACE_A}/state`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    expect((await get()).status).toBe(401);
    expect((await get(cloud.consoleToken(WORKSPACE_A))).status).toBe(401);
    expect(
      (await get(cloud.serviceJwt("ws_other", ["workspaces:admin"]))).status,
    ).toBe(403);
    expect(
      (await get(cloud.serviceJwt(WORKSPACE_A, ["artifacts:pin"]))).status,
    ).toBe(403);
    const ok = await get(cloud.serviceJwt(WORKSPACE_A, ["workspaces:admin"]));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      workspace_id: WORKSPACE_A,
      state: "active",
    });
    expect((await setState("archived")).status).toBe(422);
    // No lease auth configured: the lease-token routes are not mounted.
    const mint = await internal.request("/internal/v1/worker-tokens", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cloud.serviceJwt(WORKSPACE_A, ["workspaces:admin"])}`,
      },
    });
    expect(mint.status).toBe(404);
    expect(await mint.json()).toMatchObject({ code: "route_not_found" });
  });

  it("suspend stops runs resumable and refuses new jobs; reinstating resumes sources", async () => {
    await setup();
    await t.json("/v1/secrets", {
      body: { name: "langfuse-prod", value: "pk:sk" },
    });
    const source = await t.json<{ id: string }>(
      "/v1/datasets/support-prod/sources",
      { body: { provider: LANGFUSE } },
    );
    expect(source.status).toBe(201);
    const running = await createSftRun(t, { name: "running" });
    const worker = new FakeWorker(t);
    const job = (await worker.claim())!;
    expect(job.id).toBe(running.id);
    const queued = await createSftRun(t, { name: "queued" });

    const suspended = await setState("suspended");
    expect(suspended.status).toBe(200);
    expect(await suspended.json()).toMatchObject({ state: "suspended" });
    // Idempotent.
    expect((await setState("suspended")).status).toBe(200);

    expect((await t.json(`/v1/runs/${queued.id}`)).body).toMatchObject({
      status: "stopped_balance",
      error: SUSPENDED_STOPPED,
    });
    expect((await worker.heartbeat(job)).body).toMatchObject({
      should_stop: true,
      stop_reason: "insufficient_balance",
    });
    const done = await worker.complete(
      job,
      {
        status: "stopped_budget",
        stop_reason: "insufficient_balance",
        tokens_processed: 100,
      },
      "partial",
    );
    expect(done.body.run).toMatchObject({
      status: "stopped_balance",
      error: SUSPENDED_STOPPED,
    });
    const refused = await createSftRun(t, { name: "new" }).catch(
      (e: unknown) => e,
    );
    expect(String(refused)).toMatch(/workspace_suspended|403/);
    const resume = await t.json(`/v1/runs/${queued.id}/resume`, { body: {} });
    expect(resume.status).toBe(403);
    expect(resume.body).toMatchObject({ code: "workspace_suspended" });
    expect((await t.json(`/v1/sources/${source.body.id}`)).body).toMatchObject({
      status: "paused",
      paused_reason: "workspace_suspended",
    });

    expect((await setState("active")).status).toBe(200);
    expect((await t.json(`/v1/sources/${source.body.id}`)).body).toMatchObject({
      status: "active",
    });
    expect(
      (await t.json(`/v1/runs/${queued.id}/resume`, { body: {} })).status,
    ).toBe(200);
  });

  it("delete cancels work, then purges rows and objects in passes; the usage ledger stays", async () => {
    await setup();
    await t.json("/v1/secrets", {
      body: { name: "langfuse-prod", value: "pk:sk" },
    });
    const run = await createSftRun(t);
    const worker = new FakeWorker(t);
    const job = (await worker.claim())!;
    await worker.complete(
      job,
      { status: "completed", tokens_processed: 500 },
      "bundle",
    );
    const finished = await t.json<{ artifact_id: string }>(
      `/v1/runs/${run.id}`,
    );
    expect(finished.body.artifact_id).toBeTruthy();
    const queued = await createSftRun(t, { name: "second" });
    await t.deps.storage.put(
      `ws/${WORKSPACE_A}/stray/object`,
      Buffer.from("x"),
    );

    expect((await setState("deleted")).status).toBe(200);
    expect((await t.json(`/v1/runs/${queued.id}`)).body).toMatchObject({
      status: "cancelled",
    });
    const reinstate = await setState("active");
    expect(reinstate.status).toBe(409);

    const ticks = [];
    for (let i = 0; i < 5; i += 1) {
      ticks.push((await t.services.maintenance.tick()).purgedWorkspaces);
    }
    expect(ticks[0]).toBe(1);
    const state = await t.deps.store.workspaces.get(WORKSPACE_A);
    expect(state?.purged_at).not.toBeNull();
    expect((await t.json("/v1/runs")).body).toMatchObject({ data: [] });
    expect((await t.json("/v1/datasets")).body).toMatchObject({ data: [] });
    expect((await t.json("/v1/secrets")).body).toMatchObject({ data: [] });
    for (const prefix of ["ws", "artifacts"]) {
      const keys = await t.deps.storage.listOlder(
        `${prefix}/${WORKSPACE_A}`,
        new Date(Date.now() + 86_400_000),
        10,
      );
      expect(
        keys.filter((k) => k.startsWith(`${prefix}/${WORKSPACE_A}/`)),
      ).toEqual([]);
    }
    expect((await t.deps.store.usage.listByRef(run.id)).length).toBe(1);
  });

  it("resolves and pins artifacts for serving; a delete keeps pinned bundles until they are unpinned", async () => {
    await setup();
    const sha = createHash("sha256").update("bundle").digest("hex");
    const key = `artifacts/${WORKSPACE_A}/${sha}`;
    await t.deps.storage.put(key, Buffer.from("bundle"));
    const release = (name: string, format: "peft_lora" | "reference") =>
      t.deps.store.artifacts.createRelease({
        workspaceId: WORKSPACE_A,
        name,
        runId: null,
        sourceId: null,
        baseModel: "test/tiny-qwen3",
        recipeKind: "sft",
        format,
        storageKey: key,
        sha256: sha,
        sizeBytes: 6,
        manifest: { format: "peft_lora", lora: { rank: 32 } },
        evalReport: null,
      });
    const artifact = await release("support-sft", "peft_lora");
    const reference = await release("support-ref", "reference");
    const token = cloud.serviceJwt(WORKSPACE_A, ["artifacts:pin"]);
    const call = (
      method: string,
      path: string,
      body?: unknown,
      bearer = token,
    ) =>
      internal.request(
        `/internal/v1/workspaces/${WORKSPACE_A}/artifacts/${encodeURIComponent(path)}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${bearer}`,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
    const pinPath = (id: string, holder: string) =>
      `${encodeURIComponent(id)}/pins/${encodeURIComponent(holder)}`;
    const pin = (id: string, holder: string, bearer = token) =>
      internal.request(
        `/internal/v1/workspaces/${WORKSPACE_A}/artifacts/${pinPath(id, holder)}`,
        { method: "PUT", headers: { Authorization: `Bearer ${bearer}` } },
      );
    const unpin = (id: string, holder: string) =>
      internal.request(
        `/internal/v1/workspaces/${WORKSPACE_A}/artifacts/${pinPath(id, holder)}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      );

    const resolved = await call("GET", artifact.id);
    expect(resolved.status).toBe(200);
    const body = (await resolved.json()) as {
      artifact: { id: string; sha256: string; manifest: unknown };
      object: Record<string, unknown>;
      download_url: string;
    };
    expect(body.artifact).toMatchObject({ id: artifact.id, sha256: sha });
    // The stored object's full-object checksum is the recorded sha256.
    expect(body.object).toEqual({
      key,
      sha256: sha,
      checksum_sha256: Buffer.from(sha, "hex").toString("base64"),
      checksum_type: "FULL_OBJECT",
      size_bytes: 6,
    });
    expect(body.artifact).not.toHaveProperty("storage_key");
    expect(await (await fetch(body.download_url)).text()).toBe("bundle");
    expect((await call("GET", "missing@1")).status).toBe(404);
    // A bundle whose stored checksum isn't the recorded sha256 is never handed out.
    const tampered = await t.deps.store.artifacts.createRelease({
      workspaceId: WORKSPACE_A,
      name: "support-tampered",
      runId: null,
      sourceId: null,
      baseModel: "test/tiny-qwen3",
      recipeKind: "sft",
      format: "peft_lora",
      storageKey: key,
      sha256: "ab".repeat(32),
      sizeBytes: 6,
      manifest: {},
      evalReport: null,
    });
    const refused = await call("GET", tampered.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe(
      "artifact_checksum_mismatch",
    );
    expect((await call("GET", reference.id)).status).toBe(409);
    expect(
      (
        await call(
          "GET",
          artifact.id,
          undefined,
          cloud.serviceJwt(WORKSPACE_A, ["workspaces:admin"]),
        )
      ).status,
    ).toBe(403);

    const holder = "inference:version:7b1c";
    const pinned = await pin(artifact.id, holder);
    expect(pinned.status).toBe(201);
    // The artifact it returns already lists the new pin.
    const pinnedBody = (await pinned.json()) as {
      artifact: { pins: { holder: string }[] };
    };
    expect(pinnedBody.artifact.pins.map((p) => p.holder)).toEqual([holder]);
    expect((await pin(artifact.id, holder)).status).toBe(200);
    expect((await pin(artifact.id, "bad holder")).status).toBe(422);
    // An optional body: a reason, or nothing usable (never a 500).
    const withBody = (body: string) =>
      internal.request(
        `/internal/v1/workspaces/${WORKSPACE_A}/artifacts/${pinPath(artifact.id, "inference:version:v2")}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body,
        },
      );
    const reasoned = await withBody('{"reason":"published v2"}');
    expect(reasoned.status).toBe(201);
    expect(
      ((await reasoned.json()) as { pin: { reason: string } }).pin,
    ).toMatchObject({
      reason: "published v2",
    });
    expect((await withBody("null")).status).toBe(422);
    expect((await withBody("{nope")).status).toBe(400);
    expect((await unpin(artifact.id, "inference:version:v2")).status).toBe(204);
    expect(
      (await t.json(`/v1/artifacts/${artifact.id}`, { method: "DELETE" }))
        .status,
    ).toBe(409);
    // A workspace admin can't drop serving's pin through the public API.
    const publicUnpin = await t.json<{ code: string; detail: string }>(
      `/v1/artifacts/${artifact.id}/pins/${encodeURIComponent(holder)}`,
      { method: "DELETE" },
    );
    expect(publicUnpin.status).toBe(403);
    expect(publicUnpin.body.code).toBe("pin_managed_by_cloud");
    expect(publicUnpin.body.detail).toMatch(/published model version/);
    // Other holders and pinning stay public.
    const own = await t.json(`/v1/artifacts/${artifact.id}/pins`, {
      body: { holder: "team:keep", reason: "kept by hand" },
    });
    expect(own.status).toBe(201);
    expect(
      (
        await t.json(`/v1/artifacts/${artifact.id}/pins/team:keep`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);

    expect((await setState("deleted")).status).toBe(200);
    await t.services.maintenance.tick();
    await t.services.maintenance.tick();
    const pending = await t.deps.store.workspaces.get(WORKSPACE_A);
    expect(pending?.purged_at).toBeNull();
    expect(pending?.last_error).toMatch(/1 pinned artifacts/);
    expect(await t.deps.storage.head(key)).not.toBeNull();

    expect((await unpin(artifact.id, holder)).status).toBe(204);
    expect((await unpin(artifact.id, holder)).status).toBe(204);
    clock.advanceSeconds(3601);
    await t.services.maintenance.tick();
    await t.services.maintenance.tick();
    expect(
      (await t.deps.store.workspaces.get(WORKSPACE_A))?.purged_at,
    ).not.toBeNull();
    expect(await t.deps.storage.head(key)).toBeNull();
  });
});

describe("workspace purge passes", () => {
  it("a dataset only evals use is purged once its evals are, never failing a pass", async () => {
    const t = await makeTestApp({ inferenceConfigured: true });
    try {
      await seedDataset(t, "qa", qaRecords(3));
      for (let i = 0; i < 3; i += 1) {
        await createEval(
          t.services.evals,
          WORKSPACE_A,
          PlanEvalRequestSchema.parse({
            name: `e${i}`,
            models: ["qwen/qwen3-8b"],
            dataset: "qa",
          }),
        );
      }
      // One row per table per pass: the evals outlive the first passes, so
      // their dataset must wait for them (grad_evals.dataset_id has no cascade).
      for (let pass = 0; pass < 10; pass += 1) {
        const { remainingRows } = await t.deps.store.workspaces.purgeRows(
          WORKSPACE_A,
          1,
        );
        if (remainingRows === 0) break;
      }
      expect((await t.json("/v1/evals")).body).toMatchObject({ data: [] });
      expect((await t.json("/v1/datasets")).body).toMatchObject({ data: [] });
    } finally {
      await t.close();
    }
  });
});
