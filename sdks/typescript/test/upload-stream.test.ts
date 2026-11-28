// nodeFetch streams an upload from disk over a real socket, with its exact Content-Length.
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Grad } from "../src/index.js";
import { nodeFetch } from "../src/node/files.js";
import { FileBody } from "../src/transport.js";

describe("streamed uploads (nodeFetch)", () => {
  const seen: Array<{ length: string | undefined; chunked: boolean; sha: string; bytes: number }> = [];
  let fail = 0;
  const server = createServer((req, res) => {
    const hash = createHash("sha256");
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    req.on("end", () => {
      seen.push({ length: req.headers["content-length"], chunked: req.headers["transfer-encoding"] === "chunked", sha: hash.digest("hex"), bytes });
      if (req.url?.startsWith("/flaky") && fail > 0) {
        fail -= 1;
        res.writeHead(503, { "content-type": "application/problem+json" }).end('{"code":"unavailable"}');
        return;
      }
      res.writeHead(200).end();
    });
  });
  let base = "";
  const file = path.join(mkdtempSync(path.join(tmpdir(), "grad-up-")), "big.bin");
  const data = Buffer.alloc(3 * 1024 * 1024 + 17, 7);

  beforeAll(async () => {
    writeFileSync(file, data);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("sends the file with its Content-Length (not chunked) and hands other bodies to fetch", async () => {
    const res = await nodeFetch(`${base}/put`, { method: "PUT", body: new FileBody(file, data.length) as unknown as BodyInit });
    expect(res.status).toBe(200);
    const sha = createHash("sha256").update(data).digest("hex");
    expect(seen.at(-1)).toEqual({ length: String(data.length), chunked: false, sha, bytes: data.length });
    expect((await nodeFetch(`${base}/plain`, { method: "PUT", body: "x" })).status).toBe(200);
  });

  it("sends the file's bytes through a caller's own fetch (a proxy wrapper), not '[object Object]'", async () => {
    const grad = new Grad({ baseURL: base, apiKey: "k", fetch: (input, init) => fetch(input, init) });
    const core = (grad as unknown as { datasets: { core: { upload: (u: string, h: Record<string, string>, f: { path: string; sizeBytes: number }) => Promise<{ status: number; cancel: () => Promise<void> }> } } }).datasets.core;
    const put = await core.upload(`${base}/put`, {}, { path: file, sizeBytes: data.length });
    await put.cancel();
    const sha = createHash("sha256").update(data).digest("hex");
    expect(seen.at(-1)).toEqual({ length: String(data.length), chunked: false, sha, bytes: data.length });
  });

  it("replays the whole file on a retry through the client's upload path", async () => {
    fail = 1;
    const grad = new Grad({ baseURL: base, apiKey: "k", sleep: async () => undefined });
    const before = seen.length;
    const core = (grad as unknown as { datasets: { core: { upload: (u: string, h: Record<string, string>, f: { path: string; sizeBytes: number }) => Promise<{ status: number; cancel: () => Promise<void> }> } } }).datasets.core;
    const put = await core.upload(`${base}/flaky`, {}, { path: file, sizeBytes: data.length });
    await put.cancel();
    expect(put.status).toBe(200);
    expect(seen.slice(before).map((s) => s.bytes)).toEqual([data.length, data.length]);
  });
});
