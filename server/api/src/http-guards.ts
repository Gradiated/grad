import type { Context, MiddlewareHandler, Next } from "hono";
import { isIP } from "node:net";

/** Request bodies past this size are parsed a few at a time (see `largeBodyGate`). */
export const LARGE_BODY_BYTES = 1024 * 1024;

/**
 * At most `slots` large request bodies are handled at once per replica; the
 * rest wait their turn. A parsed JSON push costs about ten times its size in
 * heap, so a few concurrent 32 MiB pushes would OOM a 1 GiB API pod for every
 * tenant on it. Bodyless requests and small bodies are never held up.
 */
export const largeBodyGate = (slots: number): MiddlewareHandler => {
  let free = slots;
  const waiting: Array<() => void> = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else free += 1;
  };

  return async (c: Context, next: Next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return next();
    }
    const length = Number(c.req.header("content-length") ?? NaN);
    // No Content-Length (chunked) is treated as large: it can be.
    if (Number.isFinite(length) && length <= LARGE_BODY_BYTES) return next();

    if (free > 0) free -= 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      await next();
    } finally {
      release();
    }
  };
};

/** Names a public DNS name can't be: what a DNS-rebinding page can never put in Host. */
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".svc"];

const isLocalHostname = (hostname: string): boolean => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return true;
  if (host === "localhost" || !host.includes(".")) return true;

  return (
    LOCAL_SUFFIXES.some((s) => host.endsWith(s)) ||
    host.endsWith(".svc.cluster.local")
  );
};

/**
 * AUTH_MODE=none makes every request a platform admin, so a web page the
 * developer visits must not be able to drive the server: requests whose Host
 * is a public DNS name (DNS rebinding) and cross-site browser requests (a
 * no-preflight `text/plain` POST) are refused. CLI, SDK and worker requests
 * carry neither, and the bundled web UI is same-origin.
 */
export const unauthenticatedGuard = (
  allowedOrigins: readonly string[],
  refuse: (c: Context, code: string, detail: string) => Response,
): MiddlewareHandler => {
  return async (c, next) => {
    const url = new URL(c.req.url);
    if (!isLocalHostname(url.hostname)) {
      return refuse(
        c,
        "host_not_allowed",
        `AUTH_MODE=none answers only loopback, IP-literal and single-label host names, not '${url.hostname}' (a public name may be a DNS-rebinding page). Use AUTH_MODE=api_key to serve a domain.`,
      );
    }
    const origin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    const crossSite =
      site === "cross-site" ||
      site === "same-site" ||
      (origin !== undefined && origin !== url.origin);
    // A link from another site opens the UI: the page, not the attacker, reads it.
    const navigation =
      c.req.method === "GET" && c.req.header("sec-fetch-mode") === "navigate";
    if (
      crossSite &&
      !navigation &&
      !(origin && allowedOrigins.includes(origin))
    ) {
      return refuse(
        c,
        "cross_site_request",
        "AUTH_MODE=none refuses browser requests from other sites: every request here is a platform admin.",
      );
    }

    return next();
  };
};
