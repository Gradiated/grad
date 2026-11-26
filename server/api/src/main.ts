import { serve } from "@hono/node-server";

import {
  createDisabledDeployAdapter,
  createLocalApiKeyAuth,
  createLocalDeployAdapter,
  createLocalNoneAuth,
  createNoopBillingAdapter,
} from "./adapters.js";
import { createApp } from "./app.js";
import { parseServerEnvironment } from "./environment.js";
import { EnvWorkerHub } from "./env-hub.js";
import { LocalObjectStore, S3ObjectStore } from "./storage.js";
import {
  InMemoryTrainingStore,
  PostgresTrainingStore,
  type TrainingStore,
} from "./store.js";

const main = async () => {
  const env = parseServerEnvironment();

  const store: TrainingStore = env.DATABASE_URL
    ? new PostgresTrainingStore(env.DATABASE_URL)
    : new InMemoryTrainingStore();

  if (store.migrate) {
    await store.migrate();
  }

  const storage = env.S3_BUCKET
    ? new S3ObjectStore(env.S3_BUCKET, env.S3_REGION, env.S3_ENDPOINT)
    : new LocalObjectStore(env.STORAGE_DIR);

  const auth =
    env.AUTH_MODE === "api_key"
      ? createLocalApiKeyAuth({
          ...(env.ADMIN_API_KEY_HASH
            ? { adminKeyHash: env.ADMIN_API_KEY_HASH }
            : {}),
          workspaceId: env.DEFAULT_WORKSPACE_ID,
          lookup: store,
        })
      : createLocalNoneAuth(env.DEFAULT_WORKSPACE_ID);

  const deploy =
    env.DEPLOY_MODE === "local"
      ? createLocalDeployAdapter()
      : createDisabledDeployAdapter();

  const app = createApp({
    store,
    storage,
    auth,
    billing: createNoopBillingAdapter(),
    deploy,
    envHub: new EnvWorkerHub(),
    allowWave2Recipes: env.ALLOW_WAVE2_RECIPES,
  });

  const server = serve({
    fetch: app.fetch,
    hostname: env.HOST,
    port: env.PORT,
  });

  console.log(`grad-server listening on http://${env.HOST}:${env.PORT}`);

  const shutdown = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close?.();
  };

  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
};

void main();
