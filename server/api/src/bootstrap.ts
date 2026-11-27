import {
  createLocalApiKeyAuth,
  createLocalNoneAuth,
  createNoopBillingAdapter,
  hashApiKey,
  trainerKeysOf,
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
import { assertMigrated } from "./migrations.js";
import { resolveUiBundle, type UiBundle } from "./ui.js";
import { S3ObjectStore } from "./storage/s3.js";
import { createSecretsCipher } from "./secrets.js";
import { createPostgresStore } from "./store/postgres.js";
import { log } from "./telemetry/log.js";
import { instrumentObjectStore } from "./telemetry/storage.js";
import { buildWorkerAuthenticator } from "./worker-auth/index.js";

export { log } from "./telemetry/log.js";

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
    new S3ObjectStore({
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      publicEndpoint: env.S3_PUBLIC_ENDPOINT,
    }),
  );

  const trainerKeyHash =
    env.TRAINER_API_KEY_HASH ??
    (env.TRAINER_API_KEY ? hashApiKey(env.TRAINER_API_KEY) : undefined);
  const workers = buildWorkerAuthenticator(env.workerAuth, {
    staticKeys: trainerKeysOf(trainerKeyHash, env.trainerKeys),
    tokens: store.workerTokens,
    clock,
  });
  const cloud = (): CloudAdapterConfig => ({
    internalApiBaseUrl: env.CLOUD_INTERNAL_API_URL as string,
    serviceToken: env.CLOUD_SERVICE_TOKEN as string,
    workers,
  });

  const auth =
    env.AUTH_MODE === "cloud"
      ? createCloudAuthAdapter(cloud())
      : env.AUTH_MODE === "api_key"
        ? createLocalApiKeyAuth({
            adminKeyHash: env.ADMIN_API_KEY_HASH,
            workers,
            workspaceId: env.DEFAULT_WORKSPACE_ID,
            lookup: store.apiKeys,
          })
        : createLocalNoneAuth(env.DEFAULT_WORKSPACE_ID);

  let ui: UiBundle | null = null;
  if (env.uiEnabled) {
    ui = resolveUiBundle(env.UI_DIR);
    if (!ui) {
      log(
        "warn",
        `UI_ENABLED but no built UI found${env.UI_DIR ? ` in UI_DIR=${env.UI_DIR}` : ""}: run \`pnpm -C server/ui build\` (the image ships one).`,
      );
    }
  }

  return {
    store,
    storage,
    ui,
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
    inferenceConfigured: env.inferenceConfigured,
    secrets: createSecretsCipher({
      key: env.GRAD_SECRETS_KEY,
      oldKeys: env.GRAD_SECRETS_KEYS_OLD,
    }),
    // The `gradiated` source reads Cloud gateway traces: Cloud only.
    traces:
      env.AUTH_MODE === "cloud" ? createCloudTracesAdapter(cloud()) : null,
    settings: {
      maxAttempts: env.MAX_ATTEMPTS,
      maxPreemptions: env.MAX_PREEMPTIONS,
      waitingForComputeSeconds: env.WAITING_FOR_COMPUTE_SECONDS,
      workerAutoscaling: env.GRAD_WORKER_AUTOSCALING,
      queue: {
        maxRunning: {
          train: env.GRAD_MAX_RUNNING_PER_WORKSPACE_TRAIN,
          import: env.GRAD_MAX_RUNNING_PER_WORKSPACE_IMPORT,
          eval: env.GRAD_MAX_RUNNING_PER_WORKSPACE_EVAL,
        },
        maxQueued: env.GRAD_MAX_QUEUED_PER_WORKSPACE,
      },
      ssePollMs: env.SSE_POLL_MS,
      jobEventRetentionDays: env.JOB_EVENT_RETENTION_DAYS,
      orphanBlobDays: env.ORPHAN_BLOB_DAYS,
      usageFlushTokens: env.USAGE_FLUSH_TOKENS,
      usageFlushSeconds: env.USAGE_FLUSH_SECONDS,
      usageExportLagSeconds: env.USAGE_EXPORT_LAG_SECONDS,
      sourceSyncIntervalSeconds: env.SOURCE_SYNC_INTERVAL_SECONDS,
      sourceVersionIntervalSeconds: env.SOURCE_VERSION_INTERVAL_SECONDS,
      sourceVersionMaxRecords: env.SOURCE_VERSION_MAX_RECORDS,
      metrics: {
        enabled: env.METRICS_ENABLED,
        token: env.METRICS_TOKEN,
        separatePort: env.METRICS_PORT !== undefined,
        workspaceLabel: env.METRICS_WORKSPACE_LABEL,
      },
    },
  };
};
