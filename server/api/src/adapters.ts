import { createHash, timingSafeEqual } from "node:crypto";

import type { ApiKeyScope, Artifact, ChatMessage, Scope } from "./contracts.js";
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

export interface BillingAdapter {
  checkCanStartRun(
    workspaceId: string,
    estimatedCostUsd: number,
  ): Promise<{ allowed: boolean; reason?: string }>;
  /** Must be idempotent on `idempotencyKey`; throws to request a retry. */
  recordRunUsage(input: {
    workspaceId: string;
    runId: string;
    attempt: number;
    tokensProcessed: number;
    costUsd: number;
    idempotencyKey: string;
  }): Promise<void>;
}

export interface DeployAdapter {
  readonly mode: "disabled" | "cloud";
  publishAndPromote(input: {
    workspaceId: string;
    name: string;
    artifact: Artifact & { storage_key: string };
    fallbackModel: string | null;
  }): Promise<{ modelId: string }>;
}

export interface RouteDecision {
  model: string;
  is_exploration: boolean;
  confidence: number;
  scores: Record<string, number>;
}

export interface ServingAdapter {
  readonly mode: "disabled" | "cloud";
  route(input: {
    workspaceId: string;
    inferenceId: string;
    deploymentName: string;
    modelId: string;
    artifactId: string;
    fallbackModel: string | null;
    exploreRate: number;
    messages: readonly ChatMessage[];
    tools?: ReadonlyArray<Record<string, unknown>> | undefined;
    sessionId?: string | undefined;
  }): Promise<RouteDecision>;
  embed(input: {
    workspaceId: string;
    deploymentName: string;
    modelId: string;
    inputs: readonly string[];
  }): Promise<{
    embeddings: number[][];
    usage: { prompt_tokens: number; total_tokens: number };
  }>;
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
  recordRunUsage: async () => undefined,
});

const DEPLOY_HINT =
  "Hosted serving is disabled on this self-hosted server (DEPLOY_MODE=disabled). Download the artifact with `grad artifacts download <id> --output ./adapter` and serve it with vLLM or SGLang (`vllm serve <base> --enable-lora --lora-modules name=./adapter`).";

export const DEPLOY_DISABLED_DETAIL = DEPLOY_HINT;

export const createDisabledDeployAdapter = (): DeployAdapter => ({
  mode: "disabled",
  publishAndPromote: async () => {
    throw new Error(DEPLOY_HINT);
  },
});

export const createDisabledServingAdapter = (): ServingAdapter => ({
  mode: "disabled",
  route: async () => {
    throw new Error(DEPLOY_HINT);
  },
  embed: async () => {
    throw new Error(DEPLOY_HINT);
  },
});
