import { errorMessage } from "../errors.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Plain HTTP is allowed to loopback and to in-cluster Services only. */
const allowsHttp = (host: string): boolean =>
  LOOPBACK_HOSTS.has(host) ||
  host.endsWith(".svc") ||
  host.endsWith(".svc.cluster.local");

/**
 * Validates a Gradiated Cloud endpoint setting: https, or http to loopback or
 * a cluster-internal Service (`*.svc`, `*.svc.cluster.local`); never embedded
 * credentials. Returns the URL without a trailing slash.
 */
export const cloudUrl = (setting: string, raw: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`${setting} is not a URL: '${raw}'.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${setting} must not contain credentials.`);
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === "http:" && !allowsHttp(host)) {
    throw new Error(
      `${setting} must use https:// (plain http is allowed only to loopback or a cluster-internal *.svc host, not '${host}').`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${setting} must be an http(s) URL.`);
  }

  return parsed.toString().replace(/\/+$/, "");
};

/** The Cloud endpoint could not be reached (network error or timeout). */
class CloudUnreachableError extends Error {}

export interface CloudResponse {
  status: number;
  headers: Headers;
  json: Record<string, unknown>;
}

/**
 * One JSON request to a Cloud endpoint: bearer `token`, a timeout, no
 * redirects (a redirect could carry the token elsewhere). A non-JSON body
 * becomes `{detail: <text>}`.
 */
export const cloudRequest = async (
  fetchFn: typeof fetch,
  url: string,
  init: {
    method?: "GET" | "POST";
    token?: string | undefined;
    body?: unknown;
    headers?: Record<string, string>;
    timeoutMs: number;
  },
): Promise<CloudResponse> => {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...init.headers,
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  let resp: Response;
  try {
    resp = await fetchFn(url, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: "error",
      signal: AbortSignal.timeout(init.timeoutMs),
    });
  } catch (error) {
    throw new CloudUnreachableError(
      `${new URL(url).pathname} unreachable: ${errorMessage(error)}`,
    );
  }

  const text = await resp.text().catch(() => "");
  let json: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      const decoded = JSON.parse(text) as unknown;
      json =
        decoded && typeof decoded === "object" && !Array.isArray(decoded)
          ? (decoded as Record<string, unknown>)
          : { detail: text };
    } catch {
      json = { detail: text.slice(0, 500) };
    }
  }

  return { status: resp.status, headers: resp.headers, json };
};

export const isOk = (status: number): boolean => status >= 200 && status < 300;

export const detailOf = (res: CloudResponse): string =>
  typeof res.json.detail === "string" ? `: ${res.json.detail}` : "";
