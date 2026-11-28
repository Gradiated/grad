import { describe, expect, it } from "vitest";

import {
  APIUserAbortError,
  Dataset,
  Eval,
  EvalFailedError,
  EvalFailures,
  GradUsageError,
  Judge,
  Rubric,
  Scorer,
  validators,
  WaitTimeoutError,
} from "../src/index.js";
import { FakeServer, json, makeGrad, wire } from "./helpers.js";

type Wire = Record<string, unknown> & { id: string };
const awaiting = wire<Wire>("eval-awaiting-scores.json");
const completed = wire<Wire>("eval-completed.json");
const outputs = wire<{ data: Array<Record<string, unknown> & { id: string; output: string }> }>("eval-outputs.json");
const EVAL = `/v1/evals/${awaiting.id}`;
const running = { ...awaiting, status: "running", local_scorers: [] };

const rubric = () =>
  new Rubric([
    new Scorer("non_empty", { fn: validators.nonEmpty() }),
    new Scorer("mentions_menu", { fn: (output) => (output ?? "").includes("Settings") }),
  ]);

describe("evals", () => {
  it("posts scores 1,000 per request and sums accepted", async () => {
    const server = new FakeServer().on("POST", `${EVAL}/scores`, (call) =>
      json({ accepted: (JSON.parse(call.body ?? "{}") as { scores: unknown[] }).scores.length, status: "awaiting_scores", pending_local_scores: 0 }),
    );
    const { grad } = makeGrad(server);
    const scores = Array.from({ length: 2500 }, (_, i) => ({ outputId: `out_${i}`, scorer: "short", score: 1 }));
    const result = await grad.evals.postScores(awaiting.id, scores);
    expect(server.callsTo("POST", `${EVAL}/scores`).map((c) => (JSON.parse(c.body ?? "{}") as { scores: unknown[] }).scores.length)).toEqual([1000, 1000, 500]);
    expect(server.lastBody<{ scores: Array<Record<string, unknown>> }>("POST", `${EVAL}/scores`).scores[0]).toEqual({ output_id: "out_2000", scorer: "short", score: 1 });
    expect(result).toEqual({ accepted: 2500, status: "awaiting_scores", pendingLocalScores: 0 });
    await expect(grad.evals.postScores(awaiting.id, [])).rejects.toBeInstanceOf(GradUsageError);
  });

  it("plans with the wire rubric and creates with local scorers kept in-process", async () => {
    const server = new FakeServer()
      .on("POST", "/v1/evals/plan", json(wire("plan-eval.json")))
      .on("POST", "/v1/evals", json(awaiting, 202));
    const { grad } = makeGrad(server);
    const params = {
      name: "support-eval",
      models: ["test/tiny-qwen3", { name: "support-sft", version: "3" }],
      baseline: "qwen/qwen3-8b",
      dataset: { name: "support-eval" },
      datasetVersion: 1,
      rubric: rubric(),
      samples: 1,
      temperature: 0.7,
      maxTokens: 1024,
      limit: 10,
      passThreshold: 0.5,
    };
    const plan = await grad.evals.plan(params);
    expect(plan.localScorers).toEqual(["mentions_menu"]);
    expect(server.lastBody("POST", "/v1/evals/plan")).toEqual({
      models: ["test/tiny-qwen3", "support-sft@3"],
      name: "support-eval",
      baseline: "qwen/qwen3-8b",
      dataset: "support-eval",
      dataset_version: 1,
      rubric: [
        { name: "non_empty", kind: "validator", validator: "non_empty" },
        { name: "mentions_menu", kind: "code", runtime: "local" },
      ],
      samples: 1,
      temperature: 0.7,
      max_tokens: 1024,
      limit: 10,
      pass_threshold: 0.5,
    });
    const ev = await grad.evals.create(params);
    expect(ev).toBeInstanceOf(Eval);
    expect(ev.status).toBe("awaiting_scores");
    expect(JSON.parse(JSON.stringify(ev)).id).toBe(awaiting.id);
    await expect(grad.evals.plan({ models: [], dataset: "support-holdout" })).rejects.toBeInstanceOf(GradUsageError);
  });

  it("wait() scores outputs locally, posts the scores and resolves on completed", async () => {
    const server = new FakeServer()
      .on("POST", "/v1/evals", json(awaiting, 202))
      .on("GET", EVAL, json(running), json(awaiting), json(completed))
      .on("GET", `${EVAL}/outputs`, json(outputs), json({ data: [], next_cursor: null }))
      .on("POST", `${EVAL}/scores`, json({ accepted: 6, status: "awaiting_scores", pending_local_scores: 0 }));
    const { grad } = makeGrad(server);
    const statuses: string[] = [];
    const ev = await grad.evals.create({ models: ["test/tiny-qwen3"], dataset: "support-holdout", rubric: rubric() }).wait({ onStatus: (s) => void statuses.push(s) });
    expect(ev.status).toBe("completed");
    expect(statuses).toEqual(["running", "awaiting_scores", "completed"]);
    const scoreCall = server.callsTo("GET", `${EVAL}/outputs`)[0];
    expect(scoreCall?.url.searchParams.get("missing_scorer")).toBe("mentions_menu");
    const posted = server.lastBody<{ scores: Array<{ output_id: string; scorer: string; score: number }> }>("POST", `${EVAL}/scores`);
    expect(posted.scores).toHaveLength(outputs.data.length);
    expect(posted.scores[0]).toEqual({ output_id: outputs.data[0]?.id, scorer: "mentions_menu", score: outputs.data[0]?.output.includes("Settings") ? 1 : 0 });

    const table = ev.summaryTable().split("\n");
    expect(table[0]).toMatch(/^model\s+overall\s+95% CI\s+pass@1\s+vs qwen\/qwen3-8b\s+tasks\s+errors\s+\$\/1k tasks$/);
    expect(table[2]).toContain("+50.0% (50.0%..50.0%)");
    expect(table[3]).toContain("baseline");
    expect(table[3]).toContain("$0.01");
  });

  it("stops after the server stops asking, and refuses to re-post outputs it already scored", async () => {
    const done = new FakeServer()
      .on("GET", EVAL, json(awaiting), json(awaiting), json(completed))
      .on("GET", `${EVAL}/outputs`, json(outputs))
      .on("POST", `${EVAL}/scores`, json(wire("eval-scores-response.json")));
    const ev = await makeGrad(done).grad.evals.wait(awaiting.id, { rubric: rubric() });
    expect(ev.status).toBe("completed");
    expect(done.callsTo("POST", `${EVAL}/scores`)).toHaveLength(1);

    const stuck = new FakeServer()
      .on("GET", EVAL, json(awaiting))
      .on("GET", `${EVAL}/outputs`, json(outputs))
      .on("POST", `${EVAL}/scores`, json({ accepted: 0, status: "awaiting_scores", pending_local_scores: 6 }));
    await expect(makeGrad(stuck).grad.evals.wait(awaiting.id, { rubric: rubric() })).rejects.toMatchObject({ code: "score_not_recorded" });
    expect(stuck.callsTo("POST", `${EVAL}/scores`)).toHaveLength(1);
  });

  it("explains a missing local scorer and an invalid score", async () => {
    const server = new FakeServer().on("GET", EVAL, json(awaiting));
    await expect(makeGrad(server).grad.evals.wait(awaiting.id)).rejects.toMatchObject({ code: "missing_local_scorer" });

    const bad = new FakeServer().on("GET", EVAL, json(awaiting)).on("GET", `${EVAL}/outputs`, json(outputs));
    const nan = new Scorer("mentions_menu", { fn: () => Number.NaN });
    await expect(makeGrad(bad).grad.evals.wait(awaiting.id, { rubric: nan })).rejects.toMatchObject({ code: "invalid_score" });
  });

  it("throws EvalFailedError on failed/cancelled, honours timeouts and aborts", async () => {
    const failed = new FakeServer().on("GET", EVAL, json({ ...running, status: "failed", error: "judge quota" }));
    const err = await makeGrad(failed).grad.evals.wait(awaiting.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvalFailedError);
    expect((err as EvalFailedError).eval.status).toBe("failed");
    expect((err as Error).message).toContain("judge quota");

    const slow = new FakeServer().on("GET", EVAL, json(running));
    await expect(makeGrad(slow).grad.evals.wait(awaiting.id, { timeoutMs: 3_000 })).rejects.toBeInstanceOf(WaitTimeoutError);

    const controller = new AbortController();
    controller.abort();
    const ev = await makeGrad(slow).grad.evals.get(awaiting.id);
    await expect(ev.wait({ signal: controller.signal })).rejects.toBeInstanceOf(APIUserAbortError);
  });

  it("stops scoring when aborted between pages", async () => {
    const controller = new AbortController();
    const server = new FakeServer()
      .on("GET", EVAL, json(awaiting))
      .on("GET", `${EVAL}/outputs`, json(outputs))
      .on("POST", `${EVAL}/scores`, () => {
        controller.abort();
        return json({ accepted: 6, status: "awaiting_scores", pending_local_scores: 6 });
      });
    const fresh = { ...outputs, data: outputs.data.map((o, i) => ({ ...o, id: `evout_${i}` })) };
    server.on("GET", `${EVAL}/outputs`, json(outputs), json(fresh));
    await expect(makeGrad(server).grad.evals.wait(awaiting.id, { rubric: rubric(), signal: controller.signal })).rejects.toBeInstanceOf(APIUserAbortError);
    expect(server.callsTo("POST", `${EVAL}/scores`)).toHaveLength(1);
  });

  it("lists, gets, refreshes, cancels; results, outputs and failures page through cursors", async () => {
    const result = wire<{ data: Array<Record<string, unknown>> }>("eval-results.json");
    const failure = { task_id: "rec_1", model: "test/tiny-qwen3", score: 0, passed: false, sample_scores: [0], judge_model: null, record: { id: "rec_1", messages: [{ role: "user", content: "hi" }] } };
    const server = new FakeServer()
      .on("GET", "/v1/evals", json({ data: [completed], next_cursor: "c2" }), json({ data: [awaiting], next_cursor: null }))
      .on("GET", EVAL, json(completed))
      .on("POST", `${EVAL}/cancel`, json({ ...running, status: "cancelled" }))
      .on("GET", `${EVAL}/results`, json({ data: result.data, next_cursor: null }))
      .on("GET", `${EVAL}/outputs`, json({ data: outputs.data.slice(0, 2), next_cursor: "o2" }), json({ data: outputs.data.slice(2), next_cursor: null }))
      .on(
        "GET",
        `${EVAL}/failures`,
        json({ eval_id: awaiting.id, data: [failure, failure], next_cursor: "f2" }),
        json({ eval_id: awaiting.id, data: [{ ...failure, task_id: "rec_2", record: { id: "rec_2", messages: [] } }], next_cursor: null }),
      )
      .on("POST", "/v1/datasets/sql-hard/records", json(wire("dataset.json")));
    const { grad } = makeGrad(server);

    const all = [];
    for await (const ev of grad.evals.list({ limit: 1 })) all.push(ev);
    expect(all.map((e) => e.status)).toEqual(["completed", "awaiting_scores"]);
    expect(all[0]).toBeInstanceOf(Eval);
    expect(server.callsTo("GET", "/v1/evals")[1]?.url.searchParams.get("cursor")).toBe("c2");

    const ev = await grad.evals.get(awaiting.id);
    await ev.refresh();
    expect((await grad.evals.cancel(awaiting.id)).status).toBe("cancelled");
    expect((await ev.cancel()).status).toBe("cancelled");

    expect(await ev.results({ model: "qwen/qwen3-8b", limit: 5 }).all()).toHaveLength(result.data.length);
    expect(server.callsTo("GET", `${EVAL}/results`)[0]?.url.searchParams.get("model")).toBe("qwen/qwen3-8b");
    expect(await grad.evals.outputs(awaiting.id, { model: "m", limit: 2 }).all()).toHaveLength(outputs.data.length);

    const failures = await ev.failures({ model: "test/tiny-qwen3", threshold: 0.8 });
    expect(failures).toBeInstanceOf(EvalFailures);
    expect(failures.length).toBe(3);
    expect([...failures].map((f) => f.taskId)).toEqual(["rec_1", "rec_1", "rec_2"]);
    expect(server.callsTo("GET", `${EVAL}/failures`)[0]?.url.searchParams.get("threshold")).toBe("0.8");

    const ds = await failures.toDataset("sql-hard", { metadata: { round: 2 } });
    expect(ds).toBeInstanceOf(Dataset);
    const pushed = server.lastBody<{ records: Array<{ id: string }>; metadata: Record<string, unknown> }>("POST", "/v1/datasets/sql-hard/records");
    expect(pushed.records.map((r) => r.id)).toEqual(["rec_1", "rec_2"]);
    expect(pushed.metadata).toEqual({ source: `eval:${awaiting.id}`, round: 2 });

    const none = new FakeServer().on("GET", `${EVAL}/failures`, json(wire("eval-failures.json")));
    await expect((await makeGrad(none).grad.evals.failures(awaiting.id)).toDataset("x")).rejects.toMatchObject({ code: "empty_push" });
  });

  it("renders a table without a baseline and with missing pass@k and cost", async () => {
    const server = new FakeServer().on(
      "GET",
      EVAL,
      json({
        ...completed,
        baseline: null,
        summary: [
          { model: "a", overall: 0.25, ci_low: 0.1, ci_high: 0.4, pass_at_k: { "pass@1": 0.25 }, vs_baseline: null, tasks: 4, errors: 1, tokens_per_task: 3, cost_per_1k_tasks_usd: null },
          { model: "b", overall: 0.5, ci_low: 0.4, ci_high: 0.6, pass_at_k: {}, vs_baseline: null, tasks: 4, errors: 0, tokens_per_task: 3, cost_per_1k_tasks_usd: 1.5 },
        ],
      }),
    );
    const ev = await makeGrad(server).grad.evals.get(awaiting.id);
    const lines = ev.summaryTable().split("\n");
    expect(lines[0]).not.toContain("vs ");
    expect(lines[2]).toMatch(/^a\s+25\.0%\s+10\.0%-40\.0%\s+25\.0%\s+4\s+1\s+-$/);
    expect(lines[3]).toMatch(/^b\s+50\.0%\s+40\.0%-60\.0%\s+-\s+4\s+0\s+\$1\.50$/);
  });

  it("accepts judges and raw wire rubric items", async () => {
    const server = new FakeServer().on("POST", "/v1/evals/plan", json(wire("plan-eval.json")));
    const { grad } = makeGrad(server);
    await grad.evals.plan({ models: ["m"], dataset: "d", rubric: new Judge({ name: "resolved", model: "anthropic/claude-sonnet", prompt: "Solved?" }) });
    expect(server.lastBody<{ rubric: unknown }>("POST", "/v1/evals/plan").rubric).toEqual([
      { name: "resolved", kind: "judge", model: "anthropic/claude-sonnet", prompt: "Solved?" },
    ]);
    await grad.evals.plan({ models: ["m"], dataset: "d", rubric: [{ name: "ok", kind: "validator", validator: "json" }] });
    expect(server.lastBody<{ rubric: unknown }>("POST", "/v1/evals/plan").rubric).toEqual([{ name: "ok", kind: "validator", validator: "json" }]);
  });
});
