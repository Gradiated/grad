import { createHash } from "node:crypto";

import type { AuthAdapter, AuthPrincipal } from "../adapters.js";
import type { Clock } from "../clock.js";
import { ApiError, errorMessage } from "../errors.js";
import { metrics } from "../telemetry/metrics.js";
import type { AuthView, AuthViewRow } from "./auth-view.js";
import { looksLikeJwt, type JwtClaims, type JwtVerifier } from "./jwt.js";
import {
  authenticateWorkerFirst,
  type WorkerAuthenticator,
} from "../worker-auth/principal.js";
import { cloudPrincipal, isCloudRole } from "./roles.js";

const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface CloudAuthOptions {
  view: AuthView;
  jwt: JwtVerifier;
  clock: Clock;
  /** Worker credentials are grad-local (static, Kubernetes, lease) and never touch the view. */
  workers: WorkerAuthenticator;
  cache?: {
    positiveTtlMs?: number;
    negativeTtlMs?: number;
    maxEntries?: number;
  };
}

interface CacheEntry {
  principal: AuthPrincipal | null;
  /** A key whose principal is not active (403). */
  refused?: ApiError | undefined;
  expiresAt: number;
}

const keySuspended = () =>
  new ApiError(
    403,
    "workspace_suspended",
    "Forbidden",
    "This API key's organization or workspace is suspended, or its creator is no longer an active member.",
  );

const authUnavailable = (detail: string) =>
  new ApiError(
    503,
    "auth_unavailable",
    "Authentication service unavailable",
    detail,
  );

/** A console JWT's principal: a member of `ws` with `role`; service tokens are internal only. */
export const principalOfClaims = (claims: JwtClaims): AuthPrincipal | null => {
  const ws = claims.ws;
  if (
    typeof ws !== "string" ||
    !WORKSPACE_ID_RE.test(ws) ||
    typeof claims.org !== "string" ||
    !isCloudRole(claims.role) ||
    !claims.sub.startsWith("user:")
  ) {
    return null;
  }
  const scopes = Array.isArray(claims.scopes)
    ? claims.scopes.filter((s): s is string => typeof s === "string")
    : null;

  return cloudPrincipal({
    workspaceId: ws,
    actor: claims.sub,
    role: claims.role,
    scopes,
  });
};

const principalOfRow = (row: AuthViewRow, now: Date): AuthPrincipal | null => {
  if (row.expires_at && row.expires_at.getTime() <= now.getTime()) return null;
  if (!WORKSPACE_ID_RE.test(row.workspace_id) || !isCloudRole(row.role)) {
    return null;
  }

  return cloudPrincipal({
    workspaceId: row.workspace_id,
    actor: row.actor || `key:${row.api_key_id}`,
    role: row.role,
    scopes: row.scopes,
  });
};

/**
 * Gradiated Cloud auth. A JWT is verified locally (JWKS); any other token is
 * a `grad_` key, looked up by SHA-256 in the product's read-only
 * `auth_principals_v1` view and cached in-process (5 s either way, bounded
 * LRU; no revocation push). With the database unreachable, an uncached key
 * gets 503 auth_unavailable: auth fails closed.
 */
export const createCloudAuth = (options: CloudAuthOptions): AuthAdapter => {
  const { clock, view, jwt } = options;
  const positiveTtlMs = options.cache?.positiveTtlMs ?? 5_000;
  const negativeTtlMs = options.cache?.negativeTtlMs ?? 5_000;
  const maxEntries = options.cache?.maxEntries ?? 10_000;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<AuthPrincipal | null>>();

  const remember = (
    key: string,
    principal: AuthPrincipal | null,
    refused?: ApiError,
  ): void => {
    cache.delete(key);
    cache.set(key, {
      principal,
      refused,
      expiresAt:
        clock.now().getTime() + (principal ? positiveTtlMs : negativeTtlMs),
    });
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value as string;
      cache.delete(oldest);
    }
  };

  const lookup = async (
    digest: Buffer,
    key: string,
  ): Promise<AuthPrincipal | null> => {
    let row: AuthViewRow | null;
    try {
      row = await view.find(digest);
    } catch (error) {
      metrics.cloudAuthLookups.inc({ result: "error" });
      throw authUnavailable(
        `Could not check the API key with Gradiated Cloud: ${errorMessage(error)}`,
      );
    }
    if (row && row.status !== "active") {
      metrics.cloudAuthLookups.inc({ result: "inactive" });
      const refused = keySuspended();
      remember(key, null, refused);
      throw refused;
    }
    const principal = row ? principalOfRow(row, clock.now()) : null;
    metrics.cloudAuthLookups.inc({ result: principal ? "found" : "not_found" });
    remember(key, principal);

    return principal;
  };

  const apiKey = async (token: string): Promise<AuthPrincipal | null> => {
    const digest = createHash("sha256").update(token).digest();
    const key = digest.toString("hex");
    const hit = cache.get(key);
    if (hit && hit.expiresAt > clock.now().getTime()) {
      // Refresh recency: the LRU evicts the least recently used key.
      cache.delete(key);
      cache.set(key, hit);
      if (hit.refused) throw hit.refused;
      return hit.principal;
    }
    // Concurrent requests with one key share one query.
    let pending = inFlight.get(key);
    if (!pending) {
      pending = lookup(digest, key).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
    }

    return pending;
  };

  return {
    authenticate: async (bearerToken) => {
      const token = bearerToken?.trim();
      if (!token) return null;

      const viaJwt = async () => {
        const claims = await jwt.verify(token);
        return claims ? principalOfClaims(claims) : null;
      };
      // A Cloud JWT never goes to the worker authenticators (a Kubernetes
      // TokenReview per console request): its issuer says whose it is.
      if (looksLikeJwt(token) && jwt.issuedHere(token)) return viaJwt();

      return authenticateWorkerFirst(options.workers, token, () =>
        looksLikeJwt(token) ? viaJwt() : apiKey(token),
      );
    },
  };
};
