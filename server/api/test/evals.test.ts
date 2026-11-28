import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EvalRubricItemSchema, type EvalRubricItem } from "../src/contracts.js";
import { createEvalAggregator } from "../src/services/evals/aggregate.js";
import {
  createOpenAICompatibleClient,
  inferenceErrorReason,
} from "../src/services/evals/inference.js";
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
import type { RegexEvaluator } from "../src/services/evals/types.js";
import type { EvalScoreRow } from "../src/store/types.js";
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

  it("runs a regex that timed out only once per eval (r8 P2-10)", async () => {
    const calls: string[] = [];
    const slow: RegexEvaluator = {
      test: async (pattern) => {
        calls.push(pattern);
        return pattern === "(a+)+$" ? { timedOut: true } : { matched: true };
      },
      close: async () => {},
    };
    const rubric = [
      item({ name: "bad", kind: "regex", pattern: "(a+)+$" }),
      item({ name: "good", kind: "regex", pattern: "a" }),
    ];
    const ctx = {
      regex: slow,
      judge: null,
      workspace: "ws",
      judgeTargets: {},
      timedOutRegex: new Set<string>(),
    };
    for (let i = 0; i < 5; i += 1) {
      const out = await scoreOutput(
        rubric,
        { prompt: [], output: "aaaa!", reference: null },
        ctx,
      );
      expect(out.scores).toEqual({ bad: 0, good: 1 });
    }
    expect(calls.filter((p) => p === "(a+)+$")).toHaveLength(1);
    expect(calls.filter((p) => p === "a")).toHaveLength(5);
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

  it("retries a response whose body breaks off mid-stream", async () => {
    let calls = 0;
    const broken = () =>
      new Response(
        new ReadableStream({
          start: (controller) => {
            controller.enqueue(new TextEncoder().encode('{"choices":'));
            controller.error(new Error("socket hang up"));
          },
        }),
        { status: 200 },
      );
    const client = createOpenAICompatibleClient({
      baseUrl: fake.baseUrl,
      retryDelayMs: 1,
      fetchImpl: async (url, init) => {
        calls += 1;
        return calls === 1 ? broken() : fetch(url, init);
      },
    });
    const result = await client.complete({
      model: "m1",
      workspace: "ws_a",
      messages: [{ role: "user", content: "x" }],
      temperature: 0,
      max_tokens: 4,
    });
    expect([calls, result.text]).toEqual([2, "answer: x"]);
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

  it("classifies failures by reason, capacity_unavailable included", async () => {
    const answer = (status: number, body = "{}") =>
      createOpenAICompatibleClient({
        baseUrl: "http://gateway.test",
        retryDelayMs: 1,
        maxAttempts: 1,
        fetchImpl: async () => new Response(body, { status }),
      });
    const reason = (client: ReturnType<typeof answer>) =>
      client
        .complete({
          model: "m",
          workspace: "ws_a",
          messages: [],
          temperature: 0,
          max_tokens: 4,
        })
        .then(
          () => "ok",
          (error: unknown) => inferenceErrorReason(error),
        );
    expect(await reason(answer(503, '{"error":"capacity_unavailable"}'))).toBe(
      "capacity_unavailable",
    );
    expect(await reason(answer(429))).toBe("rate_limited");
    expect(await reason(answer(504))).toBe("timeout");
    expect(await reason(answer(500))).toBe("server_error");
    expect(await reason(answer(400))).toBe("rejected");
    expect(await reason(answer(200, "not json"))).toBe("malformed");
    const refused = createOpenAICompatibleClient({
      baseUrl: "http://gateway.test",
      maxAttempts: 1,
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await reason(refused)).toBe("unreachable");
    const slow = createOpenAICompatibleClient({
      baseUrl: "http://gateway.test",
      maxAttempts: 1,
      fetchImpl: async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    });
    expect(await reason(slow)).toBe("timeout");
  });

  it("gives up after max attempts and on unreachable or malformed endpoints", async () => {
    const flaky = createOpenAICompatibleClient({
      baseUrl: fake.baseUrl,
      retryDelayMs: 1,
      maxAttempts: 2,
    });
    // 5xx through every retry: a transient outage (503), not a model error.
    fake.failNext(5, 500);
    await expect(
      flaky.complete({
        model: "m",
        workspace: "ws_a",
        messages: [],
        temperature: 0,
        max_tokens: 4,
      }),
    ).rejects.toMatchObject({ status: 503, code: "inference_unavailable" });
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
  ): EvalScoreRow => ({
    id: `o_${model}_${task}_${sample}`,
    task_index: task,
    task_id: `t${task}`,
    model,
    sample_index: sample,
    answered: score !== null,
    scores: score === null ? {} : { v: score },
    error: score === null ? "boom" : null,
    prompt_tokens: 10,
    completion_tokens: 10,
    cost_usd: 0.001,
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
    const run = {
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
    };
    // listScoreRows order: task, model, sample.
    outputs.sort(
      (a, b) =>
        a.task_index - b.task_index ||
        a.model.localeCompare(b.model) ||
        a.sample_index - b.sample_index,
    );
    const aggregator = createEvalAggregator(run);
    const outputScores = aggregator.add(outputs);
    const agg = { ...aggregator.finish(), outputScores };
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
    expect(agg.generated).toBe(8);

    // Pages that split a task's outputs aggregate exactly like one page.
    for (const size of [1, 3, 5]) {
      const paged = createEvalAggregator(run);
      const scores = [];
      for (let at = 0; at < outputs.length; at += size) {
        scores.push(...paged.add(outputs.slice(at, at + size)));
      }
      expect({ ...paged.finish(), outputScores: scores }).toEqual(agg);
    }
  });
});
