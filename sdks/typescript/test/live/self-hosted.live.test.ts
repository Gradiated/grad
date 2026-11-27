// Live: the docs' TypeScript snippets, nearly verbatim, against a real grad-server
// (tests/harness/stack.ts, self-hosted, reference trainer worker).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AuthenticationError,
  ConflictError,
  Grad,
  PermissionDeniedError,
  Rubric,
  Run,
  Scorer,
  Trajectory,
  loggers,
  recipes,
  validators,
  type MetricPoint,
} from "../../src/index.js";
import { liveSkipReason, scratchHome, Stack } from "./stack.js";

const skip = liveSkipReason("reference");
if (skip) console.warn(`skipping self-hosted live tests: ${skip}`);

const writeTraces = (file: string, n: number) =>
  writeFileSync(
    file,
    Array.from({ length: n }, (_, i) =>
      JSON.stringify({
        session_id: `s${i}`,
        messages: [
          { role: "user", content: `Reset my password ${i}` },
          { role: "assistant", content: "Open Settings, then Security." },
        ],
      }),
    ).join("\n") + "\n",
  );

describe.skipIf(skip !== undefined)("live: self-hosted with the reference worker", () => {
  let stack: Stack;
  let home: ReturnType<typeof scratchHome>;
  let grad: Grad;

  beforeAll(async () => {
    stack = await Stack.start({ worker: "reference" });
    home = scratchHome("self");
    grad = new Grad({ apiKey: stack.apiKey, baseURL: stack.baseURL });
  });

  afterAll(async () => {
    await stack?.stop();
    home?.cleanup();
  });

  it("quickstart: create, importFile().wait(), plan, train with .wait(), metrics, download, provenance", async () => {
    const traces = path.join(home.dir, "support_traces.jsonl");
    writeTraces(traces, 40);

    const dataset = await grad.datasets.create("support-prod");
    const imported = await dataset.importFile(traces).wait();
    expect(imported.status).toBe("completed");
    expect(imported.importedCount).toBe(40);
    expect(await dataset.count()).toBe(40);
    await expect(grad.datasets.create("support-prod")).rejects.toBeInstanceOf(ConflictError);

    const recipe = recipes.sft({ model: "test/tiny-qwen3", batchSize: 8 });
    const plan = await grad.runs.plan({ dataset, name: "support-sft", recipe });
    expect(plan.estimatedSteps).toBeGreaterThanOrEqual(1);
    expect(plan.resolvedRecipe.recipeKind).toBe("sft");

    const metrics: MetricPoint[] = [];
    const statuses: string[] = [];
    const run = await grad.runs
      .create({ dataset, name: "support-sft", recipe, maxCostUsd: 5 })
      .wait({ onMetric: (m) => void metrics.push(m), onStatus: (s) => void statuses.push(s), timeoutMs: 240_000 });
    expect(run).toBeInstanceOf(Run);
    expect(run.status).toBe("completed");
    expect(statuses.at(-1)).toBe("completed");
    expect(metrics.length).toBeGreaterThan(0);
    expect(run.artifact.name).toBe("support-sft");

    const pages: MetricPoint[] = [];
    for await (const m of run.metrics()) pages.push(m);
    expect(pages.map((m) => m.step)).toEqual(metrics.map((m) => m.step));

    const checkpoints = await run.checkpoints();
    expect(checkpoints.length).toBeGreaterThan(0);

    const result = await run.download(home.dir);
    const bytes = readFileSync(result.path);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(run.artifact.sha256);
    expect(result.sizeBytes).toBe(bytes.byteLength);

    expect(run.artifact.provenance).toEqual({ source: "run", runId: run.id, uploader: null, uri: null });

    const latest = await grad.artifacts.get("support-sft@latest");
    expect(latest.id).toBe(run.artifact.id);
    const listed = [];
    for await (const r of grad.runs.list({ limit: 1 })) listed.push(r.id);
    expect(listed).toContain(run.id);
  });

  it("push, trajectories, records paging and render", async () => {
    const dataset = await grad.datasets.push("support-sft-push", [
      { messages: [{ role: "user", content: "How do I reset my password?" }, { role: "assistant", content: "Settings -> Security." }] },
    ]);
    expect(await dataset.count()).toBe(1);
    const traj = Trajectory.fromMessages(
      [
        { role: "user", content: "Merge these two diffs into one patch." },
        { role: "assistant", content: "--- a/app.py" },
      ],
      { sessionId: "pr_481" },
    );
    traj.scores.tests_passed = 1.0;
    await grad.datasets.push("support-sft-push", [traj, traj, traj], { batchSize: 2 });
    const records = [];
    for await (const r of dataset.records({ limit: 2 })) records.push(r);
    expect(records).toHaveLength(4);
    const rendered = await dataset.render({ limit: 1 });
    expect(rendered).toBeTruthy();
  });

  it("evals: server validators plus a local scorer, summary table, failures to a dataset", async () => {
    const holdout = path.join(home.dir, "holdout.jsonl");
    writeTraces(holdout, 4);
    const dataset = await grad.datasets.create("support-eval");
    await dataset.importFile(holdout).wait();

    const rubric = new Rubric([
      new Scorer("nonempty", { weight: 0.5, fn: validators.nonEmpty() }),
      new Scorer("mentions_settings", { weight: 0.5, fn: (output) => (output ?? "").includes("Settings") }),
    ]);
    const plan = await grad.evals.plan({ name: "smoke", models: ["qwen/qwen3-8b"], dataset, rubric, limit: 4 });
    expect(plan.localScorers).toEqual(["mentions_settings"]);
    const ev = await grad.evals
      .create({ name: "smoke", models: ["qwen/qwen3-8b"], dataset, rubric, limit: 4, passThreshold: 0.9 })
      .wait({ timeoutMs: 120_000 });
    expect(ev.status).toBe("completed");
    expect(ev.summaryTable()).toContain("qwen/qwen3-8b");
    const results = await ev.results().all();
    expect(results.length).toBeGreaterThan(0);
    const failures = await ev.failures({ threshold: 0.9 });
    if (failures.length > 0) {
      const hard = await failures.toDataset("support-hard-cases");
      expect(await hard.count()).toBeGreaterThan(0);
    }
  });

  it("scores a dataset, then filters on the scores and with a local function", async () => {
    const dataset = await grad.datasets.push("support-logs-ts", [
      { id: "short", messages: [{ role: "user", content: "Reset?" }, { role: "assistant", content: "Settings." }] },
      { id: "long", messages: [{ role: "user", content: "Export?" }, { role: "assistant", content: "Open Billing, then Export, then pick CSV." }] },
    ]);
    const rubric = new Rubric([
      new Scorer("mentions_settings", { fn: validators.regex("Settings") }),
      new Scorer("brief", { fn: (output) => (output ?? "").length < 20 }),
    ]);
    const scored = await dataset.score(rubric).wait({ timeoutMs: 120_000 });
    expect(scored.version).toBe(dataset.version + 1);
    const records = await scored.records().all();
    expect(records.map((r) => r.scores)).toEqual([
      { mentions_settings: 1, brief: 1 },
      { mentions_settings: 0, brief: 0 },
    ]);
    const passing = await scored.filter({ scores: { brief: ">=0.8" } });
    expect(await passing.count()).toBe(1);
    expect((await scored.filter({ scores: { brief: ">=0.8" } })).id).toBe(passing.id);
    const exports = await scored.filter((r) => JSON.stringify(r.messages).includes("Export"));
    expect((await exports.records().all()).map((r) => r.id)).toEqual(["long"]);
  });

  it("plans checkpoint evals and loggers", async () => {
    await grad.datasets.push("ts-holdout", [{ messages: [{ role: "user", content: "Reset?" }, { role: "assistant", content: "Settings." }] }]);
    await grad.datasets.push("ts-train", [{ messages: [{ role: "user", content: "Reset?" }, { role: "assistant", content: "Settings." }] }]);
    const plan = await grad.runs.plan({
      dataset: "ts-train",
      name: "tracked",
      recipe: recipes.sft({ model: "test/tiny-qwen3", evals: ["ts-holdout"], loggers: [loggers.wandb({ project: "p", secret: "wandb-key" })] }),
    });
    expect(plan.resolvedConfig.checkpointEvals).toEqual([
      { name: "ts-holdout", dataset: "ts-holdout", datasetVersion: 1, rubric: [{ name: "non_empty", kind: "validator", weight: 1, validator: "non_empty" }], limit: null },
    ]);
    expect(plan.warnings.join("\n")).toContain("wandb-key");
  });

  it("queues a pinned benchmark import", async () => {
    const gsm8k = await grad.datasets.fromBenchmark("gsm8k", { limit: 5, wait: false });
    expect(gsm8k.name).toBe("gsm8k-5");
    const jobs = await grad.imports.list().all();
    const job = jobs.find((j) => j.dataset === "gsm8k-5");
    expect(job?.source).toMatchObject({ kind: "hf", repo: "openai/gsm8k", split: "test", benchmark: "gsm8k", limit: 5 });
    expect(String(job?.source.revision)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("retries a POST whose response was lost and gets the server's replay", async () => {
    // The fault proxy lets the server commit the first attempt, then answers 503. The
    // retry carries the same Idempotency-Key, so the server replays 201 instead of 409.
    const flaky = new Grad({ apiKey: stack.apiKey, baseURL: stack.info.fault_url });
    const created = await flaky.datasets.create("ts-idempotent-create");
    expect(created.name).toBe("ts-idempotent-create");
    const stats = (await (await fetch(`${stack.info.fault_url}/__fault/stats`)).json()) as { dropped: number; replayed: number };
    expect(stats.dropped).toBeGreaterThanOrEqual(1);
    expect(stats.replayed).toBeGreaterThanOrEqual(1);
    await expect(grad.datasets.create("ts-idempotent-create")).rejects.toBeInstanceOf(ConflictError);
  });

  it("scoped keys and authentication errors", async () => {
    const key = await grad.keys.create({ name: "ci", scopes: ["runs:read"] });
    expect(key.secret).toMatch(/^grad_/);
    const ci = new Grad({ apiKey: key.secret, baseURL: stack.baseURL });
    await expect(ci.datasets.push("x", [{ messages: [{ role: "user", content: "hi" }] }])).rejects.toBeInstanceOf(PermissionDeniedError);
    await ci.runs.list();
    const keys = await grad.keys.list().all();
    expect(keys.map((k) => k.id)).toContain(key.key.id);
    await grad.keys.revoke(key.key.id);
    await expect(ci.runs.list()).rejects.toBeInstanceOf(AuthenticationError);
    await expect(new Grad({ apiKey: "grad_not_a_key", baseURL: stack.baseURL }).models.list()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("reads GRADIATED_* env vars and the `grad login` config file", async () => {
    const saved = { ...process.env };
    try {
      process.env.GRADIATED_API_KEY = stack.apiKey;
      process.env.GRADIATED_BASE_URL = stack.baseURL;
      expect((await new Grad().models.list()).some((m) => m.id === "test/tiny-qwen3")).toBe(true);

      delete process.env.GRADIATED_API_KEY;
      delete process.env.GRADIATED_BASE_URL;
      process.env.XDG_CONFIG_HOME = path.join(home.dir, "xdg");
      const { mkdirSync } = await import("node:fs");
      mkdirSync(path.join(home.dir, "xdg", "gradiated"), { recursive: true });
      writeFileSync(
        path.join(home.dir, "xdg", "gradiated", "config.json"),
        JSON.stringify({ profiles: { default: { base_url: stack.baseURL, api_key: stack.apiKey } } }),
      );
      const fromFile = new Grad();
      expect(await fromFile.config()).toEqual({ baseURL: stack.baseURL, apiKeySource: "config" });
      expect((await fromFile.models.list()).length).toBeGreaterThan(0);
    } finally {
      process.env = saved;
    }
  });
});
