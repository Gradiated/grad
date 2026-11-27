import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Grad, type GradOptions } from "../src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../../..");
export const wireDir = path.join(repoRoot, "tests", "fixtures", "wire");

/** A shared wire fixture (tests/fixtures/wire). */
export const wire = <T = Record<string, unknown>>(name: string): T =>
  (name.endsWith(".json") ? JSON.parse(readFileSync(path.join(wireDir, name), "utf8")) : readFileSync(path.join(wireDir, name), "utf8")) as T;

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
  rawBody: unknown;
}

export type Reply = Response | ((call: Call) => Response | Promise<Response>);

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": `req_${status}`, ...headers },
  });

export const problemFixture = (name: string): Response => {
  const p = wire<{ status: number; headers: Record<string, string>; body: unknown }>(`problem-${name}.json`);
  return new Response(JSON.stringify(p.body), { status: p.status, headers: p.headers });
};

/**
 * A fake fetch that routes `METHOD /path` to queued replies (FIFO per route;
 * the last reply repeats) and records every call. It refuses to serve more
 * than `maxCalls` requests, so every fake is finite.
 */
export class FakeServer {
  readonly calls: Call[] = [];
  private readonly routes = new Map<string, Reply[]>();

  /** Hard cap on requests, so a client bug that loops fails the test instead of running forever. */
  constructor(private readonly maxCalls = 500) {}

  on(method: string, pathname: string, ...replies: Reply[]): this {
    this.routes.set(`${method.toUpperCase()} ${pathname}`, replies);
    return this;
  }

  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const rawBody = init.body;
    const body = typeof rawBody === "string" ? rawBody : undefined;
    const call: Call = { method, url, headers, body, rawBody };
    if (this.calls.length >= this.maxCalls) throw new Error(`FakeServer: more than ${this.maxCalls} requests; the client is looping.`);
    this.calls.push(call);
    if (init.signal?.aborted) throw init.signal.reason;
    const key = `${method} ${url.pathname}`;
    const queue = this.routes.get(key);
    if (!queue || queue.length === 0) {
      return json({ type: "about:blank", title: "Route not found", status: 404, detail: `no fake for ${key}`, code: "route_not_found", request_id: "req_fake" }, 404);
    }
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    return typeof reply === "function" ? reply(call) : (reply as Response).clone();
  };

  callsTo(method: string, pathname: string): Call[] {
    return this.calls.filter((c) => c.method === method.toUpperCase() && c.url.pathname === pathname);
  }

  lastBody<T = Record<string, unknown>>(method: string, pathname: string): T {
    const calls = this.callsTo(method, pathname);
    const last = calls[calls.length - 1];
    if (!last?.body) throw new Error(`no body sent to ${method} ${pathname}`);
    return JSON.parse(last.body) as T;
  }
}

/** A fake clock: sleeps resolve immediately and advance `now`; durations are recorded. */
export class FakeClock {
  time = 1_700_000_000_000;
  readonly sleeps: number[] = [];

  readonly sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) throw signal.reason;
    this.sleeps.push(ms);
    this.time += ms;
    await Promise.resolve();
  };

  readonly now = (): number => this.time;
}

export const BASE = "http://grad.test";

export const makeGrad = (server: FakeServer, extra: GradOptions = {}): { grad: Grad; clock: FakeClock } => {
  const clock = new FakeClock();
  const grad = new Grad({
    baseURL: BASE,
    apiKey: "grad_test_key",
    fetch: server.fetch as typeof fetch,
    sleep: clock.sleep,
    now: clock.now,
    random: () => 0.5,
    ...extra,
  });
  return { grad, clock };
};
