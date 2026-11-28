/**
 * The internal listener (INTERNAL_PORT, default off): routes an orchestrator
 * or the Cloud product API calls, never served on the public API port. Two
 * groups, each mounted only when configured (otherwise 404): lease-scoped
 * worker tokens (lease in GRAD_WORKER_AUTH; callers authenticate with an
 * orchestrator key, GRAD_ORCHESTRATOR_KEYS_JSON) and, on Cloud, the product
 * API's routes in routes/internal-cloud.ts (AUTH_MODE=cloud; service JWTs).
 * Workspace and worker keys are never accepted.
 *
 *   POST   /internal/v1/worker-tokens {host_id, lease_id, kinds, gpu_memory_gb?, expires_at}
 *          -> 201 {token, host_id, lease_id, kinds, gpu_memory_gb, expires_at}
 *   DELETE /internal/v1/worker-tokens/{lease_id} -> 200 {lease_id, revoked}
 */
import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";

import {
  WORKER_JOB_KINDS,
  findKeyByToken,
  hashApiKey,
  type TrainerKey,
} from "../adapters.js";
import type { Clock } from "../clock.js";
import {
  ApiError,
  insufficientScope,
  issuesOf,
  parseBearer,
  unauthorized,
  validationFailed,
} from "../errors.js";
import type { WorkerTokenRepository } from "../store/types.js";
import { log } from "../telemetry/log.js";
import {
  MAX_LEASE_TOKEN_SECONDS,
  newLeaseToken,
} from "../worker-auth/lease.js";
import { problemResponse, readJson } from "./helpers.js";
import {
  createCloudInternalRoutes,
  type CloudInternalDeps,
} from "./internal-cloud.js";

const HOST_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const LEASE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export const MintWorkerTokenSchema = z.strictObject({
  host_id: z.string().regex(HOST_ID_RE, "1-128 of A-Z a-z 0-9 . _ - (no ':')"),
  lease_id: z.string().regex(LEASE_ID_RE, "1-128 of A-Z a-z 0-9 . _ : -"),
  kinds: z
    .array(z.enum(WORKER_JOB_KINDS))
    .min(1)
    .refine((k) => new Set(k).size === k.length, "kinds repeat"),
  gpu_memory_gb: z.number().positive().max(100_000).optional(),
  expires_at: z.iso.datetime({ offset: true }),
});

type InternalEnv = {
  Variables: { requestId: string; orchestrator: TrainerKey };
};

const problem = (
  c: Context<InternalEnv>,
  error: Pick<ApiError, "status" | "code" | "title" | "detail">,
): Response =>
  problemResponse(
    c.get("requestId") ?? "req_unknown",
    error.status,
    error.code,
    error.title,
    error.detail,
  );

export const createInternalApp = (deps: {
  tokens: WorkerTokenRepository;
  clock: Clock;
  /** Empty: no lease-token routes. */
  orchestratorKeys: readonly TrainerKey[];
  /** Cloud: the product API's routes (workspace state, artifact pins). */
  cloud?: CloudInternalDeps | undefined;
}): Hono<InternalEnv> => {
  const app = new Hono<InternalEnv>();

  app.onError((error, c) => {
    if (error instanceof ApiError) return problem(c, error);
    log("error", "internal route failed", {
      path: c.req.path,
      error,
    });

    return problem(c, {
      status: 500,
      code: "internal_error",
      title: "Internal server error",
      detail: "An unexpected error occurred.",
    });
  });
  app.notFound((c) =>
    problem(c, {
      status: 404,
      code: "route_not_found",
      title: "Route not found",
      detail: `No route matches ${c.req.method} ${c.req.path}.`,
    }),
  );

  app.use("*", async (c, next) => {
    c.set("requestId", `req_${randomUUID()}`);
    await next();
  });
  app.get("/health/live", (c) => c.json({ status: "ok" }, 200));
  app.use(
    "/internal/*",
    bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) =>
        problem(c, {
          status: 413,
          code: "payload_too_large",
          title: "Request payload too large",
          detail: "Internal requests are limited to 16 KiB.",
        }),
    }),
  );
  const orchestratorOnly = async (
    c: Context<InternalEnv>,
    next: () => Promise<void>,
  ) => {
    const token = parseBearer(c.req.header("authorization"));
    const key = token ? findKeyByToken(token, deps.orchestratorKeys) : null;
    if (!key) {
      throw unauthorized(
        "Internal routes need an orchestrator key (GRAD_ORCHESTRATOR_KEYS_JSON) as 'Authorization: Bearer <key>'.",
      );
    }
    c.set("orchestrator", key);
    await next();
  };
  // Gradiated Cloud's routes authenticate with service JWTs instead.
  if (deps.cloud) app.route("/", createCloudInternalRoutes(deps.cloud));
  if (deps.orchestratorKeys.length === 0) return app;

  app.use("/internal/v1/worker-tokens", orchestratorOnly);
  app.use("/internal/v1/worker-tokens/*", orchestratorOnly);
  app.post("/internal/v1/worker-tokens", async (c) => {
    const orchestrator = c.get("orchestrator");
    const parsed = MintWorkerTokenSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      throw validationFailed(issuesOf(parsed.error, "body"));
    }
    const input = parsed.data;
    const denied = input.kinds.filter((k) => !orchestrator.kinds.includes(k));
    if (denied.length > 0) {
      throw insufficientScope(
        `Orchestrator '${orchestrator.label}' may mint tokens only for ${orchestrator.kinds.join(", ")} jobs, not ${denied.join(", ")}.`,
        "job_kind_forbidden",
      );
    }
    const now = deps.clock.now();
    const expiresAt = new Date(input.expires_at);
    const seconds = (expiresAt.getTime() - now.getTime()) / 1000;
    if (seconds <= 0) {
      throw validationFailed("expires_at: must be in the future.");
    }
    if (seconds > MAX_LEASE_TOKEN_SECONDS) {
      throw validationFailed(
        `expires_at: at most ${MAX_LEASE_TOKEN_SECONDS / 86_400} days ahead; mint a new token to extend a lease.`,
      );
    }

    const token = newLeaseToken();
    await deps.tokens.create({
      tokenSha256: hashApiKey(token),
      hostId: input.host_id,
      leaseId: input.lease_id,
      kinds: input.kinds,
      gpuMemoryGb: input.gpu_memory_gb ?? null,
      expiresAt,
      createdBy: `orchestrator:${orchestrator.label}`,
      now,
    });
    log("info", "worker token minted", {
      lease_id: input.lease_id,
      host_id: input.host_id,
      kinds: input.kinds.join(","),
      expires_at: expiresAt.toISOString(),
      orchestrator: orchestrator.label,
    });

    return c.json(
      {
        token,
        host_id: input.host_id,
        lease_id: input.lease_id,
        kinds: input.kinds,
        gpu_memory_gb: input.gpu_memory_gb ?? null,
        expires_at: expiresAt.toISOString(),
      },
      201,
      { "Cache-Control": "no-store" },
    );
  });

  app.delete("/internal/v1/worker-tokens/:lease_id", async (c) => {
    const orchestrator = c.get("orchestrator");
    const leaseId = c.req.param("lease_id");
    if (!LEASE_ID_RE.test(leaseId)) {
      throw validationFailed("lease_id: invalid.");
    }
    const revoked = await deps.tokens.revokeLease(
      leaseId,
      `orchestrator:${orchestrator.label}`,
      deps.clock.now(),
    );
    log("info", "worker tokens revoked", {
      lease_id: leaseId,
      revoked,
      orchestrator: orchestrator.label,
    });

    return c.json({ lease_id: leaseId, revoked }, 200);
  });

  return app;
};
