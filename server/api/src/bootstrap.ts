import {
  createDisabledDeployAdapter,
  createDisabledServingAdapter,
  createLocalApiKeyAuth,
  createLocalNoneAuth,
  createNoopBillingAdapter,
  hashApiKey,
} from "./adapters.js";
import {
  createCloudAuthAdapter,
  createCloudBillingAdapter,
  createCloudDeployAdapter,
  createCloudServingAdapter,
  type CloudAdapterConfig,
} from "./adapters-cloud.js";
import { createModelCatalog } from "./catalog.js";
import { createDbAnchoredClock } from "./clock.js";
import type { AppDependencies } from "./deps.js";
import type { ServerEnvironment } from "./environment.js";
import { createOpenAICompatibleClient } from "./services/evals/inference.js";
import { createRegexEvaluator } from "./services/evals/regex.js";
import type { InferenceClients } from "./services/evals/types.js";
import { LocalObjectStore } from "./storage/local.js";
import { S3ObjectStore } from "./storage/s3.js";
import { createBlobSigner } from "./storage/signer.js";
import { createPostgresStore } from "./store/postgres.js";

export const log = (
  level: "info" | "warn" | "error",
  msg: string,
  extra: Record<string, unknown> = {},
) =>
  console[level === "info" ? "log" : level](
    JSON.stringify({ level, msg, ...extra }),
  );

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

  return { models, judge };
};

export const buildDependencies = async (
  env: ServerEnvironment,
): Promise<AppDependencies> => {
  const clock = createDbAnchoredClock();
  const store = createPostgresStore({
    connectionString: env.DATABASE_URL,
    clock,
  });
  await store.migrate();
  // Lease times follow the database clock: sync now and every minute.
  await clock.sync(store.dbNow);
  setInterval(() => {
    clock.sync(store.dbNow).catch(() => undefined);
  }, 60_000).unref();

  const storage = env.S3_BUCKET
    ? new S3ObjectStore({
        bucket: env.S3_BUCKET,
        region: env.S3_REGION,
        endpoint: env.S3_ENDPOINT,
      })
    : new LocalObjectStore(env.STORAGE_DIR);

  const trainerKeyHash =
    env.TRAINER_API_KEY_HASH ??
    (env.TRAINER_API_KEY ? hashApiKey(env.TRAINER_API_KEY) : undefined);
  const cloud = (): CloudAdapterConfig => ({
    internalApiBaseUrl: env.CLOUD_INTERNAL_API_URL as string,
    serviceToken: env.CLOUD_SERVICE_TOKEN as string,
    trainerKeyHash,
  });

  const auth =
    env.AUTH_MODE === "cloud"
      ? createCloudAuthAdapter(cloud())
      : env.AUTH_MODE === "api_key"
        ? createLocalApiKeyAuth({
            adminKeyHash: env.ADMIN_API_KEY_HASH,
            trainerKeyHash,
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
    deploy:
      env.DEPLOY_MODE === "cloud"
        ? createCloudDeployAdapter(cloud())
        : createDisabledDeployAdapter(),
    serving:
      env.DEPLOY_MODE === "cloud"
        ? createCloudServingAdapter(cloud())
        : createDisabledServingAdapter(),
    catalog: createModelCatalog(env.GRAD_EXTRA_MODELS_JSON),
    clock,
    inference: buildInference(env),
    regex: createRegexEvaluator(),
    settings: {
      maxAttempts: env.MAX_ATTEMPTS,
      evalConcurrency: env.EVAL_CONCURRENCY,
    },
  };
};
