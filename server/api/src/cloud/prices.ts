import { z } from "zod";

import { inferenceSku, trainSku, type ModelCatalog } from "../catalog.js";
import type { TrainableModel } from "../contracts.js";
import type { Clock } from "../clock.js";
import { ApiError, issuesOf } from "../errors.js";
import { log } from "../telemetry/log.js";
import { watchPriceList } from "../telemetry/metrics.js";
import { cloudRequest, detailOf, isOk } from "./http.js";

/**
 * Gradiated Cloud's versioned price list: billing owns every price. grad
 * polls it (ETag), prices plans and runs from it, records its version on
 * ledger rows, and keeps the last good list through an outage for
 * `maxStaleMs` (24 h); past that, new runs and evals are refused.
 */

const PriceListSchema = z.object({
  price_version: z.string().min(1).max(200),
  effective_at: z.string().optional(),
  skus: z
    .array(
      z.object({
        sku: z.string().min(1).max(300),
        unit: z.string().optional(),
        price_nano_usd_per_mtok: z.number().int().nonnegative().safe(),
      }),
    )
    .max(100_000),
});

/** No price list yet (a boot during a billing outage) or none confirmed for 24 h. */
export const billingUnavailable = (detail: string): ApiError =>
  new ApiError(
    503,
    "billing_unavailable",
    "Billing service unavailable",
    detail,
  );

export const pricesUnavailable = (): ApiError =>
  billingUnavailable(
    "The Gradiated Cloud price list is unavailable, so new runs and evals cannot be priced; retry shortly.",
  );

/** A failed fetch with no list at all retries at this pace, not the slower backoff. */
const UNPRICED_RETRY_MS = 30_000;

interface PriceList {
  version: string;
  /** SKU → nano-USD per million units (tokens). */
  skus: ReadonlyMap<string, number>;
}

export interface CloudPrices {
  /** The last good price list; null until one was fetched. */
  current(): PriceList | null;
  /** Whether the last good list was confirmed within the stale limit. */
  fresh(): boolean;
  /** Fetches the list when a poll is due (or `force`); false when billing could not be reached. */
  refresh(force?: boolean): Promise<boolean>;
}

interface CloudPricesOptions {
  url: string;
  token: string;
  clock: Clock;
  fetchImpl?: typeof fetch;
  pollMs?: number;
  maxStaleMs?: number;
  timeoutMs?: number;
}

export const createCloudPrices = (options: CloudPricesOptions): CloudPrices => {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const pollMs = options.pollMs ?? 300_000;
  const maxStaleMs = options.maxStaleMs ?? 86_400_000;
  let list: PriceList | null = null;
  let etag: string | null = null;
  let confirmedAt = -Infinity;
  let nextPollAt = -Infinity;
  let failures = 0;

  const now = () => options.clock.now().getTime();

  const fetchList = async (): Promise<void> => {
    const res = await cloudRequest(fetchFn, options.url, {
      token: options.token,
      timeoutMs: options.timeoutMs ?? 10_000,
      headers: etag && list ? { "If-None-Match": etag } : {},
    });
    if (res.status === 304 && list) return;
    if (!isOk(res.status)) {
      throw new Error(`HTTP ${res.status}${detailOf(res)}`);
    }
    const parsed = PriceListSchema.safeParse(res.json);
    if (!parsed.success) {
      throw new Error(`unexpected body: ${issuesOf(parsed.error)}`);
    }
    list = {
      version: parsed.data.price_version,
      skus: new Map(
        parsed.data.skus.map((s) => [s.sku, s.price_nano_usd_per_mtok]),
      ),
    };
    etag = res.headers.get("etag");
  };

  watchPriceList(() =>
    Number.isFinite(confirmedAt) ? (now() - confirmedAt) / 1000 : null,
  );

  return {
    current: () => list,
    fresh: () => list !== null && now() - confirmedAt <= maxStaleMs,
    refresh: async (force = false) => {
      if (!force && now() < nextPollAt) return true;
      try {
        await fetchList();
        confirmedAt = now();
        failures = 0;
        nextPollAt = now() + pollMs;

        return true;
      } catch (error) {
        failures += 1;
        // Back off 30 s, 60 s, ... up to the poll interval (never past
        // 30 s while there is no list at all: nothing can be priced).
        nextPollAt =
          now() +
          Math.min(
            list ? pollMs : UNPRICED_RETRY_MS,
            30_000 * 2 ** (failures - 1),
          );
        log("warn", "Gradiated Cloud price list unavailable", {
          error,
          keeping: list?.version ?? null,
        });

        return false;
      }
    },
  };
};

const usdOf = (nanoPerMtok: number): number => nanoPerMtok / 1e9;

/**
 * The catalog priced by the Cloud price list: a model trains at its
 * `train:<model>` SKU, and only models with one are offered; judges (and eval
 * targets) are estimated at `inference:<model>`, since the gateway serves
 * and bills them. Until a list is fetched (a boot during a billing outage)
 * model lookups answer 503 billing_unavailable: plans and creates fail,
 * retryably, rather than use a price billing would reject or call a model
 * unknown. Prices of existing runs and evals (`priceFor`) never throw.
 */
export const pricedCatalog = (
  catalog: ModelCatalog,
  prices: CloudPrices,
): ModelCatalog => {
  const priced = (model: TrainableModel | undefined) => {
    const nano = model && prices.current()?.skus.get(trainSku(model.id));
    if (!model || nano === undefined) return undefined;

    return { ...model, price_per_million_tokens_usd: usdOf(nano) };
  };

  const listed = () => {
    if (!prices.current()) throw pricesUnavailable();
  };

  return {
    list: () => {
      listed();
      return catalog
        .list()
        .map(priced)
        .filter((m): m is TrainableModel => m !== undefined);
    },
    find: (id) => {
      listed();
      return priced(catalog.find(id));
    },
    defaultModelFor: (kind) => {
      listed();
      return priced(catalog.defaultModelFor(kind));
    },
    priceFor: (id) => priced(catalog.find(id))?.price_per_million_tokens_usd,
    judgePriceFor: (id) => {
      const nano = prices
        .current()
        ?.skus.get(inferenceSku(id.trim().toLowerCase()));

      return nano === undefined ? undefined : usdOf(nano);
    },
    judgeModels: () =>
      [...(prices.current()?.skus.keys() ?? [])]
        .filter((s) => s.startsWith("inference:"))
        .map((s) => s.slice("inference:".length))
        .sort(),
    charsPerToken: (id) => catalog.charsPerToken(id),
    servingId: (id) => catalog.servingId(id),
    get priceVersion() {
      return prices.current()?.version ?? "unpriced";
    },
  };
};
