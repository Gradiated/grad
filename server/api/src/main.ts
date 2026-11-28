import type { Server } from "node:http";

import { serve } from "@hono/node-server";

import { API_VERSION, createGradApp, createMetricsApp } from "./app.js";
import { buildDependencies } from "./bootstrap.js";
import { log, setLogComponent } from "./telemetry/log.js";
import { parseServerEnvironment } from "./environment.js";
import { createInternalApp } from "./routes/internal.js";
import { runMigrations } from "./migrations.js";
import { gracefulShutdown } from "./shutdown.js";
import { startTracing, stopTracing } from "./telemetry/tracing.js";
import { runWorker } from "./worker/main.js";

// A stray rejection is a bug to log, not a reason to take the replica down.
process.on("unhandledRejection", (reason: unknown) => {
  log("error", "unhandled promise rejection", {
    error: reason,
  });
});

const main = async () => {
  const env = parseServerEnvironment();
  for (const warning of env.warnings) log("warn", warning);
  const tracing = await startTracing(process.env, { version: API_VERSION });

  const deps = await buildDependencies(env);
  const { app, services, startDraining } = createGradApp(deps);

  services.maintenance.start(env.MAINTENANCE_INTERVAL_MS);

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
            cloud: deps.jwt ? { jwt: deps.jwt, deps, services } : undefined,
          }).fetch,
          hostname: env.HOST,
          port: internalPort,
        })
      : null;
  log("info", "grad-server listening", {
    url: `http://${env.HOST}:${env.PORT}`,
    auth_mode: env.AUTH_MODE,
    storage: env.S3_ENDPOINT ? `s3 ${env.S3_ENDPOINT}` : "s3",
    evals: deps.inferenceConfigured
      ? "on eval workers"
      : "unavailable (no GRAD_INFERENCE_BASE_URL)",
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
    const ok = await gracefulShutdown({
      servers: [server, internalServer, metricsServer].filter(
        (s) => s !== null,
      ) as Server[],
      startDraining,
      drainMs: env.SHUTDOWN_DRAIN_SECONDS * 1000,
      stopBackground: async () => {
        await services.maintenance.stop();
        // Ends every SSE stream now; clients resume on another replica with Last-Event-ID.
        await services.events.close();
      },
      closeResources: async () => {
        await deps.store.close();
        await stopTracing();
      },
    });
    process.exit(ok ? 0 : 1);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
};

const migrateOnly = async () => {
  const applied = await runMigrations(process.env.DATABASE_URL);
  log("info", "grad-server migrations applied", { applied });
};

const command = process.argv[2];
if (command === "migrate") setLogComponent("migrate");
if (command === "worker") setLogComponent("eval-worker");
(command === "migrate"
  ? migrateOnly()
  : command === "worker"
    ? runWorker(process.argv.slice(3))
    : main()
).catch((error: unknown) => {
  // The worker's promise settles when its loop ends, so it fails mid-run too.
  log(
    "error",
    command === "worker"
      ? "grad-server worker stopped on an error"
      : "grad-server failed to start",
    { error },
  );
  process.exit(1);
});
