import { afterEach, describe, expect, it } from "vitest";

import {
  makeEvalHarness,
  qaRecords,
  seedDataset,
  type EvalHarness,
} from "./fixtures/evals.js";
import { createSftRun, FakeWorker } from "./fixtures/worker.js";

/**
 * One rule for every job kind: a completion status the kind doesn't have is a
 * 422 unsupported_completion and changes nothing (the worker still holds the
 * lease and can complete properly); a reclaim that made progress starts the
 * preemption count again wherever the next attempt resumes from it.
 */
describe("trainer-job completion protocol", () => {
  let h: EvalHarness;

  afterEach(async () => {
    await h.close();
  });

  it("refuses a status the job's kind doesn't have, for runs, evals and imports alike", async () => {
    h = await makeEvalHarness();
    await h.worker.close();
    const { t } = h;
    const worker = new FakeWorker(t);
    const refused = async (
      job: { id: string; attempt: number },
      status: string,
    ) => {
      const res = await worker.call(`/v1/trainer-jobs/${job.id}/complete`, {
        ...worker.ref(job),
        status,
      });
      expect([status, res.status, res.body.code]).toEqual([
        status,
        422,
        "unsupported_completion",
      ]);
    };

    await createSftRun(t);
    const run = (await worker.claim({ kinds: ["train"] }))!;
    await refused(run, "cancelled");
    expect((await t.json(`/v1/runs/${run.id}`)).body).toMatchObject({
      status: "running",
    });

    await seedDataset(t, "qa", qaRecords(2));
    const created = await t.json<{ id: string }>("/v1/evals", {
      body: { models: ["qwen/qwen3-8b"], dataset: "qa", name: "e" },
    });
    const ev = (await worker.claim({ kinds: ["eval"] }))!;
    expect(ev.id).toBe(created.body.id);
    for (const status of ["stopped_budget", "cancelled"]) {
      await refused(ev, status);
    }

    const imp = await t.json<{ id: string }>("/v1/datasets/support/imports", {
      body: { source: { kind: "hf", repo: "o/n" } },
    });
    const job = (await worker.claim({ kinds: ["import"] }))!;
    expect(job.id).toBe(imp.body.id);
    for (const status of ["stopped_budget", "cancelled"]) {
      await refused(job, status);
    }
    expect((await t.json(`/v1/imports/${job.id}`)).body).toMatchObject({
      status: "running",
    });

    // Still leased: the proper completion lands.
    const failed = await worker.call(`/v1/trainer-jobs/${job.id}/complete`, {
      ...worker.ref(job),
      status: "failed",
      error: "repo not found",
    });
    expect([failed.status, failed.body.status]).toEqual([200, "failed"]);
  });

  it("starts an eval's preemption count again when a reclaimed attempt kept outputs", async () => {
    h = await makeEvalHarness();
    await h.worker.close();
    const { t } = h;
    t.deps.settings.maxPreemptions = 2;
    await seedDataset(t, "qa", qaRecords(4));
    const created = await t.json("/v1/evals", {
      body: { models: ["qwen/qwen3-8b"], dataset: "qa", name: "reclaimed" },
    });
    expect(created.status).toBe(202);
    const worker = new FakeWorker(t);
    const reclaim = async (outputs: number) => {
      const job = (await worker.claim({ kinds: ["eval"] }))!;
      if (outputs > 0) {
        const res = await worker.call(`/v1/trainer-jobs/${job.id}/outputs`, {
          ...worker.ref(job),
          outputs: Array.from({ length: outputs }, (_, i) => ({
            model: "qwen/qwen3-8b",
            task_index: job.attempt - 1 + i,
            task_id: `q${job.attempt - 1 + i}`,
            sample_index: 0,
            record: {},
            input: [],
            output: "x",
            scores: {},
            error: null,
            prompt_tokens: 1,
            completion_tokens: 1,
          })),
        });
        expect(res.status).toBe(200);
      }
      const done = await worker.call<{ status: string }>(
        `/v1/trainer-jobs/${job.id}/complete`,
        {
          ...worker.ref(job),
          status: "abandoned",
          reason: "compute_reclaimed",
        },
      );
      return done.body.status;
    };

    // Each reclaim kept an output: the count restarts every time.
    for (let i = 0; i < 3; i += 1) expect(await reclaim(1)).toBe("queued");
    // Two in a row that saved nothing reach the cap of 2.
    expect(await reclaim(0)).toBe("queued");
    expect(await reclaim(0)).toBe("failed");
  });
});
