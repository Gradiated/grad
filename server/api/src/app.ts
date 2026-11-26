import { randomUUID } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";

import { registerArtifactAndServingRoutes } from "./routes/artifacts.js";
import { registerDatasetRoutes } from "./routes/datasets.js";
import { registerEnvWorkerRoutes } from "./routes/env-workers.js";
import { registerEvalRoutes } from "./routes/evals.js";
import {
  respondProblem,
  type AppDependencies,
  type AppEnv,
} from "./routes/helpers.js";
import { registerModelsAndKeysRoutes } from "./routes/keys.js";
import { registerRunRoutes } from "./routes/runs.js";

export type { AppDependencies } from "./routes/helpers.js";

const parseBearer = (header: string | undefined): string | undefined =>
  header?.match(/^Bearer\s+(\S+)$/i)?.[1];

export const createApp = (deps: AppDependencies): OpenAPIHono<AppEnv> => {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return respondProblem(
          c,
          422,
          "validation_error",
          "Validation failed",
          result.error.issues
            .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
            .join("; "),
        );
      }

      return undefined;
    },
  });

  const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

  app.use("*", async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const requestId =
      incoming && REQUEST_ID_RE.test(incoming)
        ? incoming
        : `req_${randomUUID()}`;
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    await next();
  });

  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: 35 * 1024 * 1024,
      onError: (c) =>
        respondProblem(
          c,
          413,
          "payload_too_large",
          "Request payload too large",
          "Request body exceeds the 35 MiB limit.",
        ),
    }),
  );

  app.get("/health/live", (c) => c.json({ status: "ok" }, 200));

  app.get("/health/ready", async (c) => {
    const ok = await deps.store.ping();
    if (!ok) {
      return respondProblem(
        c,
        503,
        "store_unavailable",
        "Database unavailable",
        "The training store failed its readiness check.",
      );
    }

    return c.json({ status: "ready" }, 200);
  });

  app.use("/v1/*", async (c, next) => {
    const token = parseBearer(c.req.header("authorization"));
    const principal = await deps.auth.authenticate(token);
    if (!principal) {
      return respondProblem(
        c,
        401,
        "unauthorized",
        "Authentication required",
        "Provide a valid Bearer API key.",
      );
    }

    c.set("principal", principal);
    await next();
  });

  registerModelsAndKeysRoutes(app, deps);
  registerDatasetRoutes(app, deps);
  registerRunRoutes(app, deps);
  registerArtifactAndServingRoutes(app, deps);
  registerEvalRoutes(app, deps);
  registerEnvWorkerRoutes(app, deps);

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "Gradiated Training & Serving API",
      version: "0.1.0",
    },
  });

  return app;
};

export const buildOpenApiDocument = (
  app: OpenAPIHono<AppEnv>,
): {
  openapi: string;
  info: { title: string; version: string };
  paths?: Record<string, unknown>;
  components?: Record<string, unknown>;
} =>
  app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Gradiated Training & Serving API",
      version: "0.1.0",
    },
  }) as {
    openapi: string;
    info: { title: string; version: string };
    paths?: Record<string, unknown>;
    components?: Record<string, unknown>;
  };
