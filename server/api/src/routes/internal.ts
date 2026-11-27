/**
 * The internal listener (INTERNAL_PORT, default off): routes an orchestrator
 * calls, never served on the public API port. Today: lease-scoped worker
 * tokens (callers authenticate with an orchestrator key,
 * GRAD_ORCHESTRATOR_KEYS_JSON) and, on Cloud, the product API's routes in
 * routes/internal-cloud.ts (service JWTs). Workspace and worker keys are
 * never accepted.
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
import { ApiError } from "../errors.js";
import type { WorkerTokenRepository } from "../store/types.js";
import { log } from "../telemetry/log.js";
import {
  MAX_LEASE_TOKEN_SECONDS,
  newLeaseToken,
} from "../worker-auth/lease.js";
import { problemBody } from "./helpers.js";
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
  new Response(
    JSON.stringify(
      problemBody(
        error.status,
        error.code,
        error.title,
        error.detail,
        c.get("requestId") ?? "req_unknown",
      ),
    ),
    {
      status: error.status,
      headers: { "Content-Type": "application/problem+json" },
    },
  );

const invalid = (detail: string) =>
  new ApiError(422, "validation_error", "Validation failed", detail);

export const createInternalApp = (deps: {
  tokens: WorkerTokenRepository;
  clock: Clock;
  orchestratorKeys: readonly TrainerKey[];
  /** Cloud: the product API's routes (workspace state, artifact pins). */
  cloud?: CloudInternalDeps | undefined;
}): Hono<InternalEnv> => {
  const app = new Hono<InternalEnv>();

  app.onError((error, c) => {
    if (error instanceof ApiError) return problem(c, error);
    log("error", "internal route failed", {
      path: c.req.path,
      error: error instanceof Error ? error.message : String(error),
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
    const token = c.req
      .header("authorization")
      ?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const key = token ? findKeyByToken(token, deps.orchestratorKeys) : null;
    if (!key) {
      throw new ApiError(
        401,
        "unauthorized",
        "Authentication required",
        "Internal routes need an orchestrator key (GRAD_ORCHESTRATOR_KEYS_JSON) as 'Authorization: Bearer <key>'.",
      );
    }
    c.set("orchestrator", key);
    await next();
  };
  app.use("/internal/v1/worker-tokens", orchestratorOnly);
  app.use("/internal/v1/worker-tokens/*", orchestratorOnly);
  // Gradiated Cloud's routes authenticate with service JWTs instead.
  if (deps.cloud) app.route("/", createCloudInternalRoutes(deps.cloud));

  app.post("/internal/v1/worker-tokens", async (c) => {
    const orchestrator = c.get("orchestrator");
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      throw new ApiError(
        400,
        "malformed_request",
        "Malformed request",
        "The body must be JSON.",
      );
    }
    const parsed = MintWorkerTokenSchema.safeParse(json);
    if (!parsed.success) {
      throw invalid(
        parsed.error.issues
          .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
          .join("; "),
      );
    }
    const input = parsed.data;
    const denied = input.kinds.filter((k) => !orchestrator.kinds.includes(k));
    if (denied.length > 0) {
      throw new ApiError(
        403,
        "job_kind_forbidden",
        "Insufficient scope",
        `Orchestrator '${orchestrator.label}' may mint tokens only for ${orchestrator.kinds.join(", ")} jobs, not ${denied.join(", ")}.`,
      );
    }
    const now = deps.clock.now();
    const expiresAt = new Date(input.expires_at);
    const seconds = (expiresAt.getTime() - now.getTime()) / 1000;
    if (seconds <= 0) throw invalid("expires_at: must be in the future.");
    if (seconds > MAX_LEASE_TOKEN_SECONDS) {
      throw invalid(
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
    if (!LEASE_ID_RE.test(leaseId)) throw invalid("lease_id: invalid.");
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
