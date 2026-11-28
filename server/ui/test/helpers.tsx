import { readFileSync } from "node:fs";
import path from "node:path";

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dir = path.join(import.meta.dirname, "fixtures");
/** Wire JSON captured from the harness (tests/harness/stack.ts, reference worker). */
export const fixture = <T = Record<string, unknown>,>(name: string): T => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as T;
export const fixtureText = (name: string): string => readFileSync(path.join(dir, name), "utf8");

type Handler = (req: { method: string; url: URL; headers: Headers; body: string | undefined }) => Response | Promise<Response> | undefined;

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json", "x-request-id": "req_test" } });

export const problem = (status: number, code: string, detail = code): Response => json({ type: `https://gradiated.com/problems/${code}`, title: code, status, detail, code, request_id: "req_test" }, status);

export const sse = (text: string): Response => new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });

export interface FakeServer {
  fetch: typeof fetch;
  calls: { method: string; path: string; auth: string | null; body: string | undefined }[];
}

/** A fetch that routes `METHOD /path` to handlers; unmatched requests are 404 route_not_found. */
export const fakeServer = (routes: Record<string, Handler | unknown>, opts: { key?: string } = {}): FakeServer => {
  const calls: FakeServer["calls"] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    const method = req.method;
    const body = method === "GET" || method === "HEAD" ? undefined : await req.text();
    const auth = req.headers.get("authorization");
    calls.push({ method, path: url.pathname + url.search, auth, body });
    if (opts.key !== undefined && auth !== `Bearer ${opts.key}`) return problem(401, "unauthorized");
    for (const [pattern, handler] of Object.entries(routes)) {
      const [m, p] = pattern.split(" ") as [string, string];
      if (m !== method) continue;
      const re = new RegExp(`^${p.replace(/:[a-z_]+/g, "[^/]+")}$`);
      if (!re.test(url.pathname)) continue;
      const out = typeof handler === "function" ? await (handler as Handler)({ method, url, headers: req.headers, body }) : json(handler);
      if (out) return out;
    }
    return problem(404, "route_not_found");
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
};

export interface Mounted {
  container: HTMLElement;
  root: Root;
  unmount: () => void;
}

export const mount = async (node: ReactNode): Promise<Mounted> => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
};

/** Flushes pending promises and timers until `check` passes (or times out). */
export const waitFor = async (check: () => boolean | void, timeoutMs = 2000): Promise<void> => {
  const end = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      if (check() !== false) return;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() > end) throw lastError instanceof Error ? lastError : new Error("waitFor timed out");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
};

export const click = async (el: Element | null | undefined): Promise<void> => {
  if (!el) throw new Error("click: no element");
  await act(async () => {
    (el as HTMLElement).click();
  });
};

export const type = async (el: Element | null | undefined, value: string): Promise<void> => {
  const input = el as HTMLInputElement | null;
  if (!input) throw new Error("type: no element");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

export const byText = (root: ParentNode, selector: string, text: string | RegExp): HTMLElement | undefined =>
  [...root.querySelectorAll<HTMLElement>(selector)].find((e) => (typeof text === "string" ? e.textContent?.includes(text) : text.test(e.textContent ?? "")));

/** A `#key=` handoff shows the sign-in form filled in: confirm it, as the user would. */
export const confirmHandoff = async (container: HTMLElement): Promise<void> => {
  await waitFor(() => {
    if (!container.textContent?.includes("This link signs you in")) throw new Error("no #key= handoff form yet");
  }, 20_000);
  await click(container.querySelector("button[type=submit]"));
};
