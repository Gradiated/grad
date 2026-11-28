import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import { gracefulShutdown } from "../src/shutdown.js";

describe("gracefulShutdown", () => {
  it("drains (still serving) before stopping background work, and finishes with an SSE client connected", async () => {
    const app = new Hono();
    app.get("/ping", (c) => c.text("pong"));
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
    let drainedAt = 0;
    const shutdown = gracefulShutdown({
      servers: [server],
      graceMs: 200,
      drainMs: 300,
      startDraining: () => {
        order.push("drain");
        drainedAt = Date.now();
      },
      stopBackground: async () => {
        expect(Date.now() - drainedAt).toBeGreaterThanOrEqual(290);
        order.push("background");
      },
      closeResources: async () => {
        order.push("resources");
      },
    });
    // While draining the listener is still open: new requests are served.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const during = await fetch(`http://127.0.0.1:${port}/ping`);
    expect(await during.text()).toBe("pong");
    await shutdown;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(order).toEqual(["drain", "background", "resources"]);
    await reader.read().catch(() => undefined);
  });

  it("runs every step and finishes when one fails", async () => {
    const server = serve({ fetch: new Hono().fetch, port: 0 }) as Server;
    await new Promise((resolve) => server.once("listening", resolve));
    const order: string[] = [];
    const ok = await gracefulShutdown({
      servers: [server],
      startDraining: () => order.push("drain"),
      stopBackground: async () => {
        order.push("background");
        throw new Error("maintenance stop failed");
      },
      closeResources: async () => {
        order.push("resources");
        throw new Error("pool close failed");
      },
    });
    expect(ok).toBe(false);
    expect(order).toEqual(["drain", "background", "resources"]);
    expect(server.listening).toBe(false);
  });
});
