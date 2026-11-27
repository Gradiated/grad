import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EvalRubricItemSchema, type EvalRubricItem } from "../src/contracts.js";
import { aggregateEval } from "../src/services/evals/aggregate.js";
import { createOpenAICompatibleClient } from "../src/services/evals/inference.js";
import { resolvePassThreshold } from "../src/services/evals/planner.js";
import { createRegexEvaluator } from "../src/services/evals/regex.js";
import {
  buildJudgeMessages,
  combineScores,
  parseJudgeScore,
  scoreOutput,
} from "../src/services/evals/scoring.js";
import {
  bootstrapMeanCI,
  computePassAtK,
} from "../src/services/evals/stats.js";
import type { EvalOutputRow } from "../src/store/types.js";
import {
  judgeResponder,
  startFakeOpenAI,
  type FakeOpenAI,
} from "./fixtures/fake-openai.js";

const item = (raw: Record<string, unknown>): EvalRubricItem =>
  EvalRubricItemSchema.parse(raw);

const seeded = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
};

describe("eval statistics", () => {
  it("bootstrap CI of the mean covers the true mean ~95% of the time", () => {
    const rand = seeded(7);
    let covered = 0;
    const trials = 200;
    const p = 0.6;
    for (let t = 0; t < trials; t += 1) {
      const sample = Array.from({ length: 60 }, () => (rand() < p ? 1 : 0));
      const ci = bootstrapMeanCI(sample, t);
      if (ci.ci_low <= p && p <= ci.ci_high) covered += 1;
    }
    expect(covered / trials).toBeGreaterThan(0.88);
    expect(covered / trials).toBeLessThan(0.995);
  });

  it("handles empty, single and constant inputs", () => {
    expect(bootstrapMeanCI([])).toEqual({ mean: 0, ci_low: 0, ci_high: 0 });
    expect(bootstrapMeanCI([0.7])).toEqual({
      mean: 0.7,
      ci_low: 0.7,
      ci_high: 0.7,
    });
    expect(bootstrapMeanCI([1, 1, 1])).toEqual({
      mean: 1,
      ci_low: 1,
      ci_high: 1,
    });
    const two = bootstrapMeanCI([0, 1]);
    expect(two.mean).toBe(0.5);
    expect(two.ci_low).toBeLessThanOrEqual(0.5);
    expect(two.ci_high).toBeGreaterThanOrEqual(0.5);
  });

  it("matches unbiased pass@k reference values", () => {
    const passes = (n: number, c: number) =>
      Array.from({ length: n }, (_, i) => i < c);
    expect(computePassAtK(passes(10, 3), 1)).toBeCloseTo(0.3, 4);
    expect(computePassAtK(passes(10, 3), 5)).toBeCloseTo(1 - 21 / 252, 4);
    expect(computePassAtK(passes(5, 0), 1)).toBe(0);
    expect(computePassAtK(passes(5, 4), 2)).toBe(1);
    expect(computePassAtK([], 1)).toBe(0);
    expect(computePassAtK(passes(3, 1), 0)).toBe(0);
  });
});

describe("rubric scoring", () => {
  const regex = createRegexEvaluator({ timeoutMs: 100 });
  afterAll(() => regex.close());

  it("scores validators and regexes", async () => {
    const rubric = [
      item({ name: "json", kind: "validator", validator: "json" }),
      item({ name: "nonempty", kind: "validator", validator: "non_empty" }),
      item({ name: "exact", kind: "validator", validator: "exact_match" }),
      item({ name: "has_ok", kind: "regex", pattern: "ok", flags: "i" }),
      item({ name: "fn", kind: "code", runtime: "local" }),
    ];
    const good = await scoreOutput(
      rubric,
      { prompt: [], output: ' {"OK": 1} ', reference: '{"OK": 1}' },
      { regex, judge: null, workspace: "ws", judgeTargets: {} },
    );
    expect(good.scores).toEqual({ json: 1, nonempty: 1, exact: 1, has_ok: 1 });
    expect(good.errors).toEqual([]);

    const bad = await scoreOutput(
      rubric,
      { prompt: [], output: "  ", reference: null },
      { regex, judge: null, workspace: "ws", judgeTargets: {} },
    );
    expect(bad.scores).toEqual({ json: 0, nonempty: 0, exact: 0, has_ok: 0 });
  });

  it("combines weighted scores with missing items as zero", () => {
    const rubric = [
      item({ name: "a", kind: "validator", validator: "non_empty", weight: 3 }),
      item({ name: "b", kind: "code" }),
    ];
    expect(combineScores(rubric, { a: 1, b: 0 })).toBe(0.75);
    expect(combineScores(rubric, { a: 1 })).toBe(0.75);
    expect(combineScores([], {})).toBe(0);
  });

  it("parses judge replies strictly", () => {
    expect(parseJudgeScore('{"score": 0.8}')).toBe(0.8);
    expect(parseJudgeScore('Sure! {"reason": "x"} then {"score": 1.7}')).toBe(
      1,
    );
    expect(parseJudgeScore("0.25")).toBe(0.25);
    expect(parseJudgeScore("-3")).toBe(0);
    expect(parseJudgeScore("great answer")).toBeNull();
    expect(parseJudgeScore('{"score": "high"}')).toBeNull();
  });

  it("builds a judge prompt with criteria, conversation, response and reference", () => {
    const messages = buildJudgeMessages(
      item({
        name: "j",
        kind: "judge",
        model: "judge/m",
        prompt: "Is it polite?",
      }),
      {
        prompt: [{ role: "user", content: "hi" }],
        output: "hello",
        reference: null,
      },
    );
    const text = String(messages[1]?.content);
    expect(text).toContain("Is it polite?");
    expect(text).toContain("user: hi");
    expect(text).toContain("hello");
    expect(text).toContain("(none)");
  });

  it("records judge failures and missing judge endpoints as errors with score 0", async () => {
    const judgeItem = item({ name: "j", kind: "judge", model: "judge/m" });
    const noJudge = await scoreOutput(
      [judgeItem],
      { prompt: [], output: "x", reference: null },
      { regex, judge: null, workspace: "ws", judgeTargets: {} },
    );
    expect(noJudge.scores.j).toBe(0);
    expect(noJudge.errors[0]).toContain("no judge endpoint");

    const garbage = await scoreOutput(
      [judgeItem],
      { prompt: [], output: "x", reference: null },
      {
        regex,
        workspace: "ws",
        judgeTargets: {},
        judge: {
          complete: async () => ({
            text: "no idea",
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }),
        },
      },
    );
    expect(garbage.scores.j).toBe(0);
    expect(garbage.errors[0]).toContain("unparseable");
    expect(garbage.judgeTokens["judge/m"]).toBe(5);

    const thrown = await scoreOutput(
      [judgeItem],
      { prompt: [], output: "x", reference: null },
      {
        regex,
        workspace: "ws",
        judgeTargets: {},
        judge: {
          complete: async () => {
            throw new Error("down");
          },
        },
      },
    );
    expect(thrown.errors[0]).toContain("down");
  });

  it("resolves the default pass threshold from the rubric", () => {
    expect(
      resolvePassThreshold(
        [item({ name: "a", kind: "regex", pattern: "x" })],
        null,
      ),
    ).toBe(1);
    expect(
      resolvePassThreshold(
        [item({ name: "a", kind: "judge", model: "m" })],
        null,
      ),
    ).toBe(0.5);
    expect(resolvePassThreshold([], 0.3)).toBe(0.3);
  });

  it("rejects invalid rubric items at the boundary", () => {
    expect(
      EvalRubricItemSchema.safeParse({ name: "j", kind: "judge" }).success,
    ).toBe(false);
    expect(
      EvalRubricItemSchema.safeParse({ name: "r", kind: "regex" }).success,
    ).toBe(false);
    expect(
      EvalRubricItemSchema.safeParse({ name: "r", kind: "regex", pattern: "(" })
        .success,
    ).toBe(false);
    expect(
      EvalRubricItemSchema.safeParse({ name: "v", kind: "validator" }).success,
    ).toBe(false);
  });
});

describe("bounded regex evaluator", () => {
  it("interrupts catastrophic patterns without blocking the event loop", async () => {
    const regex = createRegexEvaluator({ timeoutMs: 100 });
    try {
      expect(await regex.test("^a+$", "", "aaa")).toEqual({ matched: true });

      let ticks = 0;
      const ticker = setInterval(() => {
        ticks += 1;
      }, 10);
      const started = Date.now();
      const outcome = await regex.test("(a|a)+$", "", `${"a".repeat(30)}!`);
      const elapsed = Date.now() - started;
      clearInterval(ticker);

      expect(outcome).toEqual({ timedOut: true });
      expect(elapsed).toBeLessThan(1500);
      expect(ticks).toBeGreaterThanOrEqual(3);

      expect(await regex.test("^(a|aa)+$", "", `${"a".repeat(40)}b`)).toEqual({
        timedOut: true,
      });

      expect(await regex.test("b", "", "abc")).toEqual({ matched: true });
      expect(await regex.test("z", "", "abc")).toEqual({ matched: false });
      await expect(regex.test("(", "", "abc")).rejects.toThrow();
      expect(await regex.test("c$", "", "abc")).toEqual({ matched: true });
    } finally {
      await regex.close();
    }
    await expect(regex.test("a", "", "a")).rejects.toThrow("closed");
  });

  it("serializes concurrent requests", async () => {
    const regex = createRegexEvaluator();
    try {
      const results = await Promise.all(
        ["a", "b", "z"].map((p) => regex.test(p, "", "ab")),
      );
      expect(results).toEqual([
        { matched: true },
        { matched: true },
        { matched: false },
      ]);
    } finally {
      await regex.close();
    }
  });
});

describe("OpenAI-compatible client", () => {
  let fake: FakeOpenAI;
  beforeAll(async () => {
    fake = await startFakeOpenAI();
  });
  afterAll(() => fake.close());

  it("calls /chat/completions with auth and returns text + usage", async () => {
    const client = createOpenAICompatibleClient({
      baseUrl: `${fake.baseUrl}/`,
      apiKey: "sk-test",
    });
    const result = await client.complete({
      model: "m1",
      workspace: "ws_a",
      messages: [{ role: "user", content: "ping", train: false }],
      temperature: 0,
      max_tokens: 8,
    });
    expect(result.text).toBe("answer: ping");
    expect(result.usage.prompt_tokens).toBe(10);
    const last = fake.requests.at(-1);
    expect(last?.headers.authorization).toBe("Bearer sk-test");
    expect(last?.headers["x-grad-workspace"]).toBe("ws_a");
    expect(last?.messages[0]).toEqual({ role: "user", content: "ping" });
  });

  it("retries 503 and then succeeds", async () => {
    const client = createOpenAICompatibleClient({
      baseUrl: fake.baseUrl,
      retryDelayMs: 1,
    });
    fake.failNext(2, 503);
    const result = await client.complete({
      model: "m1",
      workspace: "ws_a",
      messages: [{ role: "user", content: "x" }],
      temperature: 0,
      max_tokens: 4,
    });
    expect(result.text).toBe("answer: x");
  });

  it("does not retry 4xx and surfaces inference_error", async () => {
    const client = createOpenAICompatibleClient({
      baseUrl: fake.baseUrl,
      retryDelayMs: 1,
    });
    const before = fake.requests.length;
    fake.failNext(1, 404);
    await expect(
      client.complete({
        model: "missing",
        workspace: "ws_a",
        messages: [],
        temperature: 0,
        max_tokens: 4,
      }),
    ).rejects.toMatchObject({ status: 502, code: "inference_error" });
    expect(fake.requests.length - before).toBe(1);
  });

  it("gives up after max attempts and on unreachable or malformed endpoints", async () => {
    const flaky = createOpenAICompatibleClient({
      baseUrl: fake.baseUrl,
      retryDelayMs: 1,
      maxAttempts: 2,
    });
    fake.failNext(5, 500);
    await expect(
      flaky.complete({
        model: "m",
        workspace: "ws_a",
        messages: [],
        temperature: 0,
        max_tokens: 4,
      }),
    ).rejects.toMatchObject({ code: "inference_error" });
    fake.failNext(0);

    const down = createOpenAICompatibleClient({
      baseUrl: "http://127.0.0.1:9",
      retryDelayMs: 1,
      maxAttempts: 1,
    });
    await expect(
      down.complete({
        model: "m",
        workspace: "ws_a",
        messages: [],
        temperature: 0,
        max_tokens: 4,
      }),
    ).rejects.toThrow("request failed");

    const malformed = createOpenAICompatibleClient({
      baseUrl: "http://x",
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    });
    await expect(
      malformed.complete({
        model: "m",
        workspace: "ws_a",
        messages: [],
        temperature: 0,
        max_tokens: 4,
      }),
    ).rejects.toThrow("malformed completion");

    const toolCalls = createOpenAICompatibleClient({
      baseUrl: "http://x",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: null, tool_calls: [{ id: "t" }] } },
            ],
          }),
          { status: 200 },
        ),
    });
    const res = await toolCalls.complete({
      model: "m",
      workspace: "ws_a",
      messages: [],
      temperature: 0,
      max_tokens: 4,
    });
    expect(res.text).toBe('[{"id":"t"}]');
    expect(res.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0 });
  });

  it("judge responder fixture returns parseable scores", async () => {
    fake.setModel("judge/x", judgeResponder(0.4));
    const client = createOpenAICompatibleClient({ baseUrl: fake.baseUrl });
    const reply = await client.complete({
      model: "judge/x",
      workspace: "ws_a",
      messages: [],
      temperature: 0,
      max_tokens: 4,
    });
    expect(parseJudgeScore(reply.text)).toBe(0.4);
  });
});

describe("aggregation", () => {
  const output = (
    model: string,
    task: number,
    sample: number,
    score: number | null,
  ): EvalOutputRow => ({
    id: `o_${model}_${task}_${sample}`,
    eval_id: "eval_1",
    attempt: 1,
    record: { messages: [] },
    task_index: task,
    task_id: `t${task}`,
    model,
    sample_index: sample,
    input: [],
    output: score === null ? null : "x",
    expected_output: null,
    scores: score === null ? {} : { v: score },
    error: score === null ? "boom" : null,
    prompt_tokens: 10,
    completion_tokens: 10,
    cost_usd: 0.001,
    created_at: "2026-11-27T00:00:00.000Z",
  });

  it("computes per-model summaries, pass@k and a paired baseline diff", () => {
    const rubric = [
      item({ name: "v", kind: "validator", validator: "non_empty" }),
    ];
    const outputs = [
      output("base", 0, 0, 0),
      output("base", 0, 1, 1),
      output("base", 1, 0, 0),
      output("base", 1, 1, 0),
      output("tuned", 0, 0, 1),
      output("tuned", 0, 1, 1),
      output("tuned", 1, 0, 1),
      output("tuned", 1, 1, null),
    ];
    const agg = aggregateEval(
      {
        id: "eval_1",
        models: ["base", "tuned"],
        baseline: "base",
        rubric,
        samples: 2,
        pass_threshold: 1,
        judge_models: [],
        model_targets: {
          base: { inference_model: "base", price_per_million_tokens: 1 },
          tuned: { inference_model: "tuned", price_per_million_tokens: null },
        },
      },
      outputs,
    );
    const [base, tuned] = agg.summary;
    expect(base?.overall).toBe(0.25);
    expect(base?.pass_at_k["pass@1"]).toBe(0.25);
    expect(base?.pass_at_k["pass@2"]).toBe(0.5);
    expect(base?.vs_baseline).toBeNull();
    expect(base?.cost_per_1k_tasks_usd).toBe(2);
    expect(base?.tokens_per_task).toBe(40);
    expect(tuned?.overall).toBe(0.75);
    expect(tuned?.errors).toBe(1);
    expect(tuned?.cost_per_1k_tasks_usd).toBeNull();
    expect(tuned?.vs_baseline?.delta).toBe(0.5);
    expect(agg.outputScores).toHaveLength(8);
    expect(agg.outputScores.find((o) => o.id === "o_tuned_1_1")?.score).toBe(0);
    expect(agg.outputScores.find((o) => o.id === "o_base_0_1")?.score).toBe(1);
    expect(agg.totalCostUsd).toBeCloseTo(0.008, 6);
  });
});
