import { describe, expect, it } from "vitest";

import { createModelCatalog } from "../src/catalog.js";
import {
  PlanRunRequestSchema,
  type DatasetRecord,
  type PlanRunRequest,
} from "../src/contracts.js";
import { ApiError } from "../src/errors.js";
import { planRun, renderMessages, splitRecords } from "../src/planner.js";
import {
  assessRecipeUsability,
  recordConversation,
  recordPromptAndReference,
} from "../src/records.js";
import { TINY_MODELS_JSON } from "./fixtures/app.js";

const catalog = createModelCatalog(TINY_MODELS_JSON);

const chat = (i: number, session = `s${i}`): DatasetRecord => ({
  id: `r${i}`,
  session_id: session,
  messages: [
    { role: "user", content: `question ${i}` },
    { role: "assistant", content: `answer ${i}` },
  ],
});

const request = (
  recipe: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): PlanRunRequest =>
  PlanRunRequestSchema.parse({ dataset: "ds", name: "run", recipe, ...extra });

const plan = (
  recipe: Record<string, unknown>,
  records: DatasetRecord[],
  extra: Record<string, unknown> = {},
) => planRun(request(recipe, extra), records, { catalog, datasetVersion: 3 });

const expectCode = (fn: () => unknown, code: string, message?: RegExp) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe(code);
    if (message) expect((error as ApiError).detail).toMatch(message);
    return;
  }
  throw new Error(`expected ApiError ${code}`);
};

describe("splitRecords", () => {
  it("keeps sessions on one side and treats empty ids like missing ones", () => {
    const records = Array.from({ length: 200 }, (_, i) =>
      chat(i, `sess-${i % 20}`),
    );
    const { train, eval: evalSet } = splitRecords(records, {
      strategy: "by_session",
      eval_fraction: 0.2,
      seed: 7,
    });
    const trainSessions = new Set(train.map((r) => r.session_id));
    expect(evalSet.every((r) => !trainSessions.has(r.session_id))).toBe(true);

    const blank = splitRecords([{ id: "", session_id: "", messages: [] }], {
      strategy: "by_group",
      eval_fraction: 0.5,
      seed: 1,
    });
    expect(blank.train).toHaveLength(1);
    const random = splitRecords(records, {
      strategy: "random",
      eval_fraction: 0,
      seed: 1,
    });
    expect(random.eval).toHaveLength(0);
  });
});

describe("renderMessages", () => {
  const opts = {
    templateRevision: "qwen3@3",
    train_on: "last" as const,
    thinking: "auto" as const,
    preserve_thinking: false,
  };
  const messages = [
    { role: "user" as const, content: "hi" },
    { role: "assistant" as const, content: "<think>old</think>first" },
    { role: "user" as const, content: "again" },
    { role: "assistant" as const, content: "<think>new</think>second" },
  ];

  it("trains only the last assistant turn and strips earlier thinking", () => {
    const r = renderMessages("r", messages, opts);
    expect(r.spans.filter((s) => s.trained)).toHaveLength(1);
    expect(r.spans[3]?.text).not.toContain("<think>");
    expect(r.template_revision).toBe("qwen3@3");
  });

  it("supports all_assistant, preserve_thinking, per-message overrides and thinking checks", () => {
    const all = renderMessages("r", messages, {
      ...opts,
      train_on: "all_assistant",
      preserve_thinking: true,
    });
    expect(all.spans.filter((s) => s.trained)).toHaveLength(2);
    expect(all.spans[3]?.text).toContain("<think>");
    const override = renderMessages(
      "r",
      [
        { role: "user", content: "x", train: true },
        { role: "assistant", content: "y", train: false },
      ],
      opts,
    );
    expect(override.spans[1]?.trained).toBe(true);
    expect(override.spans[3]?.trained).toBe(false);
    expect(() =>
      renderMessages("r", messages, { ...opts, thinking: "off" }),
    ).toThrow(ApiError);
    expect(() =>
      renderMessages("r", [{ role: "assistant", content: "x" }], {
        ...opts,
        thinking: "on",
      }),
    ).toThrow(/thinking='on'/);
    expect(renderMessages("r", [], opts).trained_fraction).toBe(0);
  });
});

describe("planRun", () => {
  const records = Array.from({ length: 40 }, (_, i) => chat(i));

  it("resolves defaults for every v0 recipe with the catalog's defaults", () => {
    const sft = plan({ kind: "sft" }, records);
    expect(sft.resolved_config).toMatchObject({
      model: "qwen/qwen3-8b",
      adapter: { kind: "lora", rank: 32 },
      dataset_version: 3,
    });
    expect(sft.price_per_million_tokens).toBe(0.4);
    expect(sft.resolved_config.lr_source).toMatch(/calibrated/);

    const router = plan(
      { kind: "router" },
      records.map((r) => ({
        ...r,
        scores: { "qwen/qwen3-8b": 0.4, "qwen/qwen3-32b": 0.9 },
      })),
    );
    expect(router.resolved_config.model).toBe("qwen/qwen3-0.6b");
    expect(router.resolved_config.recipe_params.models).toEqual([
      "qwen/qwen3-32b",
      "qwen/qwen3-8b",
    ]);

    const decision = plan(
      { kind: "decision" },
      records.map((r) => ({
        ...r,
        state: { a: 1 },
        expected_output: { label: "yes" },
      })),
    );
    expect(decision.resolved_config.model).toBe("gradiated/linden-1");

    const embedding = plan(
      { kind: "embedding" },
      records.map((_, i) => ({ query: `q${i}`, positive: `p${i}` })),
    );
    expect(embedding.resolved_config.adapter).toEqual({ kind: "encoder_full" });

    const cartridge = plan({ kind: "cartridge", context_text: "doc" }, records);
    expect(cartridge.resolved_config.adapter).toEqual({
      kind: "prefix_kv",
      num_tokens: 256,
    });
    expect(cartridge.resolved_config.recipe_params.context_text).toBe("doc");

    const dpo = plan(
      { kind: "dpo", beta: 0.2 },
      records.map((_, i) => ({ prompt: `p${i}`, chosen: "a", rejected: "b" })),
    );
    expect(dpo.resolved_config.split.strategy).toBe("by_group");
    expect(dpo.resolved_config.recipe_params.loss).toEqual({
      kind: "dpo",
      beta: 0.2,
    });
  });

  it("rejects unknown models even with an explicit lr (no misleading lr hint)", () => {
    expectCode(
      () => plan({ kind: "sft", model: "meta/llama-405b", lr: 1e-4 }, records),
      "unknown_model",
      /GET \/v1\/models/,
    );
    expectCode(
      () => plan({ kind: "sft", model: "meta/llama-405b" }, records),
      "unknown_model",
      /^(?!.*explicit lr)/,
    );
  });

  it("rejects recipes and adapters a model does not support", () => {
    expectCode(
      () => plan({ kind: "embedding", model: "qwen/qwen3-32b" }, records),
      "recipe_not_supported_for_model",
      /baai\/bge-small-en-v1.5/,
    );
    expectCode(
      () =>
        plan(
          {
            kind: "sft",
            model: "qwen/qwen3-0.6b",
            adapter: { kind: "frozen_head" },
          },
          records,
        ),
      "adapter_not_supported",
    );
    // The service resolves artifact references; an unresolved one is unknown.
    expectCode(
      () => plan({ kind: "sft", model: "sql-helper@latest" }, records),
      "unknown_model",
      /not found in this workspace/,
    );
  });

  it("rejects records a recipe cannot train and explains the expected shape", () => {
    expectCode(
      () => plan({ kind: "sft" }, [{ metadata: { foo: "bar" } }]),
      "no_usable_records",
      /assistant/,
    );
    expectCode(
      () => plan({ kind: "embedding" }, records),
      "no_usable_records",
      /query/,
    );
    expectCode(
      () => plan({ kind: "router" }, records),
      "no_usable_records",
      /per-model scores/,
    );
    expectCode(
      () => plan({ kind: "decision" }, [{ metadata: {} }]),
      "no_usable_records",
    );
    expectCode(() => plan({ kind: "sft" }, []), "empty_dataset");
    const partial = plan({ kind: "sft" }, [...records, { query: "x" }]);
    expect(partial.usable_records).toBe(40);
    expect(partial.warnings.join(" ")).toMatch(
      /1 of 41 records cannot be used/,
    );
  });

  it("accepts the documented DPO trajectory-group format and flags one-sided groups", () => {
    const group = (g: string, role: "chosen" | "rejected"): DatasetRecord => ({
      schema: "grad.trajectory/1",
      group_id: g,
      role,
      input: { messages: [{ role: "user", content: "q" }] },
      output: { turns: [{ role: "assistant", content: role }] },
    });
    const result = plan({ kind: "dpo" }, [
      group("a", "chosen"),
      group("a", "rejected"),
      group("b", "chosen"),
    ]);
    expect(result.usable_records).toBe(1);
    expect(result.warnings.join(" ")).toMatch(
      /only a chosen or only a rejected/,
    );
    expectCode(
      () => plan({ kind: "dpo" }, [group("b", "chosen")]),
      "no_usable_records",
      /group_id/,
    );
  });

  it("needs two router candidates and cartridge context", () => {
    const oneModel = records.map((r) => ({
      ...r,
      scores: { "qwen/qwen3-8b": 0.4 },
    }));
    expectCode(
      () => plan({ kind: "router" }, oneModel),
      "router_candidates_required",
    );
    // Candidates the records never score leave nothing to train on.
    expectCode(
      () => plan({ kind: "router", models: ["a/b", "c/d"] }, oneModel),
      "no_usable_records",
    );
    expectCode(
      () => plan({ kind: "cartridge" }, records),
      "cartridge_context_required",
    );
  });

  it("rejects Wave 2 recipes", () => {
    expectCode(() => plan({ kind: "grpo" }, records), "recipe_deferred");
  });

  it("plans distillation with the teacher's cost and validates the teacher", () => {
    const prompts = records.map((r) => ({
      ...r,
      messages: r.messages?.slice(0, 1),
    }));
    const distill = (
      recipe: Record<string, unknown>,
      rows: DatasetRecord[] = prompts,
    ) => plan({ kind: "distill", ...recipe }, rows);

    const onPolicy = distill({
      model: "qwen/qwen3-4b",
      teacher: "qwen/qwen3-32b",
      rollout: { kind: "on_policy", max_new_tokens: 64 },
    });
    expect(onPolicy.resolved_config.model).toBe("qwen/qwen3-4b");
    expect(onPolicy.resolved_config.lr).toBeCloseTo(2e-4, 8);
    expect(onPolicy.resolved_config.adapter).toMatchObject({ kind: "lora" });
    expect(onPolicy.resolved_config.recipe_params).toMatchObject({
      teacher: "qwen/qwen3-32b",
      rollout: { kind: "on_policy", max_new_tokens: 64 },
      loss: { kind: "top_k_kl_distill", top_k: 32 },
      teacher_token_weight: 4,
    });
    const teacher = onPolicy.teacher;
    expect(teacher).toMatchObject({
      model: "qwen/qwen3-32b",
      price_per_million_tokens: 1.2,
    });
    expect(teacher?.estimated_tokens).toBeGreaterThan(64 * prompts.length);
    const train = onPolicy.resolved_config.split.train_records;
    expect(onPolicy.estimated_tokens).toBeGreaterThan(
      (teacher?.estimated_tokens ?? 0) * 4,
    );
    expect(onPolicy.estimated_tokens).toBeGreaterThan(2 * 64 * train);
    expect(onPolicy.estimated_cost_usd).toBeCloseTo(
      (onPolicy.estimated_tokens / 1e6) * 0.3,
      4,
    );
    expect(onPolicy.labeling).toBeNull();

    // auto sizes answers from the records' own assistant turns (or 256 without any).
    const sized = distill(
      { model: "qwen/qwen3-4b", teacher: "qwen/qwen3-32b" },
      records,
    );
    expect(sized.resolved_config.recipe_params.rollout).toEqual({
      kind: "on_policy",
      max_new_tokens: 32,
    });
    expect(
      distill({ teacher: "qwen/qwen3-32b" }).resolved_config,
    ).toMatchObject({
      model: "qwen/qwen3-4b",
      recipe_params: { rollout: { max_new_tokens: 256 } },
    });

    expectCode(
      () => distill({ teacher: "qwen/qwen3-4b" }),
      "distill_teacher_is_student",
    );
    const contextOnly = distill({
      teacher: "qwen/qwen3-4b",
      context_text: "Refunds take 30 days.",
    });
    expect(contextOnly.teacher?.estimated_tokens).toBeGreaterThan(0);
    expect(
      distill({
        model: "qwen/qwen3-8b",
        teacher: "qwen/qwen3-4b",
      }).warnings.join(" "),
    ).toMatch(/smaller than the student/);
    expectCode(
      () => distill({ teacher: "sft@2026-11-27-1" }),
      "distill_teacher_unsupported",
      /OffPolicy/,
    );
    expectCode(
      () => distill({ teacher: "openai/gpt-x" }),
      "unknown_model",
      /OffPolicy/,
    );
    expectCode(
      () => distill({ teacher: "gradiated/linden-1" }),
      "distill_tokenizer_mismatch",
    );
    expectCode(
      () =>
        distill(
          { teacher: "qwen/qwen3-32b" },
          records.map((r) => ({
            ...r,
            messages: [{ role: "system", content: "x" }],
          })),
        ),
      "no_usable_records",
      /no user prompt/,
    );

    // Off-policy: the teacher answers in a labeling eval, billed as an eval.
    const labeling = {
      estimated_model_calls: 40,
      estimated_judge_calls: 0,
      estimated_cost_usd: 0.05,
    };
    const offPolicy = planRun(
      request({
        kind: "distill",
        model: "qwen/qwen3-4b",
        teacher: "anthropic/claude-x",
        rollout: { kind: "off_policy" },
      }),
      prompts,
      { catalog, datasetVersion: 3, labeling },
    );
    expect(offPolicy.resolved_config.recipe_params).toEqual({
      teacher: "anthropic/claude-x",
      rollout: { kind: "off_policy", max_new_tokens: 1024 },
      loss: { kind: "cross_entropy" },
    });
    expect(offPolicy.teacher).toBeNull();
    expect(offPolicy.labeling).toEqual(labeling);
    expect(offPolicy.estimated_cost_usd).toBeGreaterThan(0.05);
    expect(offPolicy.warnings.join(" ")).toMatch(
      /teacher 'anthropic\/claude-x' answers each prompt/,
    );
    expect(() =>
      plan(
        { kind: "distill", teacher: "x/y", rollout: { kind: "off_policy" } },
        prompts,
      ),
    ).toThrow(/labeling eval/);
  });

  it("plans reward models on pairs and pointwise scores", () => {
    const pairs = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`,
      prompt: `q${i}`,
      chosen: "good",
      rejected: "bad",
    }));
    const reward = plan({ kind: "reward" }, [...pairs, ...records]);
    expect(reward.resolved_config).toMatchObject({
      model: "qwen/qwen3-8b",
      adapter: { kind: "lora", rank: 32 },
      recipe_kind: "reward",
      split: { strategy: "by_group" },
    });
    expect(reward.resolved_config.lr).toBeCloseTo(1e-4, 8);
    expect(reward.usable_records).toBe(20);
    expect(reward.warnings.join(" ")).toMatch(/not paired/);
    const scored = records.map((r, i) => ({
      ...r,
      scores: { resolved: i % 2 },
    }));
    const pointwise = plan({ kind: "reward", rubric: "resolved" }, scored);
    expect(pointwise.usable_records).toBe(40);
    expect(pointwise.resolved_config.recipe_params).toEqual({
      rubric: "resolved",
    });
    expectCode(
      () => plan({ kind: "reward" }, scored),
      "no_usable_records",
      /Reward models need/,
    );
  });

  it("scales lr, warns on few steps, empty eval split and budget, and supports explicit lr", () => {
    const scaled = plan({ kind: "sft", batch_size: 512, lr_scale: 2 }, records);
    expect(scaled.resolved_config.lr).toBeCloseTo(5e-4 * 2 * 2, 8);
    expect(scaled.warnings.join(" ")).toMatch(/below the 100/);
    const explicit = plan({ kind: "sft", lr: 1e-4 }, records);
    expect(explicit.resolved_config.lr_source).toBe("explicit");
    const noEval = plan({ kind: "sft" }, records, {
      split: { eval_fraction: 0 },
    });
    expect(noEval.warnings.join(" ")).toMatch(/eval split is empty/);
    const budget = plan({ kind: "sft" }, records, { max_cost_usd: 0.0000001 });
    expect(budget.warnings.join(" ")).toMatch(/stopped_budget/);
    const long = plan({ kind: "sft", model: "test/tiny-qwen3" }, [
      {
        messages: [
          { role: "user", content: "x".repeat(20_000) },
          { role: "assistant", content: "y" },
        ],
      },
    ]);
    expect(long.warnings.join(" ")).toMatch(/truncated/);
  });
});

describe("catalog", () => {
  it("extends and overrides via GRAD_EXTRA_MODELS_JSON and validates it", () => {
    expect(catalog.find("TEST/Tiny-Qwen3")?.price_per_million_tokens_usd).toBe(
      1,
    );
    expect(catalog.priceFor("qwen/qwen3-8b")).toBe(0.4);
    expect(catalog.priceFor("nope")).toBeUndefined();
    expect(createModelCatalog().find("test/tiny-qwen3")).toBeUndefined();
    expect(() => createModelCatalog("{nope")).toThrow(/not valid JSON/);
    expect(() => createModelCatalog('[{"id": "x"}]')).toThrow(/is invalid/);
    const override = createModelCatalog(
      '[{"id":"qwen/qwen3-8b","family":"llm","adapters":["lora"],"price_per_million_tokens_usd":9,"calibrated_lrs":{"sft":1e-4}}]',
    );
    expect(override.find("qwen/qwen3-8b")).toMatchObject({
      price_per_million_tokens_usd: 9,
      recipes: ["sft"],
    });
  });
});

describe("record helpers", () => {
  it("extracts conversations and prompts from every documented shape", () => {
    expect(recordConversation({ prompt: "p", completion: "c" })).toHaveLength(
      2,
    );
    expect(
      recordConversation({
        prompt: [{ role: "user", content: "p" }],
        expected_output: { content: "e" },
      }),
    ).toHaveLength(2);
    expect(recordConversation({ prompt: "p" })).toHaveLength(1);
    expect(
      recordConversation({
        input: { messages: [{ role: "user", content: "u" }] },
        expected_output: "e",
      }),
    ).toHaveLength(2);
    expect(
      recordConversation({
        input: { messages: [{ role: "user", content: "u" }] },
      }),
    ).toHaveLength(1);
    expect(recordConversation({ query: "q" })).toEqual([]);

    expect(
      recordPromptAndReference({
        input: { messages: [{ role: "user", content: "u" }] },
        output: { turns: [{ role: "assistant", content: "a" }] },
      }),
    ).toEqual({ prompt: [{ role: "user", content: "u" }], reference: "a" });
    expect(
      recordPromptAndReference({
        prompt: "p",
        completion: [{ role: "assistant", content: "c" }],
      })?.reference,
    ).toBe("c");
    expect(
      recordPromptAndReference({ prompt: "p", expected_output: { label: "L" } })
        ?.reference,
    ).toBe("L");
    expect(recordPromptAndReference({ prompt: "p" })?.reference).toBeNull();
    expect(recordPromptAndReference(chat(1))).toEqual({
      prompt: [{ role: "user", content: "question 1" }],
      reference: "answer 1",
    });
    expect(
      recordPromptAndReference({
        messages: [{ role: "assistant", content: "x" }],
      }),
    ).toBeNull();
    expect(
      recordPromptAndReference({
        messages: [
          { role: "user", content: [{ type: "text", text: "multi" }] },
        ],
      })?.reference,
    ).toBeNull();
  });

  it("counts usable records per recipe", () => {
    expect(assessRecipeUsability("cartridge", [{}]).usable).toBe(1);
    expect(
      assessRecipeUsability("sft", [
        {
          messages: [
            { role: "assistant", content: "", tool_calls: [{ id: "t" }] },
          ],
        },
      ]).usable,
    ).toBe(1);
    expect(
      assessRecipeUsability("embedding", [{ prompt: "q", positive: "p" }])
        .usable,
    ).toBe(1);
    expect(
      assessRecipeUsability("decision", [
        { input: { features: {} }, scores: { ok: 1 } },
      ]).usable,
    ).toBe(1);
    expect(
      assessRecipeUsability("router", [{ query: "q", scores: { "a/b": 1 } }])
        .discoveredModels,
    ).toEqual(["a/b"]);
  });
});
