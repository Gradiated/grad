import { describe, expect, it } from "vitest";

import { EnvWorkerHub } from "../src/env-hub.js";

describe("EnvWorkerHub", () => {
  it("registers workers, dispatches and claims tasks, and enforces worker ownership", async () => {
    const hub = new EnvWorkerHub(10_000);
    const worker = hub.register("ws1", "repo-ci", "wrk_1", 4);
    expect(worker.name).toBe("repo-ci");
    expect(hub.listActiveWorkers("ws1", "repo-ci")).toHaveLength(1);

    const dispatched = hub.dispatch({
      workspaceId: "ws1",
      envName: "repo-ci",
      task: { repo: "acme/app", issue: 42 },
      modelId: "qwen/qwen3-8b",
      timeoutS: 60,
    });
    expect(dispatched.status).toBe("queued");

    const claimed = await hub.claim("ws1", "repo-ci", "wrk_1", 0);
    expect(claimed?.id).toBe(dispatched.id);
    expect(claimed?.status).toBe("claimed");

    // Wrong worker cannot complete someone else's claimed task.
    const wrongWorker = hub.complete("ws1", dispatched.id, {
      worker_id: "wrk_other",
      score: 1,
      scores: { pass: 1 },
    });
    expect(wrongWorker).toBeNull();

    // Right worker completes cleanly.
    const done = hub.complete("ws1", dispatched.id, {
      worker_id: "wrk_1",
      score: 0.95,
      scores: { tests: 1, lint: 0.9 },
      trajectory: { steps: 3 },
    });
    expect(done?.status).toBe("completed");
    expect(done?.result?.score).toBe(0.95);
  });

  it("wakes up a long-polling worker when a task is dispatched", async () => {
    const hub = new EnvWorkerHub();
    hub.register("ws1", "browser-env", "wrk_poll", 1);

    const claimPromise = hub.claim("ws1", "browser-env", "wrk_poll", 1000);
    const dispatched = hub.dispatch({
      workspaceId: "ws1",
      envName: "browser-env",
      task: { url: "https://example.com" },
      modelId: "qwen/qwen3-8b",
      timeoutS: 30,
    });

    const claimed = await claimPromise;
    expect(claimed?.id).toBe(dispatched.id);
    expect(claimed?.worker_id).toBe("wrk_poll");
  });

  it("caps queued tasks per workspace with 429", () => {
    const hub = new EnvWorkerHub(60_000, 2000, 2);
    const dispatch = () =>
      hub.dispatch({
        workspaceId: "ws",
        envName: "e",
        task: {},
        modelId: "m",
        timeoutS: 5,
      });
    dispatch();
    dispatch();
    expect(dispatch).toThrow(/queued environment tasks/);
    expect(() =>
      hub.dispatch({
        workspaceId: "other",
        envName: "e",
        task: {},
        modelId: "m",
        timeoutS: 5,
      }),
    ).not.toThrow();
  });

  it("drops a long-poll waiter when the client aborts so the task goes to a live worker", async () => {
    const hub = new EnvWorkerHub();
    const abort = new AbortController();
    const dead = hub.claim("ws", "e", "dead", 10_000, abort.signal);
    abort.abort();
    expect(await dead).toBeNull();
    const live = hub.claim("ws", "e", "live", 10_000);
    const task = hub.dispatch({
      workspaceId: "ws",
      envName: "e",
      task: {},
      modelId: "m",
      timeoutS: 5,
    });
    expect((await live)?.id).toBe(task.id);
    expect(hub.getTask("ws", task.id)?.worker_id).toBe("live");
  });
});
