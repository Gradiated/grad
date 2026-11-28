import { describe, expect, it } from "vitest";

import { createModelCatalog } from "../src/catalog.js";
import {
  PlanRunRequestSchema,
  type DatasetRecord,
  type PlanRunRequest,
} from "../src/contracts.js";
import { ApiError } from "../src/errors.js";
import { formatUsd, planRun, splitRecords } from "../src/planner.js";
import { renderMessages } from "../src/render.js";
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

  it("holds out a group whenever there are two or more (r8 reward-model flake)", () => {
    // 12 pairs at the default 10%: before, about 29% of pushes trained with no eval side.
    for (let seed = 0; seed < 200; seed += 1) {
      const records = Array.from({ length: 12 }, (_, i) => chat(i, `s-${i}`));
      const { train, eval: evalSet } = splitRecords(records, {
        strategy: "by_session",
        eval_fraction: 0.1,
        seed,
      });
      expect(evalSet.length).toBeGreaterThan(0);
      expect(train.length).toBeGreaterThan(0);
      expect(train.length + evalSet.length).toBe(12);
    }
    // The held-out group moves whole; one group alone stays on the train side.
    const grouped = Array.from({ length: 6 }, (_, i) => chat(i, `g-${i % 2}`));
    const split = splitRecords(grouped, {
      strategy: "by_session",
      eval_fraction: 0.01,
      seed: 3,
    });
    expect(new Set(split.eval.map((r) => r.session_id)).size).toBe(1);
    expect(split.eval).toHaveLength(3);
    const single = splitRecords(
      Array.from({ length: 6 }, (_, i) => chat(i, "only")),
      { strategy: "by_session", eval_fraction: 0.01, seed: 3 },
    );
    expect(single.eval).toHaveLength(0);
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
    expect(r.spans.map((s) => s.text).join("")).not.toContain("old");
    expect(r.template_revision).toBe("qwen3@3");
  });

  it("supports all_assistant, preserve_thinking, per-message overrides and thinking checks", () => {
    const all = renderMessages("r", messages, {
      ...opts,
      train_on: "all_assistant",
      preserve_thinking: true,
    });
    const trained = all.spans.filter((s) => s.trained);
    expect(trained.map((s) => s.text)).toEqual([
      "<think>\nold\n</think>\n\nfirst<|im_end|>",
      "<think>\nnew\n</think>\n\nsecond<|im_end|>",
    ]);
    const override = renderMessages(
      "r",
      [
        { role: "user", content: "x" },
        { role: "assistant", content: "y", train: false },
      ],
      opts,
    );
    expect(override.trained_tokens).toBe(0);
    expect(() =>
      renderMessages(
        "r",
        [
          { role: "user", content: "x", train: true },
          { role: "assistant", content: "y" },
        ],
        opts,
      ),
    ).toThrow(/only assistant turns can be trained/);
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

  it("refuses a merged export bigger than one upload at plan time", () => {
    const merged = (model: string) => ({
      kind: "sft",
      model,
      adapter: { kind: "lora", merge_on_export: true },
    });

    expectCode(
      () => plan(merged("qwen/qwen3-4b"), records),
      "merged_export_too_large",
      /8\.8 GB merged model.*at most 5 GiB.*merge_on_export=false.*merge_and_unload/,
    );
    expect(
      plan(merged("qwen/qwen3-1.7b"), records).resolved_config.adapter,
    ).toMatchObject({ merge_on_export: true });
    // Unprofiled bases are the trainer's to check once the weights load.
    expect(() => plan(merged("test/tiny-qwen3"), records)).not.toThrow();
    expect(() =>
      plan({ kind: "sft", model: "qwen/qwen3-14b" }, records),
    ).not.toThrow();
  });

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
      /GET \/v1\/base-models/,
    );
    expectCode(
      () => plan({ kind: "sft", model: "meta/llama-405b" }, records),
      "unknown_model",
      /^(?!.*(explicit lr|did you mean)).*grad models list/,
    );
    expectCode(
      () => plan({ kind: "sft", model: "qwen/qwen3-8" }, records),
      "unknown_model",
      /did you mean 'qwen\/qwen3-8b'\?/,
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

  it("counts router prompt groups and prompt tokens, split by group like the trainer", () => {
    const models = [
      "qwen/qwen3-8b",
      "qwen/qwen3-14b",
      "qwen/qwen3-1.7b",
      "qwen/qwen3-4b",
    ];
    const prompt = (i: number) =>
      `Which planet is closest to the sun? Case ${i}.`;
    // One record per (prompt, model), as RouterBench: 300 prompts x 4 responses.
    const rows: DatasetRecord[] = Array.from({ length: 300 }, (_, i) =>
      models.map((m, j) => ({
        id: `r${i}-${j}`,
        session_id: `r${i}-${j}`,
        group_id: `g${i}`,
        messages: [
          { role: "user" as const, content: prompt(i) },
          { role: "assistant" as const, content: "A long answer ".repeat(40) },
        ],
        metadata: { model: m },
        scores: { correct: j % 2 },
      })),
    ).flat();
    const router = plan({ kind: "router", batch_size: 16 }, rows);
    const { train_records, eval_records, strategy } =
      router.resolved_config.split;
    expect(strategy).toBe("by_session");
    expect(train_records % 4).toBe(0); // whole groups land on one side
    expect(eval_records % 4).toBe(0);
    const groups = train_records / 4;
    expect(router.estimated_steps).toBe(Math.ceil(groups / 16));
    // Prompt tokens only, once per group: header 3 + text + footer 2 + generation header 3.
    const perGroup = 3 + Math.ceil(prompt(0).length / 4) + 2 + 3;
    expect(router.estimated_tokens).toBeGreaterThanOrEqual(groups * perGroup);
    expect(router.estimated_tokens).toBeLessThanOrEqual(
      groups * (perGroup + 1),
    );
    expect(router.trained_token_fraction).toBe(1);

    // Without group_id, records join on their prompt (recipes/router.py prompt_key).
    const ungrouped = plan(
      { kind: "router", batch_size: 16 },
      rows.map(({ group_id: _drop, ...r }) => r),
    );
    expect(ungrouped.resolved_config.split.train_records % 4).toBe(0);
    expect(ungrouped.estimated_tokens).toBeGreaterThan(0);
  });

  it("estimates chat tokens with exact ChatML framing and the trainer's 8,192-token cut", () => {
    const one = (content: string): DatasetRecord => ({
      id: "x",
      messages: [
        { role: "user", content: "abcd" },
        { role: "assistant", content },
      ],
    });
    const rendered = renderMessages("x", one("wxyz").messages ?? [], {
      templateRevision: "qwen3@3",
      train_on: "last",
      thinking: "auto",
      preserve_thinking: false,
    });
    // user: 3 + 1 + 2; assistant: 3 + 4 (empty think) + 1 + 2, of which the
    // answer and its <|im_end|> train (not the newline after it).
    expect(rendered.total_tokens).toBe(16);
    expect(rendered.trained_tokens).toBe(2);
    expect(rendered.spans[0]?.text).toContain("<think>\n\n</think>");
    const long = plan({ kind: "sft" }, [one("y".repeat(80_000))], {
      split: { eval_fraction: 0 },
    });
    expect(long.estimated_tokens).toBe(8192);
    expect(long.warnings.join(" ")).toMatch(/exceed 8192 tokens/);
  });

  it("estimates what the trainer bills: tokenizer density, both pair sides, whole batches per epoch", () => {
    // r8 trial: a dev-model SFT run planned $1.13 and billed about 2.3x that (chars/4
    // against a 1.5 characters-a-token tokenizer); DPO missed the rejected side and the
    // prompt's second pass; 3 epochs planned 32 steps where the trainer ran 33.
    const dense = createModelCatalog(
      JSON.stringify([
        {
          id: "test/dense",
          family: "llm",
          adapters: ["lora"],
          price_per_million_tokens_usd: 1,
          chars_per_token: 1.5,
          calibrated_lrs: { sft: 1e-3, dpo: 1e-4 },
        },
      ]),
    );
    expect(dense.charsPerToken("TEST/Dense")).toBe(1.5);
    expect(dense.charsPerToken("qwen/qwen3-8b")).toBe(4);
    expect(dense.find("test/dense")).not.toHaveProperty("chars_per_token");
    const long = (i: number): DatasetRecord => ({
      id: `r${i}`,
      messages: [
        { role: "user", content: "q".repeat(600) },
        { role: "assistant", content: "a".repeat(600) },
      ],
    });
    const rows = Array.from({ length: 83 }, (_, i) => long(i));
    const at = (cat: typeof catalog, recipe: Record<string, unknown>) =>
      planRun(
        request(
          { kind: "sft", model: "test/dense", batch_size: 8, ...recipe },
          { split: { eval_fraction: 0 } },
        ),
        rows,
        { catalog: cat, datasetVersion: 1 },
      );
    const sft = at(dense, {});
    expect(sft.estimated_tokens).toBe(83 * (3 + 400 + 2 + 3 + 4 + 400 + 2));
    expect(sft.cost_breakdown).toEqual({
      train_usd: sft.estimated_cost_usd,
      teacher_usd: 0,
      eval_usd: 0,
    });
    // ceil(83 / 8) = 11 steps per epoch, as the trainer's loop: 33, not ceil(249 / 8) = 32.
    expect(at(dense, { epochs: 3 }).estimated_steps).toBe(33);
    expect(at(dense, { epochs: 3 }).estimated_tokens).toBe(
      3 * sft.estimated_tokens,
    );

    const pairs = Array.from({ length: 40 }, (_, i) => ({
      id: `p${i}`,
      prompt: "q".repeat(300),
      chosen: "c".repeat(150),
      rejected: "r".repeat(30),
    }));
    const dpo = planRun(
      request(
        { kind: "dpo", model: "test/dense", batch_size: 8 },
        { split: { eval_fraction: 0 } },
      ),
      pairs,
      { catalog: dense, datasetVersion: 1 },
    );
    // Each pair: user prompt (3 + 200 + 2) on both sides, plus each answer (3 + 4 + n + 2).
    expect(dpo.estimated_tokens).toBe(40 * (2 * 205 + (9 + 100) + (9 + 20)));
    expect(dpo.estimated_steps).toBe(5);
  });

  it("defaults small datasets to a smaller batch and warns about few optimizer steps", () => {
    const rows = Array.from({ length: 40 }, (_, i) => chat(i));
    const small = plan({ kind: "sft" }, rows);
    const train = small.resolved_config.split.train_records;
    expect(small.resolved_config.batch_size).toBe(
      Math.max(8, Math.floor(train / 4)),
    );
    expect(small.estimated_steps).toBe(
      Math.ceil(train / small.resolved_config.batch_size),
    );
    const pinned = plan({ kind: "sft", batch_size: 128 }, rows);
    // The auto lr follows the batch size (sqrt scaling from the calibrated 128).
    const scale = Math.sqrt(small.resolved_config.batch_size / 128);
    expect(small.resolved_config.lr).toBeCloseTo(
      Number((pinned.resolved_config.lr * scale).toPrecision(3)),
      8,
    );
    expect(pinned.estimated_steps).toBe(1);
    expect(pinned.warnings).toContain(
      `${train} training examples at batch 128 is 1 step per epoch, below the 100 steps we recommend; consider more data, more epochs or a smaller batch_size.`,
    );
    const big = Array.from({ length: 2000 }, (_, i) => chat(i));
    expect(plan({ kind: "sft" }, big).resolved_config.batch_size).toBe(128);
    const embedding = Array.from({ length: 40 }, (_, i) => ({
      id: `e${i}`,
      query: `q${i}`,
      positive: `p${i}`,
    }));
    expect(
      plan({ kind: "embedding" }, embedding).resolved_config.batch_size,
    ).toBe(128);
  });

  it("checkpoints every 10% of steps (at least every 20), evaluates every 25%, and estimates duration and GPU memory", () => {
    const many = Array.from({ length: 4000 }, (_, i) => chat(i));
    const big = plan({ kind: "sft", batch_size: 8 }, many);
    expect(big.estimated_steps).toBeGreaterThan(400);
    expect(big.resolved_config.checkpoint_every_steps).toBe(20);
    // Evals cost far more than checkpoints: every 25% of the run, at most every 20 steps.
    expect(big.resolved_config.eval_every_steps).toBe(
      Math.ceil(big.estimated_steps * 0.25),
    );
    const small = plan({ kind: "sft" }, records);
    expect(small.resolved_config.checkpoint_every_steps).toBe(1);
    expect(small.resolved_config.eval_every_steps).toBe(small.estimated_steps);
    const mid = plan({ kind: "sft", batch_size: 1 }, records.slice(0, 30));
    expect(mid.resolved_config.checkpoint_every_steps).toBe(
      Math.floor(mid.estimated_steps * 0.1),
    );

    expect(big.min_gpu_memory_gb).toBe(36);
    expect(big.estimated_duration_s).toBeGreaterThan(65);
    const slower = plan(
      { kind: "sft", batch_size: 8, model: "qwen/qwen3-14b" },
      many,
    );
    expect(slower.min_gpu_memory_gb).toBe(56);
    expect(slower.estimated_duration_s).toBeGreaterThan(
      big.estimated_duration_s,
    );
    // The CPU dev models finish in seconds, not an 8B's minutes.
    const dev = plan({ kind: "sft", model: "test/tiny-qwen3" }, records);
    expect(dev.min_gpu_memory_gb).toBeNull();
    expect(dev.estimated_duration_s).toBeLessThan(30);
    // qwen3-32b is an eval/judge model only: no recipe trains it on one GPU.
    expectCode(
      () => plan({ kind: "sft", model: "qwen/qwen3-32b" }, records),
      "recipe_not_supported_for_model",
    );
    expect(catalog.find("qwen/qwen3-32b")?.recipes).toEqual([]);
    expect(
      plan({ kind: "sft", model: "test/tiny-qwen3" }, records)
        .min_gpu_memory_gb,
    ).toBeNull();
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
      teacher: "qwen/qwen3-14b",
      batch_size: 128,
      rollout: { kind: "on_policy", max_new_tokens: 64 },
    });
    expect(onPolicy.resolved_config.model).toBe("qwen/qwen3-4b");
    expect(onPolicy.resolved_config.lr).toBeCloseTo(2e-4, 8);
    expect(onPolicy.resolved_config.adapter).toMatchObject({ kind: "lora" });
    expect(onPolicy.resolved_config.recipe_params).toMatchObject({
      teacher: "qwen/qwen3-14b",
      rollout: { kind: "on_policy", max_new_tokens: 64 },
      loss: { kind: "top_k_kl_distill", top_k: 32 },
      teacher_token_weight: 2.33333,
    });
    const teacher = onPolicy.teacher;
    expect(teacher).toMatchObject({
      model: "qwen/qwen3-14b",
      price_per_million_tokens: 0.7,
    });
    expect(teacher?.estimated_tokens).toBeGreaterThan(64 * prompts.length);
    const train = onPolicy.resolved_config.split.train_records;
    expect(onPolicy.estimated_tokens).toBeGreaterThan(
      (teacher?.estimated_tokens ?? 0) * 2.3,
    );
    expect(onPolicy.estimated_tokens).toBeGreaterThan(2 * 64 * train);
    expect(onPolicy.estimated_cost_usd).toBeCloseTo(
      (onPolicy.estimated_tokens / 1e6) * 0.3,
      4,
    );
    expect(onPolicy.labeling).toBeNull();

    // auto sizes answers from the records' own assistant turns (or 256 without any).
    const sized = distill(
      { model: "qwen/qwen3-4b", teacher: "qwen/qwen3-14b" },
      records,
    );
    expect(sized.resolved_config.recipe_params.rollout).toEqual({
      kind: "on_policy",
      max_new_tokens: 32,
    });
    expect(
      distill({ teacher: "qwen/qwen3-14b" }).resolved_config,
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
    // A 32B teacher beside the student doesn't fit one 80 GB GPU.
    expectCode(
      () => distill({ model: "qwen/qwen3-4b", teacher: "qwen/qwen3-32b" }),
      "model_exceeds_gpu_memory",
      /needs about 88 GB.*rollout=OffPolicy\(\)/,
    );
    expect(onPolicy.min_gpu_memory_gb).toBe(52);
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
          { teacher: "qwen/qwen3-14b" },
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
    const reward = plan({ kind: "reward", batch_size: 128 }, [
      ...pairs,
      ...records,
    ]);
    expect(reward.resolved_config).toMatchObject({
      model: "qwen/qwen3-8b",
      adapter: { kind: "lora", rank: 32 },
      recipe_kind: "reward",
      split: { strategy: "by_group" },
    });
    expect(reward.resolved_config.lr).toBeCloseTo(1e-4, 8);
    expect(reward.usable_records).toBe(20);
    expect(reward.warnings.join(" ")).toMatch(
      /40 of 60 records cannot be used by 'reward' .*for example 'r0', 'r1', 'r2'/,
    );
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
    // Sub-cent amounts keep two significant digits instead of "$0.00 exceeds $0.00".
    expect(budget.warnings.join(" ")).toMatch(
      /\(\$0\.0\d*[1-9]\d*\) exceeds max_cost_usd \(\$0\.00000010\)/,
    );
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(12.345)).toBe("$12.35");
    expect(formatUsd(0.00041)).toBe("$0.00041");
    expect(formatUsd(0.00001)).toBe("$0.000010");
    // One example per step at most: a batch size can't reach 100 steps, and "1 step" is singular.
    const one = plan({ kind: "sft" }, records.slice(0, 4));
    const few = one.warnings.find((w) => w.includes("below the 100"));
    expect(few).toMatch(
      /^\d training examples at batch 8 is 1 step per epoch, below the 100 steps we recommend; consider more data, more epochs or a smaller batch_size\.$/,
    );
    const many = Array.from({ length: 400 }, (_, i) => chat(i));
    const advice = plan({ kind: "sft", batch_size: 32 }, many).warnings.find(
      (w) => w.includes("below the 100"),
    );
    expect(advice).toMatch(
      /^\d+ training examples at batch 32 is \d+ steps per epoch, below the 100 steps we recommend; use batch_size=\d+ \(or add epochs or data\)\.$/,
    );
    const epochs = plan({ kind: "sft", batch_size: 32, epochs: 3 }, many);
    expect(epochs.warnings.join(" ")).toMatch(
      /at batch 32 is (\d+) steps per epoch \(\d+ over 3 epochs\)/,
    );
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

  it("prices judges from the catalog and GRAD_JUDGE_MODELS_JSON only", () => {
    const judges = createModelCatalog(
      undefined,
      '[{"id":"Anthropic/Claude-X","price_per_million_tokens_usd":3}]',
    );
    expect(judges.judgePriceFor("anthropic/claude-x")).toBe(3);
    expect(judges.judgePriceFor("qwen/qwen3-8b")).toBe(0.4);
    expect(judges.judgePriceFor("nope")).toBeUndefined();
    expect(judges.judgeModels()).toContain("anthropic/claude-x");
    expect(judges.find("anthropic/claude-x")).toBeUndefined();
    expect(judges.priceVersion).not.toBe(createModelCatalog().priceVersion);
    expect(() => createModelCatalog(undefined, "{nope")).toThrow(
      /GRAD_JUDGE_MODELS_JSON is not valid JSON/,
    );
    expect(() =>
      createModelCatalog(
        undefined,
        '[{"id":"j","price_per_million_tokens_usd":0}]',
      ),
    ).toThrow(/GRAD_JUDGE_MODELS_JSON is invalid/);
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
    const turn = (role: "user" | "assistant", content: string) => ({
      role,
      content,
    });
    // TRL's implicit-prompt pairs: the shared opening turns are the prompt.
    expect(
      assessRecipeUsability("dpo", [
        {
          chosen: [turn("user", "q"), turn("assistant", "good")],
          rejected: [turn("user", "q"), turn("assistant", "bad")],
        },
        { chosen: "good", rejected: "bad" },
      ]).usable,
    ).toBe(1);
    expect(assessRecipeUsability("cartridge", [{ prompt: "q" }]).usable).toBe(
      1,
    );
    expect(assessRecipeUsability("cartridge", [{}])).toMatchObject({
      usable: 0,
      unusable: 1,
      examples: ["#0"],
    });
    expect(
      assessRecipeUsability("sft", [
        {
          messages: [
            { role: "user", content: "call it" },
            { role: "assistant", content: "", tool_calls: [{ id: "t" }] },
          ],
        },
      ]).usable,
    ).toBe(1);
    // An answer with no prompt would train without context: counted and reported.
    expect(
      assessRecipeUsability("sft", [
        { id: "lonely", messages: [{ role: "assistant", content: "a" }] },
        { id: "no-answer", prompt: "q" },
      ]),
    ).toMatchObject({
      usable: 0,
      unusable: 2,
      examples: ["lonely", "no-answer"],
      reasons: [
        "record has no prompt (a user or system turn before the answer)",
        "record has no assistant answer (an assistant turn, completion or expected_output) to train on",
      ],
    });
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

describe("planRun on a sample of a bigger version", () => {
  it("scales counts, tokens and cost to the version's total and says so", () => {
    const records = Array.from({ length: 200 }, (_, i) => chat(i));
    const recipe = { kind: "sft", model: "test/tiny-qwen3" };
    const whole = plan(recipe, records);
    const sampled = planRun(request(recipe), records, {
      catalog,
      datasetVersion: 3,
      totalRecords: 2000,
    });

    expect(sampled.total_records).toBe(2000);
    expect(sampled.usable_records).toBe(whole.usable_records * 10);
    expect(sampled.resolved_config.split.train_records).toBe(
      whole.resolved_config.split.train_records * 10,
    );
    expect(sampled.estimated_tokens).toBe(whole.estimated_tokens * 10);
    expect(sampled.estimated_steps).toBeGreaterThan(whole.estimated_steps);
    expect(sampled.warnings).toContain(
      "Estimated from 200 of the 2000 records (pages spread over the dataset); the run trains on all of them.",
    );
    expect(whole.warnings.join(" ")).not.toMatch(/Estimated from/);
  });
});
