import { describe, expect, it, vi } from "vitest";

import * as errors from "../src/errors.js";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  convertKeys,
  defaultSleep,
  defaultUserAgent,
  encodePathParam,
  GradError,
  makeAPIError,
  parseFieldErrors,
  parseRetryAfterMs,
  RateLimitError,
  readEnv,
  RedirectError,
  ResponseDecodeError,
  ServerError,
  Transport,
} from "../src/generated/transport.js";
import { BASE, FakeClock, FakeServer, json, wire } from "./helpers.js";

interface ErrorCase {
  name: string;
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  body_text?: string;
  expect: {
    class: string;
    status: number;
    code: string;
    request_id: string | null;
    message_contains?: string[];
    field_errors?: Array<{ field: string; message: string }>;
    retry_after_ms?: number;
    retryable: boolean;
  };
}

const transport = (server: FakeServer, clock = new FakeClock(), extra: Partial<ConstructorParameters<typeof Transport>[0]> = {}) =>
  new Transport({ baseURL: BASE, apiKey: "grad_test_key", fetch: server.fetch as typeof fetch, sleep: clock.sleep, random: () => 0.5, ...extra });

const refused = () => {
  const error = new TypeError("fetch failed");
  (error as { cause?: unknown }).cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
  return error;
};

const reset = () => {
  const error = new TypeError("fetch failed");
  (error as { cause?: unknown }).cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  return error;
};

describe("error mapping (tests/fixtures/wire/errors.json)", () => {
  const { cases } = wire<{ cases: ErrorCase[] }>("errors.json");

  for (const c of cases) {
    it(c.name, async () => {
      const server = new FakeServer().on(
        "GET",
        "/v1/runs/run_x",
        new Response(c.body_text ?? JSON.stringify(c.body), { status: c.status, headers: c.headers }),
      );
      const error = await transport(server).json({ method: "GET", path: "/v1/runs/run_x" }, { maxRetries: 0 }).catch((e: unknown) => e);
      const Expected = (errors as Record<string, unknown>)[c.expect.class] as typeof APIError;
      expect(error).toBeInstanceOf(Expected);
      expect(error).toBeInstanceOf(APIError);
      expect(error).toBeInstanceOf(GradError);
      const e = error as APIError;
      expect(e.constructor).toBe(Expected);
      expect(e.status).toBe(c.expect.status);
      expect(e.code).toBe(c.expect.code);
      expect(e.requestId ?? null).toBe(c.expect.request_id);
      expect(e.message).toContain(`GET ${BASE}/v1/runs/run_x returned ${c.status}`);
      for (const part of c.expect.message_contains ?? []) expect(e.message).toContain(part);
      if (c.expect.field_errors) expect(e.fieldErrors).toEqual(c.expect.field_errors);
      if (c.expect.retry_after_ms !== undefined) expect(e.retryAfterMs).toBe(c.expect.retry_after_ms);

      const retryServer = new FakeServer().on(
        "GET",
        "/v1/runs/run_x",
        new Response(c.body_text ?? JSON.stringify(c.body), { status: c.status, headers: c.headers }),
        json({ ok: true }),
      );
      const outcome = await transport(retryServer).json({ method: "GET", path: "/v1/runs/run_x" }).then(() => "retried", () => "thrown");
      expect(outcome).toBe(c.expect.retryable ? "retried" : "thrown");
    });
  }

  it("names the missing API key on 401 when no key is configured", () => {
    const e = makeAPIError(401, new Headers(), "", { method: "GET", url: "u", apiKeyConfigured: false });
    expect(e.message).toContain("GRADIATED_API_KEY");
    expect(e.message).toContain("grad login");
    expect(makeAPIError(401, new Headers(), "", { method: "GET", url: "u", apiKeyConfigured: true }).message).not.toContain("grad login");
  });

  it("parses field errors and Retry-After variants", () => {
    expect(parseFieldErrors({ errors: [{ path: ["a", 0], detail: "bad" }, "junk", { pointer: "/x" }] }, "")).toEqual([
      { field: "a.0", message: "bad" },
      { field: "/x", message: "" },
    ]);
    expect(parseRetryAfterMs(new Headers({ "retry-after-ms": "250" }))).toBe(250);
    expect(parseRetryAfterMs(new Headers({ "retry-after": "1.5" }))).toBe(1500);
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfterMs(new Headers({ "retry-after": "Thu, 01 Jan 2026 00:00:03 GMT" }), now)).toBe(3000);
    expect(parseRetryAfterMs(new Headers({ "retry-after": "soon" }))).toBeUndefined();
    expect(parseRetryAfterMs(new Headers())).toBeUndefined();
  });
});

describe("retries", () => {
  it("honours Retry-After on 429 for POST and counts attempts", async () => {
    const clock = new FakeClock();
    const server = new FakeServer().on("POST", "/v1/runs", json({ code: "rate_limited" }, 429, { "retry-after": "2" }), json({ id: "run_1" }, 202));
    await expect(transport(server, clock).json({ method: "POST", path: "/v1/runs", json: {} })).resolves.toEqual({ id: "run_1" });
    expect(server.calls).toHaveLength(2);
    expect(clock.sleeps).toEqual([2000]);
  });

  it("retries idempotent GETs on 502/503/504 with exponential backoff, up to 2 retries", async () => {
    const clock = new FakeClock();
    const server = new FakeServer().on("GET", "/v1/runs", json({}, 503), json({}, 502), json({}, 504));
    await expect(transport(server, clock).json({ method: "GET", path: "/v1/runs" })).rejects.toBeInstanceOf(ServerError);
    expect(server.calls).toHaveLength(3);
    expect(clock.sleeps).toEqual([375, 750]);
  });

  it("never retries POST on 5xx (no idempotency key)", async () => {
    const server = new FakeServer().on("POST", "/v1/runs", json({}, 500), json({ id: "dup" }));
    await expect(transport(server).json({ method: "POST", path: "/v1/runs", json: {} })).rejects.toBeInstanceOf(ServerError);
    expect(server.calls).toHaveLength(1);
  });

  it("does not retry 4xx", async () => {
    const server = new FakeServer().on("GET", "/v1/runs", json({}, 400), json({}));
    await expect(transport(server).json({ method: "GET", path: "/v1/runs" })).rejects.toBeInstanceOf(errors.BadRequestError);
    expect(server.calls).toHaveLength(1);
  });

  it("gives up when Retry-After exceeds the cap", async () => {
    const server = new FakeServer().on("GET", "/v1/runs", json({}, 429, { "retry-after": "3600" }), json({}));
    const e = await transport(server).json({ method: "GET", path: "/v1/runs" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RateLimitError);
    expect((e as RateLimitError).retryAfterMs).toBe(3_600_000);
    expect(server.calls).toHaveLength(1);
  });

  it("retries POST only when the connection was never established", async () => {
    let n = 0;
    const flaky = async () => {
      n += 1;
      if (n === 1) throw refused();
      return json({ id: "run_1" }, 202);
    };
    const t = new Transport({ baseURL: BASE, fetch: flaky as typeof fetch, sleep: new FakeClock().sleep, random: () => 0 });
    await expect(t.json({ method: "POST", path: "/v1/runs", json: {} })).resolves.toEqual({ id: "run_1" });
    expect(n).toBe(2);

    let m = 0;
    const dropped = async () => {
      m += 1;
      throw reset();
    };
    const t2 = new Transport({ baseURL: BASE, fetch: dropped as typeof fetch, sleep: new FakeClock().sleep });
    const e = await t2.json({ method: "POST", path: "/v1/runs", json: {} }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(APIConnectionError);
    expect((e as Error).message).toContain("ECONNRESET");
    expect((e as Error).message).toContain("GRADIATED_BASE_URL");
    expect(m).toBe(1);

    let k = 0;
    const getDropped = async () => {
      k += 1;
      throw reset();
    };
    const t3 = new Transport({ baseURL: BASE, fetch: getDropped as typeof fetch, sleep: new FakeClock().sleep });
    await expect(t3.json({ method: "GET", path: "/v1/runs" })).rejects.toBeInstanceOf(APIConnectionError);
    expect(k).toBe(3);
  });

  it("detects never-sent errors nested in AggregateError (happy eyeballs)", async () => {
    let n = 0;
    const flaky = async () => {
      n += 1;
      if (n === 1) {
        const error = new TypeError("fetch failed");
        (error as { cause?: unknown }).cause = new AggregateError([Object.assign(new Error("a"), { code: "ECONNREFUSED" })], "x");
        throw error;
      }
      return json({});
    };
    const t = new Transport({ baseURL: BASE, fetch: flaky as typeof fetch, sleep: new FakeClock().sleep });
    await t.json({ method: "POST", path: "/v1/x", json: {} });
    expect(n).toBe(2);
  });

  it("backs off exponentially with jitter, capped at 8 s", () => {
    const t = new Transport({ baseURL: BASE, fetch: (() => undefined) as unknown as typeof fetch, random: () => 1 });
    expect([0, 1, 2, 3, 4, 10].map((a) => t.backoffMs(a))).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
    const low = new Transport({ baseURL: BASE, fetch: (() => undefined) as unknown as typeof fetch, random: () => 0 });
    expect(low.backoffMs(0)).toBe(250);
  });

  it("stops retry waits when the caller aborts", async () => {
    const controller = new AbortController();
    const server = new FakeServer().on("GET", "/v1/runs", json({}, 503));
    const sleep = async (_ms: number, signal?: AbortSignal) => {
      controller.abort(new Error("bye"));
      if (signal?.aborted) throw signal.reason;
    };
    const t = new Transport({ baseURL: BASE, fetch: server.fetch as typeof fetch, sleep });
    await expect(t.json({ method: "GET", path: "/v1/runs" }, { signal: controller.signal })).rejects.toBeInstanceOf(APIUserAbortError);
  });
});

describe("redirects", () => {
  it("refuses cross-origin redirects and never sends the key to the other host", async () => {
    const server = new FakeServer().on("GET", "/v1/runs", new Response(null, { status: 302, headers: { location: "https://evil.example/v1/runs" } }));
    const e = await transport(server).json({ method: "GET", path: "/v1/runs" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RedirectError);
    expect((e as RedirectError).code).toBe("redirect_refused");
    expect((e as Error).message).toContain("https://evil.example/v1/runs");
    expect(server.calls.map((c) => c.url.host)).toEqual(["grad.test"]);
    expect(server.calls[0]?.headers.get("authorization")).toBe("Bearer grad_test_key");
  });

  it("refuses https -> http downgrades on the same host", async () => {
    const server = new FakeServer().on("GET", "/v1/x", new Response(null, { status: 301, headers: { location: "http://grad.test/v1/x" } }));
    const t = new Transport({ baseURL: "https://grad.test", fetch: server.fetch as typeof fetch });
    await expect(t.json({ method: "GET", path: "/v1/x" })).rejects.toBeInstanceOf(RedirectError);
  });

  it("follows same-origin GET redirects", async () => {
    const server = new FakeServer()
      .on("GET", "/v1/old", new Response(null, { status: 307, headers: { location: "/v1/new?x=1" } }))
      .on("GET", "/v1/new", json({ moved: true }));
    await expect(transport(server).json({ method: "GET", path: "/v1/old" })).resolves.toEqual({ moved: true });
    expect(server.calls[1]?.url.search).toBe("?x=1");
  });

  it("refuses same-origin redirects of POST (no silent POST -> GET)", async () => {
    const server = new FakeServer().on("POST", "/v1/runs", new Response(null, { status: 302, headers: { location: "/v1/runs/other" } }));
    await expect(transport(server).json({ method: "POST", path: "/v1/runs", json: {} })).rejects.toBeInstanceOf(RedirectError);
    expect(server.calls).toHaveLength(1);
  });

  it("refuses browser opaque redirects and redirect loops", async () => {
    const opaque = { type: "opaqueredirect", status: 0, ok: false, headers: new Headers(), body: null } as unknown as Response;
    const t = new Transport({ baseURL: BASE, fetch: (async () => opaque) as typeof fetch });
    await expect(t.json({ method: "GET", path: "/v1/x" })).rejects.toBeInstanceOf(RedirectError);

    const loop = new FakeServer().on("GET", "/v1/loop", new Response(null, { status: 302, headers: { location: "/v1/loop" } }));
    await expect(transport(loop).json({ method: "GET", path: "/v1/loop" })).rejects.toBeInstanceOf(RedirectError);
    expect(loop.calls).toHaveLength(6);
  });
});

describe("timeouts, aborts and decoding", () => {
  const hanging = (calls: AbortSignal[]) =>
    (async (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      calls.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as unknown as typeof fetch;

  it("times out each attempt and retries GETs", async () => {
    const signals: AbortSignal[] = [];
    const t = new Transport({ baseURL: BASE, fetch: hanging(signals), timeoutMs: 5, sleep: new FakeClock().sleep });
    const e = await t.json({ method: "GET", path: "/v1/runs" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(APITimeoutError);
    expect(e).toBeInstanceOf(APIConnectionError);
    expect(signals).toHaveLength(3);
  });

  it("does not retry a timed-out POST", async () => {
    const signals: AbortSignal[] = [];
    const t = new Transport({ baseURL: BASE, fetch: hanging(signals), timeoutMs: 5, sleep: new FakeClock().sleep });
    await expect(t.json({ method: "POST", path: "/v1/runs", json: {} })).rejects.toBeInstanceOf(APITimeoutError);
    expect(signals).toHaveLength(1);
  });

  it("forwards the caller's AbortSignal to fetch", async () => {
    const signals: AbortSignal[] = [];
    const t = new Transport({ baseURL: BASE, fetch: hanging(signals) });
    const controller = new AbortController();
    const pending = t.json({ method: "GET", path: "/v1/runs" }, { signal: controller.signal });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 1));
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(APIUserAbortError);
    expect(signals[0]?.aborted).toBe(true);
    await expect(t.json({ method: "GET", path: "/v1/runs" }, { signal: controller.signal })).rejects.toBeInstanceOf(APIUserAbortError);
  });

  it("decodes empty bodies as undefined and rejects non-JSON 2xx bodies", async () => {
    const server = new FakeServer()
      .on("DELETE", "/v1/x", new Response(null, { status: 204 }))
      .on("GET", "/v1/html", new Response("<html>", { status: 200, headers: { "x-request-id": "req_h" } }));
    await expect(transport(server).json({ method: "DELETE", path: "/v1/x" })).resolves.toBeUndefined();
    const e = await transport(server).json({ method: "GET", path: "/v1/html" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ResponseDecodeError);
    expect((e as ResponseDecodeError).requestId).toBe("req_h");
  });

  it("maps a broken body read to a connection error", async () => {
    const broken = new Response(
      new ReadableStream({
        pull: (c) => c.error(new Error("socket closed")),
      }),
      { status: 200 },
    );
    const t = new Transport({ baseURL: BASE, fetch: (async () => broken) as typeof fetch });
    await expect(t.json({ method: "GET", path: "/v1/x" })).rejects.toBeInstanceOf(APIConnectionError);
  });

  it("guards streaming bodies with an idle timeout, not the request timeout", async () => {
    const slow = new Response(
      new ReadableStream({
        start: (c) => c.enqueue(new Uint8Array([1])),
        pull: () => new Promise(() => undefined),
      }),
      { status: 200 },
    );
    const t = new Transport({ baseURL: BASE, fetch: (async (_u: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      const reader = slow.body!.getReader();
      return new Response(
        new ReadableStream({
          pull: async (c) => {
            const abort = new Promise<never>((_r, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
            const chunk = await Promise.race([reader.read(), abort]);
            if (chunk.done) c.close();
            else c.enqueue(chunk.value);
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch, timeoutMs: 1 });
    const raw = await t.raw({ method: "GET", path: "/v1/blob" }, { idleTimeoutMs: 20 });
    await new Promise((r) => setTimeout(r, 5));
    const reader = raw.body.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    await expect(reader.read()).rejects.toBeInstanceOf(APITimeoutError);
  });

  it("reports the final response's request id", async () => {
    const server = new FakeServer().on("GET", "/v1/x", json({}, 200, { "x-request-id": "req_ok" }));
    const onResponse = vi.fn();
    await transport(server).json({ method: "GET", path: "/v1/x" }, { onResponse });
    expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({ status: 200, requestId: "req_ok" }));
  });
});

describe("request building", () => {
  it("sends auth, user agent, accept and JSON content type; serializes queries", async () => {
    const server = new FakeServer().on("POST", "/base/v1/x", json({}));
    const t = new Transport({ baseURL: `${BASE}/base/`, apiKey: async () => "lazy_key", fetch: server.fetch as typeof fetch, defaultHeaders: { "x-extra": "1" } });
    await t.json({ method: "post", path: "/v1/x", json: { a: 1 }, query: [["b", true], ["c", [1, null, "z"]], ["d", undefined], ["e", { k: 1 }]], headers: [["x-h", 5], ["x-skip", undefined]] }, { headers: { "x-call": "y" } });
    const call = server.calls[0]!;
    expect(call.url.toString()).toBe(`${BASE}/base/v1/x?b=true&c=1&c=z&e=%7B%22k%22%3A1%7D`);
    expect(call.headers.get("authorization")).toBe("Bearer lazy_key");
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.headers.get("accept")).toBe("application/json");
    expect(call.headers.get("user-agent")).toMatch(/^grad-typescript\/[\d.]+ node\/v\d+/);
    expect(call.headers.get("x-extra")).toBe("1");
    expect(call.headers.get("x-call")).toBe("y");
    expect(call.headers.get("x-h")).toBe("5");
    expect(call.headers.has("x-skip")).toBe(false);
  });

  it("omits Authorization when there is no key", async () => {
    const server = new FakeServer().on("GET", "/v1/x", json({}));
    await new Transport({ baseURL: BASE, apiKey: "", fetch: server.fetch as typeof fetch }).json({ method: "GET", path: "/v1/x" });
    expect(server.calls[0]?.headers.has("authorization")).toBe(false);
  });

  it("validates base URLs and path params", () => {
    expect(() => new Transport({ baseURL: "localhost:8787" })).toThrow(/include the scheme/);
    expect(() => new Transport({ baseURL: "not a url" })).toThrow(/absolute http\(s\) URL/);
    expect(() => new Transport({ baseURL: "ftp://x" })).toThrow(/only http and https/);
    expect(() => new Transport({ baseURL: BASE, fetch: 5 as unknown as typeof fetch })).toThrow(/No fetch/);
    expect(encodePathParam("a/b@c d", "id")).toBe("a%2Fb%40c%20d");
    expect(encodePathParam(5, "step")).toBe("5");
    for (const bad of ["", ".", "..", undefined]) expect(() => encodePathParam(bad, "id")).toThrow(GradError);
  });

  it("keeps user-keyed maps verbatim while renaming declared keys", () => {
    const table = { R: { o: [["sessionId", "session_id", 0], ["scores", "scores", 0]] as Array<[string, string, 0]> } };
    expect(convertKeys(table, "R", { session_id: "s", scores: { tests_passed: 1 }, extra_key: 2 }, "decode")).toEqual({
      sessionId: "s",
      scores: { tests_passed: 1 },
      extra_key: 2,
    });
    expect(convertKeys(table, "R", { sessionId: "s", dropped: undefined }, "encode")).toEqual({ session_id: "s" });
    expect(convertKeys(table, "Missing", { a: 1 }, "decode")).toEqual({ a: 1 });
    expect(convertKeys(table, { a: "R" }, "not-an-array", "decode")).toBe("not-an-array");
    expect(convertKeys(table, { m: "R" }, [1], "decode")).toEqual([1]);
    expect(convertKeys(table, { u: { o: "R" } }, 5, "decode")).toBe(5);
    expect(convertKeys(table, "R", 7, "decode")).toBe(7);
  });

  it("exposes env and UA helpers", () => {
    process.env.GRAD_TEST_ENV_VALUE = "v";
    expect(readEnv("GRAD_TEST_ENV_VALUE")).toBe("v");
    process.env.GRAD_TEST_ENV_VALUE = "";
    expect(readEnv("GRAD_TEST_ENV_VALUE")).toBeUndefined();
    expect(defaultUserAgent()).toContain("grad-typescript/");
  });

  it("defaultSleep resolves, rejects on abort, and removes its listener", async () => {
    await expect(defaultSleep(1)).resolves.toBeUndefined();
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await defaultSleep(1, controller.signal);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    const pending = defaultSleep(1_000, controller.signal);
    controller.abort(new Error("stop"));
    await expect(pending).rejects.toThrow("stop");
    await expect(defaultSleep(1, controller.signal)).rejects.toThrow("stop");
  });
});

describe("server-sent events", () => {
  it("parses the captured metrics stream (ids, events, comments, multi-line data, CRLF)", async () => {
    const text = wire<string>("metrics.sse");
    const server = new FakeServer().on("GET", "/v1/runs/r/metrics", new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const events = [];
    for await (const e of transport(server).sse({ method: "GET", path: "/v1/runs/r/metrics" }, { lastEventId: "0" })) events.push(e);
    expect(server.calls[0]?.headers.get("last-event-id")).toBe("0");
    expect(server.calls[0]?.headers.get("accept")).toBe("text/event-stream");
    const metrics = events.filter((e) => e.event === "metric");
    expect(metrics.length).toBeGreaterThan(0);
    expect(metrics[0]?.id).toBe("1");
    expect(JSON.parse(metrics[0]?.data ?? "{}").step).toBe(1);
    expect(events[events.length - 1]?.event).toBe("status");

    const crlf = new FakeServer().on("GET", "/s", new Response(": hi\r\nretry: 1500\r\nid: 7\r\ndata: a\r\ndata: b\r\n\r\nevent: x\rdata\r\r", { status: 200 }));
    const out = [];
    for await (const e of transport(crlf).sse({ method: "GET", path: "/s" })) out.push(e);
    expect(out).toEqual([
      { event: "message", data: "a\nb", id: "7", retry: 1500 },
      { event: "x", data: "", id: "7", retry: undefined },
    ]);
  });
});
