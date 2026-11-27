// Live: Gradiated Cloud mode (fake Cloud control plane + real grad-server).
// The torch worker trains a tiny distilled student and a reward model.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ArtifactImportFailedError, AuthenticationError, Grad, NotFoundError, recipes, Rubric, rollouts, Scorer, validators } from "../../src/index.js";
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

  /** The fake Cloud's control routes (keys, tokens, balances, ingested usage). */
  const control = async <T>(route: string, body: unknown = {}): Promise<T> => {
    const res = await fetch(`${stack.info.cloud_url}/_control/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    return (await res.json()) as T;
  };
  const setState = async (state: string) => {
    const ws = stack.info.workspace_id;
    const { token } = await control<{ token: string }>("service-token", { workspace_id: ws, scopes: ["workspaces:admin"] });
    return fetch(`${stack.info.internal_url}/internal/v1/workspaces/${ws}/state`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    });
  };
  const waitFor = async (check: () => Promise<boolean>, what: string) => {
    for (let i = 0; i < 300; i += 1) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  it("console JWT -> train -> eval on the gateway -> usage pushed -> suspend -> delete", async () => {
    const ws = stack.info.workspace_id;
    // The console calls with a short-lived JWT instead of a key.
    const { token } = await control<{ token: string }>("console-token", { workspace_id: ws, role: "member" });
    const grad = new Grad({ apiKey: token, baseURL: stack.baseURL });
    const dataset = await grad.datasets.push(
      "cloud-flow",
      Array.from({ length: 8 }, (_, i) => ({
        messages: [
          { role: "user" as const, content: `How do I export report ${i}?` },
          { role: "assistant" as const, content: "Reports -> Export." },
        ],
      })),
    );
    const run = await grad.runs.create({ dataset, name: "cloud-flow", recipe: recipes.sft({ model: "test/tiny-qwen3", batchSize: 4 }) }).wait({ timeoutMs: 240_000 });
    expect(run.status).toBe("completed");

    // Evals go through the gateway's eval lane and are billed there (the
    // reference worker's bundles are not servable, so the base model here;
    // artifacts as eval-only Versions are covered in server/api/test/cloud-evals.test.ts).
    const ev = await grad.evals
      .create({ name: "cloud-flow-eval", models: ["test/tiny-qwen3"], dataset, rubric: new Rubric([new Scorer("nonempty", { fn: validators.nonEmpty() })]), limit: 2 })
      .wait({ timeoutMs: 120_000 });
    expect(ev.status).toBe("completed");
    const evalRows = await grad.usage.list({ evalId: ev.id }).all();
    expect(evalRows.length).toBeGreaterThan(0);
    expect(evalRows.every((u) => u.billedBy === "gateway")).toBe(true);

    // The run's ledger rows reach billing ingest; eval rows never do.
    const runRows = await grad.usage.list({ runId: run.id, kind: "training" }).all();
    await waitFor(async () => {
      const { events } = await control<{ events: Array<{ event_id: string; subject_id: string }> }>("usage-events");
      return runRows.every((u) => events.some((e) => e.event_id === `training:${u.idempotencyKey}`));
    }, "usage events");
    const { events } = await control<{ events: Array<{ subject_id: string }> }>("usage-events");
    expect(events.some((e) => e.subject_id === ev.id)).toBe(false);

    // Suspended: no new work, until reinstated.
    expect((await setState("suspended")).status).toBe(200);
    await expect(grad.runs.create({ dataset, name: "cloud-flow-2", recipe: recipes.sft({ model: "test/tiny-qwen3", batchSize: 4 }) })).rejects.toMatchObject({ status: 403 });
    expect((await setState("active")).status).toBe(200);

    // Deleted: purged by the maintenance tick (no delay on the test stack).
    expect((await setState("deleted")).status).toBe(200);
    await waitFor(async () => (await grad.runs.list().all()).length === 0, "the purge");
    expect(await grad.datasets.list().all()).toEqual([]);
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

  it("uploads a LoRA as an artifact, refuses an invalid one, and continues training from it", async () => {
    const grad = new Grad({ apiKey: stack.apiKey, baseURL: stack.baseURL });
    const art = await grad.artifacts.upload(stack.tinyLora.valid, { base: "test/tiny-qwen3", name: "uploaded-lora" }).wait({ timeoutMs: 240_000 });
    expect(art.id).toMatch(/^uploaded-lora@\d{4}-\d{2}-\d{2}-\d+$/);
    expect(art.provenance.source).toBe("upload");
    expect(art.provenance.uploader).toBeTruthy();
    expect(art.manifest.format_version).toBe(2);
    const bad = await grad.artifacts.upload(stack.tinyLora.invalid, { base: "test/tiny-qwen3" }).wait({ timeoutMs: 240_000 }).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(ArtifactImportFailedError);
    expect((bad as ArtifactImportFailedError).status).toBe(422);
    expect((bad as Error).message).toContain("adapter_config.json: base_model_name_or_path is 'Qwen/Qwen3-8B'");
    const pairs = await grad.datasets.push(
      "upload-prefs",
      Array.from({ length: 12 }, (_, i) => ({ prompt: `Count users ${i}`, chosen: "SELECT count(*) FROM users;", rejected: "no idea" })),
    );
    const plan = await grad.runs.plan({ dataset: pairs, name: "dpo-from-upload", recipe: recipes.dpo({ model: art.id }) });
    expect(plan.resolvedConfig.baseArtifact?.id).toBe(art.id);

    // Publishing pins it (the product API on grad's internal listener):
    // a pinned artifact can't be deleted; serving resolves it to a presigned bundle.
    const ws = stack.info.workspace_id;
    const service = await fetch(`${stack.info.cloud_url}/_control/service-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: ws, scopes: ["artifacts:pin"] }),
    }).then((r) => r.json() as Promise<{ token: string }>);
    const internal = (method: string, suffix = "") =>
      fetch(`${stack.info.internal_url}/internal/v1/workspaces/${ws}/artifacts/${encodeURIComponent(art.id)}${suffix}`, {
        method,
        headers: { Authorization: `Bearer ${service.token}` },
      });
    const holder = "/pins/inference%3Aversion%3A7b1c";
    expect((await internal("PUT", holder)).status).toBe(201);
    const resolved = (await (await internal("GET")).json()) as { artifact: { sha256: string }; download_url: string };
    expect(resolved.artifact.sha256).toBe(art.sha256);
    expect((await fetch(resolved.download_url)).status).toBe(200);
    await expect(art.delete()).rejects.toMatchObject({ status: 409 });
    const link = await grad.artifacts.downloadUrl(art.id);
    expect(link.sha256).toBe(art.sha256);
    expect((await internal("DELETE", holder)).status).toBe(204);
    await art.delete();
    await expect(grad.artifacts.get(art.id)).rejects.toThrow();
    await expect(art.delete()).rejects.toBeInstanceOf(NotFoundError);
  });
});
