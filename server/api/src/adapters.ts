import { createHash, timingSafeEqual } from "node:crypto";

import type { ApiKeyScope, Artifact } from "./contracts.js";

export interface AuthPrincipal {
  workspaceId: string;
  actor: string;
  scopes: readonly ApiKeyScope[];
  isPlatformAdmin?: boolean;
}

export interface AuthAdapter {
  authenticate(bearerToken: string | undefined): Promise<AuthPrincipal | null>;
}

export interface BillingAdapter {
  checkCanStartRun(
    workspaceId: string,
    estimatedCostUsd: number,
  ): Promise<{ allowed: boolean; reason?: string }>;
  recordRunUsage(input: {
    workspaceId: string;
    runId: string;
    tokensProcessed: number;
    costUsd: number;
  }): Promise<void>;
}

export interface DeployAdapter {
  enabled: boolean;
  publishAndPromote(input: {
    workspaceId: string;
    name: string;
    artifact: Artifact;
    fallbackModel: string | null;
  }): Promise<{ modelId: string }>;
}

export const hashApiKey = (rawKey: string): string =>
  createHash("sha256").update(rawKey).digest("hex");

const HEX_64_RE = /^[0-9a-f]{64}$/i;

const safeDigestEqual = (hexA: string, hexB: string): boolean => {
  if (!HEX_64_RE.test(hexA) || !HEX_64_RE.test(hexB)) return false;

  return timingSafeEqual(Buffer.from(hexA, "hex"), Buffer.from(hexB, "hex"));
};

export const hasScope = (
  principal: AuthPrincipal,
  required: ApiKeyScope,
): boolean =>
  principal.scopes.includes("admin") || principal.scopes.includes(required);

export const createLocalNoneAuth = (workspaceId = "local"): AuthAdapter => ({
  authenticate: async () => ({
    workspaceId,
    actor: "local-dev",
    scopes: ["admin"],
    isPlatformAdmin: true,
  }),
});

export interface KeyLookup {
  findActiveKeyByHash(keyHash: string): Promise<{
    id: string;
    workspace_id: string;
    name: string;
    scopes: ApiKeyScope[];
  } | null>;
}

export const createLocalApiKeyAuth = (options: {
  adminKeyHash?: string;
  workspaceId?: string;
  lookup: KeyLookup;
}): AuthAdapter => {
  const defaultWorkspaceId = options.workspaceId ?? "default";
  if (
    options.adminKeyHash !== undefined &&
    !HEX_64_RE.test(options.adminKeyHash)
  ) {
    throw new Error("adminKeyHash must be a 64-character SHA-256 hex digest.");
  }

  return {
    authenticate: async (bearerToken) => {
      const trimmed = bearerToken?.trim();
      if (!trimmed) return null;

      const digest = hashApiKey(trimmed);
      if (
        options.adminKeyHash &&
        safeDigestEqual(digest, options.adminKeyHash)
      ) {
        return {
          workspaceId: defaultWorkspaceId,
          actor: "bootstrap-admin",
          scopes: ["admin"],
          isPlatformAdmin: true,
        };
      }

      const key = await options.lookup.findActiveKeyByHash(digest);
      if (!key) return null;

      return {
        workspaceId: key.workspace_id,
        actor: `key:${key.name}`,
        scopes: key.scopes,
        isPlatformAdmin: false,
      };
    },
  };
};

export const createNoopBillingAdapter = (): BillingAdapter => ({
  checkCanStartRun: async () => ({ allowed: true }),
  recordRunUsage: async () => undefined,
});

export const createDisabledDeployAdapter = (): DeployAdapter => ({
  enabled: false,
  publishAndPromote: async () => {
    throw new Error(
      "Hosted deploy() is not enabled in self-hosted mode. Download weights with `grad artifacts download` to serve on vLLM or SGLang.",
    );
  },
});

export const createLocalDeployAdapter = (): DeployAdapter => ({
  enabled: true,
  publishAndPromote: async ({ workspaceId, name }) => ({
    modelId: `${workspaceId}/${name}`,
  }),
});
