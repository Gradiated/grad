import pg from "pg";

import type { AppDependencies } from "../../src/deps.js";
import { createCloudBilling } from "../../src/cloud/billing.js";
import { createCloudPrices, pricedCatalog } from "../../src/cloud/prices.js";
import { createModelCatalog } from "../../src/catalog.js";
import type { Clock } from "../../src/clock.js";
import { TEST_JUDGE, TEST_JUDGES_JSON, TINY_MODELS_JSON } from "./app.js";
import { fileSchemaName, postgresUrl } from "./postgres.js";
import {
  startFakeCloudApi,
  type FakeCloudApi,
  type FakeCloudOptions,
} from "./fake-cloud-api.js";

/** The fake price list's training and inference SKUs (nano-USD per million tokens). */
export const TEST_PRICES: Record<string, number> = {
  "train:test/tiny-qwen3": 1_000_000_000,
  "train:test/tiny-qwen3-teacher": 2_000_000_000,
  [`inference:${TEST_JUDGE}`]: 10_000_000_000,
  "inference:test/tiny-qwen3": 1_000_000_000,
};

export const startTestCloud = (
  options: FakeCloudOptions = {},
): Promise<FakeCloudApi> =>
  startFakeCloudApi({ prices: TEST_PRICES, ...options });

/** Cloud billing over `cloud`: its price list (fetched), the priced catalog and the billing adapter. */
export const cloudBillingDeps = async (
  cloud: FakeCloudApi,
  clock: Clock,
  options: { gatewayBillsEvals?: boolean } = {},
): Promise<Pick<AppDependencies, "billing" | "catalog" | "prices">> => {
  const prices = createCloudPrices({
    url: cloud.pricesUrl,
    token: cloud.serviceToken,
    clock,
  });
  await prices.refresh(true);

  return {
    prices,
    catalog: pricedCatalog(
      createModelCatalog(TINY_MODELS_JSON, TEST_JUDGES_JSON),
      prices,
    ),
    billing: createCloudBilling({
      baseUrl: cloud.billingUrl,
      token: cloud.serviceToken,
      prices,
      clock,
      ...options,
    }),
  };
};

/**
 * Waits until every usage row is older than every open transaction on the
 * Postgres cluster (what the exporter reads): other test files run in
 * parallel on the same server, and their open transactions hold it back.
 */
export const usageCommitted = async (timeoutMs = 10_000): Promise<void> => {
  const client = new pg.Client({
    connectionString: postgresUrl(),
    options: `-c search_path=${await fileSchemaName()}`,
  });
  await client.connect();
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await client.query<{ ok: boolean | null }>(
        "SELECT bool_and(txid < pg_snapshot_xmin(pg_current_snapshot())) AS ok FROM grad_usage",
      );
      if (rows[0]?.ok !== false || Date.now() > deadline) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    await client.end();
  }
};
