import { afterEach, describe, expect, it } from "vitest";

import type { DatasetRecord } from "../src/contracts.js";
import {
  compileFilter,
  parseCondition,
  viewName,
} from "../src/services/dataset-filter.js";
import { mergeRecords, scoreUpdate } from "../src/services/record-merge.js";
import { makeTestApp, type TestApp } from "./fixtures/app.js";
import {
  makeEvalHarness,
  qaRecords,
  seedDataset,
  type EvalHarness,
} from "./fixtures/evals.js";
import { judgeResponder } from "./fixtures/fake-openai.js";

type Json = Record<string, unknown> & {
  id?: string;
  status?: string;
  code?: string;
  name?: string;
  version?: number;
  record_count?: number;
  data?: DatasetRecord[];
};

const JUDGE = {
  name: "resolved",
  kind: "judge",
  model: "qwen/qwen3-32b",
  prompt: "Did it resolve the request?",
};

describe("mergeRecords", () => {
  it("folds score updates and content updates by id, latest wins", () => {
    const merged = mergeRecords([
      scoreUpdate("b", { early: 1 }), // arrives before its record
      { id: "a", messages: [{ role: "user", content: "1" }], scores: { x: 0 } },
      { messages: [{ role: "user", content: "no id" }] },
      { id: "b", prompt: "p", expected_output: "gold" },
      scoreUpdate("a", { x: 0.5, y: 1 }),
      scoreUpdate("a", { x: 0.9 }),
      { id: "b", prompt: "p2", scores: { z: 1 } },
      { id: "c", metadata: { score_update: true }, expected_output: "e" },
    ]);
    expect(merged).toEqual([
      {
        id: "a",
        messages: [{ role: "user", content: "1" }],
        scores: { x: 0.9, y: 1 },
      },
      { messages: [{ role: "user", content: "no id" }] },
      {
        id: "b",
        prompt: "p2",
        scores: { early: 1, z: 1 },
        expected_output: "gold",
      },
    ]);
  });

  it("drops everything before a reset marker", () => {
    const merged = mergeRecords([
      { id: "old", prompt: "x" },
      { id: "grad:reset", metadata: { dataset_reset: true } },
      { id: "new", prompt: "y" },
    ]);
    expect(merged.map((r) => r.id)).toEqual(["new"]);
  });
});

describe("dataset filters", () => {
  const rec = (
    id: string,
    scores: Record<string, number>,
    extra: Partial<DatasetRecord> = {},
  ): DatasetRecord => ({ id, prompt: "p", scores, ...extra });

  it("parses conditions and rejects malformed ones", () => {
    expect(parseCondition("s", ">=0.8")).toEqual({
      name: "s",
      op: ">=",
      value: 0.8,
    });
    expect(parseCondition("s", " 1 ")).toEqual({
      name: "s",
      op: "==",
      value: 1,
    });
    expect(parseCondition("s", 2)).toEqual({ name: "s", op: "==", value: 2 });
    expect(() => parseCondition("s", "about 1")).toThrow(/<op><number>/);
  });

  it("matches scores, metadata, time ranges and ids", () => {
    const records = [
      rec(
        "a",
        { s: 0.9 },
        { metadata: { env: "prod" }, timestamp: "2026-11-02T00:00:00Z" },
      ),
      rec("b", { s: 0.5 }, { metadata: { env: "prod" } }),
      rec("c", {}, { timestamp: "2026-10-01T00:00:00Z" }),
      rec(
        "d",
        { s: 1 },
        { metadata: { env: "dev" }, timestamp: "2026-11-05T00:00:00Z" },
      ),
    ];
    const ids = (f: Parameters<typeof compileFilter>[0]) =>
      records.filter(compileFilter(f)).map((r) => r.id);

    expect(ids({ scores: { s: ">=0.8" } })).toEqual(["a", "d"]);
    for (const [op, want] of [
      ["<=0.5", ["b"]],
      [">0.9", ["d"]],
      ["<0.9", ["b"]],
      ["==1", ["d"]],
      ["!=1", ["a", "b"]],
    ] as const) {
      expect(ids({ scores: { s: op } })).toEqual(want);
    }
    expect(ids({ metadata: { env: "prod" } })).toEqual(["a", "b"]);
    expect(ids({ created_after: "2026-11-01T00:00:00Z" })).toEqual(["a", "d"]);
    expect(ids({ created_before: "2026-11-03T00:00:00Z" })).toEqual(["a", "c"]);
    expect(ids({ ids: ["c", "d", "zz"] })).toEqual(["c", "d"]);
    expect(ids({})).toEqual(["a", "b", "c", "d"]);
  });

  it("names a view by a hash of source, version and filter", () => {
    const src = { id: "ds_1", name: "a".repeat(64) };
    const one = viewName(src, 1, { scores: { s: ">=0.8" } });
    expect(one).toMatch(/^a{51}-f-[0-9a-f]{10}$/);
    expect(viewName(src, 1, { scores: { s: ">=0.8" }, ids: undefined })).toBe(
      one,
    );
    expect(viewName(src, 1, { scores: { s: ">=0.9" } })).not.toBe(one);
    expect(viewName(src, 2, { scores: { s: ">=0.8" } })).not.toBe(one);
  });
});

describe("POST /v1/datasets/{name}/filter", () => {
  let t: TestApp;

  afterEach(async () => {
    await t.close();
  });

  it("saves a view, reuses it for the same filter and reads merged scores", async () => {
    t = await makeTestApp();
    await t.json("/v1/datasets/logs/records", {
      body: {
        records: [
          { id: "a", prompt: "p", completion: "c", scores: { s: 0.9 } },
          { id: "b", prompt: "p", completion: "c", scores: { s: 0.2 } },
          { prompt: "no id" },
        ],
      },
    });

    const first = await t.json<Json>("/v1/datasets/logs/filter", {
      body: { scores: { s: ">=0.8" } },
    });
    expect(first.status).toBe(201);
    expect(first.body.name).toMatch(/^logs-f-[0-9a-f]{10}$/);
    expect(first.body.record_count).toBe(1);
    expect(first.body.metadata).toEqual({
      view: { source: "logs", version: 1, filter: { scores: { s: ">=0.8" } } },
    });

    const again = await t.json<Json>("/v1/datasets/logs/filter", {
      body: { scores: { s: ">=0.8" } },
    });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);

    const looser = await t.json<Json>("/v1/datasets/logs/filter", {
      body: { scores: { s: ">=0.1" }, name: "logs-good" },
    });
    expect(looser.status).toBe(201);
    expect(looser.body.record_count).toBe(2);

    const clash = await t.json<Json>("/v1/datasets/logs/filter", {
      body: { scores: { s: ">=0.5" }, name: "logs-good" },
    });
    expect(clash.status).toBe(409);

    const empty = await t.json<Json>("/v1/datasets/logs/filter", {
      body: { ids: ["nope"] },
    });
    expect(empty.status).toBe(201);
    expect(empty.body.version).toBe(0);

    const bad = await t.json<Json>("/v1/datasets/logs/filter", {
      body: { scores: { s: "high" } },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe("invalid_filter");

    const missing = await t.json<Json>("/v1/datasets/nope/filter", {
      body: { ids: ["a"] },
    });
    expect(missing.status).toBe(404);
  });
});

describe("POST /v1/datasets/{name}/score", () => {
  let h: EvalHarness;

  afterEach(async () => {
    await h.close();
  });

  it("scores the records' own answers and writes them to the next version", async () => {
    h = await makeEvalHarness();
    await seedDataset(h.t, "logs", [
      ...qaRecords(3),
      { messages: [{ role: "user", content: "no id" }] },
    ]);
    h.fake.setModel(
      "qwen/qwen3-32b",
      judgeResponder((req) =>
        JSON.stringify(req.messages).includes("gold 1") ? 0.2 : 0.9,
      ),
    );

    const created = await h.t.json<Json>("/v1/datasets/logs/score", {
      body: {
        rubric: [
          JUDGE,
          {
            name: "has_gold",
            kind: "regex",
            pattern: "^gold",
          },
        ],
      },
    });
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({
      name: "logs-score",
      mode: "score",
      models: ["record"],
      scored_dataset_version: null,
    });
    await h.t.services.evals.drain();

    // Judges saw the stored answer; no model was asked to generate one.
    const judged = h.fake.requests.filter((r) => r.model === "qwen/qwen3-32b");
    expect(judged).toHaveLength(3);
    expect(h.fake.requests).toHaveLength(3);

    const done = await h.t.json<Json>(`/v1/evals/${created.body.id}`);
    expect(done.body).toMatchObject({
      status: "completed",
      scored_dataset_version: 2,
    });
    expect(done.body.total_cost_usd).toBeGreaterThan(0);

    const ds = await h.t.json<Json>("/v1/datasets/logs");
    expect(ds.body).toMatchObject({ version: 2, record_count: 4 });
    const records = await h.t.json<Json>("/v1/datasets/logs/records");
    expect(records.body.total).toBe(4);
    expect(records.body.data?.map((r) => r.scores ?? null)).toEqual([
      { resolved: 0.9, has_gold: 1 },
      { resolved: 0.2, has_gold: 1 },
      { resolved: 0.9, has_gold: 1 },
      null,
    ]);
    const v1 = await h.t.json<Json>("/v1/datasets/logs/records?version=1");
    expect(v1.body.data?.[0]?.scores).toBeUndefined();

    const passing = await h.t.json<Json>("/v1/datasets/logs/filter", {
      body: { scores: { resolved: ">=0.8" } },
    });
    expect(passing.body.record_count).toBe(2);

    // Re-scoring skips rows that have every score: nothing to do, no new version.
    const again = await h.t.json<Json>("/v1/datasets/logs/score", {
      body: { rubric: [JUDGE], name: "again" },
    });
    expect(again.status).toBe(202);
    await h.t.services.evals.drain();
    const noop = await h.t.json<Json>(`/v1/evals/${again.body.id}`);
    expect(noop.body).toMatchObject({
      status: "completed",
      scored_dataset_version: 2,
    });
    expect(h.fake.requests).toHaveLength(3);
  });

  it("keeps a failed judge's score out of the dataset", async () => {
    h = await makeEvalHarness();
    await seedDataset(h.t, "logs", qaRecords(1));
    h.fake.setModel("qwen/qwen3-32b", () => ({ content: "no idea" }));
    const created = await h.t.json<Json>("/v1/datasets/logs/score", {
      body: { rubric: [JUDGE] },
    });
    await h.t.services.evals.drain();
    const done = await h.t.json<Json>(`/v1/evals/${created.body.id}`);
    expect(done.body).toMatchObject({
      status: "completed",
      scored_dataset_version: 1,
    });
    const records = await h.t.json<Json>("/v1/datasets/logs/records");
    expect(records.body.data?.[0]?.scores).toBeUndefined();
  });

  it("runs validators and code scorers without any model endpoint", async () => {
    h = await makeEvalHarness();
    const t = await makeTestApp();
    try {
      await seedDataset(t, "logs", [
        { id: "j", prompt: "q", completion: '{"ok": true}' },
      ]);
      const judge = await t.json<Json>("/v1/datasets/logs/score", {
        body: { rubric: [JUDGE] },
      });
      expect(judge.status).toBe(501);
      expect(judge.body.code).toBe("inference_unavailable");

      const created = await t.json<Json>("/v1/datasets/logs/score", {
        body: {
          rubric: [
            { name: "json", kind: "validator", validator: "json" },
            { name: "mine", kind: "code", runtime: "local" },
          ],
        },
      });
      expect(created.status).toBe(202);
      await t.services.evals.drain();
      const waiting = await t.json<Json>(`/v1/evals/${created.body.id}`);
      expect(waiting.body.status).toBe("awaiting_scores");

      const outputs = await t.json<Json>(
        `/v1/evals/${created.body.id}/outputs?missing_scorer=mine`,
      );
      const output = (
        outputs.body.data as unknown as Array<{ id: string; output: string }>
      )[0];
      expect(output?.output).toBe('{"ok": true}');
      const posted = await t.json<Json>(`/v1/evals/${created.body.id}/scores`, {
        body: {
          scores: [{ output_id: output?.id, scorer: "mine", score: 0.25 }],
        },
      });
      expect(posted.body.status).toBe("completed");

      const records = await t.json<Json>("/v1/datasets/logs/records");
      expect(records.body.data?.[0]?.scores).toEqual({ json: 1, mine: 0.25 });
    } finally {
      await t.close();
    }
  });

  it("rejects bad requests", async () => {
    h = await makeEvalHarness();
    await seedDataset(h.t, "logs", qaRecords(1));
    const empty = await h.t.json<Json>("/v1/datasets/logs/score", {
      body: { rubric: [] },
    });
    expect(empty.status).toBe(422);
    const dup = await h.t.json<Json>("/v1/datasets/logs/score", {
      body: { rubric: [JUDGE, JUDGE] },
    });
    expect(dup.body.code).toBe("duplicate_scorer");
    const missing = await h.t.json<Json>("/v1/datasets/nope/score", {
      body: { rubric: [JUDGE] },
    });
    expect(missing.status).toBe(404);
  });
});
