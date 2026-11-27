import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalNoneAuth } from "../src/adapters.js";
import { MAX_JSON_BODY_BYTES } from "../src/app.js";
import { LARGE_BODY_BYTES, largeBodyGate } from "../src/http-guards.js";
import { makeTestApp, type TestApp } from "./fixtures/app.js";

describe("large request bodies (security review 2026-11-28)", () => {
  it("handles at most `slots` large bodies at once; small and bodyless requests pass", async () => {
    // A 60 MiB push raised API RSS by ~670 MiB: concurrent pushes from any
    // datasets:write key could OOM a 1 GiB replica for every tenant on it.
    const app = new Hono();
    let inside = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    app.use("*", largeBodyGate(2));
    app.all("*", async (c) => {
      inside += 1;
      peak = Math.max(peak, inside);
      await new Promise<void>((resolve) => gates.push(resolve));
      inside -= 1;

      return c.text("ok");
    });
    const big = { "content-length": String(LARGE_BODY_BYTES + 1) };
    const post = (headers: Record<string, string>) =>
      app.request("/", { method: "POST", headers, body: "x" });

    const pending = [post(big), post(big), post(big)];
    await new Promise((r) => setTimeout(r, 20));
    expect(inside).toBe(2);

    // Small bodies and GETs never wait behind the large ones.
    const small = post({ "content-length": "100" });
    const get = app.request("/");
    await new Promise((r) => setTimeout(r, 20));
    expect(inside).toBe(4);

    while (gates.length > 0 || inside > 0) {
      gates.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    const statuses = (await Promise.all([...pending, small, get])).map(
      (r) => r.status,
    );
    expect(statuses).toEqual([200, 200, 200, 200, 200]);
    expect(peak).toBe(4);
  });

  it("caps JSON bodies at 32 MiB", () => {
    expect(MAX_JSON_BODY_BYTES).toBe(32 * 1024 * 1024);
  });
});

describe("AUTH_MODE=none refuses what a web page could send (security review 2026-11-28)", () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  const none = () =>
    makeTestApp({
      auth: createLocalNoneAuth("ws_a"),
      settings: { maxAttempts: 3, unauthenticated: true },
    });

  it("refuses a public Host name (DNS rebinding) but serves local names", async () => {
    t = await none();
    for (const host of [
      "rebind.attacker.example:18787",
      "127.0.0.1.nip.io:18787",
    ]) {
      const res = await t.app.request(`http://${host}/v1/runs`);
      expect(res.status, host).toBe(403);
      expect(await res.json()).toMatchObject({ code: "host_not_allowed" });
    }
    for (const host of [
      "127.0.0.1:18787",
      "localhost:18787",
      "[::1]:18787",
      "grad-server:8787",
      "10.0.0.7:8787",
      "grad.grad.svc.cluster.local",
      "app.localhost",
    ]) {
      const res = await t.app.request(`http://${host}/v1/runs`);
      expect(res.status, host).toBe(200);
    }
  });

  it("refuses cross-site browser requests, including a preflight-free text/plain POST", async () => {
    t = await none();
    const runs = await t.app.request("http://127.0.0.1:18787/v1/runs");
    expect(runs.status).toBe(200);

    const csrf = await t.app.request(
      "http://127.0.0.1:18787/v1/runs/run_x/cancel",
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Origin: "https://evil.example",
          "Sec-Fetch-Site": "cross-site",
        },
        body: "{}",
      },
    );
    expect(csrf.status).toBe(403);
    expect(await csrf.json()).toMatchObject({ code: "cross_site_request" });

    // Old browsers without Sec-Fetch-*: the Origin alone decides.
    const noFetchMeta = await t.app.request("http://127.0.0.1:18787/v1/runs", {
      headers: { Origin: "http://evil.example" },
    });
    expect(noFetchMeta.status).toBe(403);
    const sandboxed = await t.app.request("http://127.0.0.1:18787/v1/runs", {
      headers: { Origin: "null" },
    });
    expect(sandboxed.status).toBe(403);

    // The bundled UI (same origin), a typed URL and a link from elsewhere work.
    const sameOrigin = await t.app.request("http://127.0.0.1:18787/v1/runs", {
      headers: {
        Origin: "http://127.0.0.1:18787",
        "Sec-Fetch-Site": "same-origin",
      },
    });
    expect(sameOrigin.status).toBe(200);
    const link = await t.app.request("http://127.0.0.1:18787/v1/runs", {
      headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" },
    });
    expect(link.status).toBe(200);
  });

  it("lets GRAD_CORS_ORIGINS through and leaves api_key mode alone", async () => {
    t = await makeTestApp({
      auth: createLocalNoneAuth("ws_a"),
      settings: {
        maxAttempts: 3,
        unauthenticated: true,
        corsOrigins: ["http://localhost:5173"],
      },
    });
    const dev = await t.app.request("http://127.0.0.1:18787/v1/runs", {
      headers: {
        Origin: "http://localhost:5173",
        "Sec-Fetch-Site": "same-site",
      },
    });
    expect(dev.status).toBe(200);
    await t.close();

    t = await makeTestApp();
    const keyed = await t.request("/v1/runs", {
      headers: {
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "cross-site",
      },
    });
    expect(keyed.status).toBe(200);
  });
});
