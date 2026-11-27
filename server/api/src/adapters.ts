import { createHash, timingSafeEqual } from "node:crypto";

import type { ApiKeyScope, Scope, UsageRecord } from "./contracts.js";
import { PLATFORM_SCOPES } from "./contracts.js";
import type { KeyLookupResult } from "./store/types.js";

export interface AuthPrincipal {
  kind: "workspace" | "worker" | "dev";
  workspaceId: string;
  actor: string;
  scopes: readonly Scope[];
  /** Bootstrap/platform administrator (may mint keys in any configured way). */
  isPlatformAdmin: boolean;
  /**
   * Trainer workers only: the single workspace this worker may serve, or null
   * for a platform worker that serves every workspace.
   */
  workerWorkspaceId: string | null;
}

export interface AuthAdapter {
  /** Returns null for an invalid token; throws ApiError(503) when unavailable. */
  authenticate(bearerToken: string | undefined): Promise<AuthPrincipal | null>;
}

/** A usage ledger row as the Cloud exporter sends it. */
export type ExportedUsage = UsageRecord & { seq: number; workspace_id: string };

export interface BillingAdapter {
  checkCanStartRun(
    workspaceId: string,
    estimatedCostUsd: number,
  ): Promise<{ allowed: boolean; reason?: string }>;
  /**
   * Cloud only: false when the workspace is out of balance or over its limit,
   * so running jobs are told to stop (insufficient_balance). Absent: never.
   */
  canContinue?(workspaceId: string): Promise<boolean>;
  /**
   * Cloud only: pushes ledger rows to Cloud billing, each keyed by its
   * idempotency key (exactly once there). `cursor` is the highest seq Cloud
   * has. Absent on self-hosted servers: the ledger stays local.
   */
  usageExport?: {
    cursor(): Promise<number>;
    push(row: ExportedUsage): Promise<void>;
  };
}

export const hashApiKey = (rawKey: string): string =>
  createHash("sha256").update(rawKey).digest("hex");

const HEX_64_RE = /^[0-9a-f]{64}$/i;

const safeDigestEqual = (hexA: string, hexB: string): boolean => {
  if (!HEX_64_RE.test(hexA) || !HEX_64_RE.test(hexB)) return false;

  return timingSafeEqual(Buffer.from(hexA, "hex"), Buffer.from(hexB, "hex"));
};

const isPlatformScope = (scope: Scope): boolean =>
  (PLATFORM_SCOPES as readonly string[]).includes(scope);

/**
 * Scope check. `admin` implies every workspace scope and `x:write` implies
 * `x:read`, but platform scopes (`trainer:worker`) are never implied.
 */
export const hasScope = (
  principal: AuthPrincipal,
  required: Scope,
): boolean => {
  if (principal.scopes.includes(required)) return true;
  if (isPlatformScope(required)) return false;
  if (principal.scopes.includes("admin")) return true;

  if (required.endsWith(":read")) {
    const write = `${required.slice(0, -":read".length)}:write` as Scope;
    return principal.scopes.includes(write);
  }

  return false;
};

/** Development only: every request is a platform admin and trainer worker. */
export const createLocalNoneAuth = (workspaceId = "local"): AuthAdapter => ({
  authenticate: async () => ({
    kind: "dev",
    workspaceId,
    actor: "local-dev",
    scopes: ["admin", "trainer:worker"],
    isPlatformAdmin: true,
    workerWorkspaceId: null,
  }),
});

export interface KeyLookup {
  findActiveByHash(keyHash: string): Promise<KeyLookupResult | null>;
}

const assertDigest = (name: string, value: string | undefined): void => {
  if (value !== undefined && !HEX_64_RE.test(value)) {
    throw new Error(`${name} must be a 64-character SHA-256 hex digest.`);
  }
};

/**
 * Checks a bearer token against the platform trainer key (`trainerKeyHash`);
 * shared by the local and Cloud auth adapters so worker keys never depend on
 * workspace key storage.
 */
export const matchTrainerKey = (
  token: string,
  trainerKeyHash: string | undefined,
): AuthPrincipal | null => {
  if (!trainerKeyHash || !safeDigestEqual(hashApiKey(token), trainerKeyHash)) {
    return null;
  }

  return {
    kind: "worker",
    workspaceId: "_platform",
    actor: "trainer-worker",
    scopes: ["trainer:worker"],
    isPlatformAdmin: false,
    workerWorkspaceId: null,
  };
};

export const createLocalApiKeyAuth = (options: {
  adminKeyHash?: string | undefined;
  trainerKeyHash?: string | undefined;
  workspaceId?: string;
  lookup: KeyLookup;
}): AuthAdapter => {
  const defaultWorkspaceId = options.workspaceId ?? "default";
  assertDigest("adminKeyHash", options.adminKeyHash);
  assertDigest("trainerKeyHash", options.trainerKeyHash);

  return {
    authenticate: async (bearerToken) => {
      const token = bearerToken?.trim();
      if (!token) return null;

      const worker = matchTrainerKey(token, options.trainerKeyHash);
      if (worker) return worker;

      const digest = hashApiKey(token);
      if (
        options.adminKeyHash &&
        safeDigestEqual(digest, options.adminKeyHash)
      ) {
        return {
          kind: "workspace",
          workspaceId: defaultWorkspaceId,
          actor: "bootstrap-admin",
          scopes: ["admin"],
          isPlatformAdmin: true,
          workerWorkspaceId: null,
        };
      }

      const key = await options.lookup.findActiveByHash(digest);
      if (!key) return null;

      return {
        kind: "workspace",
        workspaceId: key.workspace_id,
        actor: `key:${key.name}`,
        scopes: key.scopes as ApiKeyScope[],
        isPlatformAdmin: false,
        workerWorkspaceId: null,
      };
    },
  };
};

export const createNoopBillingAdapter = (): BillingAdapter => ({
  checkCanStartRun: async () => ({ allowed: true }),
});

/** Why the serving paths answer 501 here: they belong to Gradiated Cloud. */
export const DEPLOY_DISABLED_DETAIL =
  "Deployments are served by Gradiated Cloud (api.gradiated.com), not by grad-server. Self-hosted: download the artifact with `grad artifacts download <id> --output ./adapter` and serve it with vLLM or SGLang (`vllm serve <base> --enable-lora --lora-modules name=./adapter`).";

export const INFERENCE_DISABLED_DETAIL =
  "Routing, embeddings and feedback are served by Gradiated Cloud's inference gateway, not by grad-server. Self-hosted: serve the downloaded artifact with vLLM or SGLang, and record scores in your observability tool (`grad sources` syncs them into datasets).";
