import { describe, expect, it } from "vitest";

import {
  PlanRunRequestSchema,
  type ChatMessage,
  type DatasetRecord,
} from "../src/contracts.js";
import { planRun, renderMessages, splitRecords } from "../src/planner.js";

const makeChatRecords = (count: number): DatasetRecord[] =>
  Array.from({ length: count }, (_, idx) => ({
    id: `rec_${idx + 1}`,
    session_id: `sess_${idx % 20}`,
    messages: [
      { role: "system", content: "You are helpful." },
      { role: "user", content: `Question ${idx}` },
      { role: "assistant", content: `Answer ${idx}` },
    ],
  }));

describe("splitRecords", () => {
  it("never leaks records from the same session across train and eval", () => {
    const records: DatasetRecord[] = [];
    for (let s = 0; s < 30; s += 1) {
      for (let turn = 0; turn < 4; turn += 1) {
        records.push({
          id: `s${s}_t${turn}`,
          session_id: `session_${s}`,
          messages: [
            { role: "user", content: `hi ${turn}` },
            { role: "assistant", content: `ok ${turn}` },
          ],
        });
      }
    }

    const { train, eval: evalSet } = splitRecords(records, {
      strategy: "by_session",
      eval_fraction: 0.2,
      seed: 42,
    });

    const trainSessions = new Set(train.map((r) => r.session_id));
    const evalSessions = new Set(evalSet.map((r) => r.session_id));

    expect(train.length).toBeGreaterThan(0);
    expect(evalSet.length).toBeGreaterThan(0);
    for (const s of evalSessions) {
      expect(trainSessions.has(s)).toBe(false);
    }
  });
});

describe("renderMessages", () => {
  const multiTurn: ChatMessage[] = [
    { role: "user", content: "First question" },
    { role: "assistant", content: "<think>step 1</think>First answer" },
    { role: "user", content: "Second question" },
    { role: "assistant", content: "<think>step 2</think>Second answer" },
  ];

  it("trains only the last assistant turn by default and strips prior thinking", () => {
    const rendered = renderMessages("r1", multiTurn, {
      model: "qwen/qwen3-8b",
      train_on: "last",
      thinking: "auto",
      preserve_thinking: false,
    });

    expect(rendered.template_revision).toBe("qwen3@3");
    const trainedSpans = rendered.spans.filter((s) => s.trained);
    expect(trainedSpans).toHaveLength(1);
    expect(trainedSpans[0]?.text).toContain("Second answer");
    expect(
      rendered.spans.some(
        (s) =>
          !s.trained &&
          s.text.includes("First answer") &&
          !s.text.includes("<think>"),
      ),
    ).toBe(true);
  });

  it("supports train_on='all_assistant' and preserve_thinking=true", () => {
    const rendered = renderMessages("r2", multiTurn, {
      model: "qwen/qwen3-8b",
      train_on: "all_assistant",
      thinking: "on",
      preserve_thinking: true,
    });

    const trainedSpans = rendered.spans.filter((s) => s.trained);
    expect(trainedSpans).toHaveLength(2);
    expect(trainedSpans[0]?.text).toContain("<think>step 1</think>");
  });

  it("throws when thinking='off' encounters a <think> block in a trained turn", () => {
    expect(() =>
      renderMessages("r3", multiTurn, {
        model: "qwen/qwen3-8b",
        train_on: "last",
        thinking: "off",
        preserve_thinking: false,
      }),
    ).toThrow(/thinking='off'/);
  });

  it("throws when thinking='on' encounters a trained turn without <think>", () => {
    expect(() =>
      renderMessages(
        "r4",
        [
          { role: "user", content: "hi" },
          { role: "assistant", content: "plain answer" },
        ],
        {
          model: "qwen/qwen3-8b",
          train_on: "last",
          thinking: "on",
          preserve_thinking: false,
        },
      ),
    ).toThrow(/thinking='on'/);
  });

  it("honors per-message train overrides", () => {
    const rendered = renderMessages(
      "r5",
      [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1", train: true },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2", train: false },
      ],
      {
        model: "qwen/qwen3-8b",
        train_on: "last",
        thinking: "off",
        preserve_thinking: false,
      },
    );

    const trained = rendered.spans.filter((s) => s.trained);
    expect(trained).toHaveLength(1);
    expect(trained[0]?.text).toContain("a1");
  });
});

describe("planRun", () => {
  it("resolves all 6 v0 recipes with calibrated defaults", () => {
    const records = makeChatRecords(150);

    const sft = planRun(
      PlanRunRequestSchema.parse({
        dataset: "support",
        name: "support-sft",
        recipe: { kind: "sft", batch_size: 32 },
      }),
      records,
    );
    expect(sft.resolved_config.model).toBe("qwen/qwen3-8b");
    expect(sft.resolved_config.adapter).toEqual({
      kind: "lora",
      rank: 32,
      alpha: 32,
      merge_on_export: false,
    });
    // sqrt(32 / 128) = 0.5 * 5e-4 = 2.5e-4
    expect(sft.resolved_config.lr).toBeCloseTo(2.5e-4, 6);

    const router = planRun(
      PlanRunRequestSchema.parse({
        dataset: "support",
        name: "support-router",
        recipe: {
          kind: "router",
          models: ["qwen/qwen3-8b", "qwen/qwen3-32b"],
          max_quality_drop: 0.02,
        },
      }),
      records,
    );
    expect(router.resolved_config.model).toBe("qwen/qwen3-0.6b");
    expect(router.resolved_config.split.eval_fraction).toBe(0.15);

    const decision = planRun(
      PlanRunRequestSchema.parse({
        dataset: "support",
        name: "support-decision",
        recipe: { kind: "decision" },
      }),
      records,
    );
    expect(decision.resolved_config.model).toBe("gradiated/linden-1");

    const cartridge = planRun(
      PlanRunRequestSchema.parse({
        dataset: "support",
        name: "support-cartridge",
        recipe: {
          kind: "cartridge",
          num_tokens: 128,
          context_text: "handbook",
        },
      }),
      records,
    );
    expect(cartridge.resolved_config.adapter).toEqual({
      kind: "prefix_kv",
      num_tokens: 128,
    });

    const embedding = planRun(
      PlanRunRequestSchema.parse({
        dataset: "support",
        name: "support-embed",
        recipe: { kind: "embedding" },
      }),
      [{ id: "e1", query: "reset password", positive: "go to settings" }],
    );
    expect(embedding.resolved_config.model).toBe("baai/bge-small-en-v1.5");
    expect(embedding.resolved_config.adapter).toEqual({ kind: "encoder_full" });

    const dpo = planRun(
      PlanRunRequestSchema.parse({
        dataset: "support",
        name: "support-dpo",
        recipe: { kind: "dpo", beta: 0.1 },
      }),
      [{ id: "p1", prompt: "hi", chosen: "hello!", rejected: "go away" }],
    );
    expect(dpo.resolved_config.recipe_params.beta).toBe(0.1);
  });

  it("blocks Wave 2 recipes unless allowWave2 is enabled", () => {
    const req = PlanRunRequestSchema.parse({
      dataset: "support",
      name: "wave2-grpo",
      recipe: { kind: "grpo", env_name: "code-env", group_size: 4 },
    });
    const records = makeChatRecords(10);

    expect(() => planRun(req, records)).toThrow(/deferred past v0/);

    const allowed = planRun(req, records, { allowWave2: true });
    expect(allowed.resolved_config.recipe_kind).toBe("grpo");
    expect(allowed.resolved_config.batch_size).toBe(32);
  });

  it("warns when steps < 100 or estimated cost exceeds max_cost_usd", () => {
    const req = PlanRunRequestSchema.parse({
      dataset: "support",
      name: "small-sft",
      recipe: { kind: "sft", epochs: 1 },
      max_cost_usd: 0.00001,
    });
    const plan = planRun(req, makeChatRecords(40));

    expect(plan.warnings.some((w) => w.includes("below the 100"))).toBe(true);
    expect(plan.warnings.some((w) => w.includes("exceeds max_cost_usd"))).toBe(
      true,
    );
  });
});
