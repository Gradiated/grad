import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { createSecretsCipher } from "../src/secrets.js";

import { makeTestApp } from "./fixtures/app.js";
import {
  makeEvalHarness,
  qaRecords,
  seedDataset,
  type EvalHarness,
} from "./fixtures/evals.js";
import { evalReport } from "./fixtures/eval-report.js";
import { FakeWorker, sftRecords } from "./fixtures/worker.js";

type Json = Record<string, unknown> & { id?: string; code?: string };

const RUBRIC = [{ name: "says_answer", kind: "regex", pattern: "answer" }];

describe("recipe evals= on checkpoints", () => {
  let h: EvalHarness;

  afterEach(async () => {
    await h.close();
  });

  const startRun = async (evals: unknown[], loggers?: unknown[]) => {
    await seedDataset(h.t, "support", sftRecords(20) as never);
    await seedDataset(h.t, "holdout", qaRecords(3));

    return h.t.json<Json & { resolved_config: Record<string, unknown> }>(
      "/v1/runs",
      {
        body: {
          dataset: "support",
          name: "support-sft",
          recipe: {
            kind: "sft",
            model: "test/tiny-qwen3",
            evals,
            ...(loggers ? { loggers } : {}),
          },
        },
      },
    );
  };

  it("pins the evals, scores each servable checkpoint and reports the results", async () => {
    h = await makeEvalHarness();
    const plan = await h.t.json<{ warnings: string[] }>("/v1/runs/plan", {
      body: {
        dataset: "support",
        name: "x",
        recipe: {
          kind: "sft",
          model: "test/tiny-qwen3",
          evals: [{ dataset: "holdout", rubric: RUBRIC }],
        },
      },
    });
    expect(plan.status).toBe(404); // the datasets don't exist yet

    const run = await startRun(
      [{ dataset: "holdout", rubric: RUBRIC, limit: 2 }],
      [{ kind: "mlflow", tracking_uri: "http://mlflow.internal:5000" }],
    );
    expect(run.status).toBe(202);
    expect(run.body.resolved_config.checkpoint_evals).toEqual([
      {
        name: "holdout",
        dataset: "holdout",
        dataset_version: 1,
        rubric: [{ ...RUBRIC[0], weight: 1 }],
        limit: 2,
      },
    ]);
    expect(run.body.resolved_config.loggers).toEqual([
      { kind: "mlflow", tracking_uri: "http://mlflow.internal:5000" },
    ]);
    expect(run.body.checkpoint_evals).toEqual([]);

    const worker = new FakeWorker(h.t);
    const job = (await worker.claim())!;
    const served = await worker.checkpoint(job, 2, "ckpt-2", {
      format: "peft_lora",
    });
    expect(served.status).toBe(201);
    // A retried registration queues nothing new.
    await worker.checkpoint(job, 2, "ckpt-2", { format: "peft_lora" });
    await worker.checkpoint(job, 4, "ckpt-4", { format: "reference" });

    await h.t.services.evals.drain();
    // The eval asked the inference endpoint for the checkpoint by id.
    const ckptId = String(served.body.id);
    expect(h.fake.requests.filter((r) => r.model === ckptId)).toHaveLength(2);

    const got = await h.t.json<{
      checkpoint_evals: Array<Record<string, unknown>>;
    }>(`/v1/runs/${run.body.id}`);
    const results = got.body.checkpoint_evals;
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.step === 2)).toMatchObject({
      name: "holdout",
      checkpoint_id: ckptId,
      status: "completed",
      score: 1,
      dataset_version: 1,
      error: null,
    });
    expect(results.find((r) => r.step === 4)).toMatchObject({
      status: "failed",
      eval_id: null,
      score: null,
    });
    expect(String(results.find((r) => r.step === 4)?.error)).toContain(
      "can't serve",
    );

    const evalId = String(results.find((r) => r.step === 2)?.eval_id);
    const ev = await h.t.json<Json>(`/v1/evals/${evalId}`);
    expect(ev.body).toMatchObject({ models: [ckptId], temperature: 0 });

    const events = await h.t.deps.store.jobs.listEvents(
      String(run.body.id),
      "checkpoint_eval:holdout",
      0,
      10,
    );
    expect(events.map((e) => e.step).sort()).toEqual([2, 4]);

    // The final eval report carries them too.
    await worker.complete(
      job,
      {
        status: "completed",
        tokens_processed: 100,
        manifest: {},
        eval_report: evalReport({}),
      },
      "artifact",
    );
    const done = await h.t.json<{
      eval_report: { checkpoint_evals?: unknown[] };
    }>(`/v1/runs/${run.body.id}`);
    expect(done.body.eval_report.checkpoint_evals).toHaveLength(2);
  });

  it("rejects code scorers, duplicate names and unservable setups", async () => {
    h = await makeEvalHarness();
    const code = await startRun([
      { dataset: "holdout", rubric: [{ name: "mine", kind: "code" }] },
    ]);
    expect(code.status).toBe(422);
    expect(code.body.code).toBe("checkpoint_eval_code_scorer");

    const dup = await h.t.json<Json>("/v1/runs/plan", {
      body: {
        dataset: "support",
        name: "x",
        recipe: {
          kind: "sft",
          model: "test/tiny-qwen3",
          evals: [{ dataset: "holdout" }, { dataset: "holdout" }],
        },
      },
    });
    expect(dup.body.code).toBe("duplicate_checkpoint_eval");

    const ok = await h.t.json<{ warnings: string[] }>("/v1/runs/plan", {
      body: {
        dataset: "support",
        name: "x",
        recipe: {
          kind: "sft",
          model: "test/tiny-qwen3",
          evals: [
            { dataset: "holdout" },
            { dataset: "holdout", name: "again" },
          ],
        },
      },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.warnings.join(" ")).toContain("recipe.evals run 2 eval(s)");

    const t = await makeTestApp();
    try {
      await seedDataset(t, "support", sftRecords(20) as never);
      await seedDataset(t, "holdout", qaRecords(3));
      const none = await t.json<Json>("/v1/runs/plan", {
        body: {
          dataset: "support",
          name: "x",
          recipe: {
            kind: "sft",
            model: "test/tiny-qwen3",
            evals: [{ dataset: "holdout" }],
          },
        },
      });
      expect(none.status).toBe(501);
      expect(none.body.code).toBe("inference_unavailable");
    } finally {
      await t.close();
    }
  });
});

describe("recipe loggers=", () => {
  const recipe = {
    kind: "sft",
    model: "test/tiny-qwen3",
    loggers: [
      { kind: "wandb", project: "support", secret: "wandb-key" },
      { kind: "wandb", project: "other", secret: "missing-key" },
      { kind: "mlflow", tracking_uri: "http://mlflow.internal:5000" },
    ],
  };

  it("hands the worker each logger with its secret, and warns about missing ones", async () => {
    const t = await makeTestApp({
      secrets: createSecretsCipher({ key: randomBytes(32).toString("base64") }),
    });
    try {
      await seedDataset(t, "support", sftRecords(20) as never);
      await t.json("/v1/secrets", {
        body: { name: "wandb-key", value: "wandb-secret-value" },
      });
      const plan = await t.json<{ warnings: string[] }>("/v1/runs/plan", {
        body: { dataset: "support", name: "x", recipe },
      });
      expect(plan.body.warnings.join("\n")).toContain(
        "no secret named 'missing-key'",
      );
      const run = await t.json<{ id: string; resolved_config: unknown }>(
        "/v1/runs",
        { body: { dataset: "support", name: "x", recipe } },
      );
      // The secret value never appears on the public run.
      expect(JSON.stringify(run.body)).not.toContain("wandb-secret-value");
      const job = (await new FakeWorker(t).claim()) as unknown as {
        loggers: unknown[];
      };
      expect(job.loggers).toEqual([
        { kind: "wandb", project: "support", api_key: "wandb-secret-value" },
        { kind: "mlflow", tracking_uri: "http://mlflow.internal:5000" },
      ]);
    } finally {
      await t.close();
    }
  });

  it("sends a logger's secret only to the secret's allowed hosts (r8 P1-2)", async () => {
    const t = await makeTestApp({
      secrets: createSecretsCipher({ key: randomBytes(32).toString("base64") }),
    });
    try {
      await seedDataset(t, "support", sftRecords(20) as never);
      await t.json("/v1/secrets", {
        body: { name: "hf-token", value: "hf_REAL_TOKEN" },
      });
      await t.json("/v1/secrets", {
        body: {
          name: "mlflow-token",
          value: "mlflow-secret",
          allowed_hosts: ["mlflow.internal:5000"],
        },
      });
      const exfil = {
        kind: "sft",
        model: "test/tiny-qwen3",
        loggers: [
          {
            kind: "mlflow",
            tracking_uri: "https://attacker.example",
            secret: "hf-token",
          },
        ],
      };
      const runsOnly = await t.mintKey("ws_a", ["runs:write"]);
      const denied = await t.json("/v1/runs", {
        token: runsOnly,
        body: { dataset: "support", name: "x", recipe: exfil },
      });
      expect(denied.status).toBe(403);
      const plan = await t.json("/v1/runs/plan", {
        body: { dataset: "support", name: "x", recipe: exfil },
      });
      expect([plan.status, plan.body.code]).toEqual([
        422,
        "secret_host_not_allowed",
      ]);

      const allowed = {
        ...exfil,
        loggers: [
          {
            kind: "mlflow",
            tracking_uri: "http://mlflow.internal:5000",
            secret: "mlflow-token",
          },
        ],
      };
      expect(
        (
          await t.json("/v1/runs", {
            body: { dataset: "support", name: "x", recipe: allowed },
          })
        ).status,
      ).toBe(202);
      // Re-bound before the claim: the worker gets the logger without the key.
      await t.json("/v1/secrets", {
        body: {
          name: "mlflow-token",
          value: "mlflow-secret",
          allowed_hosts: ["elsewhere.example"],
        },
      });
      const job = (await new FakeWorker(t).claim()) as unknown as {
        loggers: unknown[];
      };
      expect(JSON.stringify(job.loggers)).not.toContain("mlflow-secret");
    } finally {
      await t.close();
    }
  });

  it("warns when the server has no secrets key", async () => {
    const t = await makeTestApp();
    try {
      await seedDataset(t, "support", sftRecords(20) as never);
      const plan = await t.json<{ warnings: string[] }>("/v1/runs/plan", {
        body: { dataset: "support", name: "x", recipe },
      });
      expect(plan.body.warnings.join("\n")).toContain(
        "workspace secrets are not configured",
      );
      await t.json("/v1/runs", {
        body: { dataset: "support", name: "x", recipe },
      });
      const job = (await new FakeWorker(t).claim()) as unknown as {
        loggers: unknown[];
      };
      expect(job.loggers).toEqual([
        { kind: "mlflow", tracking_uri: "http://mlflow.internal:5000" },
      ]);
    } finally {
      await t.close();
    }
  });
});
