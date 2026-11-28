import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { DatasetRecord } from "../src/contracts.js";
import { ServerUnavailable, createWorkerClient } from "../src/worker/client.js";
import { openDownloadedVersion } from "../src/worker/dataset-file.js";

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

const collect = async (lines: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
};

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
    const lines = await collect(
      client(serving(chunks)).datasetLines("/v1/trainer-jobs/j/dataset"),
    );
    expect(lines).toHaveLength(40_005);
    expect(JSON.parse(lines.at(-1) as string).id).toBe("r40004");
  });

  it("hands back on a gzip stream cut short or a connection dropped mid-body", async () => {
    const whole = part(0, 1000);
    await expect(
      collect(
        client(serving([whole.subarray(0, whole.length - 100)])).datasetLines(
          "/d",
        ),
      ),
    ).rejects.toBeInstanceOf(ServerUnavailable);
    await expect(
      collect(
        client(
          serving([whole.subarray(0, 500)], new TypeError("terminated")),
        ).datasetLines("/d"),
      ),
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
      collect(
        createWorkerClient({
          serverUrl: "http://grad.test",
          workerId: "w",
          fetch: stall,
          retryDelaysMs: [],
          timeoutMs: 200,
        }).datasetLines("/d"),
      ),
    ).rejects.toBeInstanceOf(ServerUnavailable);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("fails the eval on a line that is not JSON, and leaves no file behind", async () => {
    const before = (await readdir(tmpdir())).filter((f) =>
      f.startsWith("grad-eval-"),
    );
    await expect(
      openDownloadedVersion(
        client(serving([gzipSync('{"id":"a"}\n{not json}\n')])).datasetLines(
          "/d",
        ),
      ),
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(
      (await readdir(tmpdir())).filter((f) => f.startsWith("grad-eval-")),
    ).toEqual(before);
  });

  it("pages the downloaded version's merge across chunks, like mergeRecords", async () => {
    const cases = JSON.parse(
      readFileSync(
        new URL(
          "../../trainer/tests/fixtures/merge_parity.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Array<{ parts: DatasetRecord[][]; merged: DatasetRecord[] }>;
    for (const { parts, merged } of cases) {
      const lines = parts.flat().map((r) => JSON.stringify(r));
      const version = await openDownloadedVersion(
        (async function* () {
          yield* lines;
        })(),
        { chunkLines: 7 },
      );
      const records: DatasetRecord[] = [];
      for await (const record of version.records()) records.push(record);
      await version.close();
      expect(records).toEqual(merged);
    }
  });
});
