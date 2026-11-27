import type { BillingAdapter, UsageEvent } from "../adapters.js";
import { nanoUsd } from "../catalog.js";
import type { Clock } from "../clock.js";
import { ApiError, errorMessage } from "../errors.js";
import { metrics } from "../telemetry/metrics.js";
import { cloudRequest, detailOf, isOk, type CloudResponse } from "./http.js";
import { pricesUnavailable, type CloudPrices } from "./prices.js";

/**
 * Gradiated Cloud billing: the balance check at create time and at every
 * heartbeat (cached 30 s per workspace), and the usage push. Prices come
 * from the versioned price list; past its stale limit, new work is refused.
 */
export interface CloudBillingOptions {
  /** `GRAD_CLOUD_BILLING_URL`: `<base>/check` and `<base>/usage-events`. */
  baseUrl: string;
  token: string;
  prices: CloudPrices;
  clock: Clock;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** How long a heartbeat's balance answer is reused (default 30 s). */
  continueCacheMs?: number;
  /** Evals call the gateway (GRAD_CLOUD_GATEWAY_URL), which bills their tokens. */
  gatewayBillsEvals?: boolean;
}

const billingUnavailable = (detail: string) =>
  new ApiError(
    503,
    "billing_unavailable",
    "Billing service unavailable",
    detail,
  );

const counted = (
  op: "start" | "continue",
  result: "allowed" | "refused" | "error",
): void => {
  metrics.billingChecks.inc({ op, result });
};

const REASONS: Record<string, string> = {
  insufficient_balance:
    "The workspace's balance does not cover this job's estimated cost; top up in the Gradiated console, then retry.",
  suspended: "The organization is suspended; contact Gradiated support.",
};

export const createCloudBilling = (
  options: CloudBillingOptions,
): BillingAdapter => {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const continueCacheMs = options.continueCacheMs ?? 30_000;
  const continued = new Map<string, { allowed: boolean; at: number }>();

  const post = (path: string, body: unknown): Promise<CloudResponse> =>
    cloudRequest(fetchFn, `${options.baseUrl}${path}`, {
      token: options.token,
      body,
      timeoutMs,
    });

  const check = async (workspaceId: string, estimatedUsd: number) =>
    post("/check", {
      workspace_id: workspaceId,
      estimated_amount_nano_usd: nanoUsd(Math.max(0, estimatedUsd)),
    });

  return {
    gatewayBillsEvals: options.gatewayBillsEvals ?? false,

    checkCanStartRun: async (workspaceId, estimatedCostUsd) => {
      if (!options.prices.fresh()) {
        await options.prices.refresh(true);
        if (!options.prices.fresh()) throw pricesUnavailable();
      }
      let res: CloudResponse;
      try {
        res = await check(workspaceId, estimatedCostUsd);
      } catch (error) {
        counted("start", "error");
        throw billingUnavailable(errorMessage(error));
      }
      if (res.status === 404) {
        counted("start", "refused");
        return {
          allowed: false,
          reason: "Gradiated Cloud billing does not know this workspace.",
        };
      }
      if (!isOk(res.status)) {
        counted("start", "error");
        throw billingUnavailable(
          `The Gradiated Cloud balance check returned HTTP ${res.status}${detailOf(res)}.`,
        );
      }
      if (res.json.allowed === true) {
        counted("start", "allowed");
        return { allowed: true };
      }
      counted("start", "refused");
      const reason = String(res.json.reason ?? "insufficient_balance");

      return { allowed: false, reason: REASONS[reason] ?? reason };
    },

    canContinue: async (workspaceId) => {
      const now = options.clock.now().getTime();
      const hit = continued.get(workspaceId);
      if (hit && now - hit.at < continueCacheMs) return hit.allowed;
      let allowed = true;
      try {
        const res = await check(workspaceId, 0);
        // A billing outage never stops running work.
        allowed = !isOk(res.status) || res.json.allowed !== false;
        counted(
          "continue",
          !isOk(res.status) ? "error" : allowed ? "allowed" : "refused",
        );
      } catch {
        allowed = true;
        counted("continue", "error");
      }
      continued.set(workspaceId, { allowed, at: now });
      if (continued.size > 10_000) {
        continued.delete(continued.keys().next().value as string);
      }

      return allowed;
    },

    pushUsage: async (events: readonly UsageEvent[]) => {
      const res = await post("/usage-events", { events });
      if (!isOk(res.status)) {
        const code = typeof res.json.code === "string" ? res.json.code : "";
        const eventId =
          typeof res.json.event_id === "string"
            ? ` (${res.json.event_id})`
            : "";
        throw new Error(
          `Gradiated Cloud usage ingest returned HTTP ${res.status}${code ? ` ${code}` : ""}${eventId}${detailOf(res)}`,
        );
      }
    },
  };
};
