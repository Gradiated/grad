import type { Server } from "node:http";

import { serve } from "@hono/node-server";

import { API_VERSION, createGradApp, createMetricsApp } from "./app.js";
import { buildDependencies, log } from "./bootstrap.js";
import { parseServerEnvironment } from "./environment.js";
import { createInternalApp } from "./routes/internal.js";
import { runMigrations } from "./migrations.js";
import { gracefulShutdown } from "./shutdown.js";
import { startTracing, stopTracing } from "./telemetry/tracing.js";

// A stray rejection is a bug to log, not a reason to take the replica down.
process.on("unhandledRejection", (reason: unknown) => {
  log("error", "unhandled promise rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
  });
});

const main = async () => {
  const env = parseServerEnvironment();
  for (const warning of env.warnings) log("warn", warning);
  const tracing = await startTracing(process.env, { version: API_VERSION });

  const deps = await buildDependencies(env);
  const { app, services } = createGradApp(deps);

  services.maintenance.start(env.MAINTENANCE_INTERVAL_MS);
  if (env.EVAL_EXECUTOR && deps.inference) services.evals.start(1000);

  const server = serve({
    fetch: app.fetch,
    hostname: env.HOST,
    port: env.PORT,
  });
  const metricsServer =
    env.METRICS_ENABLED && env.METRICS_PORT !== undefined
      ? serve({
          fetch: createMetricsApp(deps, services).fetch,
          hostname: env.HOST,
          port: env.METRICS_PORT,
        })
      : null;
  const { internalPort, orchestratorKeys } = env.workerAuth;
  const internalServer =
    internalPort !== undefined
      ? serve({
          fetch: createInternalApp({
            tokens: deps.store.workerTokens,
            clock: deps.clock,
            orchestratorKeys,
          }).fetch,
          hostname: env.HOST,
          port: internalPort,
        })
      : null;
  log("info", "grad-server listening", {
    url: `http://${env.HOST}:${env.PORT}`,
    auth_mode: env.AUTH_MODE,
    storage: env.S3_ENDPOINT ? `s3 ${env.S3_ENDPOINT}` : "s3",
    inference: deps.inference ? "configured" : "unavailable",
    metrics: env.METRICS_ENABLED
      ? `:${env.METRICS_PORT ?? env.PORT}/metrics`
      : "off",
    tracing: tracing ? "otlp" : "off",
    worker_auth: env.workerAuth.modes.join(","),
    internal: internalPort !== undefined ? `:${internalPort}` : "off",
    ui: deps.ui ? `http://${env.HOST}:${env.PORT}/` : "disabled",
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "grad-server shutting down", { signal });
    await gracefulShutdown({
      server: server as Server,
      stopBackground: async () => {
        await services.maintenance.stop();
        await services.evals.stop();
        // Ends every SSE stream now; clients resume on another replica with Last-Event-ID.
        await services.events.close();
      },
      closeResources: async () => {
        metricsServer?.close();
        internalServer?.close();
        await deps.regex.close();
        await deps.store.close();
        await stopTracing();
      },
    });
    process.exit(0);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
};

const migrateOnly = async () => {
  const applied = await runMigrations(process.env.DATABASE_URL);
  log("info", "grad-server migrations applied", { applied });
};

(process.argv[2] === "migrate" ? migrateOnly() : main()).catch(
  (error: unknown) => {
    log("error", "grad-server failed to start", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  },
);
