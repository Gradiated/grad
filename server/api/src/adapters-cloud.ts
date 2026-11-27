import { createHash } from "node:crypto";
import { z } from "zod";

import {
  matchTrainerKey,
  trainerKeysOf,
  type AuthAdapter,
  type AuthPrincipal,
  type BillingAdapter,
  type TracesAdapter,
  type TrainerKey,
} from "./adapters.js";
import { systemClock, type Clock } from "./clock.js";
import { WORKSPACE_SCOPES, type Scope } from "./contracts.js";
import { ApiError, errorMessage } from "./errors.js";

export interface CloudAdapterConfig {
  internalApiBaseUrl: string;
  serviceToken: string;
  timeoutMs?: number;
  allowInsecureHttp?: boolean;
  fetchImpl?: typeof fetch;
  /** sha256 hex of the platform trainer key; checked before Cloud auth. */
  trainerKeyHash?: string | undefined;
  /** Labelled, kind-scoped trainer keys (TRAINER_KEYS_JSON). */
  trainerKeys?: readonly TrainerKey[] | undefined;
  clock?: Clock;
  authCache?: {
    positiveTtlMs?: number;
    negativeTtlMs?: number;
    maxEntries?: number;
  };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface ResolvedConfig {
  baseUrl: string;
  serviceToken: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
}

export const validateCloudConfig = (
  cfg: CloudAdapterConfig,
): ResolvedConfig => {
  const serviceToken = cfg.serviceToken?.trim();
  if (!serviceToken) {
    throw new Error("Cloud adapter serviceToken must be a non-empty string.");
  }

  const parsed = new URL(cfg.internalApiBaseUrl);
  if (parsed.username || parsed.password) {
    throw new Error(
      "Cloud internal API URL must not contain embedded credentials.",
    );
  }
  if (parsed.protocol === "http:") {
    const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
    if (!isLoopback && !cfg.allowInsecureHttp) {
      throw new Error(
        `Insecure HTTP Cloud internal API URL rejected for non-loopback host '${parsed.hostname}'. Use https:// or set allowInsecureHttp.`,
      );
    }
  } else if (parsed.protocol !== "https:") {
    throw new Error(
      `Invalid Cloud internal API URL protocol: ${parsed.protocol}`,
    );
  }

  return {
    baseUrl: cfg.internalApiBaseUrl.trim().replace(/\/+$/, ""),
    serviceToken,
    timeoutMs: cfg.timeoutMs ?? 15_000,
    fetchFn: cfg.fetchImpl ?? globalThis.fetch,
  };
};

interface InternalResponse {
  status: number;
  json: Record<string, unknown>;
}

/** Thrown when the Cloud API cannot be reached (network error or timeout). */
class CloudUnreachableError extends Error {}

const postInternalJson = async (
  cfg: ResolvedConfig,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<InternalResponse> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.serviceToken}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  let resp: Response;
  try {
    resp = await cfg.fetchFn(`${cfg.baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (error) {
    throw new CloudUnreachableError(
      `Cloud internal API ${path} unreachable: ${errorMessage(error)}`,
    );
  }

  const text = await resp.text();
  let parsed: Record<string, unknown> = {};
  if (text.trim()) {
    try {
      const decoded = JSON.parse(text) as unknown;
      parsed =
        decoded && typeof decoded === "object" && !Array.isArray(decoded)
          ? (decoded as Record<string, unknown>)
          : { detail: text };
    } catch {
      parsed = { detail: text };
    }
  }

  return { status: resp.status, json: parsed };
};

const detailOf = (res: InternalResponse): string =>
  typeof res.json.detail === "string" ? res.json.detail : "";

const isOk = (status: number): boolean => status >= 200 && status < 300;

const KNOWN_SCOPES = new Set<string>([...WORKSPACE_SCOPES, "trainer:worker"]);

interface CacheEntry {
  principal: AuthPrincipal | null;
  expiresAt: number;
}

export const createCloudAuthAdapter = (
  cfg: CloudAdapterConfig,
): AuthAdapter => {
  const resolved = validateCloudConfig(cfg);
  const trainerKeys = trainerKeysOf(cfg.trainerKeyHash, cfg.trainerKeys);
  const clock = cfg.clock ?? systemClock;
  const positiveTtlMs = cfg.authCache?.positiveTtlMs ?? 30_000;
  const negativeTtlMs = cfg.authCache?.negativeTtlMs ?? 5_000;
  const maxEntries = cfg.authCache?.maxEntries ?? 10_000;
  const cache = new Map<string, CacheEntry>();

  const remember = (key: string, principal: AuthPrincipal | null): void => {
    cache.delete(key);
    cache.set(key, {
      principal,
      expiresAt:
        clock.now().getTime() + (principal ? positiveTtlMs : negativeTtlMs),
    });
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  };

  const verify = async (token: string): Promise<AuthPrincipal | null> => {
    let res: InternalResponse;
    try {
      res = await postInternalJson(resolved, "/api/internal/v1/auth/verify", {
        token,
      });
    } catch (error) {
      throw new ApiError(
        503,
        "auth_unavailable",
        "Authentication service unavailable",
        `Could not verify the API key with Gradiated Cloud: ${errorMessage(error)}`,
      );
    }
    if (res.status >= 500 || res.status === 429) {
      throw new ApiError(
        503,
        "auth_unavailable",
        "Authentication service unavailable",
        `Gradiated Cloud auth returned HTTP ${res.status}.`,
      );
    }
    if (res.status !== 200 || res.json.valid !== true) return null;

    const workspaceId =
      typeof res.json.workspace_id === "string" ? res.json.workspace_id : "";
    if (!WORKSPACE_ID_RE.test(workspaceId)) return null;

    const scopes: Scope[] = Array.isArray(res.json.scopes)
      ? res.json.scopes.filter(
          (s): s is Scope => typeof s === "string" && KNOWN_SCOPES.has(s),
        )
      : [];
    const isPlatformAdmin = res.json.is_platform_admin === true;
    const actor =
      typeof res.json.actor === "string" && res.json.actor.trim()
        ? res.json.actor.trim()
        : "cloud-key";

    if (scopes.includes("trainer:worker")) {
      return {
        kind: "worker",
        workspaceId,
        actor,
        scopes,
        isPlatformAdmin: false,
        workerWorkspaceId: isPlatformAdmin ? null : workspaceId,
      };
    }

    return {
      kind: "workspace",
      workspaceId,
      actor,
      scopes,
      isPlatformAdmin,
      workerWorkspaceId: null,
    };
  };

  return {
    authenticate: async (bearerToken) => {
      const token = bearerToken?.trim();
      if (!token) return null;

      const worker = matchTrainerKey(token, trainerKeys);
      if (worker) return worker;

      const key = createHash("sha256").update(token).digest("hex");
      const hit = cache.get(key);
      if (hit && hit.expiresAt > clock.now().getTime()) {
        return hit.principal;
      }

      const principal = await verify(token);
      remember(key, principal);

      return principal;
    },
  };
};

export const createCloudBillingAdapter = (
  cfg: CloudAdapterConfig,
): BillingAdapter => {
  const resolved = validateCloudConfig(cfg);
  const reportUsage = async (
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<void> => {
    const res = await postInternalJson(
      resolved,
      "/api/internal/v1/billing/usage",
      body,
      idempotencyKey,
    );
    if (!isOk(res.status)) {
      throw new Error(
        `Cloud billing usage report failed (HTTP ${res.status}): ${detailOf(res)}`,
      );
    }
  };

  return {
    checkCanStartRun: async (workspaceId, estimatedCostUsd) => {
      let res: InternalResponse;
      try {
        res = await postInternalJson(
          resolved,
          "/api/internal/v1/billing/check",
          { workspace_id: workspaceId, estimated_cost_usd: estimatedCostUsd },
        );
      } catch (error) {
        throw new ApiError(
          503,
          "billing_unavailable",
          "Billing service unavailable",
          errorMessage(error),
        );
      }
      if (!isOk(res.status)) {
        throw new ApiError(
          503,
          "billing_unavailable",
          "Billing service unavailable",
          `Gradiated Cloud billing check returned HTTP ${res.status}${detailOf(res) ? `: ${detailOf(res)}` : ""}.`,
        );
      }

      return {
        allowed: res.json.allowed === true,
        ...(typeof res.json.reason === "string"
          ? { reason: res.json.reason }
          : {}),
      };
    },
    canContinue: async (workspaceId) => {
      try {
        const res = await postInternalJson(
          resolved,
          "/api/internal/v1/billing/check",
          { workspace_id: workspaceId, estimated_cost_usd: 0 },
        );
        // A billing outage never stops running work.
        return !isOk(res.status) || res.json.allowed !== false;
      } catch {
        return true;
      }
    },
    usageExport: {
      cursor: async () => {
        const res = await postInternalJson(
          resolved,
          "/api/internal/v1/billing/usage/cursor",
          {},
        );
        if (!isOk(res.status)) {
          throw new Error(
            `Cloud billing cursor failed (HTTP ${res.status}): ${detailOf(res)}`,
          );
        }

        return typeof res.json.seq === "number" ? res.json.seq : 0;
      },
      push: (row) =>
        reportUsage(
          {
            seq: row.seq,
            workspace_id: row.workspace_id,
            kind: row.kind,
            ref_id: row.ref_id,
            attempt: row.attempt,
            tokens_from: row.tokens_from,
            tokens_through: row.tokens_through,
            tokens_processed: row.tokens,
            cost_usd: row.cost_usd,
            price_version: row.price_version,
            created_at: row.created_at,
          },
          row.idempotency_key,
        ),
    },
  };
};

const TracesPageSchema = z.object({
  records: z.array(z.record(z.string(), z.unknown())),
  cursor: z.string().max(4096).nullable(),
  has_more: z.boolean(),
});

/**
 * The `gradiated` source: gateway traces and feedback for one workspace, from
 * the product's internal `training/traces:pull` (the token stays here; workers
 * reach it only through their job's `/source-page`).
 */
export const createCloudTracesAdapter = (
  cfg: CloudAdapterConfig,
): TracesAdapter => {
  const resolved = validateCloudConfig(cfg);

  return {
    pull: async ({ workspaceId, filter, cursor, limit }) => {
      let res: InternalResponse;
      try {
        res = await postInternalJson(
          resolved,
          "/api/internal/v1/training/traces:pull",
          { workspace_id: workspaceId, filter, cursor, limit },
        );
      } catch (error) {
        throw new ApiError(
          503,
          "source_upstream_unavailable",
          "Gradiated Cloud traces unavailable",
          errorMessage(error),
        );
      }
      if (!isOk(res.status)) {
        throw new ApiError(
          502,
          "source_upstream_error",
          "Gradiated Cloud traces failed",
          `Gradiated Cloud traces:pull returned HTTP ${res.status}${detailOf(res) ? `: ${detailOf(res)}` : ""}.`,
        );
      }
      const page = TracesPageSchema.safeParse(res.json);
      if (!page.success) {
        throw new ApiError(
          502,
          "source_upstream_error",
          "Gradiated Cloud traces failed",
          "Gradiated Cloud traces:pull returned an unexpected body.",
        );
      }

      return page.data;
    },
  };
};
