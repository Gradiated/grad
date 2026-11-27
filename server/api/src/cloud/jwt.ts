import { createPublicKey, verify, type KeyObject } from "node:crypto";

import type { Clock } from "../clock.js";
import { ApiError, errorMessage } from "../errors.js";
import { cloudRequest, isOk } from "./http.js";

/**
 * Verifies Gradiated Cloud JWTs (Better Auth's jwt() plugin) locally against
 * the control plane's JWKS: no network call per request. The key set is
 * fetched once, cached, re-fetched every `refreshMs` and on an unknown `kid`
 * (at most once per `minRefetchMs`).
 */

/** Asymmetric algorithms only; Better Auth signs EdDSA (Ed25519) by default. */
export const JWT_ALGORITHMS = ["EdDSA", "ES256", "RS256"] as const;
type JwtAlgorithm = (typeof JWT_ALGORITHMS)[number];

export interface JwtClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  [claim: string]: unknown;
}

export interface JwtVerifier {
  /** The verified claims, or null for a token that is not valid. Throws 503 when the key set is unavailable. */
  verify(token: string): Promise<JwtClaims | null>;
  /** Whether the token claims (unverified) to come from this issuer. */
  issuedHere(token: string): boolean;
}

export interface JwtVerifierOptions {
  jwksUrl: string;
  issuer: string;
  audience: string;
  clock: Clock;
  fetchImpl?: typeof fetch;
  /** Tolerated clock skew on exp/nbf (default 60 s). */
  skewSeconds?: number;
  refreshMs?: number;
  minRefetchMs?: number;
  timeoutMs?: number;
}

/** A token is a JWT when it is three base64url segments, the first a JSON header. */
export const looksLikeJwt = (token: string): boolean =>
  /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

const b64json = (segment: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(
      Buffer.from(segment, "base64url").toString("utf8"),
    ) as unknown;

    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

interface Jwk {
  kid?: unknown;
  kty?: unknown;
  crv?: unknown;
  alg?: unknown;
  use?: unknown;
  [field: string]: unknown;
}

/** The algorithm a JWK may verify, from its key type (and `alg` when set). */
const algorithmOf = (jwk: Jwk): JwtAlgorithm | null => {
  const alg =
    jwk.kty === "OKP" && jwk.crv === "Ed25519"
      ? "EdDSA"
      : jwk.kty === "EC" && jwk.crv === "P-256"
        ? "ES256"
        : jwk.kty === "RSA"
          ? "RS256"
          : null;
  if (!alg || (jwk.alg !== undefined && jwk.alg !== alg)) return null;
  if (jwk.use !== undefined && jwk.use !== "sig") return null;

  return alg;
};

interface VerifyKey {
  alg: JwtAlgorithm;
  key: KeyObject;
}

const parseJwks = (body: Record<string, unknown>): Map<string, VerifyKey> => {
  const keys = new Map<string, VerifyKey>();
  for (const jwk of Array.isArray(body.keys) ? (body.keys as Jwk[]) : []) {
    if (!jwk || typeof jwk !== "object" || typeof jwk.kid !== "string")
      continue;
    const alg = algorithmOf(jwk);
    if (!alg) continue;
    try {
      // Public material only: a JWK carrying a private part is refused.
      if ("d" in jwk) continue;
      const key = createPublicKey({ key: jwk as never, format: "jwk" });
      if (
        alg === "RS256" &&
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        continue;
      keys.set(jwk.kid, { alg, key });
    } catch {
      continue;
    }
  }

  return keys;
};

const verifySignature = (
  { alg, key }: VerifyKey,
  data: Buffer,
  signature: Buffer,
): boolean => {
  try {
    if (alg === "EdDSA") return verify(null, data, key, signature);
    if (alg === "ES256") {
      return verify(
        "sha256",
        data,
        { key, dsaEncoding: "ieee-p1363" },
        signature,
      );
    }

    return verify("sha256", data, key, signature);
  } catch {
    return false;
  }
};

const authUnavailable = (detail: string) =>
  new ApiError(
    503,
    "auth_unavailable",
    "Authentication service unavailable",
    detail,
  );

export const createJwtVerifier = (options: JwtVerifierOptions): JwtVerifier => {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const skew = options.skewSeconds ?? 60;
  const refreshMs = options.refreshMs ?? 600_000;
  const minRefetchMs = options.minRefetchMs ?? 30_000;
  let keys: Map<string, VerifyKey> | null = null;
  let fetchedAt = 0;
  let attemptedAt = -Infinity;
  let inFlight: Promise<void> | null = null;

  const fetchKeys = async (): Promise<void> => {
    attemptedAt = options.clock.now().getTime();
    const res = await cloudRequest(fetchFn, options.jwksUrl, {
      timeoutMs: options.timeoutMs ?? 5_000,
    });
    if (!isOk(res.status)) {
      throw new Error(`the JWKS endpoint returned HTTP ${res.status}`);
    }
    keys = parseJwks(res.json);
    fetchedAt = options.clock.now().getTime();
  };

  /** Refetches once at a time; a failure keeps the cached keys. */
  const refetch = async (): Promise<void> => {
    inFlight ??= fetchKeys().finally(() => {
      inFlight = null;
    });
    try {
      await inFlight;
    } catch (error) {
      if (!keys) {
        throw authUnavailable(
          `Could not fetch the Gradiated Cloud signing keys: ${errorMessage(error)}`,
        );
      }
    }
  };

  const keyFor = async (kid: string): Promise<VerifyKey | null> => {
    const now = options.clock.now().getTime();
    const canRefetch = now - attemptedAt >= minRefetchMs;
    if (!keys || (now - fetchedAt >= refreshMs && canRefetch)) {
      await refetch();
    }
    const known = keys?.get(kid);
    if (known) return known;
    // A key rotated in since the last fetch: refetch, rate-limited.
    if (options.clock.now().getTime() - attemptedAt >= minRefetchMs) {
      await refetch();
    }

    return keys?.get(kid) ?? null;
  };

  return {
    issuedHere: (token) =>
      b64json(token.split(".")[1] ?? "")?.iss === options.issuer,
    verify: async (token) => {
      const parts = token.split(".");
      if (parts.length !== 3 || !looksLikeJwt(token)) return null;
      const [rawHeader, rawPayload, rawSignature] = parts as [
        string,
        string,
        string,
      ];
      const header = b64json(rawHeader);
      if (
        !header ||
        typeof header.kid !== "string" ||
        !(JWT_ALGORITHMS as readonly unknown[]).includes(header.alg) ||
        header.crit !== undefined
      ) {
        return null;
      }

      const key = await keyFor(header.kid);
      // The header's alg must be the one the key is for (no alg confusion).
      if (!key || key.alg !== header.alg) return null;
      if (
        !verifySignature(
          key,
          Buffer.from(`${rawHeader}.${rawPayload}`, "ascii"),
          Buffer.from(rawSignature, "base64url"),
        )
      ) {
        return null;
      }

      const claims = b64json(rawPayload);
      if (!claims) return null;
      const now = options.clock.now().getTime() / 1000;
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (
        claims.iss !== options.issuer ||
        !audiences.includes(options.audience) ||
        typeof claims.sub !== "string" ||
        typeof claims.exp !== "number" ||
        claims.exp + skew <= now ||
        (claims.nbf !== undefined &&
          (typeof claims.nbf !== "number" || claims.nbf - skew > now))
      ) {
        return null;
      }

      return claims as JwtClaims;
    },
  };
};
