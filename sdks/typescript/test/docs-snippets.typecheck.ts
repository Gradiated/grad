// Type-level check that the documented TypeScript snippets compile (run by `tsc --noEmit`).
// Deviations from the docs are commented inline.
import { Context, Grad, Judge, Rubric, Scorer, Trajectory, recipes, validators } from "../src/index.js";

export const quickstart = async () => {
  const grad = new Grad();
  const dataset = await grad.datasets.create("support-prod");
  await dataset.importFile("./support_traces.jsonl").wait();

  const run = await grad.runs.create({ dataset, name: "support-router", recipe: recipes.router() }).wait();
  await run.deploy();
};

export const explicitKey = () => new Grad({ apiKey: process.env.GRADIATED_API_KEY });

export const selfHosted = () =>
  new Grad({
    baseURL: "https://grad.internal.example",
    apiKey: process.env.GRADIATED_API_KEY,
  });

export const planAndWait = async () => {
  const grad = new Grad();
  const dataset = await grad.datasets.get("support-prod");
  const plan = await grad.runs.plan({ dataset, name: "support-router", recipe: recipes.router() });
  console.log(plan.resolvedRecipe, plan.warnings, plan.estimatedTokens, plan.estimatedCostUsd);
  const run = await grad.runs
    .create({ dataset, name: "support-router", recipe: recipes.router(), maxCostUsd: 20 })
    .wait({ onMetric: (m) => console.log(`step=${m.step} loss=${m.loss.toFixed(4)}`) });
  console.log(run.artifact.id, run.evalReport?.paretoSummary?.qualityDropCi95, run.evalReport?.metricName);
};

export const followMetrics = async () => {
  const grad = new Grad();
  const run = await grad.runs.get("run_01J9X");
  for await (const metric of run.metrics({ follow: true })) {
    console.log(metric.step, metric.loss, metric.evalMetrics);
  }
};

export const routeAndFeedback = async () => {
  const grad = new Grad();
  const messages = [{ role: "user" as const, content: "Where is invoice #9941?" }];
  const tools: unknown[] = [];
  const decision = await grad.route("support-router", { messages, tools });
  console.log(decision.model);
  await decision.recordFeedback({ score: 1.0, metrics: { latency_ms: 12, output_tokens: 0 } });
};

export const feedback = async (inferenceId: string, humanFix: string | null) => {
  const grad = new Grad();
  await grad.feedback.record({ inferenceId, idempotencyKey: `${inferenceId}-ci`, score: 1.0 });
  await new Grad().feedback.record({ inferenceId, score: 0.0, expectedOutput: humanFix ? { content: humanFix } : undefined });
};

export const deployArtifact = async () => {
  const grad = new Grad();
  const artifact = await grad.artifacts.get("fast-diff-merge@2026-11-26-1");
  await artifact.deploy();
};

export const evaluations = async () => {
  const grad = new Grad();
  const evalDs = await grad.datasets.get("sql-eval-holdout");
  const rubric = new Rubric([
    // docs: validators.sql() (no SQL parser ships with the TS SDK; use a local function or the server's validators)
    new Scorer("valid_json", { weight: 0.3, fn: validators.json() }),
    new Judge({ name: "correct_query", model: "anthropic/claude-sonnet", prompt: "Verify the SQL answers the question.", weight: 0.7 }),
  ]);
  const ev = await grad.evals
    .create({ name: "sql-baseline-vs-rl", models: ["qwen/qwen3-8b", "sql-agent@latest"], dataset: evalDs, rubric, samples: 4, temperature: 0.7, baseline: "qwen/qwen3-8b" })
    .wait();
  console.log(ev.summaryTable());
  const hard = await (await ev.failures({ model: "sql-agent@latest", threshold: 0.8 })).toDataset("sql-hard-cases");
  console.log(await hard.count());
};

export const recipesPages = async () => {
  const grad = new Grad();
  const prompts = await grad.datasets.get("api-docs-qa-prompts");
  const cart = await grad.runs
    .create({ dataset: prompts, name: "api-docs-cartridge", recipe: recipes.cartridge({ model: "qwen/qwen3-8b", context: Context.fromFile("./api-docs-bundle.md") }) })
    .wait();
  console.log(cart.artifact.id, cart.evalReport);
  const triage = await grad.runs.create({ dataset: "ticket-triage", name: "ticket-triage", recipe: recipes.decisionModel() }).wait();
  console.log(triage.artifact.id);
  const sftArt = await grad.artifacts.get("fast-diff-merge@sft-v1");
  const dpo = await grad.runs.create({ dataset: "diff-merge-preferences", name: "fast-diff-merge", recipe: recipes.dpo({ model: sftArt }) }).wait();
  console.log(dpo.artifact.id, dpo.evalReport);
  await grad.runs.create({ dataset: "docs-retrieval-triplets", name: "docs-embedder", recipe: recipes.embedding() }).wait();
  const judge = new Judge({ name: "resolved", model: "qwen/qwen3-32b", prompt: "Did the answer resolve the ticket?" });
  await grad.runs.create({ dataset: "support-traces", name: "support-router", recipe: recipes.router({ models: ["qwen/qwen3-8b", "qwen/qwen3-32b"], rubric: judge }) }).wait();
  void new Scorer("correct", { fn: validators.numericMatch({ field: "answer" }) });
  const prompts2 = await grad.datasets.get("support-prompts");
  const distilled = await grad.runs
    .create({ dataset: prompts2, name: "support-4b-distilled", recipe: recipes.distill({ model: "qwen/qwen3-4b", teacher: "qwen/qwen3-32b" }) })
    .wait();
  console.log(distilled.artifact.id, distilled.evalReport);
  const pairsDs = await grad.datasets.get("sql-preferences");
  const verifier = await grad.runs.create({ dataset: pairsDs, name: "sql-verifier", recipe: recipes.rewardModel({ model: "qwen/qwen3-8b" }) }).wait();
  console.log(verifier.artifact.id, verifier.evalReport?.preferenceAccuracy);
};

export const trajectories = async () => {
  const grad = new Grad();
  const dataset = await grad.datasets.push("support-sft", [
    { messages: [{ role: "user", content: "How do I reset my password?" }, { role: "assistant", content: "Settings -> Security." }] },
  ]);
  console.log(await dataset.count());
  const traj = Trajectory.fromMessages(
    [
      { role: "user", content: "Merge these two diffs into one patch." },
      { role: "assistant", content: "--- a/app.py" },
    ],
    { sessionId: "pr_481" },
  );
  traj.scores.tests_passed = 1.0;
  await grad.datasets.push("diff-merge-gold", [traj]);
  const imported = await (await grad.datasets.create("support-prod")).importFile("./traces.parquet").wait();
  console.log(imported.importedCount, imported.droppedCount, imported.detectedScores);
};
