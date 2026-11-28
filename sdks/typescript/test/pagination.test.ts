import { describe, expect, it } from "vitest";

import { ApiClient, APIUserAbortError, GradUsageError, PaginationLoopError, Paginator } from "../src/index.js";
import { FakeServer, json, makeGrad, wire } from "./helpers.js";

const dataset = wire<Record<string, unknown>>("dataset.json");
const run = wire<{ id: string }>("run-completed.json");
const RUN = `/v1/runs/${run.id}`;

describe("pagination guards", () => {
  // Regression for the host OOM: a server that always returns the same cursor must not be followed forever.
  it("stops with PaginationLoopError when the server repeats a cursor", async () => {
    const server = new FakeServer(20).on("GET", "/v1/datasets", json({ data: [dataset], next_cursor: "same" }));
    const { grad } = makeGrad(server);
    const seen: unknown[] = [];
    const err = await (async () => {
      for await (const ds of grad.datasets.list()) seen.push(ds);
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaginationLoopError);
    expect((err as PaginationLoopError).cursor).toBe("same");
    expect((err as PaginationLoopError).code).toBe("pagination_loop");
    expect(server.calls).toHaveLength(2);
    expect(seen).toHaveLength(2);
    await expect(grad.datasets.list().all()).rejects.toBeInstanceOf(PaginationLoopError);
  });

  it("guards the collecting loops too: metrics, checkpoints, eval failures", async () => {
    const point = { run_id: run.id, step: 1, loss: 0.5, eval_metric: null, lr: 0.001, tokens: 10, elapsed_s: 1, created_at: "2026-11-27T00:00:00Z" };
    const server = new FakeServer(30)
      .on("GET", `${RUN}/metrics`, json({ data: [point], next_cursor: "m" }))
      .on("GET", `${RUN}/checkpoints`, json({ data: [wire<{ data: unknown[] }>("checkpoints.json").data[0]], next_cursor: "c" }))
      .on("GET", "/v1/evals/e/failures", json({ eval_id: "e", data: [{ task_id: "t", model: "m", score: 0, passed: false, sample_scores: [], judge_model: null, record: { messages: [] } }], next_cursor: "f" }));
    const { grad } = makeGrad(server);
    await expect((async () => {
      for await (const _ of grad.runs.metrics(run.id)) void _;
    })()).rejects.toBeInstanceOf(PaginationLoopError);
    await expect(grad.runs.checkpoints(run.id)).rejects.toBeInstanceOf(PaginationLoopError);
    await expect(grad.evals.failures("e")).rejects.toBeInstanceOf(PaginationLoopError);
    expect(server.calls.length).toBeLessThanOrEqual(6);
  });

  it("stops on an empty page even when it carries a cursor", async () => {
    const server = new FakeServer(10).on(
      "GET",
      "/v1/datasets",
      json({ data: [dataset], next_cursor: "a" }),
      json({ data: [], next_cursor: "b" }),
      json({ data: [dataset], next_cursor: null }),
    );
    expect(await makeGrad(server).grad.datasets.list().all()).toHaveLength(1);
    expect(server.calls).toHaveLength(2);
  });

  it("honours an AbortSignal between pages and bounds all()", async () => {
    const controller = new AbortController();
    let n = 0;
    const server = new FakeServer(10).on("GET", "/v1/datasets", () => {
      n += 1;
      if (n === 2) controller.abort(new Error("enough"));
      return json({ data: [dataset], next_cursor: `c${n}` });
    });
    const { grad } = makeGrad(server);
    await expect(grad.datasets.list({ signal: controller.signal }).all()).rejects.toBeInstanceOf(APIUserAbortError);
    expect(server.calls).toHaveLength(2);

    const aborted = new AbortController();
    aborted.abort();
    const never = new Paginator<number>(async () => {
      throw new Error("must not fetch");
    }, aborted.signal);
    await expect(never.all()).rejects.toBeInstanceOf(APIUserAbortError);

    let page = 0;
    const big = new Paginator<number>(async () => ({ data: [1, 2, 3], nextCursor: `p${(page += 1)}` }));
    await expect(big.all({ maxItems: 5 })).rejects.toBeInstanceOf(GradUsageError);
    expect(page).toBe(2);
    expect(await new Paginator<number>(async () => ({ data: [1], nextCursor: null })).all({ maxItems: 1 })).toEqual([1]);
  });

  it("awaiting a paginator returns the first page and iteration reuses it", async () => {
    const server = new FakeServer(10).on("GET", "/v1/datasets", json({ data: [dataset], next_cursor: "n" }), json({ data: [dataset], next_cursor: null }));
    const list = makeGrad(server).grad.datasets.list({ limit: 1 });
    const first = await list;
    expect(first.nextCursor).toBe("n");
    const pages = [];
    for await (const p of list.pages()) pages.push(p);
    expect(pages).toHaveLength(2);
    expect(server.calls).toHaveLength(2);
  });
});

describe("low-level ApiClient", () => {
  // Every generated operation, called once against a fake that answers any route: proves each method
  // builds a request with the declared method and path and decodes the reply.
  it("exposes one working method per operation", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ method: init.method ?? "GET", path: url.pathname });
      if (calls.length > 200) throw new Error("too many calls");
      const accept = new Headers(init.headers).get("accept") ?? "";
      if (accept.includes("text/event-stream")) {
        return new Response("event: metric\nid: 1\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
      }
      if (!accept.includes("json")) return new Response("bytes", { headers: { "content-type": "application/octet-stream" } });
      return json({ data: [], next_cursor: null });
    };
    const { grad } = makeGrad(new FakeServer(), { fetch: fetch as typeof globalThis.fetch, maxRetries: 0 });
    const api = grad.api;
    const names = Object.getOwnPropertyNames(ApiClient.prototype).filter((n) => n !== "constructor");
    expect(names.length).toBeGreaterThan(40);
    expect(names.filter((n) => /TrainerJob|EnvTask|EnvWorker|ImportRecords|TrainerUpload|TrainerCheckpoint|TrainerDataset|TrainerProgress|TrainerQueue/.test(n))).toEqual([]);
    for (const name of names) {
      const method = (api as unknown as Record<string, (...args: unknown[]) => unknown>)[name] as (...args: unknown[]) => unknown;
      const params = /^[^(]*\(([^)]*)\)/.exec(method.toString())?.[1]?.split(",").map((p) => p.trim().split(/[=:\s]/)[0]) ?? [];
      const args = params.map((p) => (p === "options" ? undefined : p === "body" || p === "params" ? {} : "x_1"));
      const result = method.apply(api, args);
      if (result && typeof (result as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") {
        for await (const _ of result as AsyncIterable<unknown>) void _;
      } else {
        const value = await result;
        if (value && typeof (value as { cancel?: unknown }).cancel === "function") await (value as { cancel: () => Promise<void> }).cancel();
      }
    }
    // One request per method (the JSON and SSE variants of the events endpoint share a route).
    expect(calls).toHaveLength(names.length);
    expect(new Set(calls.map((c) => `${c.method} ${c.path}`)).size).toBe(names.length - 1);
  });
});
