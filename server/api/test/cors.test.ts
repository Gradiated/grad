import { afterEach, describe, expect, it } from "vitest";

import { parseServerEnvironment } from "../src/environment.js";
import { ADMIN_KEY, makeTestApp, type TestApp } from "./fixtures/app.js";
import { createSftRun } from "./fixtures/worker.js";

const CONSOLE = "https://console.gradiated.com";

describe("CORS for browser clients (GRAD_CORS_ORIGINS)", () => {
  let t: TestApp | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it("is off by default", async () => {
    t = await makeTestApp();
    const res = await t.request("/v1/runs", { headers: { Origin: CONSOLE } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers preflights and tags responses (errors and SSE too) for allowlisted origins only", async () => {
    t = await makeTestApp({
      settings: { maxAttempts: 3, corsOrigins: [CONSOLE] },
    });
    const preflight = await t.request("/v1/runs", {
      method: "OPTIONS",
      token: null,
      headers: {
        Origin: CONSOLE,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers":
          "authorization,content-type,idempotency-key,last-event-id",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(CONSOLE);
    expect(preflight.headers.get("access-control-allow-headers")).toMatch(
      /Authorization.*Idempotency-Key.*Last-Event-ID/,
    );
    expect(
      preflight.headers.get("access-control-allow-credentials"),
    ).toBeNull();

    const denied = await t.request("/v1/runs", {
      token: null,
      headers: { Origin: CONSOLE },
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-allow-origin")).toBe(CONSOLE);
    expect(denied.headers.get("access-control-expose-headers")).toMatch(
      /x-request-id/,
    );

    const other = await t.request("/v1/runs", {
      headers: { Origin: "https://evil.example" },
    });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();

    const run = await createSftRun(t);
    const controller = new AbortController();
    const stream = await t.app.request(`/v1/runs/${run.id}/events`, {
      headers: {
        Authorization: `Bearer ${ADMIN_KEY}`,
        Accept: "text/event-stream",
        Origin: CONSOLE,
      },
      signal: controller.signal,
    });
    expect(stream.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(stream.headers.get("access-control-allow-origin")).toBe(CONSOLE);
    controller.abort();
    await stream.body?.cancel().catch(() => undefined);
  });

  it("accepts only exact https origins (http for localhost)", () => {
    const base = {
      DATABASE_URL: "postgres://x",
      S3_BUCKET: "b",
      AUTH_MODE: "none",
    };
    expect(
      parseServerEnvironment({
        ...base,
        GRAD_CORS_ORIGINS: `${CONSOLE}, http://localhost:3000`,
      }).corsOrigins,
    ).toEqual([CONSOLE, "http://localhost:3000"]);
    for (const bad of [`${CONSOLE}/`, "http://console.example.com", "*"]) {
      expect(() =>
        parseServerEnvironment({ ...base, GRAD_CORS_ORIGINS: bad }),
      ).toThrow(/GRAD_CORS_ORIGINS/);
    }
  });
});
