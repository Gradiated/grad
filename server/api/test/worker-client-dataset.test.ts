import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { ServerUnavailable, createWorkerClient } from "../src/worker/client.js";

/** A fetch that serves `chunks` as the body, then errors when `fail` is set. */
const serving =
  (chunks: Uint8Array[], fail?: Error): typeof fetch =>
  async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          if (fail) controller.error(fail);
          else controller.close();
        },
      }),
      { status: 200 },
    );

const client = (fetchImpl: typeof globalThis.fetch) =>
  createWorkerClient({
    serverUrl: "http://grad.test",
    apiKey: "k",
    workerId: "w",
    fetch: fetchImpl,
    retryDelaysMs: [],
    timeoutMs: 2_000,
  });

const part = (from: number, n: number) =>
  gzipSync(
    Array.from(
      { length: n },
      (_, i) =>
        `${JSON.stringify({ id: `r${from + i}`, input: "x".repeat(200) })}\n`,
    ).join(""),
  );

describe("eval worker dataset download", () => {
  it("streams every gzip member (one per stored part) line by line", async () => {
    const parts = [part(0, 20_000), part(20_000, 20_000), part(40_000, 5)];
    // Split into small network chunks, across member boundaries.
    const body = Buffer.concat(parts);
    const chunks = [];
    for (let at = 0; at < body.length; at += 65_536) {
      chunks.push(body.subarray(at, at + 65_536));
    }
    const records = await client(serving(chunks)).datasetRecords(
      "/v1/trainer-jobs/j/dataset",
    );
    expect(records).toHaveLength(40_005);
    expect(records.at(-1)?.id).toBe("r40004");
  });

  it("hands back on a gzip stream cut short or a connection dropped mid-body", async () => {
    const whole = part(0, 1000);
    await expect(
      client(serving([whole.subarray(0, whole.length - 100)])).datasetRecords(
        "/d",
      ),
    ).rejects.toBeInstanceOf(ServerUnavailable);
    await expect(
      client(
        serving([whole.subarray(0, 500)], new TypeError("terminated")),
      ).datasetRecords("/d"),
    ).rejects.toBeInstanceOf(ServerUnavailable);
  });

  it("aborts a download that stalls", async () => {
    const stall: typeof fetch = async (_url, init) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(part(0, 1).subarray(0, 10));
            init?.signal?.addEventListener("abort", () =>
              controller.error(new Error("aborted")),
            );
          },
        }),
      );
    const started = Date.now();
    await expect(
      createWorkerClient({
        serverUrl: "http://grad.test",
        workerId: "w",
        fetch: stall,
        retryDelaysMs: [],
        timeoutMs: 200,
      }).datasetRecords("/d"),
    ).rejects.toBeInstanceOf(ServerUnavailable);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("fails the eval on a line that is not JSON", async () => {
    await expect(
      client(serving([gzipSync("{not json}\n")])).datasetRecords("/d"),
    ).rejects.toBeInstanceOf(SyntaxError);
  });
});
