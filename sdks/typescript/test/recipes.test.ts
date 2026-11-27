import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { adapters, Context, GradUsageError, Judge, losses, optim, pooling, Recipe, recipes, Rubric, Scorer, splits, Trajectory, validators, type ScoreInput } from "../src/index.js";

const spec = (recipe: Recipe) => recipe.toSpec();

const input = (over: Partial<ScoreInput> = {}): ScoreInput => ({
  output: null,
  expectedOutput: null,
  record: { messages: [] },
  input: [],
  model: "m",
  taskId: "t",
  sampleIndex: 0,
  ...over,
});

describe("recipes", () => {
  it("builds every recipe with only the fields that were set", async () => {
    expect(await spec(recipes.sft())).toEqual({ kind: "sft" });
    expect(
      await spec(
        recipes.sft({
          model: { name: "support-sft", version: "2" },
          adapter: adapters.lora({ rank: 16, alpha: 32 }),
          lr: "auto",
          lrScale: 0.5,
          batchSize: 4,
          epochs: 2,
          schedule: "cosine",
          warmup: 10,
          trainOn: "all_assistant",
          thinking: "off",
          preserveThinking: false,
          reduction: "per_token",
          select: "best",
          checkpointTtlDays: 7,
          mergeOnExport: true,
        }),
      ),
    ).toEqual({
      kind: "sft",
      model: "support-sft@2",
      adapter: { kind: "lora", rank: 16, alpha: 32, mergeOnExport: true },
      lr: "auto",
      lrScale: 0.5,
      batchSize: 4,
      epochs: 2,
      schedule: "cosine",
      warmup: 10,
      trainOn: "all_assistant",
      thinking: "off",
      preserveThinking: false,
      reduction: "per_token",
      select: "best",
      checkpointTtlDays: 7,
    });
    expect(() => recipes.sft({ adapter: adapters.prefixKv(), mergeOnExport: true })).toThrow(GradUsageError);

    expect(await spec(recipes.dpo({ beta: 0.2 }))).toEqual({ kind: "dpo", beta: 0.2 });
    expect(await spec(recipes.dpo({ loss: losses.dpo({ beta: 0.3 }) }))).toEqual({ kind: "dpo", beta: 0.3 });
    expect(await spec(recipes.dpo())).toEqual({ kind: "dpo" });
    expect(await spec(recipes.router({ models: ["a", "b"], maxQualityDrop: 0.02 }))).toEqual({ kind: "router", models: ["a", "b"], maxQualityDrop: 0.02 });
    expect(await spec(recipes.router())).toEqual({ kind: "router" });
    expect(await spec(recipes.decisionModel({ adapter: adapters.frozenHead() }))).toEqual({ kind: "decision", adapter: { kind: "frozen_head" } });
    expect(await spec(recipes.embedding({ temp: 0.05 }))).toEqual({ kind: "embedding", temp: 0.05 });
    expect(await spec(recipes.embedding({ loss: losses.infoNCE({ temp: 0.1 }) }))).toEqual({ kind: "embedding", temp: 0.1 });
    expect(await spec(recipes.embedding())).toEqual({ kind: "embedding" });
    expect(await spec(recipes.embedding({ pool: pooling.mean() }))).toEqual({ kind: "embedding", pool: { kind: "mean" } });
    expect(await spec(recipes.sft({ loss: losses.crossEntropy({ reduction: "per_token" }), evalEvery: "auto" }))).toEqual({ kind: "sft", reduction: "per_token" });
    expect(await spec(recipes.sft({ optimizer: optim.adamW({ lr: 1e-4 }) }))).toEqual({
      kind: "sft",
      lr: 1e-4,
      optimizer: { kind: "adamw", betas: [0.9, 0.95], weightDecay: 0, gradClip: 1 },
    });
    expect(await spec(recipes.router({ models: ["a", "b"], rubric: "resolved" }))).toEqual({ kind: "router", models: ["a", "b"], rubric: "resolved" });
    expect(await spec(recipes.cartridge({ context: Context.fromUri("s3://b/doc.md") }))).toEqual({ kind: "cartridge", contextUri: "s3://b/doc.md" });
    expect(
      await spec(recipes.cartridge({ context: Context.fromText("API docs"), numTokens: 512, teacher: "qwen/qwen3-32b", adapter: adapters.prefixKv({ numTokens: 512 }) })),
    ).toEqual({ kind: "cartridge", numTokens: 512, teacher: "qwen/qwen3-32b", adapter: { kind: "prefix_kv", numTokens: 512 }, contextText: "API docs" });
    expect(await spec(recipes.cartridge({ context: Context.fromText("x") }))).toEqual({ kind: "cartridge", contextText: "x" });
    expect(adapters.lora()).toEqual({ kind: "lora" });
  });

  it("reads Context.fromFile from disk when the run is submitted", async () => {
    const dir = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "grad-recipes-"));
    const file = path.join(dir, "bundle.md");
    writeFileSync(file, "# API\nGET /v1/runs");
    expect(await Context.fromFile(file).toSpec()).toEqual({ contextText: "# API\nGET /v1/runs" });
  });

  it("rejects options the server would ignore and a cartridge without context", () => {
    expect(() => recipes.sft({ rank: 8 } as never)).toThrow(/does not support 'rank'/);
    expect(() => recipes.router({ rubric: {} } as never)).toThrow(GradUsageError);
    expect(() => recipes.cartridge({ context: "text" } as never)).toThrow(/Context.fromText/);
    expect(() => recipes.decisionModel({ models: [] } as never)).toThrow(GradUsageError);
    expect(() => recipes.dpo({ beta: 0.1, loss: losses.dpo({ beta: 0.2 }) })).toThrow(/conflicts/);
    expect(() => recipes.sft({ lr: 1e-3, optimizer: optim.adamW({ lr: 1e-4 }) })).toThrow(/conflicts/);
    expect(() => recipes.router({ models: ["a", "b"], rubric: new Scorer("mine", { fn: () => 1 }) })).toThrow(/sandbox/);
    expect(() => recipes.router({ rubric: new Judge({ name: "j", model: "m" }) })).toThrow(/pass models/);
    expect((recipes as Record<string, unknown>).grpo).toBeUndefined();
  });

  it("splits carry strategy and options", () => {
    expect(splits.bySession()).toEqual({ strategy: "by_session" });
    expect(splits.byGroup({ evalFraction: 0.2 })).toEqual({ strategy: "by_group", evalFraction: 0.2 });
    expect(splits.random({ seed: 7 })).toEqual({ strategy: "random", seed: 7 });
  });
});

describe("rubrics", () => {
  it("maps scorers and judges to wire items and keeps local functions", () => {
    const fn = () => 1;
    const rubric = new Rubric([
      new Scorer("json", { fn: validators.json(), weight: 0.2 }),
      new Scorer("filled", { fn: validators.nonEmpty() }),
      new Scorer("exact", { fn: validators.exactMatch() }),
      new Scorer("ticket", { fn: validators.regex("^T-\\d+$", { flags: "i" }) }),
      new Scorer("plain_regex", { fn: validators.regex("x") }),
      new Scorer("mine", { fn, weight: 2 }),
      new Judge({ name: "resolved", model: "anthropic/claude-sonnet", prompt: "Solved?", weight: 0.5 }),
      new Judge({ name: "by_artifact", model: { name: "judge", version: "3" } }),
      new Judge({ name: "by_id", model: { id: "art_123" } }),
    ]);
    expect(rubric.toWire()).toEqual([
      { name: "json", kind: "validator", validator: "json", weight: 0.2 },
      { name: "filled", kind: "validator", validator: "non_empty" },
      { name: "exact", kind: "validator", validator: "exact_match" },
      { name: "ticket", kind: "regex", pattern: "^T-\\d+$", flags: "i" },
      { name: "plain_regex", kind: "regex", pattern: "x" },
      { name: "mine", kind: "code", runtime: "local", weight: 2 },
      { name: "resolved", kind: "judge", model: "anthropic/claude-sonnet", prompt: "Solved?", weight: 0.5 },
      { name: "by_artifact", kind: "judge", model: "judge@3" },
      { name: "by_id", kind: "judge", model: "art_123" },
    ]);
    expect([...rubric.localScorers().keys()]).toEqual(["mine"]);
    expect(rubric.items[5]).toMatchObject({ isLocal: true });
    expect(rubric.items[0]).toMatchObject({ isLocal: false });
  });

  it("validates names, weights, functions and models", () => {
    expect(() => new Rubric([])).toThrow(GradUsageError);
    expect(() => new Rubric([new Scorer("a", { fn: validators.json() }), new Scorer("a", { fn: validators.json() })])).toThrow(/unique/);
    expect(() => new Scorer("", { fn: validators.json() })).toThrow(GradUsageError);
    expect(() => new Scorer("a", { fn: "json" as never })).toThrow(/needs fn/);
    expect(() => new Scorer("a", { fn: validators.json(), weight: 0 })).toThrow(/positive/);
    expect(() => new Scorer("a", { fn: validators.json(), weight: Number.POSITIVE_INFINITY })).toThrow(/finite/);
    expect(() => new Judge({ name: "", model: "m" })).toThrow(GradUsageError);
    expect(() => new Judge({ name: "j", model: "" })).toThrow(/explicit model/);
  });

  it("numericMatch reads GSM8K answers, fields, metadata and tolerance", async () => {
    const byExpected = validators.numericMatch();
    expect(await byExpected("The answer is 1,234.", input({ expectedOutput: "#### 1234" }))).toBe(1);
    expect(await byExpected("42", input({ expectedOutput: 42 }))).toBe(1);
    expect(await byExpected("42", input({ expectedOutput: { role: "assistant", content: "so 41" } }))).toBe(0);
    expect(await byExpected(null, input({ expectedOutput: "1" }))).toBe(0);
    expect(await byExpected("no digits", input({ expectedOutput: "1" }))).toBe(0);
    expect(await byExpected("1", input({ expectedOutput: { nested: true } }))).toBe(0);

    const byField = validators.numericMatch({ field: "answer", tolerance: 0.01 });
    expect(await byField("3.141", input({ record: { messages: [], answer: "#### 3.14" } as never }))).toBe(1);
    expect(await byField("7", input({ record: { messages: [], metadata: { answer: "7" } } }))).toBe(1);
    expect(await byField("7", input({ record: { messages: [] } }))).toBe(0);
  });
});

describe("trajectory", () => {
  it("builds a grad.trajectory/1 record with empty scores to fill in", () => {
    const traj = Trajectory.fromMessages([{ role: "user", content: "hi" }], { sessionId: "s", groupId: "g", id: "r1", source: "ci", metadata: { a: 1 } });
    traj.scores.tests_passed = 1;
    expect(traj).toEqual({
      schema: "grad.trajectory/1",
      messages: [{ role: "user", content: "hi" }],
      scores: { tests_passed: 1 },
      metrics: {},
      metadata: { a: 1 },
      id: "r1",
      sessionId: "s",
      groupId: "g",
      source: "ci",
    });
    expect(Trajectory.fromMessages([])).toEqual({ schema: "grad.trajectory/1", messages: [], scores: {}, metrics: {}, metadata: {} });
  });
});
