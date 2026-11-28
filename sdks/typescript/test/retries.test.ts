/* Shared retry-policy fixture (tests/fixtures/wire/retries.json), replayed by every SDK. */
import { describe, expect, it } from "vitest";

import * as errors from "../src/index.js";
import { APIError } from "../src/index.js";
import { FakeServer, json, makeGrad, wire } from "./helpers.js";

interface RetryCase {
  name: string;
  method: "GET" | "POST" | "DELETE";
  responses: Array<{ status: number; headers?: Record<string, string>; body?: unknown }>;
  expect: { attempts: number; error: string | null; sleeps_ms?: number[] };
}

const ROUTES = { GET: "/v1/datasets", POST: "/v1/datasets", DELETE: "/v1/secrets/s" } as const;
const SUCCESS = { GET: { data: [], next_cursor: null }, POST: wire("dataset.json"), DELETE: undefined } as const;

describe("retry policy (tests/fixtures/wire/retries.json)", () => {
  for (const c of wire<{ cases: RetryCase[] }>("retries.json").cases) {
    it(c.name, async () => {
      const replies = c.responses.map((r) => {
        if (r.status >= 300) return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers ?? {} });
        const body = SUCCESS[c.method];
        return body === undefined ? new Response(null, { status: r.status }) : json(body, r.status);
      });
      const server = new FakeServer().on(c.method, ROUTES[c.method], ...replies);
      const { grad, clock } = makeGrad(server);
      const call = {
        GET: () => grad.datasets.list().pages().next(),
        POST: () => grad.datasets.create("d"),
        DELETE: () => grad.secrets.delete("s"),
      }[c.method];
      const outcome = await call().then(
        () => undefined,
        (e: unknown) => e,
      );
      if (c.expect.error === null) {
        expect(outcome).toBeUndefined();
      } else {
        expect(outcome).toBeInstanceOf(APIError);
        expect((outcome as Error).constructor).toBe((errors as Record<string, unknown>)[c.expect.error]);
      }
      const calls = server.callsTo(c.method, ROUTES[c.method]);
      expect(calls).toHaveLength(c.expect.attempts);
      if (c.expect.sleeps_ms !== undefined) expect(clock.sleeps).toEqual(c.expect.sleeps_ms);
      if (c.method === "POST") {
        const keys = new Set(calls.map((call) => call.headers.get("idempotency-key")));
        expect(keys.size).toBe(1);
        expect([...keys][0]).toBeTruthy();
      }
    });
  }
});
