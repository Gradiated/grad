/**
 * Kubernetes service-account tokens (GRAD_WORKER_AUTH=kubernetes): a worker
 * pod sends its projected token (audience `grad`); grad-server asks the API
 * server through the TokenReview API, with its own in-cluster credentials,
 * and maps `system:serviceaccount:<ns>:<name>` to job kinds
 * (GRAD_WORKER_K8S_SERVICE_ACCOUNTS). Unmapped accounts are rejected; an
 * unreachable API server rejects everything (503).
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";

import type { JobKind } from "../contracts.js";
import type { Clock } from "../clock.js";
import { b64json } from "../cloud/jwt.js";
import { ApiError } from "../errors.js";
import { log } from "../telemetry/log.js";
import { metrics, secondsSince } from "../telemetry/metrics.js";
import type { WorkerAuthenticator, WorkerPrincipal } from "./principal.js";

/** The audience worker tokens are minted for; tokens for any other audience fail review. */
const WORKER_TOKEN_AUDIENCE = "grad";

/** `status` of an authentication.k8s.io/v1 TokenReview. */
export interface TokenReviewStatus {
  authenticated?: boolean;
  user?: { username?: string; extra?: Record<string, string[]> };
  audiences?: string[];
  error?: string;
}

/** Sends one TokenReview; throws when the API server cannot answer. */
export type TokenReviewer = (
  token: string,
  audiences: readonly string[],
) => Promise<TokenReviewStatus>;

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/**
 * The in-cluster TokenReview client: KUBERNETES_SERVICE_HOST/PORT, the pod's
 * own service-account token (re-read per review, so kubelet rotation works)
 * and the cluster CA.
 */
export const inClusterTokenReviewer = (
  options: {
    env?: Record<string, string | undefined>;
    /** Overrides the API server URL (tests). */
    baseUrl?: string;
    tokenPath?: string;
    caPath?: string;
    timeoutMs?: number;
  } = {},
): TokenReviewer => {
  const env = options.env ?? process.env;
  const host = env.KUBERNETES_SERVICE_HOST;
  const port = env.KUBERNETES_SERVICE_PORT ?? "443";
  const base =
    options.baseUrl ??
    (host
      ? `https://${host.includes(":") ? `[${host}]` : host}:${port}`
      : undefined);
  const tokenPath = options.tokenPath ?? `${SA_DIR}/token`;
  const caPath = options.caPath ?? `${SA_DIR}/ca.crt`;
  const timeoutMs = options.timeoutMs ?? 5_000;
  let ca: Promise<Buffer | undefined> | null = null;

  return async (token, audiences) => {
    if (!base) {
      throw new Error(
        "KUBERNETES_SERVICE_HOST is not set: grad-server is not running in a Kubernetes pod",
      );
    }
    const url = new URL("/apis/authentication.k8s.io/v1/tokenreviews", base);
    const secure = url.protocol === "https:";
    const own = (await readFile(tokenPath, "utf8")).trim();
    ca ??= secure
      ? readFile(caPath).catch(() => undefined)
      : Promise.resolve(undefined);
    const caCert = await ca;
    const body = JSON.stringify({
      apiVersion: "authentication.k8s.io/v1",
      kind: "TokenReview",
      spec: { token, audiences },
    });

    const { status, text } = await new Promise<{
      status: number;
      text: string;
    }>((resolve, reject) => {
      const req = (secure ? https : http).request(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${own}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Content-Length": Buffer.byteLength(body),
          },
          timeout: timeoutMs,
          ...(caCert ? { ca: caCert } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 1024 * 1024)
              req.destroy(new Error("response too large"));
            else chunks.push(chunk);
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              text: Buffer.concat(chunks).toString("utf8"),
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("timeout", () =>
        req.destroy(new Error(`timed out after ${timeoutMs} ms`)),
      );
      req.on("error", reject);
      req.end(body);
    });
    if (status !== 200 && status !== 201) {
      throw new Error(`TokenReview answered HTTP ${status}`);
    }
    const parsed = JSON.parse(text) as { status?: TokenReviewStatus };

    return parsed.status ?? {};
  };
};

const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SA_USER_RE =
  /^system:serviceaccount:([a-z0-9][-a-z0-9]*):([a-z0-9][-.a-z0-9]*)$/;
const POD_NAME_KEY = "authentication.kubernetes.io/pod-name";

/**
 * Whether a token could pass review: a projected service-account token for
 * audience `grad`, of a mapped account, not yet expired. Anyone can forge
 * these claims, so this only keeps random and foreign JWTs (a console
 * session, a token for another audience) away from the API server.
 */
const worthReviewing = (
  claims: Record<string, unknown> | undefined,
  accounts: Readonly<Record<string, unknown>>,
  nowMs: number,
): boolean => {
  if (!claims) return false;
  const { aud, exp, sub } = claims;
  const audiences = Array.isArray(aud) ? aud : [aud];
  if (!audiences.includes(WORKER_TOKEN_AUDIENCE)) return false;
  if (typeof exp !== "number" || exp * 1000 <= nowMs) return false;
  const match = SA_USER_RE.exec(typeof sub === "string" ? sub : "");

  return match !== null && Object.hasOwn(accounts, `${match[1]}/${match[2]}`);
};

export const createKubernetesWorkerAuth = (options: {
  /** `<namespace>/<name>` -> kinds (GRAD_WORKER_K8S_SERVICE_ACCOUNTS). */
  serviceAccounts: Readonly<Record<string, readonly JobKind[]>>;
  review: TokenReviewer;
  clock: Clock;
  /** Longest a positive review is reused (default 60 s; never past the token's exp). */
  cacheTtlMs?: number;
  maxCacheEntries?: number;
  /** Most TokenReviews in flight at once (default 8); past it: 503. */
  maxInFlight?: number;
  /**
   * While reviews fail (the API server is down or reviews are saturated), a
   * token reviewed within this long still works (default 15 min; never past
   * its exp), so a control-plane blip doesn't expire every lease.
   */
  staleTtlMs?: number;
}): WorkerAuthenticator => {
  const ttlMs = options.cacheTtlMs ?? 60_000;
  const staleMs = options.staleTtlMs ?? 15 * 60_000;
  const maxEntries = options.maxCacheEntries ?? 1_000;
  const maxInFlight = options.maxInFlight ?? 8;
  let inFlight = 0;
  const cache = new Map<
    string,
    { principal: WorkerPrincipal; until: number; staleUntil: number }
  >();
  // One review per token at a time: a pod's concurrent requests share it.
  const pending = new Map<string, Promise<WorkerPrincipal | null>>();
  const warned = new Set<string>();

  const unavailable = (detail: string) =>
    new ApiError(
      503,
      "worker_auth_unavailable",
      "Worker authentication unavailable",
      detail,
    );

  /** `expMs`: the token's exp, which the API server checks before it authenticates. */
  const review = async (
    token: string,
    expMs: number,
  ): Promise<WorkerPrincipal | null> => {
    // Bounds what a flood of forged tokens can cost the API server.
    if (inFlight >= maxInFlight) {
      metrics.tokenReviews.inc({ result: "saturated" });
      throw unavailable(
        "grad-server is verifying too many service-account tokens at once; retry shortly.",
      );
    }
    let status: TokenReviewStatus;
    inFlight += 1;
    metrics.tokenReviewsInFlight.inc();
    const start = performance.now();
    try {
      status = await options.review(token, [WORKER_TOKEN_AUDIENCE]);
    } catch (error) {
      metrics.tokenReviews.inc({ result: "error" });
      log("error", "kubernetes TokenReview failed", {
        error,
      });
      throw unavailable(
        "grad-server could not verify the worker's service-account token with the Kubernetes API (TokenReview); retry shortly.",
      );
    } finally {
      inFlight -= 1;
      metrics.tokenReviewsInFlight.dec();
      metrics.tokenReviewDuration.observe(secondsSince(start));
    }
    const rejected = () => {
      metrics.tokenReviews.inc({ result: "rejected" });
      return null;
    };
    if (status.authenticated !== true) return rejected();
    if (!(status.audiences ?? []).includes(WORKER_TOKEN_AUDIENCE)) {
      return rejected();
    }
    const match = SA_USER_RE.exec(status.user?.username ?? "");
    if (!match) return rejected();
    const account = `${match[1]}/${match[2]}`;
    const kinds = options.serviceAccounts[account];
    if (!kinds) {
      metrics.tokenReviews.inc({ result: "rejected" });
      if (!warned.has(account)) {
        warned.add(account);
        log(
          "warn",
          "worker service account is not mapped to job kinds; rejected",
          { service_account: account },
        );
      }
      return null;
    }
    const pod = status.user?.extra?.[POD_NAME_KEY]?.[0];
    metrics.tokenReviews.inc({ result: "authenticated" });

    return {
      kinds,
      mode: "kubernetes",
      identity: pod ? `k8s:${account}/${pod}` : `k8s:${account}`,
      expiresAt: new Date(expMs),
    };
  };

  return {
    mode: "kubernetes",
    authenticate: async (token) => {
      // Only JWTs go to the API server: static keys and lease tokens never
      // leave grad-server, nor do JWTs that claim another audience or account.
      if (token.length > 16_384 || !JWT_RE.test(token)) return null;
      const now = options.clock.now().getTime();
      const claims = b64json(token.split(".")[1] ?? "") ?? undefined;
      if (!worthReviewing(claims, options.serviceAccounts, now)) return null;
      const key = createHash("sha256").update(token).digest("hex");
      const hit = cache.get(key);
      if (hit && hit.until > now) {
        metrics.authCache.inc({ mode: "kubernetes", result: "hit" });
        return hit.principal;
      }
      metrics.authCache.inc({ mode: "kubernetes", result: "miss" });

      const exp = (claims?.exp as number) * 1000;
      let reviewing = pending.get(key);
      if (!reviewing) {
        reviewing = review(token, exp).finally(() => pending.delete(key));
        pending.set(key, reviewing);
      }
      let principal: WorkerPrincipal | null;
      try {
        principal = await reviewing;
      } catch (error) {
        // Down or busy: a token the API server accepted lately still holds.
        if (hit && hit.staleUntil > now) return hit.principal;
        throw error;
      }

      cache.delete(key);
      if (principal) {
        if (cache.size >= maxEntries) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, {
          principal,
          until: Math.min(exp, now + ttlMs),
          staleUntil: Math.min(exp, now + staleMs),
        });
      }

      return principal;
    },
  };
};
