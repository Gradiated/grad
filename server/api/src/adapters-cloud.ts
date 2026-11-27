import type {
  AuthAdapter,
  AuthPrincipal,
  BillingAdapter,
  DeployAdapter,
} from "./adapters.js";
import { type ApiKeyScope, ApiKeyScopeSchema } from "./contracts.js";

export interface CloudAdapterConfig {
  internalApiBaseUrl: string;
  serviceToken: string;
  timeoutMs?: number;
  allowInsecureHttp?: boolean;
  fetchImpl?: typeof fetch;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const validateConfig = (
  cfg: CloudAdapterConfig,
): { baseUrl: string; serviceToken: string } => {
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
  if (parsed.protocol === "https:") {
    // Allowed unconditionally.
  } else if (parsed.protocol === "http:") {
    const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
    if (!isLoopback && !cfg.allowInsecureHttp) {
      throw new Error(
        `Insecure HTTP Cloud internal API URL rejected for non-loopback host '${parsed.hostname}'. Use https:// or set allowInsecureHttp.`,
      );
    }
  } else {
    throw new Error(
      `Invalid Cloud internal API URL protocol: ${parsed.protocol}`,
    );
  }

  return {
    baseUrl: cfg.internalApiBaseUrl.trim().replace(/\/+$/, ""),
    serviceToken,
  };
};

const postInternalJson = async (
  cfg: CloudAdapterConfig,
  path: string,
  body: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const { baseUrl, serviceToken } = validateConfig(cfg);
  const fetchFn = cfg.fetchImpl ?? globalThis.fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${serviceToken}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  const resp = await fetchFn(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
  });

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

export const createCloudAuthAdapter = (
  cfg: CloudAdapterConfig,
): AuthAdapter => {
  validateConfig(cfg);

  return {
    authenticate: async (bearerToken): Promise<AuthPrincipal | null> => {
      const token = bearerToken?.trim();
      if (!token) return null;

      const { status, json } = await postInternalJson(
        cfg,
        "/api/internal/v1/auth/verify",
        { token },
      );
      if (status !== 200 || json.valid !== true) return null;

      const workspaceId =
        typeof json.workspace_id === "string" ? json.workspace_id.trim() : "";
      if (!workspaceId) return null;

      const actor =
        typeof json.actor === "string" && json.actor.trim()
          ? json.actor.trim()
          : "cloud-key";

      const scopes: ApiKeyScope[] = [];
      if (Array.isArray(json.scopes)) {
        for (const rawScope of json.scopes) {
          const parsed = ApiKeyScopeSchema.safeParse(rawScope);
          if (parsed.success) {
            scopes.push(parsed.data);
          }
        }
      }

      return {
        workspaceId,
        actor,
        scopes,
        isPlatformAdmin: json.is_platform_admin === true,
      };
    },
  };
};

export const createCloudBillingAdapter = (
  cfg: CloudAdapterConfig,
): BillingAdapter => {
  validateConfig(cfg);

  return {
    checkCanStartRun: async (workspaceId, estimatedCostUsd) => {
      const { status, json } = await postInternalJson(
        cfg,
        "/api/internal/v1/billing/check",
        {
          workspace_id: workspaceId,
          estimated_cost_usd: estimatedCostUsd,
        },
      );
      if (status !== 200) {
        return {
          allowed: false,
          reason: String(
            json.detail ?? `Billing service returned HTTP ${status}.`,
          ),
        };
      }

      return {
        allowed: json.allowed === true,
        ...(typeof json.reason === "string" ? { reason: json.reason } : {}),
      };
    },
    recordRunUsage: async (input) => {
      const { status, json } = await postInternalJson(
        cfg,
        "/api/internal/v1/billing/usage",
        {
          workspace_id: input.workspaceId,
          run_id: input.runId,
          tokens_processed: input.tokensProcessed,
          cost_usd: input.costUsd,
        },
        `run-usage:${input.runId}`,
      );
      if (status < 200 || status >= 300) {
        throw new Error(
          `Cloud billing usage report failed (HTTP ${status}): ${String(json.detail ?? "")}`,
        );
      }
    },
  };
};

export const createCloudDeployAdapter = (
  cfg: CloudAdapterConfig,
): DeployAdapter => {
  validateConfig(cfg);

  return {
    enabled: true,
    publishAndPromote: async ({
      workspaceId,
      name,
      artifact,
      fallbackModel,
    }) => {
      // ART-01: register immutable artifact in Gradiated serving registry
      const publish = await postInternalJson(
        cfg,
        "/api/internal/v1/artifacts/publish",
        {
          workspace_id: workspaceId,
          artifact_id: artifact.id,
          base_model: artifact.base_model,
          format: artifact.format,
          storage_key: artifact.storage_key,
          sha256: artifact.sha256,
          size_bytes: artifact.size_bytes,
          manifest: artifact.manifest,
        },
        `art-publish:${workspaceId}:${artifact.id}`,
      );
      if (publish.status < 200 || publish.status >= 300) {
        throw new Error(
          `ART-01 artifact publish failed (HTTP ${publish.status}): ${String(publish.json.detail ?? "")}`,
        );
      }

      // SERV-03: promote artifact under stable deployment model name
      const promote = await postInternalJson(
        cfg,
        "/api/internal/v1/deployments/promote",
        {
          workspace_id: workspaceId,
          deployment_name: name,
          artifact_id: artifact.id,
          fallback_model: fallbackModel,
        },
        `deploy-promote:${workspaceId}:${name}:${artifact.id}`,
      );
      if (promote.status < 200 || promote.status >= 300) {
        throw new Error(
          `SERV-03 deployment promote failed (HTTP ${promote.status}): ${String(promote.json.detail ?? "")}`,
        );
      }

      const rawModelId =
        typeof promote.json.model_id === "string"
          ? promote.json.model_id.trim()
          : "";
      return {
        modelId: rawModelId || `${workspaceId}/${name}`,
      };
    },
  };
};
