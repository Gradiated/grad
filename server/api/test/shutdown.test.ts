import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { gracefulShutdown } from "../src/shutdown.js";

describe("gracefulShutdown", () => {
  it("finishes with an SSE client connected, after stopping background work first", async () => {
    const app = new Hono();
    app.get("/stream", (c) =>
      streamSSE(c, async (stream) => {
        while (!stream.aborted) await stream.sleep(20);
      }),
    );
    const server = serve({
      fetch: app.fetch,
      port: 0,
      hostname: "127.0.0.1",
    }) as Server;
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/stream`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();

    const order: string[] = [];
    const started = Date.now();
    await gracefulShutdown({
      server,
      graceMs: 200,
      stopBackground: async () => {
        order.push("background");
      },
      closeResources: async () => {
        order.push("resources");
      },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(order).toEqual(["background", "resources"]);
    await reader.read().catch(() => undefined);
  });
});
