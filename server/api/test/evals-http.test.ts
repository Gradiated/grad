import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestApp, TEST_JUDGE } from "./fixtures/app.js";
import {
  makeEvalHarness,
  qaRecords,
  seedArtifact,
  seedDataset,
  type EvalHarness,
} from "./fixtures/evals.js";

type Json = Record<string, unknown> & {
  id?: string;
  status?: string;
  code?: string;
  data?: Array<Record<string, unknown>>;
  next_cursor?: string | null;
};

describe("evals HTTP API", () => {
  let h: EvalHarness;

  beforeEach(async () => {
    h = await makeEvalHarness();
    await seedDataset(h.t, "qa", qaRecords(3));
  });

  afterEach(async () => {
    await h.close();
  });

  const createEval = async (body: Record<string, unknown>) => {
    const res = await h.t.json<Json>("/v1/evals", {
      body: { models: ["qwen/qwen3-8b"], dataset: "qa", ...body },
    });
    expect(res.status).toBe(202);

    return res.body;
  };

  it("plans, queues, executes and reports an eval end to end", async () => {
    const plan = await h.t.json<Json>("/v1/evals/plan", {
      body: { models: ["qwen/qwen3-8b"], dataset: "qa", samples: 2 },
    });
    expect(plan.status).toBe(200);
    expect(plan.body.estimated_model_calls).toBe(6);

    const created = await createEval({ name: "smoke" });
    expect(created.status).toBe("queued");
    await h.worker.drain();

    const got = await h.t.json<Json>(`/v1/evals/${created.id}`);
    expect(got.status).toBe(200);
    expect(got.body.status).toBe("completed");
    expect((got.body.summary as unknown[]).length).toBe(1);

    const outputs = await h.t.json<Json>(
      `/v1/evals/${created.id}/outputs?limit=2&model=qwen/qwen3-8b`,
    );
    expect(outputs.status).toBe(200);
    expect(outputs.body.data).toHaveLength(2);
    expect(outputs.body.next_cursor).toBeTruthy();

    const results = await h.t.json<Json>(`/v1/evals/${created.id}/results`);
    expect(results.body.data).toHaveLength(3);

    const failures = await h.t.json<Json>(
      `/v1/evals/${created.id}/failures?threshold=1`,
    );
    expect(failures.status).toBe(200);
    expect(failures.body.eval_id).toBe(created.id);
    expect(failures.body.data).toHaveLength(0);
    const strict = await h.t.json<Json>(
      `/v1/evals/${created.id}/failures?threshold=1.0&model=nobody`,
    );
    expect(strict.body.data).toHaveLength(0);

    await createEval({ name: "second" });
    const page1 = await h.t.json<Json>("/v1/evals?limit=1");
    expect(page1.body.data).toHaveLength(1);
    const page2 = await h.t.json<Json>(
      `/v1/evals?limit=1&cursor=${encodeURIComponent(String(page1.body.next_cursor))}`,
    );
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.data?.[0]?.id).not.toBe(page1.body.data?.[0]?.id);

    const bad = await h.t.json<Json>("/v1/evals?cursor=garbage");
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe("invalid_cursor");
  });

  it("supports the local scorer flow over HTTP", async () => {
    const created = await createEval({
      rubric: [{ name: "fn", kind: "code", runtime: "local" }],
    });
    await h.worker.drain();

    const outputs = await h.t.json<Json>(
      `/v1/evals/${created.id}/outputs?missing_scorer=fn&limit=200`,
    );
    expect(outputs.body.data).toHaveLength(3);
    const scores = (outputs.body.data ?? []).map((o) => ({
      output_id: o.id,
      scorer: "fn",
      score: 1,
    }));
    const posted = await h.t.json<Json>(`/v1/evals/${created.id}/scores`, {
      body: { scores },
    });
    expect(posted.status).toBe(200);
    expect(posted.body).toMatchObject({
      accepted: 3,
      status: "completed",
      pending_local_scores: 0,
    });

    const again = await h.t.json<Json>(`/v1/evals/${created.id}/scores`, {
      body: { scores },
    });
    expect(again.status).toBe(409);
    expect(again.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("cancels over HTTP and validates request bodies", async () => {
    const created = await createEval({});
    const cancelled = await h.t.json<Json>(`/v1/evals/${created.id}/cancel`, {
      method: "POST",
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
    const twice = await h.t.json<Json>(`/v1/evals/${created.id}/cancel`, {
      method: "POST",
    });
    expect(twice.status).toBe(200);
    expect(twice.body.status).toBe("cancelled");

    const invalid = await h.t.json<Json>("/v1/evals", {
      body: { models: [], dataset: "qa" },
    });
    expect(invalid.status).toBe(422);
    const judgeWithoutModel = await h.t.json<Json>("/v1/evals/plan", {
      body: {
        models: ["qwen/qwen3-8b"],
        dataset: "qa",
        rubric: [{ name: "j", kind: "judge" }],
      },
    });
    expect(judgeWithoutModel.status).toBe(422);
    const results = await h.t.json<Json>(`/v1/evals/${created.id}/results`);
    expect(results.status).toBe(409);
  });

  it("isolates workspaces and enforces scopes on every eval route", async () => {
    const created = await createEval({
      rubric: [{ name: "fn", kind: "code" }],
    });
    await h.worker.drain();

    const other = await h.t.mintKey("ws_b", ["runs:read", "runs:write"]);
    const id = created.id as string;
    const routes: Array<[string, string, unknown?]> = [
      ["GET", `/v1/evals/${id}`],
      ["GET", `/v1/evals/${id}/outputs`],
      [
        "POST",
        `/v1/evals/${id}/scores`,
        { scores: [{ output_id: "x", scorer: "fn", score: 1 }] },
      ],
      ["GET", `/v1/evals/${id}/results`],
      ["GET", `/v1/evals/${id}/failures`],
      ["POST", `/v1/evals/${id}/cancel`],
    ];
    for (const [method, path, body] of routes) {
      const res = await h.t.json<Json>(path, {
        method,
        token: other,
        ...(body ? { body } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body.code).toBe("eval_not_found");
    }
    const list = await h.t.json<Json>("/v1/evals", { token: other });
    expect(list.body.data).toEqual([]);
    const plan = await h.t.json<Json>("/v1/evals/plan", {
      token: other,
      body: { models: ["qwen/qwen3-8b"], dataset: "qa" },
    });
    expect(plan.status).toBe(404);

    const reader = await h.t.mintKey("ws_a", ["datasets:read"]);
    const denied = await h.t.json<Json>("/v1/evals/plan", {
      token: reader,
      body: { models: ["qwen/qwen3-8b"], dataset: "qa" },
    });
    expect(denied.status).toBe(403);
    const runsReader = await h.t.mintKey("ws_a", ["runs:read"]);
    const noWrite = await h.t.json<Json>("/v1/evals", {
      token: runsReader,
      body: { models: ["qwen/qwen3-8b"], dataset: "qa" },
    });
    expect(noWrite.status).toBe(403);
    const unauth = await h.t.json<Json>("/v1/evals", { token: null });
    expect(unauth.status).toBe(401);
  });
});

describe("eval judges (r8 P1-3)", () => {
  let h: EvalHarness;
  afterEach(async () => h.close());

  it("resolves judges within the workspace, prices every judge, and names the workspace on every call", async () => {
    h = await makeEvalHarness();
    const art = await seedArtifact(h.t, "a-private-model");
    const other = await h.t.mintKey("ws_b", ["runs:write", "datasets:write"]);
    await seedDataset(h.t, "qa", qaRecords(3), "ws_b");
    const judged = (model: string) => ({
      models: ["test/tiny-qwen3"],
      dataset: "qa",
      rubric: [{ name: "j", kind: "judge", model, prompt: "ok?" }],
    });

    // Another workspace's artifact, by version or @latest, and an unpriced
    // model are refused: no cross-tenant judges, no $0 judges.
    for (const judge of [
      art.id,
      "a-private-model@latest",
      "anthropic/claude-x",
    ]) {
      const res = await h.t.json<Json>("/v1/evals", {
        token: other,
        body: judged(judge),
      });
      expect([judge, res.status, res.body.code]).toEqual([
        judge,
        422,
        "unknown_judge_model",
      ]);
    }

    // A priced judge is estimated and billed at its price.
    const plan = await h.t.json<Json>("/v1/evals/plan", {
      token: other,
      body: judged(TEST_JUDGE),
    });
    expect(plan.status).toBe(200);
    expect(plan.body.estimated_cost_usd as number).toBeGreaterThan(0);
    const ev = await h.t.json<Json>("/v1/evals", {
      token: other,
      body: judged(TEST_JUDGE),
    });
    expect(ev.status).toBe(202);
    await h.worker.drain();
    const done = await h.t.json<Json>(`/v1/evals/${ev.body.id}`, {
      token: other,
    });
    expect(done.body.status).toBe("completed");
    const judgeRequests = h.fake.requests.filter((r) => r.model === TEST_JUDGE);
    expect(judgeRequests.length).toBe(3);
    // The same eval without the judge costs less: the judge's calls are billed.
    const unjudged = await h.t.json<Json>("/v1/evals", {
      token: other,
      body: { models: ["test/tiny-qwen3"], dataset: "qa" },
    });
    await h.worker.drain();
    const plain = await h.t.json<Json>(`/v1/evals/${unjudged.body.id}`, {
      token: other,
    });
    expect(done.body.total_cost_usd as number).toBeGreaterThan(
      plain.body.total_cost_usd as number,
    );
    // Every inference and judge call names its workspace.
    expect(
      new Set(h.fake.requests.map((r) => r.headers["x-grad-workspace"])),
    ).toEqual(new Set(["ws_b"]));

    // The owner may judge with its own artifact, priced at its base model.
    await seedDataset(h.t, "qa", qaRecords(1));
    const own = await h.t.json<Json>("/v1/evals/plan", {
      body: judged("a-private-model@latest"),
    });
    expect(own.status).toBe(200);
  });
});

describe("evals HTTP API without inference", () => {
  it("returns 501 inference_unavailable as problem+json", async () => {
    const t = await makeTestApp();
    try {
      await seedDataset(t, "qa", qaRecords(1));
      for (const path of ["/v1/evals/plan", "/v1/evals"]) {
        const res = await t.json<Json>(path, {
          body: { models: ["qwen/qwen3-8b"], dataset: "qa" },
        });
        expect(res.status).toBe(501);
        expect(res.body.code).toBe("inference_unavailable");
        expect(res.headers.get("content-type")).toContain(
          "application/problem+json",
        );
      }
      // Wave 2 sources (benchmarks, environments) are unknown keys, not ignored.
      const benchmarks = await t.json<Json>("/v1/evals/plan", {
        body: {
          models: ["qwen/qwen3-8b"],
          dataset: "qa",
          benchmarks: [{ name: "gsm8k" }],
        },
      });
      expect(benchmarks.status).toBe(422);
      const noDataset = await t.json<Json>("/v1/evals/plan", {
        body: { models: ["qwen/qwen3-8b"] },
      });
      expect(noDataset.status).toBe(422);
    } finally {
      await t.close();
    }
  });
});
