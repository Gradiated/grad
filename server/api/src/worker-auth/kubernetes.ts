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

import type { WorkerJobKind } from "../adapters.js";
import type { Clock } from "../clock.js";
import { ApiError, errorMessage } from "../errors.js";
import { log } from "../telemetry/log.js";
import type { WorkerAuthenticator, WorkerPrincipal } from "./principal.js";

/** The audience worker tokens are minted for; tokens for any other audience fail review. */
export const WORKER_TOKEN_AUDIENCE = "grad";

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

/** The `exp` claim of a token the API server has just authenticated (only used to bound caching). */
const jwtExpiry = (token: string): Date | undefined => {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { exp?: unknown };

    return typeof payload.exp === "number"
      ? new Date(payload.exp * 1000)
      : undefined;
  } catch {
    return undefined;
  }
};

export const createKubernetesWorkerAuth = (options: {
  /** `<namespace>/<name>` -> kinds (GRAD_WORKER_K8S_SERVICE_ACCOUNTS). */
  serviceAccounts: Readonly<Record<string, readonly WorkerJobKind[]>>;
  review: TokenReviewer;
  clock: Clock;
  /** Longest a positive review is reused (default 60 s; never past the token's exp). */
  cacheTtlMs?: number;
  maxCacheEntries?: number;
}): WorkerAuthenticator => {
  const ttlMs = options.cacheTtlMs ?? 60_000;
  const maxEntries = options.maxCacheEntries ?? 1_000;
  const cache = new Map<
    string,
    { principal: WorkerPrincipal; until: number }
  >();
  const warned = new Set<string>();

  const review = async (token: string): Promise<WorkerPrincipal | null> => {
    let status: TokenReviewStatus;
    try {
      status = await options.review(token, [WORKER_TOKEN_AUDIENCE]);
    } catch (error) {
      log("error", "kubernetes TokenReview failed", {
        error: errorMessage(error),
      });
      throw new ApiError(
        503,
        "worker_auth_unavailable",
        "Worker authentication unavailable",
        "grad-server could not verify the worker's service-account token with the Kubernetes API (TokenReview); retry shortly.",
      );
    }
    if (status.authenticated !== true) return null;
    if (!(status.audiences ?? []).includes(WORKER_TOKEN_AUDIENCE)) return null;
    const match = SA_USER_RE.exec(status.user?.username ?? "");
    if (!match) return null;
    const account = `${match[1]}/${match[2]}`;
    const kinds = options.serviceAccounts[account];
    if (!kinds) {
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

    return {
      kinds,
      identity: pod ? `k8s:${account}/${pod}` : `k8s:${account}`,
      expiresAt: jwtExpiry(token),
    };
  };

  return {
    mode: "kubernetes",
    authenticate: async (token) => {
      // Only JWTs go to the API server: static keys and lease tokens never leave grad-server.
      if (token.length > 16_384 || !JWT_RE.test(token)) return null;
      const now = options.clock.now().getTime();
      const key = createHash("sha256").update(token).digest("hex");
      const hit = cache.get(key);
      if (hit && hit.until > now) return hit.principal;
      if (hit) cache.delete(key);

      const principal = await review(token);
      const exp = principal?.expiresAt?.getTime();
      if (principal && exp !== undefined && exp > now) {
        if (cache.size >= maxEntries) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(key, { principal, until: Math.min(exp, now + ttlMs) });
      }

      return principal;
    },
  };
};
