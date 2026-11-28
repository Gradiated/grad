import {
  createLocalApiKeyAuth,
  createLocalNoneAuth,
  createNoopBillingAdapter,
  hashApiKey,
  trainerKeysOf,
} from "./adapters.js";
import { createCloudAuth } from "./cloud/auth.js";
import { createAuthView } from "./cloud/auth-view.js";
import { createCloudBilling } from "./cloud/billing.js";
import { createEvalModelResolver } from "./cloud/gateway.js";
import { createJwtVerifier } from "./cloud/jwt.js";
import { createKmsKeyWrapper } from "./cloud/kms.js";
import { createCloudPrices, pricedCatalog } from "./cloud/prices.js";
import { createCloudTracesAdapter } from "./cloud/traces.js";
import { createModelCatalog } from "./catalog.js";
import { createDbAnchoredClock } from "./clock.js";
import type { AppDependencies } from "./deps.js";
import type { ServerEnvironment } from "./environment.js";
import { assertMigrated } from "./migrations.js";
import { resolveUiBundle, type UiBundle } from "./ui.js";
import { S3ObjectStore } from "./storage/s3.js";
import { createSecretsCipher } from "./secrets.js";
import { createPostgresStore } from "./store/postgres/index.js";
import { log } from "./telemetry/log.js";
import { instrumentObjectStore } from "./telemetry/storage.js";
import { buildWorkerAuthenticator } from "./worker-auth/index.js";

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
    clock.sync(store.dbNow).catch((error: unknown) => {
      // The clock runs on from its last sync meanwhile.
      log("warn", "database clock sync failed", { error });
    });
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
  const jwt =
    env.AUTH_MODE === "cloud" && env.GRAD_CLOUD_JWKS_URL
      ? createJwtVerifier({
          jwksUrl: env.GRAD_CLOUD_JWKS_URL,
          issuer: env.GRAD_CLOUD_JWT_ISSUER as string,
          audience: "training",
          clock,
        })
      : null;
  const auth =
    env.AUTH_MODE === "cloud"
      ? createCloudAuth({
          view: createAuthView(env.GRAD_CLOUD_AUTH_DATABASE_URL as string),
          jwt: jwt as NonNullable<typeof jwt>,
          workers,
          clock,
        })
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

  const catalog = createModelCatalog(
    env.GRAD_EXTRA_MODELS_JSON,
    env.GRAD_JUDGE_MODELS_JSON,
  );
  const prices =
    env.BILLING_MODE === "cloud"
      ? createCloudPrices({
          url: env.GRAD_CLOUD_PRICES_URL as string,
          token: env.CLOUD_SERVICE_TOKEN as string,
          clock,
        })
      : null;
  // The first price list before serving; an outage keeps going (creates 503).
  await prices?.refresh(true);

  return {
    store,
    storage,
    ui,
    auth,
    jwt,
    prices,
    billing: prices
      ? createCloudBilling({
          baseUrl: env.GRAD_CLOUD_BILLING_URL as string,
          token: env.CLOUD_SERVICE_TOKEN as string,
          prices,
          clock,
          gatewayBillsEvals: env.GRAD_CLOUD_GATEWAY_URL !== undefined,
        })
      : createNoopBillingAdapter(),
    evalModels: env.GRAD_CLOUD_GATEWAY_URL
      ? createEvalModelResolver({
          internalApiBaseUrl: env.CLOUD_INTERNAL_API_URL as string,
          serviceToken: env.CLOUD_SERVICE_TOKEN as string,
        })
      : null,
    catalog: prices ? pricedCatalog(catalog, prices) : catalog,
    clock,
    inferenceConfigured: env.inferenceConfigured,
    secrets: createSecretsCipher({
      key: env.GRAD_SECRETS_KEY,
      oldKeys: env.GRAD_SECRETS_KEYS_OLD,
      kmsKeyId: env.GRAD_SECRETS_KMS_KEY_ID,
      kms: env.GRAD_SECRETS_KMS_KEY_ID
        ? createKmsKeyWrapper({ region: env.S3_REGION })
        : undefined,
    }),
    // The `gradiated` source reads Cloud gateway traces: Cloud only, and
    // only once the product serves traces:pull (GRAD_CLOUD_TRACES_ENABLED).
    traces:
      env.AUTH_MODE === "cloud" &&
      env.GRAD_CLOUD_TRACES_ENABLED &&
      env.CLOUD_INTERNAL_API_URL &&
      env.CLOUD_SERVICE_TOKEN
        ? createCloudTracesAdapter({
            internalApiBaseUrl: env.CLOUD_INTERNAL_API_URL,
            serviceToken: env.CLOUD_SERVICE_TOKEN,
          })
        : null,
    settings: {
      maxAttempts: env.MAX_ATTEMPTS,
      maxPreemptions: env.MAX_PREEMPTIONS,
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
      workspacePurgeDelaySeconds: env.GRAD_WORKSPACE_PURGE_DELAY_SECONDS,
      corsOrigins: env.corsOrigins,
      unauthenticated: env.AUTH_MODE === "none",
      keysManagedByCloud: env.AUTH_MODE === "cloud",
      inferencePinsManagedByCloud: env.AUTH_MODE === "cloud",
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
