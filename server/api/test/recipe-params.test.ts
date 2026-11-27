import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createModelCatalog } from "../src/catalog.js";
import { PlanRunRequestSchema, type DatasetRecord } from "../src/contracts.js";
import { ApiError } from "../src/errors.js";
import { planRun } from "../src/planner.js";

/**
 * Shared with the trainer (server/trainer/tests/test_recipe_params_contract.py):
 * the resolved configs the planner sends for requests that set every
 * documented recipe parameter. The trainer test proves each one is honoured.
 * Regenerate with GRAD_UPDATE_FIXTURES=1.
 */
const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/wire/resolved-configs.json",
);

const catalog = createModelCatalog(
  JSON.stringify([
    {
      id: "test/tiny-qwen3",
      hf_repo: null,
      family: "llm",
      adapters: ["lora", "prefix_kv"],
      default_for: [],
      price_per_million_tokens_usd: 1,
      max_context_tokens: 2048,
      template_revision: "qwen3@3",
      calibrated_lrs: {
        sft: 1e-3,
        dpo: 1e-4,
        router: 1e-3,
        cartridge: 1e-2,
        distill: 1e-3,
        reward: 1e-3,
      },
    },
    {
      id: "test/tiny-qwen3-teacher",
      hf_repo: null,
      family: "llm",
      adapters: ["lora", "prefix_kv"],
      default_for: [],
      price_per_million_tokens_usd: 2,
      max_context_tokens: 2048,
      template_revision: "qwen3@3",
      calibrated_lrs: { cartridge: 1e-2 },
    },
    {
      id: "test/tiny-bert",
      hf_repo: null,
      family: "encoder",
      adapters: ["encoder_full"],
      default_for: [],
      price_per_million_tokens_usd: 0.5,
      max_context_tokens: 512,
      template_revision: "bge@1",
      calibrated_lrs: { embedding: 1e-4 },
    },
  ]),
);

const chats: DatasetRecord[] = Array.from({ length: 24 }, (_, i) => ({
  id: `c${i}`,
  messages: [
    { role: "user", content: `question ${i}` },
    { role: "assistant", content: `answer ${i}` },
  ],
}));

/** One record per (prompt, model) response with two scores each. */
const responses: DatasetRecord[] = Array.from({ length: 24 }, (_, i) =>
  ["cheap/m", "strong/m"].map(
    (model): DatasetRecord => ({
      id: `${model}-${i}`,
      group_id: `p${i}`,
      messages: [
        { role: "user", content: `${i % 2 ? "hard" : "easy"} prompt ${i}` },
        { role: "assistant", content: "x" },
      ],
      metadata: { model },
      scores: {
        ok: model === "strong/m" || i % 2 === 0 ? 1 : 0,
        latency: 0.5,
      },
    }),
  ),
).flat();

const plan = (
  recipe: Record<string, unknown>,
  records: readonly DatasetRecord[],
) =>
  planRun(
    PlanRunRequestSchema.parse({ dataset: "ds", name: "run", recipe }),
    records,
    { catalog, datasetVersion: 1 },
  );

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

const OPTIMIZER = {
  kind: "adamw",
  betas: [0.8, 0.9],
  weight_decay: 0.1,
  grad_clip: 0.5,
};

/** Requests that set every documented parameter of each recipe. */
const FULL_REQUESTS: Record<
  string,
  { recipe: Record<string, unknown>; records: readonly DatasetRecord[] }
> = {
  sft: {
    recipe: {
      kind: "sft",
      model: "test/tiny-qwen3",
      loss: { kind: "cross_entropy", reduction: "per_token" },
      optimizer: OPTIMIZER,
      eval_every: 2,
      batch_size: 4,
    },
    records: chats,
  },
  dpo: {
    recipe: {
      kind: "dpo",
      model: "test/tiny-qwen3",
      loss: { kind: "dpo", beta: 0.3 },
      batch_size: 4,
    },
    records: Array.from({ length: 24 }, (_, i) => ({
      id: `d${i}`,
      prompt: `p${i}`,
      chosen: `good ${i}`,
      rejected: `bad ${i}`,
    })),
  },
  router: {
    recipe: {
      kind: "router",
      model: "test/tiny-qwen3",
      rubric: "ok",
      pricing: { "cheap/m": 0.001, "strong/m": 0.01 },
      fallback: "strong/m",
      max_quality_drop: 0.05,
      batch_size: 4,
    },
    records: responses,
  },
  cartridge: {
    recipe: {
      kind: "cartridge",
      model: "test/tiny-qwen3",
      context_text: "The capital of Testland is Tinytown.",
      num_tokens: 16,
      teacher: "test/tiny-qwen3-teacher",
      loss: { kind: "top_k_kl_distill", top_k: 7 },
      max_new_tokens: 5,
      slot_token: "<|fim_pad|>",
      batch_size: 4,
    },
    records: chats.map((r) => ({ ...r, messages: r.messages?.slice(0, 1) })),
  },
  distill: {
    recipe: {
      kind: "distill",
      model: "test/tiny-qwen3",
      teacher: "test/tiny-qwen3-teacher",
      rollout: { kind: "on_policy", max_new_tokens: 6 },
      loss: { kind: "top_k_kl_distill", top_k: 5 },
      context_text: "The capital of Testland is Tinytown.",
      batch_size: 4,
    },
    records: chats,
  },
  reward: {
    recipe: {
      kind: "reward",
      model: "test/tiny-qwen3",
      adapter: { kind: "lora", rank: 8, alpha: 16 },
      rubric: "ok",
      batch_size: 4,
    },
    records: [
      ...Array.from({ length: 16 }, (_, i) => ({
        id: `rp${i}`,
        prompt: `p${i}`,
        chosen: `good ${i}`,
        rejected: `bad ${i}`,
      })),
      ...chats.slice(0, 8).map((r, i) => ({ ...r, scores: { ok: i % 2 } })),
    ],
  },
  embedding: {
    recipe: {
      kind: "embedding",
      model: "test/tiny-bert",
      loss: { kind: "infonce", temp: 0.1 },
      pool: { kind: "cls" },
      batch_size: 4,
    },
    records: Array.from({ length: 24 }, (_, i) => ({
      query: `q${i}`,
      positive: `p${i}`,
    })),
  },
};

describe("recipe parameters", () => {
  it("forwards every documented parameter (shared trainer fixture)", () => {
    const resolved = Object.fromEntries(
      Object.entries(FULL_REQUESTS).map(([kind, { recipe, records }]) => [
        kind,
        plan(recipe, records).resolved_config,
      ]),
    );
    expect(resolved.sft).toMatchObject({
      reduction: "per_token",
      optimizer: OPTIMIZER,
      eval_every_steps: 2,
    });
    expect(resolved.router?.recipe_params).toMatchObject({
      rubric: "ok",
      fallback: "strong/m",
      models: ["cheap/m", "strong/m"],
    });

    const serialized = `${JSON.stringify(resolved, null, 2)}\n`;
    if (process.env.GRAD_UPDATE_FIXTURES === "1") {
      writeFileSync(FIXTURE, serialized);
    }
    expect(serialized).toBe(readFileSync(FIXTURE, "utf8"));
  });

  it("defaults the optimizer, eval cadence and losses", () => {
    const sft = plan({ kind: "sft", model: "test/tiny-qwen3" }, chats);
    expect(sft.resolved_config).toMatchObject({
      reduction: "per_example",
      optimizer: {
        kind: "adamw",
        betas: [0.9, 0.95],
        weight_decay: 0,
        grad_clip: 1,
      },
    });
    expect(sft.resolved_config.eval_every_steps).toBe(
      sft.resolved_config.checkpoint_every_steps,
    );
    const dpo = plan(
      { kind: "dpo", model: "test/tiny-qwen3", beta: 0.2 },
      FULL_REQUESTS.dpo?.records ?? [],
    );
    expect(dpo.resolved_config.recipe_params.loss).toEqual({
      kind: "dpo",
      beta: 0.2,
    });
    const embedding = plan(
      { kind: "embedding", model: "test/tiny-bert" },
      FULL_REQUESTS.embedding?.records ?? [],
    );
    expect(embedding.resolved_config.recipe_params).toEqual({
      loss: { kind: "infonce", temp: 0.05 },
      pool: "mean",
    });
    const late = plan(
      { kind: "sft", model: "test/tiny-qwen3", eval_every: 10_000 },
      chats,
    );
    expect(late.warnings.join(" ")).toMatch(/evaluated only at the end/);
  });

  it("rejects parameters a recipe cannot honour instead of dropping them", () => {
    const strict = PlanRunRequestSchema.safeParse({
      dataset: "ds",
      name: "run",
      recipe: { kind: "sft", evals: [{ name: "ifeval" }] },
    });
    expect(strict.success).toBe(false);
    expect(JSON.stringify(strict.error?.issues)).toMatch(/evals/);

    expectCode(
      () => plan({ kind: "sft", beta: 0.1 }, chats),
      "recipe_param_unsupported",
      /beta does not apply to recipe 'sft'.*dpo/,
    );
    expectCode(
      () => plan({ kind: "sft", models: ["a/b", "c/d"] }, chats),
      "recipe_param_unsupported",
    );
    expectCode(
      () => plan({ kind: "sft", loss: { kind: "dpo", beta: 0.1 } }, chats),
      "loss_unsupported",
      /cross_entropy/,
    );
    expectCode(
      () =>
        plan(
          { kind: "decision", loss: { kind: "cross_entropy" } },
          chats.map((r) => ({ ...r, expected_output: { label: "a" } })),
        ),
      "loss_unsupported",
      /per question type/,
    );
    expectCode(
      () =>
        plan(
          {
            kind: "dpo",
            beta: 0.2,
            loss: { kind: "dpo", beta: 0.3 },
          },
          FULL_REQUESTS.dpo?.records ?? [],
        ),
      "recipe_param_conflict",
    );
    expectCode(
      () =>
        plan(
          {
            kind: "sft",
            reduction: "per_example",
            loss: { kind: "cross_entropy", reduction: "per_token" },
          },
          chats,
        ),
      "recipe_param_conflict",
    );
    expectCode(
      () =>
        plan(
          {
            kind: "embedding",
            model: "test/tiny-bert",
            temp: 0.2,
            loss: { kind: "infonce", temp: 0.1 },
          },
          FULL_REQUESTS.embedding?.records ?? [],
        ),
      "recipe_param_conflict",
    );
    expectCode(
      () =>
        plan(
          {
            kind: "cartridge",
            model: "test/tiny-qwen3",
            context_text: "doc",
            teacher: "test/tiny-bert",
          },
          chats,
        ),
      "unknown_model",
      /Teacher 'test\/tiny-bert' is not a llm model/,
    );
  });

  it("validates distillation and reward-model parameters", () => {
    const prompts = chats.map((r) => ({
      ...r,
      messages: r.messages?.slice(0, 1),
    }));
    const distill = (recipe: Record<string, unknown>) =>
      plan({ kind: "distill", model: "test/tiny-qwen3", ...recipe }, prompts);
    const onPolicy = distill({ teacher: "test/tiny-qwen3-teacher" });
    expect(onPolicy.resolved_config.recipe_params).toEqual({
      teacher: "test/tiny-qwen3-teacher",
      rollout: { kind: "on_policy", max_new_tokens: 256 },
      loss: { kind: "top_k_kl_distill", top_k: 32 },
      teacher_token_weight: 2,
    });
    expectCode(() => distill({}), "distill_teacher_required");
    expectCode(
      () =>
        distill({
          teacher: "test/tiny-qwen3-teacher",
          loss: { kind: "cross_entropy" },
        }),
      "loss_unsupported",
      /OffPolicy/,
    );
    expectCode(
      () =>
        planRun(
          PlanRunRequestSchema.parse({
            dataset: "ds",
            name: "run",
            recipe: {
              kind: "distill",
              model: "test/tiny-qwen3",
              teacher: "big/m",
              rollout: { kind: "off_policy" },
              loss: { kind: "top_k_kl_distill" },
            },
          }),
          prompts,
          { catalog, datasetVersion: 1 },
        ),
      "loss_unsupported",
      /CrossEntropy/,
    );
    expectCode(
      () =>
        distill({
          teacher: "big/m",
          rollout: { kind: "off_policy" },
          context_text: "doc",
        }),
      "distill_context_needs_on_policy",
    );
    expectCode(
      () => distill({ teacher: "test/tiny-qwen3", max_new_tokens: 5 }),
      "recipe_param_unsupported",
      /max_new_tokens does not apply/,
    );
    expectCode(
      () =>
        plan(
          {
            kind: "reward",
            model: "test/tiny-qwen3",
            rubric: [{ name: "q", kind: "judge", model: "j/m", prompt: "ok?" }],
          },
          FULL_REQUESTS.reward?.records ?? [],
        ),
      "reward_rubric_unsupported",
    );
    expectCode(
      () =>
        plan({ kind: "reward", model: "test/tiny-qwen3", rubric: "ok" }, [
          { ...chats[0], scores: { ok: 2 } } as DatasetRecord,
        ]),
      "reward_score_out_of_range",
    );
    const pairsOnly = plan(
      { kind: "reward", model: "test/tiny-qwen3" },
      FULL_REQUESTS.reward?.records ?? [],
    );
    expect(pairsOnly.resolved_config.recipe_params).toEqual({});
    expect(pairsOnly.usable_records).toBe(16);
    expect(pairsOnly.resolved_config.split.strategy).toBe("by_group");
  });

  it("validates router labels, fallback and pricing like the trainer", () => {
    expectCode(
      () => plan({ kind: "router", model: "test/tiny-qwen3" }, responses),
      "no_usable_records",
      /several scores \(latency, ok\); pass recipe.rubric/,
    );
    expectCode(
      () =>
        plan(
          { kind: "router", model: "test/tiny-qwen3", rubric: "missing" },
          responses,
        ),
      "no_usable_records",
      /no 'missing' score/,
    );
    expectCode(
      () =>
        plan(
          {
            kind: "router",
            model: "test/tiny-qwen3",
            rubric: "ok",
            fallback: "other/m",
          },
          responses,
        ),
      "router_fallback_not_candidate",
    );
    expectCode(
      () =>
        plan(
          {
            kind: "router",
            model: "test/tiny-qwen3",
            rubric: "ok",
            pricing: { "other/m": 1 },
          },
          responses,
        ),
      "router_pricing_not_candidate",
    );
    expectCode(
      () =>
        plan({ kind: "router", model: "test/tiny-qwen3", rubric: "ok" }, [
          { ...responses[0], scores: { ok: 3 } } as DatasetRecord,
        ]),
      "router_score_out_of_range",
    );
    const unpriced = plan(
      { kind: "router", model: "test/tiny-qwen3", rubric: "ok" },
      responses,
    );
    expect(unpriced.warnings.join(" ")).toMatch(/No price for cheap\/m/);
    const restricted = plan(
      {
        kind: "router",
        model: "test/tiny-qwen3",
        models: ["cheap/m", "strong/m"],
      },
      [{ prompt: "p", scores: { "cheap/m": 0.2, "strong/m": 1, x: 0.5 } }],
    );
    expect(restricted.resolved_config.recipe_params.models).toEqual([
      "cheap/m",
      "strong/m",
    ]);
  });
});
