import { serve } from "@hono/node-server";

import { createGradApp } from "./app.js";
import { buildDependencies, log } from "./bootstrap.js";
import { parseServerEnvironment } from "./environment.js";

const main = async () => {
  const env = parseServerEnvironment();
  for (const warning of env.warnings) log("warn", warning);

  const deps = await buildDependencies(env);
  const { app, services } = createGradApp(deps);

  services.maintenance.start(env.MAINTENANCE_INTERVAL_MS);
  if (env.EVAL_EXECUTOR && deps.inference) services.evals.start(1000);

  const server = serve({
    fetch: app.fetch,
    hostname: env.HOST,
    port: env.PORT,
  });
  log("info", "grad-server listening", {
    url: `http://${env.HOST}:${env.PORT}`,
    auth_mode: env.AUTH_MODE,
    deploy_mode: env.DEPLOY_MODE,
    storage: deps.storage.kind,
    inference: deps.inference ? "configured" : "unavailable",
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "grad-server shutting down", { signal });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await services.maintenance.stop();
    await services.evals.stop();
    await deps.regex.close();
    await deps.store.close();
    process.exit(0);
  };

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
};

main().catch((error: unknown) => {
  log("error", "grad-server failed to start", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
