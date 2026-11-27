import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createModelCatalog } from "../src/catalog.js";
import { resolveContinuation } from "../src/continued-training.js";
import { RecipeSpecSchema, type Artifact } from "../src/contracts.js";
import { ApiError } from "../src/errors.js";
import { makeTestApp, TINY_MODELS_JSON, type TestApp } from "./fixtures/app.js";
import { createSftRun, FakeWorker, sha256Hex } from "./fixtures/worker.js";

const PAIRS = Array.from({ length: 12 }, (_, i) => ({
  id: `p${i}`,
  prompt: `question ${i}`,
  chosen: `good ${i}`,
  rejected: `bad ${i}`,
}));

const LORA_MANIFEST = { adapter: { kind: "lora", rank: 8, alpha: 16 } };

describe("continued training from an artifact", () => {
  let t: TestApp;
  let worker: FakeWorker;

  beforeEach(async () => {
    t = await makeTestApp();
    worker = new FakeWorker(t);
  });

  afterEach(async () => {
    await t.close();
  });

  /** Trains an SFT run through the worker protocol and returns its artifact. */
  const sftArtifact = async (
    body: Record<string, unknown> = {},
  ): Promise<Artifact> => {
    await createSftRun(t);
    const job = await worker.claim();
    const done = await worker.complete(
      job!,
      {
        status: "completed",
        format: "peft_lora",
        tokens_processed: 10,
        manifest: LORA_MANIFEST,
        ...body,
      },
      "sft-adapter-bundle",
    );
    expect(done.status).toBe(200);

    return done.body.artifact as unknown as Artifact;
  };

  const planDpo = (recipe: Record<string, unknown>) =>
    t.json<Record<string, unknown> & { resolved_config: Record<string, any> }>(
      "/v1/runs/plan",
      {
        body: {
          dataset: "prefs",
          name: "support-dpo",
          recipe: { kind: "dpo", ...recipe },
        },
      },
    );

  it("plans from the artifact's base model and adapter and ships it to the worker", async () => {
    const artifact = await sftArtifact();
    await t.json("/v1/datasets/prefs/records", { body: { records: PAIRS } });

    const plan = await planDpo({ model: "support-sft@latest" });
    expect(plan.status).toBe(200);
    expect(plan.body.resolved_config).toMatchObject({
      model: "test/tiny-qwen3",
      adapter: { kind: "lora", rank: 8, alpha: 16, merge_on_export: false },
      base_artifact: {
        id: artifact.id,
        recipe_kind: "sft",
        format: "peft_lora",
        sha256: sha256Hex("sft-adapter-bundle"),
      },
    });
    expect(plan.body.resolved_config.lr_source).toMatch(/calibrated/);

    const created = await t.json<{ id: string }>("/v1/runs", {
      body: {
        dataset: "prefs",
        name: "support-dpo",
        recipe: { kind: "dpo", model: artifact.id, beta: 0.3 },
      },
    });
    expect(created.status).toBe(202);

    const job = await worker.claim();
    expect(job?.run?.id).toBe(created.body.id);
    const base = (job as unknown as { base: Record<string, string> }).base;
    expect(base).toMatchObject({
      artifact_id: artifact.id,
      sha256: sha256Hex("sft-adapter-bundle"),
    });
    const bytes = await t.request(base.download_url ?? "");
    expect(await bytes.text()).toBe("sft-adapter-bundle");

    const fresh = await createSftRun(t, { dataset: "more", name: "fresh" });
    expect(fresh.resolved_config).toMatchObject({ base_artifact: null });
  });

  it("rejects artifacts it cannot continue with a clear 422", async () => {
    await sftArtifact();
    await t.json("/v1/datasets/prefs/records", { body: { records: PAIRS } });

    const missing = await planDpo({ model: "nope@latest" });
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ code: "unknown_model" });

    const conflict = await planDpo({
      model: "support-sft@latest",
      adapter: { kind: "lora", rank: 32 },
    });
    expect(conflict.body).toMatchObject({ code: "adapter_conflict" });

    const merged = await planDpo({
      model: "support-sft@latest",
      adapter: { kind: "lora", rank: 8, alpha: 16, merge_on_export: true },
    });
    expect(merged.body.resolved_config).toMatchObject({
      adapter: { merge_on_export: true },
    });

    const router = await t.json("/v1/runs/plan", {
      body: {
        dataset: "prefs",
        name: "r",
        recipe: { kind: "router", model: "support-sft@latest" },
      },
    });
    expect(router.body).toMatchObject({
      code: "continued_training_unsupported",
    });
  });

  describe("chained runs (depends_on)", () => {
    const DEFAULT_LORA = { adapter: { kind: "lora", rank: 32, alpha: 32 } };

    const chain = async (
      dependsOn: string,
      recipe: Record<string, unknown> = { kind: "dpo" },
      dataset = "prefs",
    ) =>
      t.json<Record<string, any> & { id: string }>("/v1/runs", {
        body: { dataset, name: "chained", recipe, depends_on: dependsOn },
      });

    const getRun = async (id: string) =>
      (await t.json<Record<string, any>>(`/v1/runs/${id}`)).body;

    beforeEach(async () => {
      await t.json("/v1/datasets/prefs/records", { body: { records: PAIRS } });
    });

    it("waits for the dependency, then starts from its artifact", async () => {
      const sft = await createSftRun(t);
      const dpo = await chain(sft.id);
      expect(dpo.status).toBe(202);
      expect(dpo.body).toMatchObject({ status: "queued", depends_on: sft.id });
      expect(dpo.body.resolved_config).toMatchObject({
        model: "test/tiny-qwen3",
        adapter: { kind: "lora", rank: 32, alpha: 32 },
        base_artifact: null,
      });

      const job = await worker.claim();
      expect(job?.id).toBe(sft.id);
      expect(await new FakeWorker(t, "worker-2").claim()).toBeNull();
      const queue = await worker.call<{ queued: number }>(
        "/v1/trainer-jobs/queue",
        undefined,
        "GET",
      );
      expect(queue.body.queued).toBe(0);

      const done = await worker.complete(
        job!,
        { status: "completed", manifest: DEFAULT_LORA, tokens_processed: 1 },
        "sft-bundle",
      );
      const artifact = done.body.artifact as { id: string };
      expect((await getRun(dpo.body.id)).resolved_config.base_artifact).toEqual(
        {
          id: artifact.id,
          recipe_kind: "sft",
          format: "peft_lora",
          sha256: sha256Hex("sft-bundle"),
        },
      );
      const next = await worker.claim();
      expect(next?.id).toBe(dpo.body.id);
      expect(
        (next as unknown as { base: { artifact_id: string } }).base.artifact_id,
      ).toBe(artifact.id);
      expect(next?.run?.resolved_config).toMatchObject({
        base_artifact: { id: artifact.id },
      });

      // Chaining onto a finished run resolves its artifact right away.
      const late = await chain(sft.id);
      expect(late.body.resolved_config.base_artifact).toMatchObject({
        id: artifact.id,
      });
    });

    it("cancels the whole chain when a dependency fails, and resumes it again", async () => {
      const sft = await createSftRun(t);
      const dpo = await chain(sft.id);
      const third = await chain(dpo.body.id);
      const job = await worker.claim();
      await worker.complete(job!, { status: "failed", error: "boom" });

      for (const id of [dpo.body.id, third.body.id]) {
        const run = await getRun(id);
        expect(run.status).toBe("cancelled");
        expect(run.error).toMatch(/dependency run .* ended (failed|cancelled)/);
      }
      expect((await chain(sft.id)).body).toMatchObject({
        code: "dependency_failed",
      });
      const blocked = await t.json(`/v1/runs/${dpo.body.id}/resume`, {
        body: {},
      });
      expect(blocked.body).toMatchObject({ code: "dependency_not_viable" });

      expect(
        (await t.json(`/v1/runs/${sft.id}/resume`, { body: {} })).status,
      ).toBe(200);
      const resumed = await t.json<Record<string, any>>(
        `/v1/runs/${dpo.body.id}/resume`,
        { body: {} },
      );
      expect(resumed.body).toMatchObject({ status: "queued" });
      const retry = await worker.claim();
      expect(retry?.id).toBe(sft.id);
      await worker.complete(
        retry!,
        { status: "completed", manifest: DEFAULT_LORA },
        "sft-2",
      );
      expect(
        (await getRun(dpo.body.id)).resolved_config.base_artifact,
      ).toMatchObject({ sha256: sha256Hex("sft-2") });
    });

    it("cancels dependents of a cancelled queued run and of a non-continuable artifact", async () => {
      const sft = await createSftRun(t);
      const dpo = await chain(sft.id);
      expect(
        (await t.json(`/v1/runs/${sft.id}/cancel`, { body: {} })).status,
      ).toBe(200);
      expect((await getRun(dpo.body.id)).status).toBe("cancelled");

      const other = await createSftRun(t, { dataset: "d2", name: "other" });
      const follower = await chain(other.id);
      const job = await worker.claim();
      await worker.complete(
        job!,
        { status: "completed", format: "reference", manifest: DEFAULT_LORA },
        "ref-bundle",
      );
      const cancelled = await getRun(follower.body.id);
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.error).toMatch(/format 'reference'/);
    });

    it("validates the chain at plan time", async () => {
      const sft = await createSftRun(t);
      expect(
        (await chain(sft.id, { kind: "dpo", model: "test/tiny-qwen3" })).body,
      ).toMatchObject({ code: "depends_on_model_conflict" });
      expect((await chain("run_missing")).body).toMatchObject({
        code: "unknown_dependency",
      });
      expect(
        (
          await chain(sft.id, {
            kind: "router",
          })
        ).body,
      ).toMatchObject({ code: "continued_training_unsupported" });
    });
  });

  describe("resolveContinuation", () => {
    const catalog = createModelCatalog(TINY_MODELS_JSON);
    const artifact = (over: Partial<Artifact> = {}): Artifact => ({
      id: "a@2026-11-27-1",
      workspace_id: "ws",
      name: "a",
      version: "2026-11-27-1",
      run_id: null,
      checkpoint_id: null,
      base_model: "test/tiny-qwen3",
      recipe_kind: "sft",
      format: "peft_lora",
      sha256: "0".repeat(64),
      size_bytes: 1,
      manifest: LORA_MANIFEST,
      eval_report: null,
      created_at: "2026-11-27T00:00:00Z",
      ...over,
    });
    const recipe = RecipeSpecSchema.parse({ kind: "sft", model: "a@latest" });
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as ApiError).code;
      }
      return null;
    };

    it("needs a LoRA artifact on a catalog model with recorded adapter settings", () => {
      expect(resolveContinuation(recipe, artifact(), catalog).model.id).toBe(
        "test/tiny-qwen3",
      );
      expect(
        code(() =>
          resolveContinuation(
            recipe,
            artifact({ format: "merged_safetensors" }),
            catalog,
          ),
        ),
      ).toBe("continued_training_unsupported");
      expect(
        code(() =>
          resolveContinuation(
            recipe,
            artifact({ base_model: "gone/model" }),
            catalog,
          ),
        ),
      ).toBe("unknown_model");
      expect(
        code(() =>
          resolveContinuation(recipe, artifact({ manifest: {} }), catalog),
        ),
      ).toBe("continued_training_unsupported");
    });
  });
});
