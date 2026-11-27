/**
 * Gradiated Cloud's internal routes on the internal listener (INTERNAL_PORT):
 * what the product API calls on grad, never on the public port. Callers send
 * a service JWT signed by the control plane (the same JWKS as console
 * tokens): `sub` = `service:<name>`, `ws` = the path's workspace, and the
 * route's scope in `scopes`.
 *
 *   GET    /internal/v1/workspaces/{ws}/state                       workspaces:admin
 *   PUT    /internal/v1/workspaces/{ws}/state {state}               workspaces:admin
 *   GET    /internal/v1/workspaces/{ws}/artifacts/{id}               artifacts:pin
 *          -> {artifact, download_url (presigned GET, 15 min), expires_at}
 *   PUT    /internal/v1/workspaces/{ws}/artifacts/{id}/pins/{holder} {reason?} artifacts:pin
 *          -> 201 (200 when it existed) {pin, artifact}
 *   DELETE /internal/v1/workspaces/{ws}/artifacts/{id}/pins/{holder} artifacts:pin -> 204
 */
import { Hono, type Context } from "hono";
import { z } from "zod";

import type { JwtVerifier } from "../cloud/jwt.js";
import { PinHolderSchema } from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { ApiError, notFound } from "../errors.js";
import { toPublicArtifact } from "../services/artifacts.js";
import type { Services } from "../services/index.js";
import { log } from "../telemetry/log.js";

export const CLOUD_SERVICE_SCOPES = [
  "workspaces:admin",
  "artifacts:pin",
] as const;
type ServiceScope = (typeof CLOUD_SERVICE_SCOPES)[number];

const WORKSPACE_RE = /^[A-Za-z0-9_-]{1,64}$/;

const StateSchema = z.strictObject({
  state: z.enum(["active", "suspended", "deleted"]),
});

export interface CloudInternalDeps {
  jwt: JwtVerifier;
  deps: Pick<AppDependencies, "store" | "storage" | "clock">;
  services: Pick<Services, "workspaces" | "artifacts">;
}

/** How long a resolve's presigned GET stays valid. */
const RESOLVE_URL_SECONDS = 900;

const unauthorized = (detail: string) =>
  new ApiError(401, "unauthorized", "Authentication required", detail);

/** The service the token names, after checking its workspace and scope. */
const authorize = async (
  c: Context,
  jwt: JwtVerifier,
  scope: ServiceScope,
): Promise<{ workspaceId: string; service: string }> => {
  const workspaceId = c.req.param("ws") ?? "";
  if (!WORKSPACE_RE.test(workspaceId)) {
    throw new ApiError(
      422,
      "validation_error",
      "Validation failed",
      "ws: invalid.",
    );
  }
  const token = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const claims = token ? await jwt.verify(token) : null;
  if (!claims || !claims.sub.startsWith("service:")) {
    throw unauthorized(
      "Cloud internal routes need a service JWT from the Gradiated control plane (sub service:<name>) as 'Authorization: Bearer <jwt>'.",
    );
  }
  const scopes = Array.isArray(claims.scopes) ? claims.scopes : [];
  if (claims.ws !== workspaceId || !scopes.includes(scope)) {
    throw new ApiError(
      403,
      "insufficient_scope",
      "Insufficient scope",
      `This route needs a service token for workspace '${workspaceId}' with scope '${scope}'.`,
    );
  }

  return { workspaceId, service: claims.sub };
};

const readJson = async (c: Context): Promise<unknown> => {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(
      400,
      "malformed_request",
      "Malformed request",
      "The body must be JSON.",
    );
  }
};

/** The Cloud routes, mounted on the internal app (routes/internal.ts). */
export const createCloudInternalRoutes = (deps: CloudInternalDeps): Hono => {
  const app = new Hono();
  const { workspaces, artifacts } = deps.services;
  const { store, storage, clock } = deps.deps;

  const holderOf = (c: Context): string => {
    const holder = PinHolderSchema.safeParse(c.req.param("holder"));
    if (!holder.success) {
      throw new ApiError(
        422,
        "validation_error",
        "Validation failed",
        "holder: letters, digits and . _ : @ - (e.g. inference:version:<id>).",
      );
    }

    return holder.data;
  };

  /** A release of the workspace (checkpoints are not found) that can be served. */
  const release = async (workspaceId: string, reference: string) => {
    const artifact = await store.artifacts.get(workspaceId, reference);
    if (!artifact) throw notFound("artifact", reference);
    if (artifact.format === "reference") {
      throw new ApiError(
        409,
        "artifact_not_servable",
        "Artifact not servable",
        `'${artifact.id}' is a reference bundle (the reference trainer's output), which nothing can serve.`,
      );
    }

    return artifact;
  };

  // Serving's view of an artifact: its metadata and manifest, the stored
  // object (key and its full-object SHA-256 checksum, which S3 recorded on
  // the checksummed PUT or copy and HEAD reports), and a short-lived
  // presigned GET of the bundle.
  app.get("/internal/v1/workspaces/:ws/artifacts/:id", async (c) => {
    const { workspaceId } = await authorize(c, deps.jwt, "artifacts:pin");
    const artifact = await release(workspaceId, c.req.param("id"));
    const head = await storage.head(artifact.storage_key);
    if (!head || head.sha256 !== artifact.sha256) {
      throw new ApiError(
        409,
        "artifact_checksum_mismatch",
        "Artifact checksum unavailable",
        `The stored bundle of '${artifact.id}' has no full-object SHA-256 checksum equal to its recorded sha256 (${head ? (head.sha256 ?? "none") : "missing object"}).`,
      );
    }
    const expiresAt = new Date(
      clock.now().getTime() + RESOLVE_URL_SECONDS * 1000,
    );

    return c.json(
      {
        artifact: toPublicArtifact(artifact),
        object: {
          key: artifact.storage_key,
          sha256: artifact.sha256,
          // As S3 returns it (x-amz-checksum-sha256, ChecksumMode=ENABLED).
          checksum_sha256: Buffer.from(artifact.sha256, "hex").toString(
            "base64",
          ),
          checksum_type: "FULL_OBJECT",
          size_bytes: head.sizeBytes,
        },
        download_url: await storage.presignDownload(
          artifact.storage_key,
          RESOLVE_URL_SECONDS,
        ),
        expires_at: expiresAt.toISOString(),
      },
      200,
      { "Cache-Control": "no-store" },
    );
  });

  app.put(
    "/internal/v1/workspaces/:ws/artifacts/:id/pins/:holder",
    async (c) => {
      const { workspaceId, service } = await authorize(
        c,
        deps.jwt,
        "artifacts:pin",
      );
      const holder = holderOf(c);
      const artifact = await release(workspaceId, c.req.param("id"));
      const body = (await c.req.json().catch(() => ({}))) as {
        reason?: unknown;
      };
      const reason =
        typeof body.reason === "string" && body.reason.trim()
          ? body.reason.trim().slice(0, 500)
          : `published by ${service}`;
      const { pin, created } = await artifacts.pin(
        workspaceId,
        artifact.id,
        holder,
        reason,
      );

      return c.json(
        { pin, artifact: toPublicArtifact(artifact) },
        created ? 201 : 200,
      );
    },
  );

  // Idempotent: a pin that is already gone is a success.
  app.delete(
    "/internal/v1/workspaces/:ws/artifacts/:id/pins/:holder",
    async (c) => {
      const { workspaceId } = await authorize(c, deps.jwt, "artifacts:pin");
      const holder = holderOf(c);
      try {
        await artifacts.unpin(workspaceId, c.req.param("id"), holder);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
      }

      return c.body(null, 204);
    },
  );

  app.get("/internal/v1/workspaces/:ws/state", async (c) => {
    const { workspaceId } = await authorize(c, deps.jwt, "workspaces:admin");

    return c.json(await workspaces.get(workspaceId), 200);
  });

  app.put("/internal/v1/workspaces/:ws/state", async (c) => {
    const { workspaceId, service } = await authorize(
      c,
      deps.jwt,
      "workspaces:admin",
    );
    const parsed = StateSchema.safeParse(await readJson(c));
    if (!parsed.success) {
      throw new ApiError(
        422,
        "validation_error",
        "Validation failed",
        "state: one of active, suspended, deleted.",
      );
    }
    const record = await workspaces.set(workspaceId, parsed.data.state);
    if (record.state !== parsed.data.state) {
      throw new ApiError(
        409,
        "workspace_deleted",
        "Conflict",
        `Workspace '${workspaceId}' was deleted; it cannot become ${parsed.data.state} again.`,
      );
    }
    log("info", "workspace state set by Cloud", {
      workspace_id: workspaceId,
      state: record.state,
      service,
    });

    return c.json(record, 200);
  });

  return app;
};
