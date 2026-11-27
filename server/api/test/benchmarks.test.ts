import { afterEach, describe, expect, it } from "vitest";

import { BENCHMARKS } from "../src/benchmarks.js";
import {
  choiceMatches,
  finalNumberMatches,
} from "../src/services/evals/answers.js";
import { makeEvalHarness, type EvalHarness } from "./fixtures/evals.js";
import { FakeWorker } from "./fixtures/worker.js";

type Json = Record<string, unknown> & { id?: string; code?: string };

describe("benchmark answer checks", () => {
  it("compares the final number", () => {
    expect(finalNumberMatches("so 3 + 4 = 7\n#### 7", "7")).toBe(true);
    expect(finalNumberMatches("The answer is $1,018.", "1018")).toBe(true);
    expect(finalNumberMatches("It is 18.0", "18")).toBe(true);
    expect(finalNumberMatches("#### 42 then 7", "7")).toBe(true);
    expect(finalNumberMatches("about 19", "18")).toBe(false);
    expect(finalNumberMatches("no number", "18")).toBe(false);
    expect(finalNumberMatches("18", null)).toBe(false);
  });

  it("finds the chosen letter", () => {
    expect(choiceMatches("Answer: C", "C")).toBe(true);
    expect(choiceMatches("The answer is (b).", "B")).toBe(true);
    expect(choiceMatches("C", "C")).toBe(true);
    expect(choiceMatches("(D) because ...", "D")).toBe(true);
    expect(choiceMatches("Answer: A", "C")).toBe(false);
    expect(choiceMatches("I think it's the second one", "B")).toBe(false);
    expect(choiceMatches("C", null)).toBe(false);
  });

  it("pins every benchmark to a full commit", () => {
    for (const b of Object.values(BENCHMARKS)) {
      expect(b.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(b.rubric[0]?.kind).toBe("validator");
    }
  });
});

describe("datasets.from_benchmark", () => {
  let h: EvalHarness;

  afterEach(async () => {
    await h.close();
  });

  it("imports at the pinned revision and evals default to its answer check", async () => {
    h = await makeEvalHarness();
    const worker = new FakeWorker(h.t);
    const created = await h.t.json<Json>("/v1/datasets/gsm8k-2/imports", {
      body: { source: { kind: "benchmark", benchmark: "gsm8k", limit: 2 } },
    });
    expect(created.status).toBe(202);
    expect(created.body.source).toEqual({
      kind: "hf",
      repo: "openai/gsm8k",
      config: "main",
      split: "test",
      revision: BENCHMARKS.gsm8k.revision,
      columns: {},
      benchmark: "gsm8k",
      limit: 2,
    });

    const job = await worker.claim();
    expect(job?.import?.source).toMatchObject({ benchmark: "gsm8k" });
    await worker.records(
      job!,
      0,
      [0, 1].map((i) => ({
        id: `gsm8k:${i}`,
        messages: [{ role: "user", content: `What is ${i} + 1?` }],
        expected_output: String(i + 1),
        metadata: { benchmark: "gsm8k" },
      })),
    );
    await worker.complete(job!, { status: "completed" });

    const ds = await h.t.json<Json>("/v1/datasets/gsm8k-2");
    expect(ds.body.metadata).toMatchObject({
      benchmark: { name: "gsm8k", revision: BENCHMARKS.gsm8k.revision },
      rubric: BENCHMARKS.gsm8k.rubric,
    });

    // The fake model echoes "answer: What is i + 1?": its last number is 1,
    // right for the first problem (1) and wrong for the second (2).
    const ev = await h.t.json<Json>("/v1/evals", {
      body: { models: ["qwen/qwen3-8b"], dataset: "gsm8k-2" },
    });
    expect(ev.body.rubric).toEqual(BENCHMARKS.gsm8k.rubric);
    await h.worker.drain();
    const done = await h.t.json<{
      summary: Array<{ overall: number }>;
      pass_threshold: number;
    }>(`/v1/evals/${String(ev.body.id)}`);
    expect(done.body.pass_threshold).toBe(1);
    expect(done.body.summary[0]?.overall).toBe(0.5);

    const unknown = await h.t.json<Json>("/v1/datasets/x/imports", {
      body: { source: { kind: "benchmark", benchmark: "ifeval" } },
    });
    expect(unknown.status).toBe(422);
  });
});
