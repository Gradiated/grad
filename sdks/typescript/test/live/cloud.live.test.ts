// Live: Gradiated Cloud mode (fake Cloud control plane + real grad-server).
// The torch worker trains a tiny distilled student and a reward model.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthenticationError, Grad, recipes, rollouts } from "../../src/index.js";
import { liveSkipReason, Stack } from "./stack.js";

const skipReference = liveSkipReason("reference");
const skipTorch = liveSkipReason("torch");
if (skipTorch) console.warn(`skipping the cloud torch live test: ${skipTorch}`);

describe.skipIf(skipReference !== undefined)("live: cloud auth with the reference worker", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await Stack.start({ cloud: true, worker: "reference" });
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it("authenticates through the Cloud control plane and trains", async () => {
    const grad = new Grad({ apiKey: stack.apiKey, baseURL: stack.baseURL });
    const dataset = await grad.datasets.push(
      "support-prod",
      Array.from({ length: 16 }, (_, i) => ({
        sessionId: `s${i}`,
        messages: [
          { role: "user" as const, content: `Where is invoice #${i}?` },
          { role: "assistant" as const, content: "Billing -> Invoices." },
        ],
      })),
    );
    const run = await grad.runs.create({ dataset, name: "support-sft", recipe: recipes.sft({ model: "test/tiny-qwen3", batchSize: 8 }) }).wait({ timeoutMs: 240_000 });
    expect(run.artifact.id).toBe(run.artifactId);
    await expect(new Grad({ apiKey: "grad_unknown", baseURL: stack.baseURL }).runs.list()).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe.skipIf(skipTorch !== undefined)("live: cloud distillation and reward models with the torch worker", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await Stack.start({ cloud: true, worker: "torch", timeoutMs: 600_000 });
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it("distills a tiny teacher and trains a reward model", async () => {
    const grad = new Grad({ apiKey: stack.apiKey, baseURL: stack.baseURL });
    const prompts = await grad.datasets.push(
      "support-prompts",
      Array.from({ length: 12 }, (_, i) => ({ messages: [{ role: "user" as const, content: `How do I rotate API key ${i}?` }] })),
    );
    const recipe = recipes.distill({ model: "test/tiny-qwen3", teacher: "test/tiny-qwen3-teacher", rollout: rollouts.onPolicy({ maxNewTokens: 4 }), batchSize: 4 });
    const plan = await grad.runs.plan({ dataset: prompts, name: "support-distilled", recipe });
    expect(plan.teacher?.model).toBe("test/tiny-qwen3-teacher");
    const distilled = await grad.runs.create({ dataset: prompts, name: "support-distilled", recipe }).wait({ timeoutMs: 480_000 });
    expect(distilled.artifact.format).toBe("peft_lora");
    expect(distilled.evalReport?.metricName).toBe("eval_kl");

    const pairs = await grad.datasets.push(
      "sql-preferences",
      Array.from({ length: 16 }, (_, i) => ({ prompt: `Count users ${i}`, chosen: "SELECT count(*) FROM users;", rejected: "no idea" })),
    );
    const verifier = await grad.runs
      .create({ dataset: pairs, name: "sql-verifier", recipe: recipes.rewardModel({ model: "test/tiny-qwen3", batchSize: 4 }) })
      .wait({ timeoutMs: 480_000 });
    expect(verifier.artifact.format).toBe("reward_bundle");
    expect(verifier.evalReport?.metricName).toBe("preference_accuracy");
    expect(verifier.evalReport?.preferenceAccuracy).not.toBeNull();
  });
});
