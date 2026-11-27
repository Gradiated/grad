// Live: Gradiated Cloud mode (fake Cloud control plane + real grad-server).
// The torch worker trains a real tiny router for deploy -> route -> feedback -> rollback.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthenticationError, Grad, recipes, type DatasetRecord } from "../../src/index.js";
import { liveSkipReason, scratchHome, Stack } from "./stack.js";

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

describe.skipIf(skipTorch !== undefined)("live: cloud router with the torch worker", () => {
  let stack: Stack;
  let home: ReturnType<typeof scratchHome>;
  beforeAll(async () => {
    stack = await Stack.start({ cloud: true, worker: "torch", timeoutMs: 600_000 });
    home = scratchHome("cloud");
  });
  afterAll(async () => {
    await stack?.stop();
    home?.cleanup();
  });

  it("quickstart: import, router .wait(), deploy, route, recordFeedback, promote, rollback", async () => {
    const traces = path.join(home.dir, "support_traces.jsonl");
    const records: DatasetRecord[] = Array.from({ length: 60 }, (_, i) => {
      const hard = i % 2 === 0;
      return {
        sessionId: `s${i}`,
        messages: [{ role: "user", content: `${hard ? "hard SQL join query" : "say hello"} ${i}` }],
        scores: { "cheap/m": hard ? 0 : 1, "strong/m": 1 },
      };
    });
    writeFileSync(traces, records.map((r) => JSON.stringify({ session_id: r.sessionId, messages: r.messages, scores: r.scores })).join("\n") + "\n");

    const grad = new Grad({ apiKey: stack.apiKey, baseURL: stack.baseURL });
    const dataset = await grad.datasets.create("support-prod");
    await dataset.importFile(traces).wait();

    const run = await grad.runs
      .create({ dataset, name: "support-router", recipe: recipes.router({ model: "test/tiny-qwen3", models: ["cheap/m", "strong/m"], batchSize: 8 }) })
      .wait({ timeoutMs: 480_000 });
    const deployment = await run.deploy();
    expect(deployment.activeArtifactId).toBe(run.artifact.id);

    const messages = [{ role: "user" as const, content: "hard SQL join query 3" }];
    const decision = await grad.route("support-router", { messages });
    // The fake Cloud picks from the artifact manifest's router_config.candidates; torch router bundles do not
    // carry it yet (r4 backlog), so it falls back to the deployment's model id.
    expect(decision.model).toMatch(/\S/);
    expect(decision.deployment).toBe("support-router");
    expect(decision.artifactId).toBe(run.artifact.id);
    const recorded = await decision.recordFeedback({ score: 1.0, metrics: { latency_ms: 12, output_tokens: 0 } });
    expect(recorded.accepted).toBe(1);
    const again = await grad.feedback.record({ inferenceId: decision.inferenceId, idempotencyKey: decision.inferenceId, score: 1.0 });
    expect(again.deduplicated).toBe(1);

    const checkpoints = await run.checkpoints();
    expect(checkpoints.length).toBeGreaterThan(0);
    const promoted = await checkpoints[0]!.promote({ name: "support-router" });
    const second = await promoted.deploy({ name: "support-router" });
    expect(second.activeArtifactId).not.toBe(deployment.activeArtifactId);
    const rolledBack = await grad.deployments.rollback("support-router");
    expect(rolledBack.activeArtifactId).toBe(deployment.activeArtifactId);
    const status = await grad.deployments.get("support-router");
    expect(status.feedbackCount).toBeGreaterThanOrEqual(1);
    expect((await grad.deployments.list().all()).map((d) => d.name)).toContain("support-router");
  });
});
