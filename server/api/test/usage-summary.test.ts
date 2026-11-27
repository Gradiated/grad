import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { UsageKind } from "../src/contracts.js";
import { summaryPeriod } from "../src/services/usage.js";
import { createDb } from "../src/store/postgres/db.js";
import { createUsageRepository } from "../src/store/postgres/usage.js";
import { WORKSPACE_A } from "./fixtures/app.js";
import {
  makeEvalHarness,
  qaRecords,
  seedDataset,
  type EvalHarness,
} from "./fixtures/evals.js";
import { fileSchemaName, postgresUrl } from "./fixtures/postgres.js";
import { createSftRun } from "./fixtures/worker.js";

interface Refs {
  sft: string;
  plain: string;
  scoring: string;
  router: string;
  labels: string;
  distill: string;
  teacher: string;
}

type Summary = {
  from: string;
  to: string;
  cost_usd: number;
  tokens: number;
  records: number;
  by_kind: Array<{ kind: UsageKind; cost_usd: number; tokens: number }>;
  top_runs: Array<{ id: string; name: string; cost_usd: number }>;
  top_evals: Array<{ id: string; name: string; kind: UsageKind }>;
  group_by: string | null;
  groups: Array<{ key: string | null; cost_usd: number; tokens: number }>;
};

type Listed = {
  data: Array<{
    kind: UsageKind;
    ref_id: string;
    ref_name: string | null;
    run_id: string | null;
    tokens: number;
    cost_usd: number;
    created_at: string;
  }>;
  next_cursor: string | null;
};

describe("usage summary and filters (GET /v1/usage/summary, GET /v1/usage)", () => {
  let h: EvalHarness;
  let refs: Refs;
  let seq = 0;

  /** One ledger row for `refId`, billed at `at`. */
  const bill = async (
    kind: "run" | "eval",
    refId: string,
    at: string,
    tokens: number,
    costUsd: number,
  ) => {
    h.t.clock.set(at);
    seq += 1;
    await h.t.deps.store.usage.record({
      idempotencyKey: `test:${seq}`,
      workspaceId: WORKSPACE_A,
      kind,
      refId,
      attempt: 1,
      tokensFrom: 0,
      tokensThrough: tokens,
      costUsd,
      priceVersion: "p_1",
    });
  };

  const summary = async (query = "") =>
    h.t.json<Summary>(`/v1/usage/summary${query}`);

  const list = async (query = "") => h.t.json<Listed>(`/v1/usage${query}`);

  beforeEach(async () => {
    h = await makeEvalHarness();
    const { t } = h;
    await seedDataset(t, "prompts", qaRecords(3));
    const sft = await createSftRun(t, { name: "support-sft" });
    const plain = await t.json<{ id: string }>("/v1/evals", {
      body: { name: "nightly", models: ["qwen/qwen3-8b"], dataset: "prompts" },
    });
    const scoring = await t.json<{ id: string }>("/v1/datasets/prompts/score", {
      body: {
        rubric: [{ name: "j", kind: "judge", model: "qwen/qwen3-32b" }],
      },
    });
    const router = await t.json<{
      id: string;
      resolved_config: { label_eval_id: string };
    }>("/v1/runs", {
      body: {
        dataset: "prompts",
        name: "support-router",
        recipe: {
          kind: "router",
          model: "test/tiny-qwen3",
          models: ["qwen/qwen3-8b", "qwen/qwen3-1.7b"],
          rubric: [{ name: "ok", kind: "judge", model: "qwen/qwen3-32b" }],
        },
      },
    });
    const distill = await t.json<{
      id: string;
      resolved_config: { label_eval_id: string };
    }>("/v1/runs", {
      body: {
        dataset: "prompts",
        name: "support-distilled",
        recipe: {
          kind: "distill",
          model: "test/tiny-qwen3",
          teacher: "qwen/qwen3-32b",
          rollout: { kind: "off_policy", max_new_tokens: 64 },
        },
      },
    });
    expect([
      plain.status,
      scoring.status,
      router.status,
      distill.status,
    ]).toEqual([202, 202, 202, 202]);
    refs = {
      sft: sft.id,
      plain: plain.body.id,
      scoring: scoring.body.id,
      router: router.body.id,
      labels: router.body.resolved_config.label_eval_id,
      distill: distill.body.id,
      teacher: distill.body.resolved_config.label_eval_id,
    };
    seq = 0;
  });

  afterEach(async () => {
    await h.close();
  });

  it("classifies every kind, names the refs and links evals to their run", async () => {
    await bill("run", refs.sft, "2026-11-02T10:00:00Z", 1000, 0.001);
    await bill("eval", refs.plain, "2026-11-03T10:00:00Z", 200, 0.0005);
    await bill("eval", refs.scoring, "2026-11-04T10:00:00Z", 300, 0.0007);
    await bill("eval", refs.labels, "2026-11-05T10:00:00Z", 400, 0.0011);
    await bill("eval", refs.teacher, "2026-11-06T10:00:00Z", 500, 0.0013);
    h.t.clock.set("2026-11-27T12:00:00Z");

    const rows = (await list()).body.data;
    expect(rows.map((r) => [r.kind, r.ref_id, r.ref_name, r.run_id])).toEqual([
      ["teacher", refs.teacher, "support-distilled-teacher", refs.distill],
      ["labeling", refs.labels, "support-router-labels", refs.router],
      ["scoring", refs.scoring, expect.any(String), null],
      ["eval", refs.plain, "nightly", null],
      ["training", refs.sft, "support-sft", refs.sft],
    ]);

    const s = (await summary()).body;
    expect([s.tokens, s.records, s.cost_usd]).toEqual([2400, 5, 0.0046]);
    expect(s.by_kind.map((k) => [k.kind, k.tokens, k.cost_usd])).toEqual([
      ["teacher", 500, 0.0013],
      ["labeling", 400, 0.0011],
      ["training", 1000, 0.001],
      ["scoring", 300, 0.0007],
      ["eval", 200, 0.0005],
    ]);
    expect(s.top_runs).toEqual([
      {
        id: refs.sft,
        name: "support-sft",
        kind: "training",
        cost_usd: 0.001,
        tokens: 1000,
      },
    ]);
    expect(s.top_evals.map((e) => [e.id, e.kind])).toEqual([
      [refs.teacher, "teacher"],
      [refs.labels, "labeling"],
      [refs.scoring, "scoring"],
      [refs.plain, "eval"],
    ]);

    const byRecipe = (await summary("?group_by=recipe")).body.groups;
    expect(byRecipe.map((g) => [g.key, g.tokens])).toEqual([
      ["distill", 500],
      [null, 500],
      ["router", 400],
      ["sft", 1000],
    ]);
    const byModel = (await summary("?group_by=model")).body.groups;
    expect(byModel.map((g) => [g.key, g.tokens])).toEqual([
      ["qwen/qwen3-32b", 500],
      ["qwen/qwen3-1.7b, qwen/qwen3-8b", 400],
      ["test/tiny-qwen3", 1000],
      [expect.any(String), 300],
      ["qwen/qwen3-8b", 200],
    ]);
  });

  it("sums costs exactly: no float drift across many rows", async () => {
    for (let i = 0; i < 10; i += 1) {
      await bill("run", refs.sft, `2026-11-10T10:00:0${i}Z`, 1, 0.1);
    }
    const s = (await summary("?from=2026-11-10&to=2026-11-10")).body;
    // 0.1 summed ten times as doubles is 0.9999999999999999.
    expect(s.cost_usd).toBe(1);
    expect(s.top_runs[0]?.cost_usd).toBe(1);
  });

  it("defaults to this UTC month; --from is inclusive and a date --to covers the whole day", async () => {
    await bill("run", refs.sft, "2026-10-31T23:59:59.999Z", 1, 0.01);
    await bill("run", refs.sft, "2026-11-01T00:00:00.000Z", 10, 0.1);
    await bill("run", refs.sft, "2026-11-30T23:59:59.999Z", 100, 1);
    await bill("run", refs.sft, "2026-12-01T00:00:00.000Z", 1000, 10);
    h.t.clock.set("2026-11-27T12:00:00Z");

    const month = (await summary()).body;
    expect([month.from, month.to, month.tokens]).toEqual([
      "2026-11-01T00:00:00.000Z",
      "2026-12-01T00:00:00.000Z",
      110,
    ]);
    expect((await summary("?from=2026-11-01&to=2026-11-30")).body.tokens).toBe(
      110,
    );
    // A timestamp `to` is exclusive; one with an offset is converted to UTC.
    expect(
      (await summary("?from=2026-11-01&to=2026-11-30T23:59:59.999Z")).body
        .tokens,
    ).toBe(10);
    expect(
      (await summary("?from=2026-11-01T01:00:00%2B02:00&to=2026-11-01")).body
        .tokens,
    ).toBe(11);
    // Only `to`: that month. Only `from`: through the end of this month.
    expect((await summary("?to=2026-10-31")).body).toMatchObject({
      from: "2026-10-01T00:00:00.000Z",
      tokens: 1,
    });
    expect((await summary("?from=2026-10-15")).body.tokens).toBe(111);
    expect(
      (await list("?from=2026-11-01&to=2026-11-30")).body.data.map(
        (r) => r.tokens,
      ),
    ).toEqual([100, 10]);
  });

  it("an empty range is zeros, not an error; a reversed or bad one is a 422", async () => {
    const empty = (await summary("?from=2025-01-01&to=2025-01-31&group_by=day"))
      .body;
    expect(empty).toMatchObject({
      cost_usd: 0,
      tokens: 0,
      records: 0,
      by_kind: [],
      top_runs: [],
      top_evals: [],
      group_by: "day",
      groups: [],
    });
    expect((await list("?from=2025-01-01&to=2025-01-31")).body).toEqual({
      data: [],
      next_cursor: null,
    });

    const reversed = await summary("?from=2026-11-10&to=2026-11-01");
    expect([reversed.status, reversed.body]).toMatchObject([
      422,
      { code: "invalid_period" },
    ]);
    for (const bad of [
      "2026-02-30",
      "11/01/2026",
      "2026-13-01T00:00:00Z",
      "yesterday",
    ]) {
      const res = await h.t.json<{ code: string; detail: string }>(
        `/v1/usage?from=${encodeURIComponent(bad)}`,
      );
      expect([res.status, res.body.code]).toEqual([422, "validation_error"]);
      expect(res.body.detail).toMatch(/from: must be a date \(YYYY-MM-DD\)/);
    }
    const group = await summary("?group_by=hour");
    expect(group.status).toBe(422);
  });

  it("groups by UTC day, ISO week and month", async () => {
    await bill("run", refs.sft, "2026-11-01T23:30:00Z", 1, 0.1); // Sunday
    await bill("run", refs.sft, "2026-11-02T00:30:00Z", 2, 0.2); // Monday
    await bill("run", refs.sft, "2026-11-02T22:00:00Z", 4, 0.4);
    await bill("run", refs.sft, "2026-12-03T00:00:00Z", 8, 0.8);
    const q = "?from=2026-11-01&to=2026-12-31&group_by=";
    const keys = async (by: string) =>
      (await summary(q + by)).body.groups.map((g) => [g.key, g.tokens]);

    expect(await keys("day")).toEqual([
      ["2026-11-01", 1],
      ["2026-11-02", 6],
      ["2026-12-03", 8],
    ]);
    expect(await keys("week")).toEqual([
      ["2026-10-26", 1],
      ["2026-11-02", 6],
      ["2026-11-30", 8],
    ]);
    expect(await keys("month")).toEqual([
      ["2026-11", 7],
      ["2026-12", 8],
    ]);
    expect(await keys("kind")).toEqual([["training", 15]]);
  });

  it("buckets in UTC whatever the database session's time zone", async () => {
    await bill("run", refs.sft, "2026-11-30T20:00:00Z", 5, 0.5);
    const pool = new pg.Pool({
      connectionString: postgresUrl(),
      options: `-c search_path=${await fileSchemaName()} -c TimeZone=Pacific/Kiritimati`,
    });
    try {
      const usage = createUsageRepository(createDb(pool), h.t.clock);
      const period = {
        from: new Date("2026-11-01T00:00:00Z"),
        to: new Date("2027-01-01T00:00:00Z"),
      };
      // 20:00 UTC on the 30th is already 10:00 on 1 December at UTC+14.
      expect(
        (await usage.summarize(WORKSPACE_A, period, "day")).groups,
      ).toEqual([{ key: "2026-11-30", tokens: 5, cost_usd: 0.5, records: 1 }]);
      expect(
        (await usage.summarize(WORKSPACE_A, period, "month")).groups[0]?.key,
      ).toBe("2026-11");
    } finally {
      await pool.end();
    }
  });

  it("filters combine: period, run (with its evals), eval and kind; pages follow them", async () => {
    await bill("run", refs.sft, "2026-11-02T10:00:00Z", 1, 0.1);
    await bill("run", refs.router, "2026-11-03T10:00:00Z", 2, 0.2);
    await bill("eval", refs.labels, "2026-11-04T10:00:00Z", 4, 0.4);
    await bill("eval", refs.labels, "2026-11-20T10:00:00Z", 8, 0.8);
    await bill("eval", refs.plain, "2026-11-21T10:00:00Z", 16, 1.6);
    const tokens = async (query: string) =>
      (await list(query)).body.data.map((r) => r.tokens);

    expect(await tokens(`?run_id=${refs.router}`)).toEqual([8, 4, 2]);
    expect(await tokens(`?run_id=${refs.router}&kind=labeling`)).toEqual([
      8, 4,
    ]);
    expect(
      await tokens(`?run_id=${refs.router}&kind=labeling&to=2026-11-10`),
    ).toEqual([4]);
    expect(await tokens(`?eval_id=${refs.labels}&from=2026-11-10`)).toEqual([
      8,
    ]);
    expect(
      await tokens(`?eval_id=${refs.plain}&run_id=${refs.router}`),
    ).toEqual([]);
    expect(await tokens("?kind=training&from=2026-11-03")).toEqual([2]);
    expect(await tokens("?kind=eval")).toEqual([16]);

    const first = await list(`?run_id=${refs.router}&limit=2`);
    expect(first.body.data.map((r) => r.tokens)).toEqual([8, 4]);
    const second = await list(
      `?run_id=${refs.router}&limit=2&cursor=${first.body.next_cursor}`,
    );
    expect([
      second.body.data.map((r) => r.tokens),
      second.body.next_cursor,
    ]).toEqual([[2], null]);
    expect((await list("?kind=nope")).status).toBe(422);
  });
});

describe("summaryPeriod", () => {
  const now = new Date("2026-12-31T23:00:00Z");

  it("rolls the default month over the year end", () => {
    expect(summaryPeriod({}, now)).toEqual({
      from: new Date("2026-12-01T00:00:00Z"),
      to: new Date("2027-01-01T00:00:00Z"),
    });
    expect(summaryPeriod({ from: "2027-02-10" }, now)).toEqual({
      from: new Date("2027-02-10T00:00:00Z"),
      to: new Date("2027-03-01T00:00:00Z"),
    });
    expect(summaryPeriod({ to: "2026-02-28" }, now).from).toEqual(
      new Date("2026-02-01T00:00:00Z"),
    );
    expect(summaryPeriod({ from: "2026-11-01T10:00" }, now).from).toEqual(
      new Date("2026-11-01T10:00:00Z"),
    );
  });
});
