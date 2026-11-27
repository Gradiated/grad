import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MetricPointInput, ResolvedRunConfig } from "../src/contracts.js";
import { ApiError } from "../src/errors.js";
import { loadMigrations, migrate } from "../src/store/migrate.js";
import type { DatasetPart, RunRecord, Store } from "../src/store/types.js";
import { ManualClock } from "./fixtures/clock.js";
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

const part = (key: string, count = 2): DatasetPart => ({
  key,
  count,
  sha256: "a".repeat(64),
  bytes: count * 10,
});

const metric = (step: number, extra: Record<string, number> = {}) =>
  ({
    step,
    loss: 1 / (step + 1),
    tokens: step * 100,
    timestamp: "2026-11-27T12:00:00.000Z",
    cost_usd: step * 0.01,
    ...extra,
  }) as MetricPointInput & { cost_usd: number };

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
        maxCostMicroUsd: 10_000_000,
        pricePerMillionTokens: 0.4,
        totalSteps: 100,
        maxAttempts: 3,
      });
    };

    const makeEval = async (ws = "ws_a") => {
      const dataset = await makeDataset(ws);
      return store.evals.create({
        workspace_id: ws,
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
        local_scorers: ["local_fn"],
      });
    };

    // --- API keys --------------------------------------------------------

    it("api keys: create, find by hash, list, revoke with isolation", async () => {
      const { key, secret } = await store.apiKeys.create({
        workspaceId: "ws_a",
        name: "ci",
        scopes: ["datasets:read", "runs:write"],
      });
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
      expect(first.dataset).toMatchObject({
        version: 1,
        record_count: 3,
        metadata: { a: 1 },
      });
      expect(first.dataset.updated_at).toBe(clock.now().toISOString());
      const second = await store.datasets.appendVersion({
        datasetId: ds.id,
        parts: [part("p2", 2), part("p3", 1)],
        metadata: { b: 2 },
      });
      expect(second.version.parts.map((p) => p.key)).toEqual([
        "p1",
        "p2",
        "p3",
      ]);
      expect(second.version.record_count).toBe(6);
      expect(second.dataset.metadata).toEqual({ a: 1, b: 2 });
      expect((await store.datasets.getVersion(ds.id, 1))?.parts).toEqual([
        part("p1", 3),
      ]);
      await expect(
        store.datasets.appendVersion({ datasetId: "ds_missing", parts: [] }),
      ).rejects.toThrow();
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

    // --- Import jobs -----------------------------------------------------

    it("imports: claim FIFO, CAS update, leases, parts, counts", async () => {
      const ds = await makeDataset();
      const mk = (ws: string) =>
        store.imports.create({
          workspaceId: ws,
          datasetId: ds.id,
          datasetName: ds.name,
          source: { kind: "upload", upload_id: "up_1" },
          connector: "auto",
          uploadKey: "uploads/x",
        });
      const a = await mk("ws_a");
      clock.advanceSeconds(1);
      const b = await mk("ws_b");
      expect(a).toMatchObject({
        status: "queued",
        attempt: 0,
        lease_seconds: 0,
        worker_id: null,
        imported_count: 0,
        detected_scores: [],
        dataset_version: null,
        upload_key: "uploads/x",
      });
      expect(await store.imports.get("ws_b", a.id)).toBeNull();
      expect((await store.imports.getById(a.id))?.dataset).toBe("ds");

      const onlyB = await store.imports.claimNext({
        workerId: "w1",
        leaseSeconds: 60,
        now: clock.now(),
        workspaceId: "ws_b",
      });
      expect(onlyB?.id).toBe(b.id);
      const claimed = await store.imports.claimNext({
        workerId: "w1",
        leaseSeconds: 60,
        now: clock.now(),
      });
      expect(claimed).toMatchObject({
        id: a.id,
        status: "running",
        attempt: 1,
        worker_id: "w1",
        lease_seconds: 60,
      });
      expect(claimed?.lease_expires_at).toBe(
        new Date(clock.now().getTime() + 60_000).toISOString(),
      );
      expect(
        await store.imports.claimNext({
          workerId: "w2",
          leaseSeconds: 60,
          now: clock.now(),
        }),
      ).toBeNull();

      expect(
        await store.imports.update(
          a.id,
          { imported_count: 5 },
          { workerId: "other" },
        ),
      ).toBeNull();
      expect(
        await store.imports.update(
          a.id,
          { imported_count: 5 },
          { status: ["queued"] },
        ),
      ).toBeNull();
      expect(
        await store.imports.update(a.id, { imported_count: 5 }, { attempt: 2 }),
      ).toBeNull();
      const updated = await store.imports.update(
        a.id,
        {
          imported_count: 5,
          detected_scores: ["tests_passed"],
          dataset_version: 3,
        },
        { status: ["running"], workerId: "w1", attempt: 1 },
      );
      expect(updated).toMatchObject({
        imported_count: 5,
        detected_scores: ["tests_passed"],
        dataset_version: 3,
      });

      expect(await store.imports.listExpiredLeases(clock.now(), 10)).toEqual(
        [],
      );
      clock.advanceSeconds(61);
      const expired = await store.imports.listExpiredLeases(clock.now(), 10);
      expect(expired.map((j) => j.id).sort()).toEqual([a.id, b.id].sort());

      const add = (attempt: number, batch: number, key: string | null) =>
        store.imports.addPart({
          importId: a.id,
          attempt,
          batch,
          part: key === null ? null : part(key),
          dropped: 1,
        });
      expect(await add(1, 1, "i2")).toBe(true);
      expect(await add(1, 0, "i1")).toBe(true);
      expect(await add(1, 2, null)).toBe(true);
      // A retried batch is stored once, whatever it carries.
      expect(await add(1, 0, "i1-retry")).toBe(false);
      expect(await add(2, 0, "i3")).toBe(true);
      const attempt1 = await store.imports.listParts(a.id, 1);
      expect(attempt1.parts.map((p) => p.key)).toEqual(["i1", "i2"]);
      expect(attempt1.dropped).toBe(3);
      expect(await store.imports.listParts(a.id, 3)).toEqual({
        parts: [],
        dropped: 0,
      });

      const released = await store.imports.update(a.id, {
        worker_id: null,
        lease_expires_at: null,
        status: "completed",
      });
      expect(released?.worker_id).toBeNull();
      expect(
        (await store.imports.list("ws_a", { limit: 10 })).data.map((j) => j.id),
      ).toEqual([a.id]);
    });

    // --- Runs ------------------------------------------------------------

    it("runs: create defaults, isolation, CAS update", async () => {
      const run = await makeRun();
      expect(run).toMatchObject({
        status: "queued",
        attempt: 0,
        failed_attempts: 0,
        billed_tokens: 0,
        billed_micro_usd: 0,
        attempt_tokens: 0,
        lease_seconds: 0,
        worker_id: null,
        latest_metric: null,
        max_cost_micro_usd: 10_000_000,
        price_per_million_tokens: 0.4,
        max_attempts: 3,
        resolved_config: config,
        finished_at: null,
      });
      expect(await store.runs.get("ws_b", run.id)).toBeNull();
      expect((await store.runs.getById(run.id))?.id).toBe(run.id);
      expect(await store.runs.getById("run_missing")).toBeNull();

      clock.advanceSeconds(3);
      const point = { ...metric(4), seq: 1, attempt: 1 };
      const updated = await store.runs.update(
        run.id,
        {
          current_step: 4,
          latest_metric: point as never,
          eval_report: evalReport({ acc: 0.9 }),
          billed_micro_usd: 1_250_000,
          billed_tokens: 12345678901,
          finished_at: clock.now().toISOString(),
        },
        { status: ["queued"], workerId: null, attempt: 0 },
      );
      expect(updated).toMatchObject({
        current_step: 4,
        eval_report: evalReport({ acc: 0.9 }),
        billed_micro_usd: 1_250_000,
        billed_tokens: 12345678901,
        updated_at: clock.now().toISOString(),
        finished_at: clock.now().toISOString(),
      });
      expect(updated?.latest_metric).toEqual(point);
      expect(
        await store.runs.update(
          run.id,
          { error: "x" },
          { status: ["running"] },
        ),
      ).toBeNull();
      expect(await store.runs.update("run_missing", { error: "x" })).toBeNull();
      const cleared = await store.runs.update(run.id, {
        eval_report: null,
        latest_metric: null,
      });
      expect(cleared).toMatchObject({ eval_report: null, latest_metric: null });
    });

    it("runs: claimNext FIFO with workspace and recipe filters", async () => {
      const r1 = await makeRun("ws_a", { recipe: "sft" });
      clock.advanceSeconds(1);
      const r2 = await makeRun("ws_b", { recipe: "dpo" });
      clock.advanceSeconds(1);
      const r3 = await makeRun("ws_a", { recipe: "router" });
      const now = clock.now();

      expect(
        await store.runs.claimNext({
          workerId: "w",
          leaseSeconds: 30,
          now,
          recipes: ["embedding"],
        }),
      ).toBeNull();
      const dpo = await store.runs.claimNext({
        workerId: "w",
        leaseSeconds: 30,
        now,
        recipes: ["dpo", "router"],
      });
      expect(dpo?.id).toBe(r2.id);
      const wsA = await store.runs.claimNext({
        workerId: "w",
        leaseSeconds: 30,
        now,
        workspaceId: "ws_a",
      });
      expect(wsA).toMatchObject({
        id: r1.id,
        status: "running",
        attempt: 1,
        worker_id: "w",
        lease_seconds: 30,
        attempt_tokens: 0,
      });
      expect(wsA?.lease_expires_at).toBe(
        new Date(now.getTime() + 30_000).toISOString(),
      );
      const last = await store.runs.claimNext({
        workerId: "w",
        leaseSeconds: 30,
        now,
      });
      expect(last?.id).toBe(r3.id);
      expect(
        await store.runs.claimNext({ workerId: "w", leaseSeconds: 30, now }),
      ).toBeNull();

      await store.runs.update(r1.id, {
        status: "queued",
        worker_id: null,
        lease_expires_at: null,
        attempt_tokens: 77,
      });
      const again = await store.runs.claimNext({
        workerId: "w2",
        leaseSeconds: 45,
        now,
      });
      expect(again).toMatchObject({
        id: r1.id,
        attempt: 2,
        attempt_tokens: 0,
        lease_seconds: 45,
      });
    });

    it("runs: a run waiting on its labeling eval is not claimable until released", async () => {
      const ready = await makeRun();
      clock.advanceSeconds(1);
      const waiting = await makeRun("ws_a", { waitingOn: "eval_1" });
      expect(waiting).toMatchObject({ waiting_on: "eval_1" });
      expect(ready).toMatchObject({ waiting_on: null });
      expect(
        (await store.runs.listWaitingOn("eval_1")).map((r) => r.id),
      ).toEqual([waiting.id]);

      const claim = () =>
        store.runs.claimNext({
          workerId: "w",
          leaseSeconds: 30,
          now: clock.now(),
        });
      expect((await claim())?.id).toBe(ready.id);
      expect(await claim()).toBeNull();

      await store.runs.update(
        waiting.id,
        { waiting_on: null },
        { status: ["queued"] },
      );
      expect(await store.runs.listWaitingOn("eval_1")).toEqual([]);
      expect((await claim())?.id).toBe(waiting.id);
    });

    it("runs: 20 concurrent claimers over 10 queued runs get unique runs", async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 10; i += 1) {
        ids.add((await makeRun()).id);
        clock.advance(1);
      }
      const claims = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          store.runs.claimNext({
            workerId: `w${i}`,
            leaseSeconds: 60,
            now: clock.now(),
          }),
        ),
      );
      const claimed = claims.filter((c): c is RunRecord => c !== null);
      expect(claimed).toHaveLength(10);
      expect(new Set(claimed.map((c) => c.id))).toEqual(ids);
      expect(claims.filter((c) => c === null)).toHaveLength(10);
    });

    it("runs: expired leases and active counts", async () => {
      const queued = await makeRun();
      const running = await makeRun();
      await store.runs.update(running.id, { status: "queued" });
      await store.runs.update(queued.id, { status: "completed" });
      const claimed = await store.runs.claimNext({
        workerId: "w",
        leaseSeconds: 60,
        now: clock.now(),
      });
      expect(claimed?.id).toBe(running.id);

      // A cancelled run whose attempt is still open keeps its lease.
      await store.runs.update(running.id, { status: "cancelled" });

      expect(await store.runs.listExpiredLeases(clock.now(), 10)).toEqual([]);
      clock.advanceSeconds(60);
      expect(await store.runs.listExpiredLeases(clock.now(), 10)).toEqual([]);
      clock.advance(1);
      const expired = await store.runs.listExpiredLeases(clock.now(), 10);
      expect(expired.map((r) => r.id)).toEqual([running.id]);
      expect(await store.runs.listExpiredLeases(clock.now(), 0)).toEqual([]);
    });

    it("runs: 205 runs paginate without duplicates or gaps", async () => {
      const created: string[] = [];
      for (let i = 0; i < 205; i += 1) {
        created.push((await makeRun()).id);
        if (i % 3 === 0) clock.advance(1);
      }
      await makeRun("ws_b");
      const { rows, pages } = await drain((cursor) =>
        store.runs.list("ws_a", { limit: 50, cursor }),
      );
      expect(pages).toBe(5);
      expect(rows).toHaveLength(205);
      expect(new Set(rows.map((r) => r.id))).toEqual(new Set(created));
      for (let i = 1; i < rows.length; i += 1) {
        const prev = rows[i - 1]!;
        const cur = rows[i]!;
        expect(
          prev.created_at > cur.created_at ||
            (prev.created_at === cur.created_at && prev.id > cur.id),
        ).toBe(true);
      }
      const exact = await store.runs.list("ws_a", { limit: 205 });
      expect(exact.data).toHaveLength(205);
      expect(exact.next_cursor).toBeNull();
    });

    it("pagination: malformed cursors are rejected with 422", async () => {
      await makeRun();
      for (const cursor of [
        "not-base64!",
        Buffer.from("{}").toString("base64url"),
        Buffer.from('["x"]').toString("base64url"),
      ]) {
        const error = await store.runs
          .list("ws_a", { limit: 5, cursor })
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(422);
      }
    });

    // --- Metrics ---------------------------------------------------------

    it("metrics: append assigns increasing seq; list honours afterSeq and limit", async () => {
      const run = await makeRun();
      const other = await makeRun();
      const a = await store.metrics.append(
        run.id,
        1,
        metric(1, { accuracy: 0.5 }),
      );
      const b = await store.metrics.append(other.id, 1, metric(1));
      const c = await store.metrics.append(run.id, 2, metric(2));
      expect(a.seq).toBeLessThan(b.seq);
      expect(b.seq).toBeLessThan(c.seq);
      expect(a).toMatchObject({
        attempt: 1,
        step: 1,
        accuracy: 0.5,
        cost_usd: 0.01,
      });

      const all = await store.metrics.list(run.id, 0, 100);
      expect(all.map((m) => m.seq)).toEqual([a.seq, c.seq]);
      expect(all[1]).toMatchObject({ attempt: 2, step: 2 });
      expect(
        (await store.metrics.list(run.id, a.seq, 100)).map((m) => m.seq),
      ).toEqual([c.seq]);
      expect(await store.metrics.list(run.id, 0, 1)).toHaveLength(1);
    });

    // --- Checkpoints -----------------------------------------------------

    it("checkpoints: unique per (run, attempt, step), retention, expiry, pages", async () => {
      const run = await makeRun();
      const expiresAt = (days: number) =>
        new Date(clock.now().getTime() + days * 86_400_000).toISOString();
      const insert = (
        attempt: number,
        step: number,
        days: number | null,
        sha = "b",
      ) =>
        store.checkpoints.insert({
          workspaceId: "ws_a",
          runId: run.id,
          attempt,
          step,
          evalScore: step / 100,
          format: step === 20 ? "peft_lora" : null,
          storageKey: `ckpt/${attempt}/${step}/${sha}`,
          sha256: sha.repeat(64),
          sizeBytes: 1234,
          metadata: { step },
          expiresAt: days === null ? null : expiresAt(days),
        });

      const first = await insert(1, 10, 30);
      expect(first.created).toBe(true);
      expect(first.checkpoint).toMatchObject({
        attempt: 1,
        step: 10,
        best: false,
        final: false,
        format: null,
        storage_key: "ckpt/1/10/b",
        size_bytes: 1234,
        metadata: { step: 10 },
      });
      const dup = await insert(1, 10, 30, "c");
      expect(dup).toEqual({ checkpoint: first.checkpoint, created: false });
      const otherAttempt = await insert(2, 10, 30);
      expect(otherAttempt.created).toBe(true);
      const s20 = await insert(1, 20, 30);
      expect(s20.checkpoint.format).toBe("peft_lora");
      const shortLived = await insert(2, 5, 1);

      expect(
        await store.checkpoints.get("ws_b", first.checkpoint.id),
      ).toBeNull();
      expect(
        (await store.checkpoints.get("ws_a", first.checkpoint.id))?.id,
      ).toBe(first.checkpoint.id);

      const ordered = await drain((cursor) =>
        store.checkpoints.listByRun(
          "ws_a",
          run.id,
          { limit: 2, cursor },
          clock.now(),
        ),
      );
      expect(ordered.rows.map((c) => [c.step, c.attempt])).toEqual([
        [5, 2],
        [10, 1],
        [10, 2],
        [20, 1],
      ]);
      expect(
        (
          await store.checkpoints.listByRun(
            "ws_b",
            run.id,
            { limit: 10 },
            clock.now(),
          )
        ).data,
      ).toEqual([]);

      expect(
        (await store.checkpoints.latestForRun(run.id, clock.now()))?.id,
      ).toBe(s20.checkpoint.id);
      await store.checkpoints.pinRetention(run.id, {
        bestId: otherAttempt.checkpoint.id,
        finalId: s20.checkpoint.id,
      });
      await store.checkpoints.pinRetention(run.id, {
        bestId: null,
        finalId: null,
      });

      clock.advanceDays(2);
      const live = await store.checkpoints.listAllForRun(run.id, clock.now());
      expect(live.map((c) => c.id)).not.toContain(shortLived.checkpoint.id);
      const best = live.find((c) => c.id === otherAttempt.checkpoint.id);
      const final = live.find((c) => c.id === s20.checkpoint.id);
      expect(best).toMatchObject({
        best: true,
        final: false,
        expires_at: null,
      });
      expect(final).toMatchObject({
        best: false,
        final: true,
        expires_at: null,
      });

      const expiredNow = await store.checkpoints.listExpired(clock.now(), 10);
      expect(expiredNow.map((c) => c.id)).toEqual([shortLived.checkpoint.id]);

      clock.advanceDays(40);
      const expiredLater = (
        await store.checkpoints.listExpired(clock.now(), 10)
      ).map((c) => c.id);
      expect(expiredLater.sort()).toEqual(
        [first.checkpoint.id, shortLived.checkpoint.id].sort(),
      );
      expect(
        (await store.checkpoints.latestForRun(run.id, clock.now()))?.id,
      ).toBe(s20.checkpoint.id);

      await store.checkpoints.delete(shortLived.checkpoint.id);
      expect(
        await store.checkpoints.get("ws_a", shortLived.checkpoint.id),
      ).toBeNull();
      expect(
        await store.checkpoints.latestForRun("run_none", clock.now()),
      ).toBeNull();
    });

    // --- Artifacts -------------------------------------------------------

    const artifactInput = (ws = "ws_a", artifactName = "sql-helper") => ({
      workspaceId: ws,
      name: artifactName,
      runId: null,
      checkpointId: null,
      baseModel: "qwen/qwen3-8b",
      recipeKind: "sft" as const,
      format: "peft_lora" as const,
      storageKey: `artifacts/${artifactName}/${Math.random()}`,
      sha256: "d".repeat(64),
      sizeBytes: 99,
      manifest: { schema: "grad.artifact/1" },
      evalReport: null,
    });

    it("artifacts: versions per day, rollover, @latest, list and isolation", async () => {
      const a1 = await store.artifacts.create(artifactInput());
      const a2 = await store.artifacts.create({
        ...artifactInput(),
        evalReport: evalReport({ acc: 1 }),
      });
      expect(a1.id).toBe("sql-helper@2026-11-27-1");
      expect(a2).toMatchObject({
        version: "2026-11-27-2",
        eval_report: { acc: 1, metric_name: "eval_loss" },
      });
      expect(
        (await store.artifacts.create(artifactInput("ws_a", "other"))).version,
      ).toBe("2026-11-27-1");
      expect(
        (await store.artifacts.create(artifactInput("ws_b"))).version,
      ).toBe("2026-11-27-1");

      clock.advanceDays(1);
      const next = await store.artifacts.create(artifactInput());
      expect(next.version).toBe("2026-11-28-1");
      expect((await store.artifacts.get("ws_a", "sql-helper@latest"))?.id).toBe(
        next.id,
      );
      expect(await store.artifacts.get("ws_a", a1.id)).toMatchObject({
        id: a1.id,
        storage_key: a1.storage_key,
        manifest: { schema: "grad.artifact/1" },
      });
      expect(await store.artifacts.get("ws_b", a2.id)).toBeNull();
      expect(await store.artifacts.get("ws_a", "missing@latest")).toBeNull();

      const named = await drain((cursor) =>
        store.artifacts.list(
          "ws_a",
          { name: "sql-helper" },
          { limit: 2, cursor },
        ),
      );
      expect(named.rows.map((a) => a.id)).toEqual([next.id, a2.id, a1.id]);
      expect(
        (await store.artifacts.list("ws_a", {}, { limit: 50 })).data,
      ).toHaveLength(4);
    });

    it("artifacts: 10 concurrent creates get unique versions; @latest is the highest", async () => {
      const created = await Promise.all(
        Array.from({ length: 10 }, () =>
          store.artifacts.create(artifactInput()),
        ),
      );
      const versions = created.map((a) => a.version).sort();
      expect(new Set(versions).size).toBe(10);
      expect(
        (await store.artifacts.get("ws_a", "sql-helper@latest"))?.version,
      ).toBe("2026-11-27-10");
    });

    // --- Uploads ---------------------------------------------------------

    it("uploads: single-use consumption and expiry listing", async () => {
      const mk = (id: string, expiresAt: string) =>
        store.uploads.create({
          id,
          workspaceId: "ws_a",
          purpose: "artifact",
          jobId: "run_1",
          attempt: 1,
          storageKey: `uploads/${id}`,
          sha256: "e".repeat(64),
          sizeBytes: 10,
          expiresAt,
        });
      const soon = new Date(clock.now().getTime() + 60_000).toISOString();
      const up = await mk("up_1", soon);
      expect(up).toMatchObject({
        status: "pending",
        consumed_by: null,
        attempt: 1,
      });
      expect((await store.uploads.markUploaded("up_1"))?.status).toBe(
        "uploaded",
      );
      expect(await store.uploads.markUploaded("up_1")).toBeNull();
      expect((await store.uploads.consume("up_1", "art_x"))?.consumed_by).toBe(
        "art_x",
      );
      expect(await store.uploads.consume("up_1", "art_y")).toBeNull();
      expect(await store.uploads.consume("up_missing", "x")).toBeNull();

      await mk("up_2", soon);
      expect((await store.uploads.consume("up_2", "ckpt"))?.status).toBe(
        "consumed",
      );
      await mk("up_3", soon);
      await mk("up_4", new Date(clock.now().getTime() + 600_000).toISOString());
      clock.advanceSeconds(120);
      expect(
        (await store.uploads.listExpired(clock.now(), 10)).map((u) => u.id),
      ).toEqual(["up_3"]);
      await store.uploads.delete("up_3");
      expect(await store.uploads.get("up_3")).toBeNull();
      expect((await store.uploads.get("up_4"))?.status).toBe("pending");
    });

    // --- Deployments, inferences, feedback --------------------------------

    it("deployments: upsert tracks previous artifact; isolation; lock in a transaction", async () => {
      const base = {
        workspaceId: "ws_a",
        name: "support",
        modelId: "ws_a/support",
        fallbackModel: null,
        exploreRate: 0,
      };
      const d1 = await store.deployments.upsert({
        ...base,
        activeArtifactId: "a@1",
      });
      expect(d1).toMatchObject({
        previous_artifact_id: null,
        status: "active",
      });
      clock.advanceSeconds(1);
      const same = await store.deployments.upsert({
        ...base,
        activeArtifactId: "a@1",
        exploreRate: 0.1,
      });
      expect(same).toMatchObject({
        id: d1.id,
        previous_artifact_id: null,
        explore_rate: 0.1,
      });
      expect(same.created_at).toBe(d1.created_at);
      expect(same.updated_at).toBe(clock.now().toISOString());
      const d2 = await store.deployments.upsert({
        ...base,
        activeArtifactId: "a@2",
        fallbackModel: "qwen/qwen3-32b",
      });
      expect(d2).toMatchObject({
        active_artifact_id: "a@2",
        previous_artifact_id: "a@1",
        fallback_model: "qwen/qwen3-32b",
      });
      const d3 = await store.deployments.upsert({
        ...base,
        activeArtifactId: "a@1",
      });
      expect(d3.previous_artifact_id).toBe("a@2");

      expect(await store.deployments.get("ws_b", "support")).toBeNull();
      expect(
        (await store.deployments.list("ws_a", { limit: 5 })).data,
      ).toHaveLength(1);
      expect(
        (await store.deployments.list("ws_b", { limit: 5 })).data,
      ).toHaveLength(0);

      const locked = await store.transaction(async (tx) => {
        await tx.deployments.lock("ws_a", "support");
        return tx.deployments.upsert({ ...base, activeArtifactId: "a@3" });
      });
      expect(locked.previous_artifact_id).toBe("a@1");
    });

    it("inferences: getMany keeps input order and workspace isolation", async () => {
      for (const [id, ws] of [
        ["inf_1", "ws_a"],
        ["inf_2", "ws_a"],
        ["inf_3", "ws_b"],
      ] as const) {
        await store.inferences.create({
          id,
          workspace_id: ws,
          deployment_name: "router",
          artifact_id: "r@1",
          model: "qwen/qwen3-8b",
        });
      }
      const got = await store.inferences.getMany("ws_a", [
        "inf_2",
        "inf_3",
        "inf_x",
        "inf_1",
      ]);
      expect(got.map((r) => r.id)).toEqual(["inf_2", "inf_1"]);
      expect(got[0]).toMatchObject({
        deployment_name: "router",
        created_at: clock.now().toISOString(),
      });
      expect(await store.inferences.getMany("ws_a", [])).toEqual([]);
    });

    const fb = (
      key: string,
      extra: Partial<{
        ws: string;
        score: number | null;
        dep: string | null;
      }> = {},
    ) => ({
      workspaceId: extra.ws ?? "ws_a",
      inferenceId: null,
      sessionId: "s1",
      deploymentName: extra.dep === undefined ? "support" : extra.dep,
      idempotencyKey: key,
      score: extra.score === undefined ? 0.5 : extra.score,
      expectedOutput: key === "gold" ? { content: "x" } : undefined,
      metrics: { latency_ms: 10 },
    });

    it("feedback: idempotent within and across batches and workspaces", async () => {
      const first = await store.feedback.insertMany([
        fb("k1"),
        fb("k2"),
        fb("k1"),
        fb("gold"),
      ]);
      expect(first.map((r) => r.deduplicated)).toEqual([
        false,
        false,
        true,
        false,
      ]);
      expect(first[2]?.record.id).toBe(first[0]?.record.id);
      expect(first[0]?.record).toMatchObject({
        idempotency_key: "k1",
        expected_output: null,
        metrics: { latency_ms: 10 },
        score: 0.5,
      });
      expect(first[3]?.record.expected_output).toEqual({ content: "x" });

      const second = await store.feedback.insertMany([
        fb("k2"),
        fb("k3"),
        fb("k1", { ws: "ws_b" }),
      ]);
      expect(second.map((r) => r.deduplicated)).toEqual([true, false, false]);
      expect(second[0]?.record.id).toBe(first[1]?.record.id);
      expect(await store.feedback.insertMany([])).toEqual([]);
    });

    it("feedback: 10 parallel identical keys store one row", async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          store.feedback.insertMany([fb("same")]),
        ),
      );
      const flat = results.flat();
      expect(flat.filter((r) => !r.deduplicated)).toHaveLength(1);
      expect(new Set(flat.map((r) => r.record.id)).size).toBe(1);
      expect((await store.feedback.stats("ws_a", "support")).count).toBe(1);
    });

    it("feedback: stats count every event and average non-null scores (520 rows)", async () => {
      const events = Array.from({ length: 520 }, (_, i) =>
        fb(`e${i}`, { score: i % 10 === 0 ? null : (i % 4) / 4 }),
      );
      await store.feedback.insertMany(events.slice(0, 300));
      await store.feedback.insertMany(events.slice(300));
      await store.feedback.insertMany([
        fb("other", { dep: "elsewhere" }),
        fb("nodep", { dep: null }),
      ]);
      const scored = events.filter((e) => e.score !== null);
      const expected = Number(
        (
          scored.reduce((sum, e) => sum + (e.score ?? 0), 0) / scored.length
        ).toFixed(4),
      );
      expect(await store.feedback.stats("ws_a", "support")).toEqual({
        count: 520,
        average_score: expected,
      });
      expect(await store.feedback.stats("ws_a", "none")).toEqual({
        count: 0,
        average_score: null,
      });
      expect(await store.feedback.stats("ws_b", "support")).toEqual({
        count: 0,
        average_score: null,
      });
    });

    // --- Evals -----------------------------------------------------------

    it("evals: create, claim, CAS update, leases, isolation", async () => {
      const ev = await makeEval();
      expect(ev).toMatchObject({
        status: "queued",
        attempt: 0,
        lease_seconds: 0,
        total_outputs: 0,
        generated: 0,
        summary: [],
        total_cost_micro_usd: 0,
        error: null,
        completed_at: null,
        limit: null,
        local_scorers: ["local_fn"],
        model_targets: {
          m2: { inference_model: "m2", price_per_million_tokens: null },
        },
      });
      expect(await store.evals.get("ws_b", ev.id)).toBeNull();
      expect((await store.evals.getById(ev.id))?.name).toBe("ev");
      await makeEval("ws_b");
      expect(
        (await store.evals.list("ws_a", { limit: 5 })).data.map((e) => e.id),
      ).toEqual([ev.id]);

      expect(
        await store.evals.claimNext({
          workerId: "x",
          leaseSeconds: 30,
          now: clock.now(),
          workspaceId: "ws_c",
        }),
      ).toBeNull();
      const claimed = await store.evals.claimNext({
        workerId: "ex",
        leaseSeconds: 30,
        now: clock.now(),
        workspaceId: "ws_a",
      });
      expect(claimed).toMatchObject({
        id: ev.id,
        status: "running",
        attempt: 1,
        worker_id: "ex",
        lease_seconds: 30,
      });
      expect(
        await store.evals.update(ev.id, { generated: 3 }, { workerId: "nope" }),
      ).toBeNull();
      const summary = [
        {
          model: "m1",
          overall: 0.5,
          ci_low: 0.4,
          ci_high: 0.6,
          pass_at_k: { "pass@1": 0.5 },
          vs_baseline: null,
          tasks: 2,
          errors: 0,
          tokens_per_task: 10,
          cost_per_1k_tasks_usd: null,
        },
      ];
      const done = await store.evals.update(
        ev.id,
        {
          generated: 3,
          summary,
          status: "completed",
          completed_at: clock.now().toISOString(),
        },
        { status: ["running"], workerId: "ex", attempt: 1 },
      );
      expect(done).toMatchObject({
        generated: 3,
        summary,
        status: "completed",
      });

      const other = (await store.evals.list("ws_b", { limit: 1 })).data[0]!;
      await store.evals.claimNext({
        workerId: "ex",
        leaseSeconds: 30,
        now: clock.now(),
      });
      clock.advanceSeconds(31);
      expect(
        (await store.evals.listExpiredLeases(clock.now(), 10))
          .map((e) => e.id)
          .sort(),
      ).toEqual([ev.id, other.id].sort());
    });

    it("evals: tasks, outputs, scores, results", async () => {
      const ev = await makeEval();
      await store.evals.insertTasks(ev.id, [
        {
          eval_id: ev.id,
          task_index: 0,
          task_id: "t0",
          record: { id: "t0", query: "a" },
        },
        {
          eval_id: ev.id,
          task_index: 1,
          task_id: "t1",
          record: { id: "t1", query: "b" },
        },
      ]);
      await store.evals.insertTasks(ev.id, [
        {
          eval_id: ev.id,
          task_index: 1,
          task_id: "dup",
          record: { id: "dup" },
        },
        { eval_id: ev.id, task_index: 2, task_id: "t2", record: { id: "t2" } },
      ]);
      await store.evals.insertTasks(ev.id, []);
      const tasks = await store.evals.listTasks(ev.id, -1, 10);
      expect(tasks.map((t) => t.task_id)).toEqual(["t0", "t1", "t2"]);
      expect(
        (await store.evals.listTasks(ev.id, 0, 1)).map((t) => t.task_index),
      ).toEqual([1]);

      const output = (
        model: string,
        task: number,
        sample: number,
        extra: Partial<{ error: string; scores: Record<string, number> }> = {},
      ) => ({
        id: `out_${model}_${task}_${sample}_${Math.random().toString(16).slice(2, 8)}`,
        eval_id: ev.id,
        task_index: task,
        task_id: `t${task}`,
        model,
        sample_index: sample,
        input: [{ role: "user" as const, content: "q" }],
        output: "answer",
        expected_output: null,
        scores: extra.scores ?? { ok: 1 },
        error: extra.error ?? null,
        prompt_tokens: 5,
        completion_tokens: 7,
        cost_micro_usd: 1000,
        created_at: clock.now().toISOString(),
      });
      const o1 = output("m1", 0, 0);
      await store.evals.upsertOutput(o1);
      await store.evals.upsertOutput({
        ...output("m1", 0, 0),
        output: "replaced",
      });
      await store.evals.upsertOutput(output("m2", 0, 0));
      await store.evals.upsertOutput(output("m1", 0, 1));
      await store.evals.upsertOutput(
        output("m1", 1, 0, { error: "timeout", scores: {} }),
      );
      await store.evals.upsertOutput(output("m2", 1, 1));

      expect(await store.evals.listOutputKeys(ev.id)).toEqual(
        new Set([
          "m1\u00000\u00000",
          "m2\u00000\u00000",
          "m1\u00000\u00001",
          "m1\u00001\u00000",
          "m2\u00001\u00001",
        ]),
      );
      const all = await drain((cursor) =>
        store.evals.listOutputs(ev.id, {}, { limit: 2, cursor }),
      );
      expect(
        all.rows.map((o) => [o.task_index, o.model, o.sample_index]),
      ).toEqual([
        [0, "m1", 0],
        [0, "m1", 1],
        [0, "m2", 0],
        [1, "m1", 0],
        [1, "m2", 1],
      ]);
      expect(all.rows[0]).toMatchObject({
        id: o1.id,
        output: "replaced",
        record: { id: "t0", query: "a" },
      });
      expect(
        (
          await store.evals.listOutputs(ev.id, { model: "m2" }, { limit: 10 })
        ).data.map((o) => o.task_index),
      ).toEqual([0, 1]);

      expect(await store.evals.countMissingScores(ev.id, ["local_fn"])).toBe(4);
      expect(await store.evals.countMissingScores(ev.id, [])).toBe(0);
      const missing = await store.evals.listOutputs(
        ev.id,
        { missingScorer: "local_fn" },
        { limit: 10 },
      );
      expect(missing.data).toHaveLength(4);

      const accepted = await store.evals.setScores(ev.id, [
        { output_id: o1.id, scorer: "local_fn", score: 1 },
        { output_id: o1.id, scorer: "second", score: 0.25 },
        { output_id: "out_unknown", scorer: "local_fn", score: 1 },
        ...missing.data
          .slice(1)
          .map((o) => ({ output_id: o.id, scorer: "local_fn", score: 0 })),
      ]);
      expect(accepted).toBe(5);
      expect(await store.evals.setScores(ev.id, [])).toBe(0);
      expect(await store.evals.countMissingScores(ev.id, ["local_fn"])).toBe(0);
      expect(
        await store.evals.countMissingScores(ev.id, ["local_fn", "second"]),
      ).toBe(3);
      const rescored = (
        await store.evals.listOutputs(ev.id, { model: "m1" }, { limit: 1 })
      ).data[0];
      expect(rescored?.scores).toEqual({ ok: 1, local_fn: 1, second: 0.25 });

      const result = (task: number, model: string, score: number) => ({
        eval_id: ev.id,
        task_index: task,
        task_id: `t${task}`,
        model,
        score,
        passed: score >= 0.5,
        sample_scores: [score],
        judge_model: null,
      });
      await store.evals.replaceResults(ev.id, [
        result(0, "m1", 1),
        result(0, "m2", 0.2),
      ]);
      await store.evals.replaceResults(ev.id, [
        result(0, "m1", 1),
        result(0, "m2", 0.2),
        result(1, "m1", 0.4),
        result(2, "m2", 0.9),
      ]);
      const results = await drain((cursor) =>
        store.evals.listResults(ev.id, {}, { limit: 3, cursor }),
      );
      expect(results.rows.map((r) => [r.task_index, r.model])).toEqual([
        [0, "m1"],
        [0, "m2"],
        [1, "m1"],
        [2, "m2"],
      ]);
      expect(results.rows[3]?.record).toEqual({ id: "t2" });
      const failures = await store.evals.listResults(
        ev.id,
        { maxScore: 0.5 },
        { limit: 10 },
      );
      expect(failures.data.map((r) => [r.task_index, r.model])).toEqual([
        [0, "m2"],
        [1, "m1"],
      ]);
      expect(
        (
          await store.evals.listResults(
            ev.id,
            { model: "m1", maxScore: 0.5 },
            { limit: 10 },
          )
        ).data,
      ).toHaveLength(1);
      await store.evals.replaceResults(ev.id, []);
      expect(
        (await store.evals.listResults(ev.id, {}, { limit: 10 })).data,
      ).toEqual([]);
    });

    // --- Billing outbox --------------------------------------------------

    it("billing outbox: idempotent enqueue, leased claims, retries", async () => {
      const input = {
        idempotencyKey: "run-usage:run_1:1",
        workspaceId: "ws_a",
        kind: "run" as const,
        runId: "run_1",
        attempt: 1,
        tokens: 1000,
        costMicroUsd: 400,
      };
      const first = await store.billing.enqueue(input);
      const again = await store.billing.enqueue({ ...input, tokens: 5 });
      expect(again).toEqual(first);
      expect(first).toMatchObject({
        status: "pending",
        attempts: 0,
        tokens: 1000,
        cost_micro_usd: 400,
      });
      clock.advance(1);
      const second = await store.billing.enqueue({
        ...input,
        idempotencyKey: "run-usage:run_1:2",
        attempt: 2,
      });

      const claimed = await store.billing.claimDue(clock.now(), 10, 60);
      expect(claimed.map((e) => e.id)).toEqual([first.id, second.id]);
      expect(claimed[0]).toMatchObject({
        attempts: 1,
        next_attempt_at: new Date(clock.now().getTime() + 60_000).toISOString(),
      });
      expect(await store.billing.claimDue(clock.now(), 10, 60)).toEqual([]);

      await store.billing.markSent(first.id);
      const retryAt = new Date(clock.now().getTime() + 5_000);
      await store.billing.markFailed(second.id, "x".repeat(3000), retryAt);
      clock.advanceSeconds(5);
      const retry = await store.billing.claimDue(clock.now(), 10, 60);
      expect(retry.map((e) => e.id)).toEqual([second.id]);
      expect(retry[0]?.attempts).toBe(2);
      expect(retry[0]?.last_error).toHaveLength(2000);

      const byRun = await store.billing.listByRun("run_1");
      expect(byRun.map((e) => [e.attempt, e.status])).toEqual([
        [1, "sent"],
        [2, "pending"],
      ]);
      expect(byRun[0]?.sent_at).not.toBeNull();
      expect(await store.billing.claimDue(clock.now(), 0, 60)).toEqual([]);
    });

    // --- Idempotency keys -------------------------------------------------

    const idemScope = {
      workspaceId: "ws_a",
      principal: "key_1",
      method: "POST",
      path: "/v1/runs",
      key: "k-1",
    };
    const idemAt = (ttlSeconds = 86_400, lockSeconds = 300) => ({
      now: clock.now(),
      expiredBefore: new Date(clock.now().getTime() - ttlSeconds * 1000),
      abandonedBefore: new Date(clock.now().getTime() - lockSeconds * 1000),
    });
    const stored = {
      status: 202,
      headers: { "content-type": "application/json" },
      body: '{"id":"run_1"}',
    };

    it("idempotency: claim, in-progress, mismatch, replay, release", async () => {
      const claim = await store.idempotency.claim(idemScope, "h1", idemAt());
      expect(claim.outcome).toBe("claimed");
      const claimId = claim.outcome === "claimed" ? claim.claimId : "";

      expect(await store.idempotency.claim(idemScope, "h1", idemAt())).toEqual({
        outcome: "in_progress",
      });
      expect(await store.idempotency.claim(idemScope, "h2", idemAt())).toEqual({
        outcome: "mismatch",
      });
      expect(
        (
          await store.idempotency.claim(
            { ...idemScope, principal: "key_2" },
            "h1",
            idemAt(),
          )
        ).outcome,
      ).toBe("claimed");
      expect(
        (
          await store.idempotency.claim(
            { ...idemScope, path: "/v1/evals" },
            "h1",
            idemAt(),
          )
        ).outcome,
      ).toBe("claimed");

      await store.idempotency.complete(
        idemScope,
        "not-the-claim",
        { ...stored, status: 500 },
        clock.now(),
      );
      await store.idempotency.complete(idemScope, claimId, stored, clock.now());
      expect(await store.idempotency.claim(idemScope, "h1", idemAt())).toEqual({
        outcome: "completed",
        response: stored,
      });
      expect(await store.idempotency.claim(idemScope, "h2", idemAt())).toEqual({
        outcome: "mismatch",
      });

      const other = { ...idemScope, key: "k-2" };
      const second = await store.idempotency.claim(other, "h1", idemAt());
      const secondId = second.outcome === "claimed" ? second.claimId : "";
      await store.idempotency.release(other, "not-the-claim");
      expect(
        (await store.idempotency.claim(other, "h1", idemAt())).outcome,
      ).toBe("in_progress");
      await store.idempotency.release(other, secondId);
      expect(
        (await store.idempotency.claim(other, "h2", idemAt())).outcome,
      ).toBe("claimed");
    });

    it("idempotency: abandoned claims and expired rows are taken over and purged", async () => {
      const first = await store.idempotency.claim(idemScope, "h1", idemAt());
      const firstId = first.outcome === "claimed" ? first.claimId : "";
      clock.advanceSeconds(301);
      const takeover = await store.idempotency.claim(idemScope, "h2", idemAt());
      expect(takeover.outcome).toBe("claimed");
      await store.idempotency.complete(idemScope, firstId, stored, clock.now());
      expect(await store.idempotency.claim(idemScope, "h2", idemAt())).toEqual({
        outcome: "in_progress",
      });
      const takeoverId = takeover.outcome === "claimed" ? takeover.claimId : "";
      await store.idempotency.complete(
        idemScope,
        takeoverId,
        stored,
        clock.now(),
      );

      clock.advanceSeconds(600);
      expect(
        (await store.idempotency.claim(idemScope, "h2", idemAt())).outcome,
      ).toBe("completed");
      await store.idempotency.claim(
        { ...idemScope, key: "fresh" },
        "h",
        idemAt(),
      );
      clock.advanceDays(1);
      expect(
        (await store.idempotency.claim(idemScope, "h3", idemAt())).outcome,
      ).toBe("claimed");
      expect(
        await store.idempotency.deleteExpired(
          new Date(clock.now().getTime() - 1000),
        ),
      ).toBe(1);
      expect(
        await store.idempotency.deleteExpired(
          new Date(clock.now().getTime() + 1000),
        ),
      ).toBe(1);
      expect(await store.idempotency.deleteExpired(clock.now())).toBe(0);
    });

    it("idempotency: concurrent claims of one key yield exactly one winner", async () => {
      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () =>
          store.idempotency.claim(idemScope, "h1", idemAt()),
        ),
      );
      expect(outcomes.filter((o) => o.outcome === "claimed")).toHaveLength(1);
      expect(outcomes.filter((o) => o.outcome === "in_progress")).toHaveLength(
        7,
      );
    });

    // --- Transactions ----------------------------------------------------

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
            await inner.billing.enqueue({
              idempotencyKey: "nested",
              workspaceId: "ws_t",
              kind: "run",
              runId: committed!.id,
              attempt: 1,
              tokens: 1,
              costMicroUsd: 0,
            });
          });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(rolledBack).toBeDefined();
      expect(await store.datasets.get("ws_t", "tx")).toBeNull();
      expect((await store.runs.getById(committed!.id))?.current_step).toBe(9);
      expect(await store.billing.listByRun(committed!.id)).toEqual([]);

      const nested = await store.transaction(async () =>
        store.transaction(async (inner) => {
          await inner.billing.enqueue({
            idempotencyKey: "nested-ok",
            workspaceId: "ws_t",
            kind: "eval",
            runId: committed!.id,
            attempt: 1,
            tokens: 1,
            costMicroUsd: 0,
          });
          return "ok";
        }),
      );
      expect(nested).toBe("ok");
      const [entry] = await store.billing.listByRun(committed!.id);
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
