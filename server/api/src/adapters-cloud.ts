import { createHash } from "node:crypto";
import { z } from "zod";

import {
  matchTrainerKey,
  type AuthAdapter,
  type AuthPrincipal,
  type BillingAdapter,
  type DeployAdapter,
  type RouteDecision,
  type ServingAdapter,
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

      const worker = matchTrainerKey(token, cfg.trainerKeyHash);
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
    recordRunUsage: async (input) => {
      const res = await postInternalJson(
        resolved,
        "/api/internal/v1/billing/usage",
        {
          workspace_id: input.workspaceId,
          run_id: input.runId,
          attempt: input.attempt,
          tokens_processed: input.tokensProcessed,
          cost_usd: input.costUsd,
        },
        input.idempotencyKey,
      );
      if (!isOk(res.status)) {
        throw new Error(
          `Cloud billing usage report failed (HTTP ${res.status}): ${detailOf(res)}`,
        );
      }
    },
  };
};

const toUpstreamError = (error: unknown, what: string): ApiError =>
  error instanceof ApiError
    ? error
    : new ApiError(
        502,
        "cloud_upstream_error",
        "Gradiated Cloud request failed",
        `${what}: ${errorMessage(error)}`,
      );

export const createCloudDeployAdapter = (
  cfg: CloudAdapterConfig,
): DeployAdapter => {
  const resolved = validateCloudConfig(cfg);

  return {
    mode: "cloud",
    publishAndPromote: async ({
      workspaceId,
      name,
      artifact,
      fallbackModel,
      requestKey,
    }) => {
      try {
        const publish = await postInternalJson(
          resolved,
          "/api/internal/v1/artifacts/publish",
          {
            workspace_id: workspaceId,
            artifact_id: artifact.id,
            base_model: artifact.base_model,
            recipe_kind: artifact.recipe_kind,
            format: artifact.format,
            storage_key: artifact.storage_key,
            sha256: artifact.sha256,
            size_bytes: artifact.size_bytes,
            manifest: artifact.manifest,
          },
          `art-publish:${workspaceId}:${artifact.id}`,
        );
        if (!isOk(publish.status)) {
          throw new Error(
            `artifact publish returned HTTP ${publish.status} ${detailOf(publish)}`.trim(),
          );
        }

        const promote = await postInternalJson(
          resolved,
          "/api/internal/v1/deployments/promote",
          {
            workspace_id: workspaceId,
            deployment_name: name,
            artifact_id: artifact.id,
            fallback_model: fallbackModel,
          },
          `deploy-promote:${workspaceId}:${name}:${requestKey ?? artifact.id}`,
        );
        if (!isOk(promote.status)) {
          throw new Error(
            `deployment promote returned HTTP ${promote.status} ${detailOf(promote)}`.trim(),
          );
        }

        const modelId =
          typeof promote.json.model_id === "string"
            ? promote.json.model_id.trim()
            : "";
        if (!modelId) {
          throw new Error("deployment promote response is missing model_id");
        }

        return { modelId };
      } catch (error) {
        throw toUpstreamError(error, "Deploy failed");
      }
    },
  };
};

const RouteDecisionSchema = z.object({
  model: z.string().min(1),
  is_exploration: z.boolean(),
  confidence: z.number().min(0).max(1),
  scores: z.record(z.string(), z.number()),
});

const EmbeddingsSchema = z.object({
  data: z
    .array(
      z.object({
        index: z.number().int().min(0),
        embedding: z.array(z.number()),
      }),
    )
    .min(1),
  usage: z.object({
    prompt_tokens: z.number().int().min(0),
    total_tokens: z.number().int().min(0),
  }),
});

const callServing = async <T>(
  cfg: ResolvedConfig,
  path: string,
  body: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> => {
  let res: InternalResponse;
  try {
    res = await postInternalJson(cfg, path, body);
  } catch (error) {
    throw new ApiError(
      503,
      "serving_unavailable",
      "Serving unavailable",
      errorMessage(error),
    );
  }
  if (res.status === 404) {
    throw new ApiError(
      404,
      "deployment_not_serving",
      "Deployment not serving",
      detailOf(res) ||
        "Gradiated Cloud has no serving endpoint for this deployment.",
    );
  }
  if (!isOk(res.status)) {
    throw new ApiError(
      res.status >= 500 ? 503 : 502,
      res.status >= 500 ? "serving_unavailable" : "cloud_upstream_error",
      "Serving request failed",
      `Gradiated Cloud serving returned HTTP ${res.status}${detailOf(res) ? `: ${detailOf(res)}` : ""}.`,
    );
  }

  const parsed = schema.safeParse(res.json);
  if (!parsed.success) {
    throw new ApiError(
      502,
      "cloud_upstream_error",
      "Malformed serving response",
      `Gradiated Cloud returned a malformed response for ${path}.`,
    );
  }

  return parsed.data;
};

export const createCloudServingAdapter = (
  cfg: CloudAdapterConfig,
): ServingAdapter => {
  const resolved = validateCloudConfig(cfg);

  return {
    mode: "cloud",
    route: async (input): Promise<RouteDecision> =>
      callServing(
        resolved,
        "/api/internal/v1/serving/route",
        {
          workspace_id: input.workspaceId,
          inference_id: input.inferenceId,
          deployment: input.deploymentName,
          model_id: input.modelId,
          artifact_id: input.artifactId,
          fallback_model: input.fallbackModel,
          explore_rate: input.exploreRate,
          messages: input.messages,
          tools: input.tools ?? null,
          session_id: input.sessionId ?? null,
        },
        RouteDecisionSchema,
      ),
    embed: async (input) => {
      const result = await callServing(
        resolved,
        "/api/internal/v1/serving/embeddings",
        {
          workspace_id: input.workspaceId,
          deployment: input.deploymentName,
          model_id: input.modelId,
          input: input.inputs,
        },
        EmbeddingsSchema,
      );
      if (result.data.length !== input.inputs.length) {
        throw new ApiError(
          502,
          "cloud_upstream_error",
          "Malformed serving response",
          `Expected ${input.inputs.length} embeddings, received ${result.data.length}.`,
        );
      }
      const ordered = [...result.data].sort((a, b) => a.index - b.index);

      return {
        embeddings: ordered.map((d) => d.embedding),
        usage: result.usage,
      };
    },
  };
};
