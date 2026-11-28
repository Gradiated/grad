import { describe, expect, it } from "vitest";

import type { TrainerJob } from "../src/contracts.js";
import { InferenceError } from "../src/services/evals/inference.js";
import type { WorkerClient } from "../src/worker/client.js";
import { createEvalWorker } from "../src/worker/eval-worker.js";

const job = (id: string): TrainerJob =>
  ({
    id,
    kind: "eval",
    attempt: 1,
    dataset: { download_url: `/v1/trainer-jobs/${id}/dataset` },
    eval: {
      id,
      workspace_id: "ws",
      name: id,
      mode: "generate",
      models: ["m"],
      model_targets: { m: { inference_model: "m" } },
      judge_targets: {},
      rubric: [],
      samples: 1,
      temperature: 0,
      max_tokens: 8,
      limit: null,
      done: {},
    },
  }) as unknown as TrainerJob;

describe("the eval worker, against a fake grad-server", () => {
  it("never carry an attempt's unstored calls into the next eval", async () => {
    const jobs = [job("eval_down"), job("eval_up")];
    const posted: Array<{ id: string; calls: unknown }> = [];
    const client = {
      claim: async () => jobs.shift() ?? null,
      heartbeat: async () => ({ should_stop: false }),
      datasetLines: async function* () {
        for (let i = 0; i < 3; i += 1) {
          yield JSON.stringify({
            id: `r${i}`,
            messages: [{ role: "user", content: `q${i}` }],
          });
        }
      },
      postOutputs: async (ref: { id: string }, body: { calls?: unknown }) => {
        posted.push({ id: ref.id, calls: body.calls });
        return { accepted: 1, generated: 1, should_stop: false };
      },
      complete: async () => ({}),
    } as unknown as WorkerClient;
    // The first eval's endpoint is down through the whole outage wait (its
    // calls store nothing); the second one's answers.
    const worker = createEvalWorker({
      client,
      inference: {
        models: {
          complete: async (input) => {
            if (input.evalId === "eval_down") {
              throw new InferenceError("down", "unreachable", true);
            }
            return {
              text: "a",
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            } as never;
          },
        },
        judge: { complete: async () => ({}) as never },
      },
      regex: {} as never,
      concurrency: 1,
      outageRetryMs: 1,
      outageMaxMs: 20,
    });
    expect(await worker.drain()).toBe(2);
    const calls = posted
      .filter((p) => p.id === "eval_up")
      .map((p) => p.calls as { model_ok: number; model_error: number });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.reduce((n, c) => n + c.model_error, 0)).toBe(0);
    expect(calls.reduce((n, c) => n + c.model_ok, 0)).toBe(3);
  });

  it("a stop during the dataset download hands the eval back at once", async () => {
    // A large version downloads for minutes: the stop must not wait for it
    // (the pod's grace is 60 s; past it, the attempt is lost to its lease).
    const completes: unknown[] = [];
    let sent = 0;
    const client = {
      claim: async () => (sent === 0 ? job("eval_big") : null),
      heartbeat: async () => ({ should_stop: false }),
      datasetLines: async function* () {
        for (;;) {
          sent += 1;
          await new Promise((r) => setTimeout(r, 1));
          yield JSON.stringify({ id: `r${sent}`, messages: [] });
        }
      },
      postOutputs: async () => ({ accepted: 0, generated: 0 }),
      complete: async (_ref: unknown, body: unknown) => {
        completes.push(body);
        return {};
      },
    } as unknown as WorkerClient;
    const worker = createEvalWorker({
      client,
      inference: {
        models: { complete: async () => ({}) as never },
        judge: { complete: async () => ({}) as never },
      },
      regex: {} as never,
      concurrency: 1,
    });
    const drained = worker.drain();
    while (sent < 10) await new Promise((r) => setTimeout(r, 5));
    const started = Date.now();
    await worker.stop();
    expect(await drained).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(completes).toEqual([
      { status: "abandoned", reason: "compute_reclaimed" },
    ]);
  });
});
