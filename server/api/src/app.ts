import { randomUUID } from "node:crypto";
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";

import type { AppDependencies } from "./deps.js";
import { ApiError, issuesOf, parseBearer, validationFailed } from "./errors.js";
import { largeBodyGate, unauthenticatedGuard } from "./http-guards.js";
import { documentIdempotencyHeader } from "./idempotency.js";
import { registerArtifactRoutes } from "./routes/artifacts.js";
import { registerCheckpointRoutes } from "./routes/checkpoints.js";
import { registerDatasetRoutes } from "./routes/datasets.js";
import { registerEvalRoutes } from "./routes/evals.js";
import {
  problemResponse as problemJson,
  requireScope,
  type AppEnv,
} from "./routes/helpers.js";
import { registerModelsAndKeysRoutes } from "./routes/keys.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerSourceRoutes } from "./routes/sources.js";
import { registerTrainerJobRoutes } from "./routes/trainer-jobs.js";
import { registerUsageRoutes } from "./routes/usage.js";
import { createServices, type Services } from "./services/index.js";
import { StorageUnavailableError } from "./storage/types.js";
import { isDatabaseUnavailable } from "./store/postgres/db.js";
import { registerMetricsEndpoints } from "./telemetry/endpoint.js";
import { httpTelemetry } from "./telemetry/http.js";
import { log, withLogContext } from "./telemetry/log.js";
import { metrics } from "./telemetry/metrics.js";
import { serveUiFallback, serveUiFile } from "./ui.js";

export type { AppDependencies } from "./deps.js";

export const API_TITLE = "Gradiated Training & Serving API";
export const API_VERSION = "0.2.0-alpha.7";

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** SDKs push records in 8-16 MiB batches; bigger files go through upload tickets. */
export const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024;
/** Large bodies handled at once per replica (src/http-guards.ts). */
const LARGE_BODY_SLOTS = 2;

/** What a browser may send cross-origin (GRAD_CORS_ORIGINS). */
export const CORS_REQUEST_HEADERS = [
  "Authorization",
  "Content-Type",
  "Idempotency-Key",
  "Last-Event-ID",
  "X-Request-Id",
];
/** What it may read back. */
export const CORS_EXPOSED_HEADERS = [
  "x-request-id",
  "Retry-After",
  "X-Artifact-Sha256",
  "Content-Disposition",
];

/** The worker-auth mode behind a principal's identity (WorkerPrincipal.identity). */
const workerAuthMode = (identity: string): string =>
  identity.startsWith("k8s:")
    ? "kubernetes"
    : identity.startsWith("lease:")
      ? "lease"
      : "static";

const problemResponse = (
  c: Context<AppEnv>,
  status: number,
  code: string,
  title: string,
  detail: string,
): Response =>
  problemJson(c.get("requestId") ?? "req_unknown", status, code, title, detail);

export interface GradApp {
  app: OpenAPIHono<AppEnv>;
  services: Services;
}

export const createGradApp = (deps: AppDependencies): GradApp => {
  const services = createServices(deps);
  metrics.buildInfo.set({ version: API_VERSION }, 1);
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        throw validationFailed(issuesOf(result.error, "body"));
      }

      return undefined;
    },
  });

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return problemResponse(
        c,
        error.status,
        error.code,
        error.title,
        error.detail,
      );
    }

    if (error instanceof HTTPException) {
      const status = error.status;
      const malformed = status === 400;

      return problemResponse(
        c,
        status,
        malformed ? "malformed_request" : `http_${status}`,
        malformed ? "Malformed request" : "Request failed",
        error.message || "The request could not be processed.",
      );
    }

    if (error instanceof StorageUnavailableError) {
      const res = problemResponse(
        c,
        503,
        "storage_unavailable",
        "Storage unavailable",
        "Object storage is unreachable or overloaded; retry shortly.",
      );
      res.headers.set("Retry-After", "1");
      log("warn", "object storage unavailable", {
        request_id: c.get("requestId"),
        path: c.req.path,
        error: error.message,
      });

      return res;
    }

    if (isDatabaseUnavailable(error)) {
      const res = problemResponse(
        c,
        503,
        "database_unavailable",
        "Database unavailable",
        "The database is unreachable or overloaded; retry shortly.",
      );
      res.headers.set("Retry-After", "1");

      return res;
    }

    log("error", "unhandled error", {
      request_id: c.get("requestId"),
      path: c.req.path,
      error,
    });

    return problemResponse(
      c,
      500,
      "internal_error",
      "Internal server error",
      "An unexpected error occurred. Quote the request_id when reporting it.",
    );
  });

  app.notFound(
    (c) =>
      (deps.ui && serveUiFallback(c, deps.ui, c.get("requestId"))) ??
      problemResponse(
        c,
        404,
        "route_not_found",
        "Route not found",
        `No route matches ${c.req.method} ${c.req.path}.`,
      ),
  );

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

  app.use("*", httpTelemetry());

  if (deps.settings.unauthenticated) {
    app.use(
      "*",
      unauthenticatedGuard(deps.settings.corsOrigins ?? [], (c, code, detail) =>
        problemResponse(c, 403, code, "Forbidden", detail),
      ),
    );
  }

  const metricsSettings = deps.settings.metrics ?? { enabled: true };
  if (metricsSettings.enabled && !metricsSettings.separatePort) {
    registerMetricsEndpoints(app as unknown as Hono, {
      token: metricsSettings.token,
      sampler: services.telemetry,
      now: () => deps.clock.now(),
    });
  }
  const ui = deps.ui;
  if (ui)
    app.use(
      "*",
      async (c, next) => serveUiFile(c, ui, c.get("requestId")) ?? next(),
    );

  // Browser clients (the Gradiated console) on allowlisted origins: bearer
  // tokens only, never cookies, so no credentials mode. Off by default.
  const corsOrigins = deps.settings.corsOrigins ?? [];
  if (corsOrigins.length > 0) {
    app.use(
      "/v1/*",
      cors({
        origin: (origin) => (corsOrigins.includes(origin) ? origin : null),
        allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        allowHeaders: CORS_REQUEST_HEADERS,
        exposeHeaders: CORS_EXPOSED_HEADERS,
        maxAge: 600,
      }),
    );
  }

  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: MAX_JSON_BODY_BYTES,
      onError: (c) =>
        problemResponse(
          c,
          413,
          "payload_too_large",
          "Request payload too large",
          `Request bodies are limited to ${MAX_JSON_BODY_BYTES / (1024 * 1024)} MiB; upload large files with an upload ticket.`,
        ),
    }),
  );

  app.get("/health/live", (c) => c.json({ status: "ok" }, 200));

  app.get("/health/ready", async (c) => {
    if (!(await deps.store.ping())) {
      return problemResponse(
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
    const workerRoute = c.req.path.startsWith("/v1/trainer-jobs/");
    let principal: Awaited<ReturnType<typeof deps.auth.authenticate>>;
    try {
      principal = await deps.auth.authenticate(
        parseBearer(c.req.header("authorization")),
      );
    } catch (error) {
      if (workerRoute) {
        metrics.workerAuth.inc({
          mode:
            error instanceof ApiError &&
            error.code === "worker_auth_unavailable"
              ? "kubernetes"
              : "none",
          result: "unavailable",
        });
      }
      throw error;
    }
    if (workerRoute) {
      metrics.workerAuth.inc(
        principal?.worker
          ? { mode: workerAuthMode(principal.worker.identity), result: "ok" }
          : { mode: "none", result: "rejected" },
      );
    }
    if (!principal) {
      return problemResponse(
        c,
        401,
        "unauthorized",
        "Authentication required",
        "Provide a valid API key as 'Authorization: Bearer <key>' (SDKs read GRADIATED_API_KEY).",
      );
    }

    c.set("principal", principal);
    // Log lines of a workspace request carry its workspace (never a metric label).
    if (principal.kind === "worker") await next();
    else {
      await withLogContext({ workspace_id: principal.workspaceId }, () =>
        next(),
      );
    }
  });

  app.use("/v1/*", largeBodyGate(LARGE_BODY_SLOTS));

  // Worker routes check the platform scope before body validation so tenants
  // learn nothing about the protocol from validation errors.
  app.use("/v1/trainer-jobs/*", async (c, next) => {
    requireScope(c, "trainer:worker");
    await next();
  });

  documentIdempotencyHeader(app);

  registerModelsAndKeysRoutes(app, deps);
  registerDatasetRoutes(app, deps, services);
  registerRunRoutes(app, deps, services);
  registerCheckpointRoutes(app, deps, services);
  registerTrainerJobRoutes(app, deps, services);
  registerArtifactRoutes(app, deps, services);
  registerUsageRoutes(app, services);
  registerEvalRoutes(app, deps, services);
  registerSourceRoutes(app, deps, services);

  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: { title: API_TITLE, version: API_VERSION },
  });

  return { app, services };
};

export const createApp = (deps: AppDependencies): OpenAPIHono<AppEnv> =>
  createGradApp(deps).app;

/** The metrics-only app main.ts serves on METRICS_PORT. */
export const createMetricsApp = (
  deps: AppDependencies,
  services: Services,
): Hono => {
  const app = new Hono();
  registerMetricsEndpoints(app, {
    token: deps.settings.metrics?.token,
    sampler: services.telemetry,
    now: () => deps.clock.now(),
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
    info: { title: API_TITLE, version: API_VERSION },
  }) as {
    openapi: string;
    info: { title: string; version: string };
    paths?: Record<string, unknown>;
    components?: Record<string, unknown>;
  };
