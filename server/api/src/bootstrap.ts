import type { Counter } from "@prometheus-io/client";

import {
  createLocalApiKeyAuth,
  createLocalNoneAuth,
  createNoopBillingAdapter,
  hashApiKey,
} from "./adapters.js";
import {
  createCloudAuthAdapter,
  createCloudBillingAdapter,
  createCloudTracesAdapter,
  type CloudAdapterConfig,
} from "./adapters-cloud.js";
import { createModelCatalog } from "./catalog.js";
import { createDbAnchoredClock } from "./clock.js";
import type { AppDependencies } from "./deps.js";
import type { ServerEnvironment } from "./environment.js";
import { createOpenAICompatibleClient } from "./services/evals/inference.js";
import { createRegexEvaluator } from "./services/evals/regex.js";
import type {
  ChatCompletionClient,
  InferenceClients,
} from "./services/evals/types.js";
import { assertMigrated } from "./migrations.js";
import { LocalObjectStore } from "./storage/local.js";
import { S3ObjectStore } from "./storage/s3.js";
import { createBlobSigner } from "./storage/signer.js";
import { createSecretsCipher } from "./secrets.js";
import { createPostgresStore } from "./store/postgres.js";
import { log } from "./telemetry/log.js";
import { metrics } from "./telemetry/metrics.js";
import { instrumentObjectStore } from "./telemetry/storage.js";

export { log } from "./telemetry/log.js";

/** Counts a client's calls on `counter` by result (ok, error). */
const countCalls = (
  client: ChatCompletionClient,
  counter: Counter<"result">,
): ChatCompletionClient => ({
  ...client,
  complete: async (input) => {
    try {
      const reply = await client.complete(input);
      counter.inc({ result: "ok" });

      return reply;
    } catch (error) {
      counter.inc({ result: "error" });
      throw error;
    }
  },
});

const buildInference = (env: ServerEnvironment): InferenceClients | null => {
  if (!env.INFERENCE_BASE_URL) return null;

  const models = createOpenAICompatibleClient({
    baseUrl: env.INFERENCE_BASE_URL,
    apiKey: env.INFERENCE_API_KEY,
    timeoutMs: 120_000,
  });
  const judge =
    env.judgeBaseUrl && env.judgeBaseUrl !== env.INFERENCE_BASE_URL
      ? createOpenAICompatibleClient({
          baseUrl: env.judgeBaseUrl,
          apiKey: env.judgeApiKey,
          timeoutMs: 120_000,
        })
      : models;

  return {
    models: countCalls(models, metrics.evalOutputs),
    judge: countCalls(judge, metrics.judgeCalls),
  };
};

export const buildDependencies = async (
  env: ServerEnvironment,
): Promise<AppDependencies> => {
  const clock = createDbAnchoredClock();
  const store = createPostgresStore({
    connectionString: env.DATABASE_URL,
    clock,
  });
  if (env.MIGRATE_ON_BOOT) await store.migrate();
  else await assertMigrated(env.DATABASE_URL);
  // Lease times follow the database clock: sync now and every minute.
  await clock.sync(store.dbNow);
  setInterval(() => {
    clock.sync(store.dbNow).catch(() => undefined);
  }, 60_000).unref();

  const storage = instrumentObjectStore(
    env.S3_BUCKET
      ? new S3ObjectStore({
          bucket: env.S3_BUCKET,
          region: env.S3_REGION,
          endpoint: env.S3_ENDPOINT,
        })
      : new LocalObjectStore(env.STORAGE_DIR),
  );

  const trainerKeyHash =
    env.TRAINER_API_KEY_HASH ??
    (env.TRAINER_API_KEY ? hashApiKey(env.TRAINER_API_KEY) : undefined);
  const cloud = (): CloudAdapterConfig => ({
    internalApiBaseUrl: env.CLOUD_INTERNAL_API_URL as string,
    serviceToken: env.CLOUD_SERVICE_TOKEN as string,
    trainerKeyHash,
    trainerKeys: env.trainerKeys,
  });

  const auth =
    env.AUTH_MODE === "cloud"
      ? createCloudAuthAdapter(cloud())
      : env.AUTH_MODE === "api_key"
        ? createLocalApiKeyAuth({
            adminKeyHash: env.ADMIN_API_KEY_HASH,
            trainerKeyHash,
            trainerKeys: env.trainerKeys,
            workspaceId: env.DEFAULT_WORKSPACE_ID,
            lookup: store.apiKeys,
          })
        : createLocalNoneAuth(env.DEFAULT_WORKSPACE_ID);

  if (!env.BLOB_SIGNING_SECRET && storage.kind === "local") {
    log(
      "warn",
      "BLOB_SIGNING_SECRET is not set: signed upload/download URLs are valid only on this process (set it when running more than one replica).",
    );
  }

  return {
    store,
    storage,
    signer: createBlobSigner(env.BLOB_SIGNING_SECRET),
    auth,
    billing:
      env.BILLING_MODE === "cloud"
        ? createCloudBillingAdapter(cloud())
        : createNoopBillingAdapter(),
    catalog: createModelCatalog(
      env.GRAD_EXTRA_MODELS_JSON,
      env.GRAD_JUDGE_MODELS_JSON,
    ),
    clock,
    inference: buildInference(env),
    regex: createRegexEvaluator(),
    secrets: createSecretsCipher({
      key: env.GRAD_SECRETS_KEY,
      oldKeys: env.GRAD_SECRETS_KEYS_OLD,
    }),
    // The `gradiated` source reads Cloud gateway traces: Cloud only.
    traces:
      env.AUTH_MODE === "cloud" ? createCloudTracesAdapter(cloud()) : null,
    settings: {
      maxAttempts: env.MAX_ATTEMPTS,
      evalConcurrency: env.EVAL_CONCURRENCY,
      jobEventRetentionDays: env.JOB_EVENT_RETENTION_DAYS,
      usageFlushTokens: env.USAGE_FLUSH_TOKENS,
      usageFlushSeconds: env.USAGE_FLUSH_SECONDS,
      usageExportLagSeconds: env.USAGE_EXPORT_LAG_SECONDS,
      sourceSyncIntervalSeconds: env.SOURCE_SYNC_INTERVAL_SECONDS,
      metrics: {
        enabled: env.METRICS_ENABLED,
        token: env.METRICS_TOKEN,
        separatePort: env.METRICS_PORT !== undefined,
        workspaceLabel: env.METRICS_WORKSPACE_LABEL,
      },
    },
  };
};
