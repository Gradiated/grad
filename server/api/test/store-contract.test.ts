import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResolvedRunConfig } from "../src/contracts.js";
import { ApiError } from "../src/errors.js";
import { loadMigrations, migrate } from "../src/store/migrate.js";
import type {
  DatasetPart,
  EvalOutputRow,
  RunRecord,
  Store,
} from "../src/store/types.js";
import { ManualClock } from "./fixtures/clock.js";
import { usageCommitted } from "./fixtures/cloud.js";
import { evalReport } from "./fixtures/eval-report.js";
import {
  createTestStore,
  dropSchema,
  freshSchemaName,
  postgresUrl,
} from "./fixtures/postgres.js";

type StoreFactory = (
  clock: ManualClock,
) => Promise<{ store: Store; dispose: () => Promise<void> }>;

const config = { model: "test/tiny" } as unknown as ResolvedRunConfig;

const part = (key: string, count = 2, resets = false): DatasetPart => ({
  key,
  count,
  resets,
  sha256: "a".repeat(64),
  bytes: count * 10,
});

const drain = async <T>(
  fetchPage: (cursor: string | undefined) => Promise<{
    data: T[];
    next_cursor: string | null;
  }>,
): Promise<{ rows: T[]; pages: number }> => {
  const rows: T[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await fetchPage(cursor);
    pages += 1;
    rows.push(...page.data);
    if (!page.next_cursor) return { rows, pages };
    cursor = page.next_cursor;
  }
};

const describeStoreContract = (name: string, factory: StoreFactory) =>
  describe(`store contract: ${name}`, () => {
    let clock: ManualClock;
    let store: Store;
    let dispose: () => Promise<void>;

    beforeEach(async () => {
      clock = new ManualClock();
      ({ store, dispose } = await factory(clock));
    });

    afterEach(async () => {
      await dispose();
    });

    const makeDataset = async (ws = "ws_a", dsName = "ds") =>
      store.datasets.getOrCreate({
        workspaceId: ws,
        name: dsName,
        metadata: {},
      });

    const makeRun = async (
      ws = "ws_a",
      overrides: Partial<{
        recipe: RunRecord["recipe_kind"];
        name: string;
        waitingOn: string;
      }> = {},
    ) => {
      const dataset = await makeDataset(ws);
      return store.runs.create({
        waitingOn: overrides.waitingOn,
        workspaceId: ws,
        name: overrides.name ?? "run",
        datasetId: dataset.id,
        datasetName: dataset.name,
        datasetVersion: 0,
        recipeKind: overrides.recipe ?? "sft",
        resolvedConfig: config,
        maxCostUsd: 10,
        pricePerMillionTokens: 0.4,
        totalSteps: 100,
        maxAttempts: 3,
      });
    };

    const makeEval = async (ws = "ws_a") => {
      const dataset = await makeDataset(ws);
      return store.evals.create({
        workspaceId: ws,
        maxAttempts: 3,
        totalOutputs: 8,
        name: "ev",
        models: ["m1", "m2"],
        model_targets: {
          m1: { inference_model: "m1", price_per_million_tokens: 1 },
          m2: { inference_model: "m2", price_per_million_tokens: null },
        },
        baseline: "m1",
        dataset_id: dataset.id,
        dataset_name: dataset.name,
        dataset_version: 0,
        rubric: [
          { name: "ok", kind: "validator", weight: 1, validator: "non_empty" },
        ],
        samples: 2,
        temperature: 0.7,
        max_tokens: 128,
        limit: null,
        pass_threshold: 0.5,
        judge_models: [],
        judge_targets: {},
        local_scorers: ["local_fn"],
        mode: "eval",
        run_id: null,
        run_step: null,
      });
    };

    // --- API keys --------------------------------------------------------

    it("api keys: create, find by hash, list, revoke with isolation", async () => {
      const { key, secret } = await store.apiKeys.create({
        workspaceId: "ws_a",
        name: "ci",
        scopes: ["datasets:read", "runs:write"],
        idempotency: { key: "k1", hash: "h" },
      });
      expect(await store.apiKeys.findIdempotent("ws_a", "k1")).toEqual({
        id: key.id,
        request_hash: "h",
      });
      expect(await store.apiKeys.findIdempotent("ws_b", "k1")).toBeNull();
      expect(secret.startsWith("grad_")).toBe(true);
      expect(key.prefix).toBe(secret.slice(0, 12));
      expect(key.revoked_at).toBeNull();
      expect(key.created_at).toBe(clock.now().toISOString());

      const { hashApiKey } = await import("../src/adapters.js");
      const found = await store.apiKeys.findActiveByHash(hashApiKey(secret));
      expect(found).toEqual({
        id: key.id,
        workspace_id: "ws_a",
        name: "ci",
        scopes: ["datasets:read", "runs:write"],
      });

      await store.apiKeys.create({
        workspaceId: "ws_b",
        name: "other",
        scopes: ["admin"],
      });
      const listed = await store.apiKeys.list("ws_a", { limit: 10 });
      expect(listed.data.map((k) => k.id)).toEqual([key.id]);
      expect(listed.next_cursor).toBeNull();

      expect(await store.apiKeys.revoke("ws_b", key.id)).toBeNull();
      clock.advanceSeconds(5);
      const revoked = await store.apiKeys.revoke("ws_a", key.id);
      expect(revoked?.revoked_at).toBe(clock.now().toISOString());
      clock.advanceSeconds(5);
      const again = await store.apiKeys.revoke("ws_a", key.id);
      expect(again?.revoked_at).toBe(revoked?.revoked_at);
      expect(
        await store.apiKeys.findActiveByHash(hashApiKey(secret)),
      ).toBeNull();
    });

    // --- Datasets --------------------------------------------------------

    it("datasets: create conflict, getOrCreate, version 0, isolation", async () => {
      const created = await store.datasets.create({
        workspaceId: "ws_a",
        name: "support",
        metadata: { team: "x" },
        idempotency: { key: "ds-k", hash: "dh" },
      });
      expect(await store.datasets.findIdempotent("ws_a", "ds-k")).toEqual({
        id: created?.id,
        request_hash: "dh",
      });
      expect(created).toMatchObject({
        version: 0,
        record_count: 0,
        metadata: { team: "x" },
      });
      expect(
        await store.datasets.create({
          workspaceId: "ws_a",
          name: "support",
          metadata: {},
        }),
      ).toBeNull();
      const same = await store.datasets.getOrCreate({
        workspaceId: "ws_a",
        name: "support",
        metadata: {},
      });
      expect(same.id).toBe(created?.id);

      const v0 = await store.datasets.getVersion(created!.id, 0);
      expect(v0).toMatchObject({ version: 0, parts: [], record_count: 0 });
      expect(await store.datasets.getVersion(created!.id, 1)).toBeNull();
      expect(await store.datasets.getVersion(created!.id, -1)).toBeNull();
      expect(await store.datasets.getVersion("ds_missing", 0)).toBeNull();

      expect(await store.datasets.get("ws_b", "support")).toBeNull();
      expect(await store.datasets.getById("ws_b", created!.id)).toBeNull();
      expect((await store.datasets.getById("ws_a", created!.id))?.name).toBe(
        "support",
      );
      const other = await store.datasets.create({
        workspaceId: "ws_b",
        name: "support",
        metadata: {},
      });
      expect(other?.id).not.toBe(created?.id);
      expect(
        (await store.datasets.list("ws_a", { limit: 10 })).data,
      ).toHaveLength(1);
    });

    it("datasets: appendVersion concatenates parts and merges metadata", async () => {
      const ds = await makeDataset();
      clock.advanceSeconds(1);
      const first = await store.datasets.appendVersion({
        datasetId: ds.id,
        parts: [part("p1", 3)],
        metadata: { a: 1 },
      });
      expect(first).toMatchObject({
        version: 1,
        record_count: 3,
        metadata: { a: 1 },
      });
      expect(first.updated_at).toBe(clock.now().toISOString());
      const second = await store.datasets.appendVersion({
        datasetId: ds.id,
        parts: [part("p2", 2), part("p3", 1)],
        metadata: { b: 2 },
        idempotency: { key: "push-1", hash: "h1" },
      });
      const v2 = await store.datasets.getVersion(ds.id, 2);
      expect(v2?.parts.map((p) => p.key)).toEqual(["p1", "p2", "p3"]);
      expect(v2?.record_count).toBe(6);
      expect(second.metadata).toEqual({ a: 1, b: 2 });
      expect(await store.datasets.findIdempotentPush(ds.id, "push-1")).toEqual({
        id: ds.id,
        request_hash: "h1",
      });
      expect(await store.datasets.findIdempotentPush(ds.id, "nope")).toBeNull();
      expect((await store.datasets.getVersion(ds.id, 1))?.parts).toEqual([
        part("p1", 3),
      ]);
      await expect(
        store.datasets.appendVersion({ datasetId: "ds_missing", parts: [] }),
      ).rejects.toThrow();

      // A resetting part (a full sync) restarts the count; later parts add.
      const reset = await store.datasets.appendVersion({
        datasetId: ds.id,
        parts: [part("p4", 0, true), part("p5", 2)],
      });
      expect(reset.record_count).toBe(2);
      expect((await store.datasets.getVersion(ds.id, 3))?.record_count).toBe(2);
      expect((await store.datasets.getVersion(ds.id, 2))?.record_count).toBe(6);
    });

    it("datasets: 10 concurrent appends produce versions 1..10 with every part", async () => {
      const ds = await makeDataset();
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          store.datasets.appendVersion({
            datasetId: ds.id,
            parts: [part(`c${i}`, 1)],
          }),
        ),
      );
      const latest = await store.datasets.get("ws_a", "ds");
      expect(latest).toMatchObject({ version: 10, record_count: 10 });
      const v10 = await store.datasets.getVersion(ds.id, 10);
      expect(new Set(v10?.parts.map((p) => p.key))).toEqual(
        new Set(Array.from({ length: 10 }, (_, i) => `c${i}`)),
      );
      for (let v = 1; v <= 10; v += 1) {
        expect((await store.datasets.getVersion(ds.id, v))?.parts).toHaveLength(
          v,
        );
      }
    });

    it("datasets: list pages newest first", async () => {
      for (let i = 0; i < 5; i += 1) {
        await makeDataset("ws_a", `d${i}`);
        clock.advanceSeconds(1);
      }
      const { rows, pages } = await drain((cursor) =>
        store.datasets.list("ws_a", { limit: 2, cursor }),
      );
      expect(pages).toBe(3);
      expect(rows.map((d) => d.name)).toEqual(["d4", "d3", "d2", "d1", "d0"]);
    });

    // --- Jobs: the one queue ---------------------------------------------

    it("jobs: one FIFO claim across kinds with workspace and recipe filters", async () => {
      const ds = await makeDataset();
      const imp = await store.imports.create({
        workspaceId: "ws_a",
        maxAttempts: 3,
        datasetId: ds.id,
        datasetName: ds.name,
        source: { kind: "hf", repo: "o/n" },
        connector: "auto",
        uploadKey: null,
      });
      clock.advanceSeconds(1);
      const dpo = await makeRun("ws_a", { recipe: "dpo" });
      clock.advanceSeconds(1);
      const other = await makeRun("ws_b");
      clock.advanceSeconds(1);
      const ev = await makeEval();

      const claim = (
        input: Partial<Parameters<Store["jobs"]["claimNext"]>[0]>,
      ) =>
        store.jobs.claimNext({
          workerId: "w1",
          workerKey: "key-a",
          leaseSeconds: 60,
          now: clock.now(),
          kinds: ["train", "import"],
          ...input,
        });
      expect(
        await claim({
          kinds: ["train"],
          recipes: ["sft"],
          workspaceId: "ws_a",
        }),
      ).toBeNull();
      const first = await claim({});
      expect(first).toMatchObject({
        id: imp.id,
        kind: "import",
        status: "running",
        attempt: 1,
        worker_id: "w1",
        worker_key: "key-a",
        lease_seconds: 60,
        billed_through: 0,
      });
      expect(first?.lease_expires_at).toBe(
        new Date(clock.now().getTime() + 60_000).toISOString(),
      );
      expect((await claim({ recipes: ["sft"] }))?.id).toBe(other.id);
      expect((await claim({}))?.id).toBe(dpo.id);
      expect(await claim({})).toBeNull();
      expect((await claim({ kinds: ["eval"] }))?.id).toBe(ev.id);

      const held = (input: Partial<Parameters<Store["jobs"]["heldBy"]>[0]>) =>
        store.jobs.heldBy({
          workerId: "w1",
          workerKey: "key-a",
          kinds: ["import"],
          ...input,
        });
      expect((await held({}))?.id).toBe(imp.id);
      expect((await held({ workspaceId: "ws_a" }))?.id).toBe(imp.id);
      expect(
        await held({ workerId: "w2", kinds: ["train", "import"] }),
      ).toBeNull();
      // A worker id is not an authority: another key, or another workspace
      // scope, reusing "w1" does not get its lease.
      expect(await held({ workerKey: "key-b" })).toBeNull();
      expect(await held({ workspaceId: "ws_b" })).toBeNull();
    });

    it("jobs: 20 concurrent claimers over 10 queued runs get unique runs", async () => {
      for (let i = 0; i < 10; i += 1) await makeRun("ws_a", { name: `r${i}` });
      const claimed = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          store.jobs.claimNext({
            workerId: `w${i}`,
            workerKey: "k",
            leaseSeconds: 60,
            now: clock.now(),
            kinds: ["train"],
          }),
        ),
      );
      const ids = claimed.flatMap((j) => (j ? [j.id] : []));
      expect(ids).toHaveLength(10);
      expect(new Set(ids).size).toBe(10);
    });

    it("jobs: a job waiting on another is not claimable until released", async () => {
      const ev = await makeEval();
      const run = await makeRun("ws_a", { waitingOn: ev.id });
      expect(run.waiting_on).toBe(ev.id);
      expect(
        await store.jobs.claimNext({
          workerId: "w",
          workerKey: "k",
          leaseSeconds: 60,
          now: clock.now(),
          kinds: ["train"],
        }),
      ).toBeNull();
      expect((await store.jobs.listWaitingOn(ev.id)).map((j) => j.id)).toEqual([
        run.id,
      ]);
      await store.runs.update(run.id, { waiting_on: null });
      expect(await store.jobs.listWaitingOn(ev.id)).toEqual([]);
      expect(
        (
          await store.jobs.claimNext({
            workerId: "w",
            workerKey: "k",
            leaseSeconds: 60,
            now: clock.now(),
            kinds: ["train"],
          })
        )?.id,
      ).toBe(run.id);
    });

    it("jobs: fenced updates, expired leases after a lease/3 grace, idempotency lookup", async () => {
      const run = await makeRun();
      await store.jobs.claimNext({
        workerId: "w1",
        workerKey: "k",
        leaseSeconds: 60,
        now: clock.now(),
        kinds: ["train"],
      });
      expect(
        await store.jobs.update(
          run.id,
          { lease_seconds: 90 },
          { workerId: "w2", attempt: 1 },
        ),
      ).toBeNull();
      expect(
        (
          await store.jobs.update(
            run.id,
            { error: "x" },
            { workerId: "w1", attempt: 1, status: ["running"] },
          )
        )?.error,
      ).toBe("x");

      clock.advanceSeconds(70);
      expect(await store.jobs.listExpiredLeases(clock.now(), 10)).toEqual([]);
      clock.advanceSeconds(11);
      const [expired] = await store.jobs.listExpiredLeases(clock.now(), 10);
      expect(expired?.id).toBe(run.id);
      expect(
        await store.jobs.update(
          run.id,
          { status: "queued" },
          { leaseExpiredBefore: new Date(0).toISOString() },
        ),
      ).toBeNull();
      expect(await store.jobs.getById("run_missing")).toBeNull();

      const keyed = await store.runs.create({
        workspaceId: "ws_a",
        maxAttempts: 3,
        idempotency: { key: "k", hash: "h" },
        name: "keyed",
        datasetId: run.dataset_id,
        datasetName: run.dataset_name,
        datasetVersion: 0,
        recipeKind: "sft",
        resolvedConfig: config,
        maxCostUsd: null,
        pricePerMillionTokens: 1,
        totalSteps: 1,
      });
      expect(await store.jobs.findIdempotent("ws_a", "k")).toEqual({
        id: keyed.id,
        request_hash: "h",
      });
      await expect(
        store.runs.create({
          workspaceId: "ws_a",
          maxAttempts: 3,
          idempotency: { key: "k", hash: "other" },
          name: "dup",
          datasetId: run.dataset_id,
          datasetName: run.dataset_name,
          datasetVersion: 0,
          recipeKind: "sft",
          resolvedConfig: config,
          maxCostUsd: null,
          pricePerMillionTokens: 1,
          totalSteps: 1,
        }),
      ).rejects.toThrow(/idempotency_key/);
    });

    it("jobs: the billed mark moves by compare-and-set, per attempt", async () => {
      const run = await makeRun();
      await store.jobs.claimNext({
        workerId: "w",
        workerKey: "k",
        leaseSeconds: 60,
        now: clock.now(),
        kinds: ["train"],
      });
      const advance = (from: number, through: number, attempt = 1) =>
        store.jobs.advanceBilling({
          id: run.id,
          attempt,
          from,
          through,
          cost: through / 1e6,
          at: clock.now(),
        });
      expect(await advance(0, 100)).toBe(true);
      expect(await advance(0, 150)).toBe(false);
      expect(await advance(100, 150, 2)).toBe(false);
      expect(await advance(100, 150)).toBe(true);
      expect(await store.jobs.getById(run.id)).toMatchObject({
        billed_through: 150,
        billed_cost: 0.00015,
        billed_at: clock.now().toISOString(),
      });
    });

    it("jobs: events are stored once per (job, attempt, type, step) and expire", async () => {
      const run = await makeRun();
      const first = await store.jobs.appendEvent({
        jobId: run.id,
        attempt: 1,
        type: "metric",
        step: 1,
        payload: { step: 1, loss: 2 },
      });
      const replay = await store.jobs.appendEvent({
        jobId: run.id,
        attempt: 1,
        type: "metric",
        step: 1,
        payload: { step: 1, loss: 999 },
      });
      expect(replay).toEqual(first);
      clock.advanceSeconds(10);
      await store.jobs.appendEvent({
        jobId: run.id,
        attempt: 2,
        type: "metric",
        step: 1,
        payload: { step: 1, loss: 1 },
      });
      await store.jobs.appendEvent({
        jobId: run.id,
        attempt: 2,
        type: "log",
        step: 1,
        payload: {},
      });
      const all = await store.jobs.listEvents(run.id, "metric", 0, 10);
      expect(all.map((e) => [e.attempt, e.payload.loss])).toEqual([
        [1, 2],
        [2, 1],
      ]);
      expect(
        await store.jobs.listEvents(run.id, "metric", first.seq, 10),
      ).toHaveLength(1);
      expect(await store.jobs.listEvents(run.id, "metric", 0, 1)).toHaveLength(
        1,
      );

      expect(
        await store.jobs.deleteEventsBefore(
          new Date(clock.now().getTime() - 5_000),
          10,
        ),
      ).toBe(1);
      expect(await store.jobs.listEvents(run.id, "metric", 0, 10)).toHaveLength(
        1,
      );
    });

    // --- Imports and staged parts -----------------------------------------

    it("imports: payload fields update with the job, staged parts commit as one version", async () => {
      const ds = await makeDataset();
      const imp = await store.imports.create({
        workspaceId: "ws_a",
        maxAttempts: 3,
        datasetId: ds.id,
        datasetName: ds.name,
        source: { kind: "upload", sha256: "f".repeat(64), upload_id: "x" },
        connector: "auto",
        uploadKey: "uploads/ws_a/f",
      });
      expect(imp).toMatchObject({
        kind: "import",
        status: "queued",
        dataset: "ds",
        upload_key: "uploads/ws_a/f",
        imported_count: 0,
        dataset_version: null,
      });
      expect(
        (await store.imports.findByUpload(ds.id, "f".repeat(64)))?.id,
      ).toBe(imp.id);
      expect(
        await store.imports.findByUpload(ds.id, "0".repeat(64)),
      ).toBeNull();
      expect(await store.imports.get("ws_b", imp.id)).toBeNull();
      expect(
        (await store.imports.list("ws_a", { limit: 10 })).data.map((j) => j.id),
      ).toEqual([imp.id]);

      const updated = await store.imports.update(imp.id, {
        imported_count: 3,
        detected_scores: ["a"],
        status: "running",
      });
      expect(updated).toMatchObject({
        imported_count: 3,
        detected_scores: ["a"],
        status: "running",
        source: { kind: "upload" },
      });

      const stage = (
        attempt: number,
        batch: number,
        p: DatasetPart | null,
        dropped = 0,
      ) =>
        store.datasets.stagePart({
          datasetId: ds.id,
          jobId: imp.id,
          attempt,
          batch,
          part: p,
          dropped,
        });
      expect(await stage(1, 0, part("a1-0", 2))).toBe(true);
      expect(await stage(2, 1, part("a2-1", 1))).toBe(true);
      expect(await stage(2, 0, part("a2-0", 2), 1)).toBe(true);
      expect(await stage(2, 0, part("a2-0", 2), 1)).toBe(false);
      expect(await stage(2, 2, null, 4)).toBe(true);
      expect(await store.datasets.listStaged(imp.id, 2)).toEqual({
        parts: [part("a2-0", 2), part("a2-1", 1)],
        dropped: 5,
        count: 3,
      });
      // Staged parts are invisible until committed.
      expect((await store.datasets.getVersion(ds.id, 0))?.parts).toEqual([]);

      const { dataset, orphanKeys } = await store.datasets.commitStaged({
        datasetId: ds.id,
        jobId: imp.id,
        attempt: 2,
      });
      expect(dataset).toMatchObject({ version: 1, record_count: 3 });
      expect(orphanKeys).toEqual(["a1-0"]);
      expect(
        (await store.datasets.getVersion(ds.id, 1))?.parts.map((p) => p.key),
      ).toEqual(["a2-0", "a2-1"]);
      expect(await store.datasets.discardStaged(imp.id)).toEqual([]);
      expect(await stage(3, 0, part("a3-0", 1))).toBe(true);
      expect(await store.datasets.discardStaged(imp.id)).toEqual(["a3-0"]);
    });

    // --- Runs ------------------------------------------------------------

    it("runs: create defaults, isolation, split updates, paging", async () => {
      const run = await makeRun();
      expect(run).toMatchObject({
        kind: "train",
        status: "queued",
        attempt: 0,
        failed_attempts: 0,
        max_attempts: 3,
        worker_id: null,
        billed_tokens: 0,
        attempt_tokens: 0,
        latest_metric: null,
        waiting_on: null,
        finished_at: null,
      });
      expect(await store.runs.get("ws_b", run.id)).toBeNull();
      const updated = await store.runs.update(
        run.id,
        { status: "running", attempt_tokens: 5, current_step: 2, error: "e" },
        { status: ["queued"] },
      );
      expect(updated).toMatchObject({
        status: "running",
        attempt_tokens: 5,
        current_step: 2,
        error: "e",
      });
      // A failed expectation applies neither table's fields.
      expect(
        await store.runs.update(
          run.id,
          { attempt_tokens: 99, status: "failed" },
          { status: ["queued"] },
        ),
      ).toBeNull();
      expect((await store.runs.getById(run.id))?.attempt_tokens).toBe(5);

      for (let i = 0; i < 4; i += 1) {
        clock.advanceSeconds(1);
        await makeRun("ws_a", { name: `r${i}` });
      }
      const { rows, pages } = await drain((cursor) =>
        store.runs.list("ws_a", { limit: 2, cursor }),
      );
      expect(pages).toBe(3);
      expect(new Set(rows.map((r) => r.id)).size).toBe(5);
      expect(rows[0]?.name).toBe("r3");
    });

    it("pagination: malformed cursors are rejected with 422", async () => {
      for (const cursor of [
        "not-base64!",
        "e30",
        Buffer.from("[1]").toString("base64url"),
      ]) {
        await expect(
          store.runs.list("ws_a", { limit: 2, cursor }),
        ).rejects.toBeInstanceOf(ApiError);
      }
    });

    // --- Artifacts: checkpoints and releases -----------------------------

    it("artifacts: checkpoints are unique per (run, attempt, step), pin, page and expire", async () => {
      const run = await makeRun();
      const insert = (
        attempt: number,
        step: number,
        key: string,
        expiresAt: string | null,
      ) =>
        store.artifacts.insertCheckpoint({
          workspaceId: "ws_a",
          runId: run.id,
          attempt,
          step,
          evalScore: step / 10,
          format: step === 2 ? "peft_lora" : null,
          baseModel: "test/tiny",
          recipeKind: "sft",
          storageKey: key,
          sha256: "b".repeat(64),
          sizeBytes: 3,
          metadata: { s: step },
          expiresAt,
        });
      const soon = new Date(clock.now().getTime() + 60_000).toISOString();
      const first = await insert(1, 1, "k1", soon);
      expect(first.created).toBe(true);
      expect(first.checkpoint).toMatchObject({
        run_id: run.id,
        attempt: 1,
        step: 1,
        format: null,
        metadata: { s: 1 },
        best: false,
      });
      const again = await insert(1, 1, "other", soon);
      expect(again).toEqual({ checkpoint: first.checkpoint, created: false });
      await insert(1, 2, "k2", soon);
      await insert(2, 2, "k3", soon);
      expect(
        await store.artifacts.getCheckpoint("ws_b", first.checkpoint.id),
      ).toBeNull();

      const { rows } = await drain((cursor) =>
        store.artifacts.listCheckpoints(
          "ws_a",
          run.id,
          { limit: 2, cursor },
          clock.now(),
        ),
      );
      expect(rows.map((c) => [c.attempt, c.step])).toEqual([
        [1, 1],
        [1, 2],
        [2, 2],
      ]);
      const all = await store.artifacts.allCheckpoints(run.id, clock.now());
      const k2 = all.find((c) => c.storage_key === "k2")!;
      const k3 = all.find((c) => c.storage_key === "k3")!;
      await store.artifacts.pinCheckpoints(run.id, {
        bestId: k2.id,
        finalId: k3.id,
      });

      // A release promoted from k1 shares its blob: expiry keeps the blob.
      await store.artifacts.createRelease({
        workspaceId: "ws_a",
        name: "rel",
        runId: run.id,
        sourceId: first.checkpoint.id,
        baseModel: "test/tiny",
        recipeKind: "sft",
        format: "peft_lora",
        storageKey: "k1",
        sha256: "b".repeat(64),
        sizeBytes: 3,
        manifest: {},
        evalReport: null,
      });
      clock.advanceSeconds(120);
      expect(
        (await store.artifacts.allCheckpoints(run.id, clock.now())).map((c) => [
          c.storage_key,
          c.best,
          c.final,
          c.expires_at,
        ]),
      ).toEqual([
        ["k2", true, false, null],
        ["k3", false, true, null],
      ]);
      expect(
        await store.artifacts.deleteExpiredCheckpoints(clock.now(), 10),
      ).toEqual([]);
      expect(
        await store.artifacts.getCheckpoint("ws_a", first.checkpoint.id),
      ).toBeNull();
      expect(
        (await store.artifacts.get("ws_a", "rel@latest"))?.storage_key,
      ).toBe("k1");

      await insert(3, 1, "k4", clock.now().toISOString());
      clock.advanceSeconds(1);
      expect(
        await store.artifacts.deleteExpiredCheckpoints(clock.now(), 10),
      ).toEqual(["k4"]);
    });

    it("artifacts: releases version per day, @latest, promoted lookup, list and isolation", async () => {
      const release = (
        name: string,
        ws = "ws_a",
        sourceId: string | null = null,
      ) =>
        store.artifacts.createRelease({
          workspaceId: ws,
          name,
          runId: null,
          sourceId,
          baseModel: "test/tiny",
          recipeKind: "sft",
          format: "peft_lora",
          storageKey: `k/${name}`,
          sha256: "c".repeat(64),
          sizeBytes: 1,
          manifest: { m: 1 },
          evalReport: null,
        });
      clock.set(new Date("2026-11-27T23:59:00.000Z"));
      const a1 = await release("a");
      const a2 = await release("a", "ws_a", "ckpt_x");
      clock.set(new Date("2026-11-28T00:01:00.000Z"));
      const a3 = await release("a");
      await release("a", "ws_b");
      expect([a1.id, a2.id, a3.id]).toEqual([
        "a@2026-11-27-1",
        "a@2026-11-27-2",
        "a@2026-11-28-1",
      ]);
      expect(a2.checkpoint_id).toBe("ckpt_x");
      expect((await store.artifacts.get("ws_a", "a@latest"))?.id).toBe(a3.id);
      expect(await store.artifacts.get("ws_a", "b@latest")).toBeNull();
      expect(await store.artifacts.get("ws_b", a1.id)).toBeNull();
      // (checkpoint, name) is the natural key: concurrent duplicates get one
      // release (r8 E2: 8 concurrent promotes made 4).
      const dups = await Promise.all(
        Array.from({ length: 8 }, () => release("a", "ws_a", "ckpt_x")),
      );
      expect(new Set(dups.map((d) => d.id))).toEqual(new Set([a2.id]));
      const listed = await store.artifacts.list(
        "ws_a",
        { name: "a" },
        { limit: 10 },
      );
      expect(listed.data.map((x) => x.id)).toEqual([a3.id, a2.id, a1.id]);
      expect(
        (await store.artifacts.list("ws_a", {}, { limit: 10 })).data,
      ).toHaveLength(3);
    });

    it("artifacts: 10 concurrent creates get unique versions", async () => {
      const made = await Promise.all(
        Array.from({ length: 10 }, () =>
          store.artifacts.createRelease({
            workspaceId: "ws_a",
            name: "par",
            runId: null,
            sourceId: null,
            baseModel: "m",
            recipeKind: "sft",
            format: "peft_lora",
            storageKey: "k",
            sha256: "d".repeat(64),
            sizeBytes: 1,
            manifest: {},
            evalReport: evalReport(),
          }),
        ),
      );
      expect(new Set(made.map((a) => a.id)).size).toBe(10);
      expect(
        (await store.artifacts.get("ws_a", "par@latest"))?.version,
      ).toMatch(/-10$/);
    });

    // --- Evals -----------------------------------------------------------

    it("evals: create, split updates, awaiting list, isolation", async () => {
      const ev = await makeEval();
      expect(ev).toMatchObject({
        kind: "eval",
        status: "queued",
        attempt: 0,
        total_outputs: 8,
        generated: 0,
        summary: [],
        local_scorers: ["local_fn"],
      });
      expect(await store.evals.get("ws_b", ev.id)).toBeNull();
      const updated = await store.evals.update(ev.id, {
        status: "awaiting_scores",
        generated: 4,
        summary: [],
      });
      expect(updated).toMatchObject({
        status: "awaiting_scores",
        generated: 4,
      });
      expect(
        (await store.evals.listAwaitingScores(10)).map((e) => e.id),
      ).toEqual([ev.id]);
      expect((await store.evals.list("ws_a", { limit: 5 })).data).toHaveLength(
        1,
      );
    });

    it("evals: outputs are first-write-wins; scores, usage per attempt and results", async () => {
      const ev = await makeEval();
      const output = (
        model: string,
        task: number,
        sample: number,
        attempt = 1,
        extra: Partial<EvalOutputRow> = {},
      ): EvalOutputRow => ({
        id: `o_${model}_${task}_${sample}`,
        eval_id: ev.id,
        attempt,
        task_index: task,
        task_id: `t${task}`,
        model,
        sample_index: sample,
        record: { id: `t${task}`, messages: [] },
        input: [],
        output: "x",
        expected_output: null,
        scores: {},
        error: null,
        prompt_tokens: 10,
        completion_tokens: 5,
        cost_usd: 0.01,
        created_at: clock.now().toISOString(),
        ...extra,
      });
      expect(await store.evals.insertOutputs([])).toBe(0);
      expect(
        await store.evals.insertOutputs(
          (
            [
              ["m1", 0, 0, 1],
              ["m1", 0, 1, 1],
              ["m2", 0, 0, 2],
              ["m1", 1, 0, 2],
            ] as const
          ).map(([m, task, sample, attempt]) =>
            output(m, task, sample, attempt),
          ),
        ),
      ).toBe(4);
      // First write wins: a replayed key (even twice in one batch) adds nothing.
      expect(
        await store.evals.insertOutputs([
          output("m1", 0, 0, 3, { output: "changed" }),
          output("m2", 1, 0, 2, { output: null, error: "boom" }),
          output("m2", 1, 0, 2, { output: null, error: "again" }),
        ]),
      ).toBe(1);
      expect(await store.evals.countOutputs(ev.id)).toBe(5);

      expect(await store.evals.listOutputKeys(ev.id)).toEqual(
        new Set([
          "m1\u00000\u00000",
          "m1\u00000\u00001",
          "m2\u00000\u00000",
          "m1\u00001\u00000",
          "m2\u00001\u00000",
        ]),
      );
      const { rows } = await drain((cursor) =>
        store.evals.listOutputs(ev.id, {}, { limit: 2, cursor }),
      );
      expect(rows.map((o) => o.id)).toEqual([
        "o_m1_0_0",
        "o_m1_0_1",
        "o_m2_0_0",
        "o_m1_1_0",
        "o_m2_1_0",
      ]);
      expect(rows[0]?.output).toBe("x");
      expect(rows[0]?.record).toEqual({ id: "t0", messages: [] });
      expect(
        (await store.evals.listOutputs(ev.id, { model: "m2" }, { limit: 10 }))
          .data,
      ).toHaveLength(2);

      expect(await store.evals.attemptUsage(ev.id, 2)).toEqual({
        tokens: 45,
        cost_usd: 0.03,
      });
      expect(await store.evals.attemptUsage(ev.id, 9)).toEqual({
        tokens: 0,
        cost_usd: 0,
      });

      expect(await store.evals.countMissingScores(ev.id, ["local_fn"])).toBe(4);
      expect(await store.evals.countMissingScores(ev.id, [])).toBe(0);
      expect(
        await store.evals.setScores(ev.id, [
          { output_id: "o_m1_0_0", scorer: "local_fn", score: 1 },
          { output_id: "o_m1_0_0", scorer: "other", score: 0 },
          { output_id: "o_missing", scorer: "local_fn", score: 1 },
        ]),
      ).toBe(2);
      expect(await store.evals.setScores(ev.id, [])).toBe(0);
      expect(await store.evals.countMissingScores(ev.id, ["local_fn"])).toBe(3);
      expect(
        (
          await store.evals.listOutputs(
            ev.id,
            { missingScorer: "local_fn" },
            { limit: 10 },
          )
        ).data,
      ).toHaveLength(3);

      await store.evals.setCombinedScores(ev.id, [
        { id: "o_m1_0_0", score: 1 },
        { id: "o_m1_0_1", score: 0.33333 },
        { id: "o_m2_0_0", score: 0.5 },
        { id: "o_m1_1_0", score: 0.2 },
      ]);
      await store.evals.setCombinedScores(ev.id, []);
      const results = await drain((cursor) =>
        store.evals.listResults(
          ev.id,
          { passThreshold: 0.5 },
          { limit: 2, cursor },
        ),
      );
      expect(
        results.rows.map((r) => [
          r.task_index,
          r.model,
          r.score,
          r.passed,
          r.sample_scores,
        ]),
      ).toEqual([
        [0, "m1", 0.6667, true, [1, 0.3333]],
        [0, "m2", 0.5, true, [0.5]],
        [1, "m1", 0.2, false, [0.2]],
        [1, "m2", 0, false, [0]],
      ]);
      expect(results.rows[0]?.record).toEqual({ id: "t0", messages: [] });
      const failing = await store.evals.listResults(
        ev.id,
        { passThreshold: 0.5, maxScore: 0.5, model: "m1" },
        { limit: 10 },
      );
      expect(failing.data.map((r) => r.task_id)).toEqual(["t1"]);
    });

    // --- Usage ledger ------------------------------------------------------

    it("usage: idempotent rows, newest-first pages, export cursor reads", async () => {
      const row = (key: string, ws = "ws_a", from = 0, through = 10) =>
        store.usage.record({
          idempotencyKey: key,
          workspaceId: ws,
          kind: "run",
          refId: "run_1",
          attempt: 1,
          tokensFrom: from,
          tokensThrough: through,
          costUsd: 0.5,
          priceVersion: "p_1",
        });
      const first = await row("k1");
      expect(first).toMatchObject({
        tokens_from: 0,
        tokens_through: 10,
        tokens: 10,
        cost_usd: 0.5,
        price_version: "p_1",
        idempotency_key: "k1",
      });
      expect(await row("k1", "ws_a", 0, 99)).toEqual(first);
      await row("k2", "ws_a", 10, 30);
      await row("k3", "ws_b", 0, 5);
      const { rows, pages } = await drain((cursor) =>
        store.usage.list("ws_a", {}, { limit: 1, cursor }),
      );
      expect(pages).toBe(2);
      expect(rows.map((u) => u.idempotency_key)).toEqual(["k2", "k1"]);
      expect(
        (await store.usage.listByRef("run_1")).map((u) => u.tokens),
      ).toEqual([10, 20, 5]);

      // The exporter: batches in commit order from the shared cursor.
      await usageCommitted();
      expect(await store.usage.exportBacklog()).toMatchObject({ rows: 3 });
      const pushed: string[][] = [];
      expect(
        await store.usage.exportBatch(2, async (rows) => {
          pushed.push(
            rows.map((u) => `${u.idempotency_key}:${u.workspace_id}`),
          );
        }),
      ).toBe(2);
      await expect(
        store.usage.exportBatch(2, async () => {
          throw new Error("ingest down");
        }),
      ).rejects.toThrow("ingest down");
      expect(
        await store.usage.exportBatch(2, async (rows) => {
          pushed.push(
            rows.map((u) => `${u.idempotency_key}:${u.workspace_id}`),
          );
        }),
      ).toBe(1);
      expect(await store.usage.exportBatch(2, async () => undefined)).toBe(0);
      expect(pushed).toEqual([["k1:ws_a", "k2:ws_a"], ["k3:ws_b"]]);
      expect(await store.usage.exportBacklog()).toEqual({
        rows: 0,
        oldest: null,
      });
    });

    it("transactions: commit, rollback on throw, nested reuse", async () => {
      const committed = await store.transaction(async (tx) => {
        const run = await makeRun();
        return tx.runs.update(run.id, { current_step: 9 });
      });
      expect((await store.runs.getById(committed!.id))?.current_step).toBe(9);

      let rolledBack: string | undefined;
      await expect(
        store.transaction(async (tx) => {
          const ds = await tx.datasets.create({
            workspaceId: "ws_t",
            name: "tx",
            metadata: {},
          });
          rolledBack = ds?.id;
          await store.runs.update(committed!.id, { current_step: 50 });
          await store.transaction(async (inner) => {
            await inner.usage.record({
              idempotencyKey: "nested",
              workspaceId: "ws_t",
              kind: "run",
              refId: committed!.id,
              attempt: 1,
              tokensFrom: 0,
              tokensThrough: 1,
              costUsd: 0,
              priceVersion: "p",
            });
          });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(rolledBack).toBeDefined();
      expect(await store.datasets.get("ws_t", "tx")).toBeNull();
      expect((await store.runs.getById(committed!.id))?.current_step).toBe(9);
      expect(await store.usage.listByRef(committed!.id)).toEqual([]);

      const nested = await store.transaction(async () =>
        store.transaction(async (inner) => {
          await inner.usage.record({
            idempotencyKey: "nested-ok",
            workspaceId: "ws_t",
            kind: "eval",
            refId: committed!.id,
            attempt: 1,
            tokensFrom: 0,
            tokensThrough: 1,
            costUsd: 0,
            priceVersion: "p",
          });
          return "ok";
        }),
      );
      expect(nested).toBe("ok");
      const [entry] = await store.usage.listByRef(committed!.id);
      expect(entry?.kind).toBe("eval");
      expect(await store.ping()).toBe(true);
    });

    it("transactions: a failed nested block rolls back alone; the outer one commits", async () => {
      await store.transaction(async (tx) => {
        await tx.datasets.create({
          workspaceId: "ws_t",
          name: "outer",
          metadata: {},
        });
        await expect(
          store.transaction(async (inner) => {
            await inner.datasets.create({
              workspaceId: "ws_t",
              name: "inner",
              metadata: {},
            });
            throw new Error("inner failed");
          }),
        ).rejects.toThrow("inner failed");
        await tx.datasets.create({
          workspaceId: "ws_t",
          name: "after",
          metadata: {},
        });
      });
      expect(await store.datasets.get("ws_t", "outer")).not.toBeNull();
      expect(await store.datasets.get("ws_t", "inner")).toBeNull();
      expect(await store.datasets.get("ws_t", "after")).not.toBeNull();
    });
  });

describe("migration files", () => {
  it("refuses two migrations with the same version", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = await mkdtemp(
      path.join(process.env.TMPDIR ?? "/tmp", "grad-mig-"),
    );
    try {
      await writeFile(path.join(dir, "0002_a.sql"), "SELECT 1;");
      await writeFile(path.join(dir, "0002_b.sql"), "SELECT 2;");
      await expect(loadMigrations(dir)).rejects.toThrow(/share version 0002/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describeStoreContract("postgres", createTestStore);

const url = postgresUrl();

describe("postgres migrations", () => {
  const withPool = async <T>(fn: (pool: pg.Pool) => Promise<T>): Promise<T> => {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    try {
      return await fn(pool);
    } finally {
      await pool.end();
    }
  };

  it("applies on a fresh schema, re-runs as a no-op", async () => {
    const schema = freshSchemaName();
    try {
      const versions = (await loadMigrations()).map((m) => m.version);
      expect(versions[0]).toBe("0001");
      await withPool(async (pool) => {
        expect(await migrate(pool, { schema })).toEqual(versions);
        expect(await migrate(pool, { schema })).toEqual([]);
        const { rows } = await pool.query(
          `SELECT version FROM "${schema}".grad_schema_migrations ORDER BY version`,
        );
        expect(rows).toEqual(versions.map((version) => ({ version })));
      });
    } finally {
      await dropSchema(url, schema);
    }
  });

  it("6 concurrent migrate() calls all succeed", async () => {
    const schema = freshSchemaName();
    try {
      await withPool(async (pool) => {
        const results = await Promise.all(
          Array.from({ length: 6 }, () => migrate(pool, { schema })),
        );
        const versions = (await loadMigrations()).map((m) => m.version);
        expect(results.flat().sort()).toEqual(versions);
        const { rows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM "${schema}".grad_schema_migrations`,
        );
        expect(rows[0]).toEqual({ n: versions.length });
      });
    } finally {
      await dropSchema(url, schema);
    }
  });

  it("rolls back a failing migration and reports it", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = await mkdtemp(
      path.join(process.env.TMPDIR ?? "/tmp", "grad-mig-"),
    );
    const schema = freshSchemaName();
    try {
      await writeFile(
        path.join(dir, "0001_ok.sql"),
        "CREATE TABLE t_ok (id int);",
      );
      await writeFile(
        path.join(dir, "0002_bad.sql"),
        "CREATE TABLE t_bad (id int); SELECT broken;",
      );
      await withPool(async (pool) => {
        await expect(migrate(pool, { schema, dir })).rejects.toThrow(
          /0002_bad\.sql failed/,
        );
        const { rows } = await pool.query(
          `SELECT to_regclass('"${schema}".t_bad') AS bad, to_regclass('"${schema}".t_ok') AS ok`,
        );
        expect(rows[0]).toMatchObject({ bad: null });
        expect(rows[0]?.ok).not.toBeNull();
      });
    } finally {
      await dropSchema(url, schema);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("postgres store lifecycle", () => {
  it("rejects bad schema names; ping fails after close", async () => {
    const { createPostgresStore } = await import("../src/store/postgres.js");
    const clock = new ManualClock();
    expect(() =>
      createPostgresStore({
        clock,
        connectionString: url,
        schema: "Bad-Name",
      }),
    ).toThrow(/Invalid schema/);

    const owned = createPostgresStore({ clock, connectionString: url });
    expect(await owned.ping()).toBe(true);
    await owned.close();
    expect(await owned.ping()).toBe(false);
  });
});
