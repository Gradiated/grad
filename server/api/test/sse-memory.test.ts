import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { expect, it } from "vitest";

const CHUNKS = 100_000;

// @hono/node-server before 2.1.11 piped a streamed response with a promise
// chain one link longer per chunk, held until the response ended: an event
// stream open for hours grew the API's heap until it ran out (p1-scale soak:
// ~20 MB/min with 1,000 streams). A long stream's chunks must not accumulate.
it("an open event stream retains nothing per chunk it has written", async () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const app = new Hono().get("/s", (c) =>
    streamSSE(c, async (stream) => {
      // Live-stream pacing: the socket never backs up (a burst would take
      // the drain path, which never chained).
      for (let i = 0; i < CHUNKS; i += 1) {
        await stream.write(": x\n\n");
        await new Promise((resolve) => setImmediate(resolve));
      }
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    }),
  );
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  gc();
  const before = process.memoryUsage().heapUsed;
  const req = request({ host: "127.0.0.1", port, path: "/s" });
  const received = new Promise<void>((resolve) => {
    req.on("response", (res) => {
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes >= CHUNKS * 5) resolve();
      });
    });
  });
  req.end();
  await received;
  gc();
  const retained = process.memoryUsage().heapUsed - before;

  req.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  expect(retained).toBeLessThan(4 * 1024 * 1024);
}, 60_000);
