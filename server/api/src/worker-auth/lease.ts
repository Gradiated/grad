/**
 * Lease tokens (GRAD_WORKER_AUTH=lease): an orchestrator (the gpu-fleet
 * operator in Cloud) leases a host to grad and mints a token for it through
 * the internal API. The token is bound to the host and lease, limited to job
 * kinds and a GPU memory bound, and expires with the lease. Only its SHA-256
 * is stored (grad_worker_tokens).
 */
import { randomBytes } from "node:crypto";

import {
  hashApiKey,
  WORKER_JOB_KINDS,
  type WorkerJobKind,
} from "../adapters.js";
import type { Clock } from "../clock.js";
import type { WorkerTokenRepository } from "../store/types.js";
import type { WorkerAuthenticator } from "./principal.js";

/** Every lease token starts with this, so other authenticators never look it up. */
export const LEASE_TOKEN_PREFIX = "gradwt_";

/** Longest a minted token may live; a longer lease rotates its token. */
export const MAX_LEASE_TOKEN_SECONDS = 7 * 86_400;

const isKind = (kind: string): kind is WorkerJobKind =>
  (WORKER_JOB_KINDS as readonly string[]).includes(kind);

export const createLeaseWorkerAuth = (options: {
  tokens: WorkerTokenRepository;
  clock: Clock;
}): WorkerAuthenticator => ({
  mode: "lease",
  authenticate: async (token) => {
    if (!token.startsWith(LEASE_TOKEN_PREFIX)) return null;
    const row = await options.tokens.findByHash(hashApiKey(token));
    if (!row || row.revokedAt !== null) return null;
    if (row.expiresAt.getTime() <= options.clock.now().getTime()) return null;

    return {
      kinds: row.kinds.filter(isKind),
      identity: `lease:${row.leaseId}`,
      host: row.hostId,
      lease: row.leaseId,
      gpuMemoryGb: row.gpuMemoryGb ?? undefined,
      expiresAt: row.expiresAt,
    };
  },
});

/** A fresh lease token: 256 random bits, returned to the orchestrator once. */
export const newLeaseToken = (): string =>
  `${LEASE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
