/**
 * Worker authentication: how a bearer token on the worker protocol
 * (/v1/trainer-jobs/*) becomes a worker principal. Three authenticators
 * (static keys, Kubernetes service-account tokens, lease tokens) are chained
 * in the configured order (GRAD_WORKER_AUTH); the first match wins.
 */
import type { AuthPrincipal } from "../adapters.js";
import type { JobKind } from "../contracts.js";
import { forbidden } from "../errors.js";

export const WORKER_AUTH_MODES = ["static", "kubernetes", "lease"] as const;
export type WorkerAuthMode = (typeof WORKER_AUTH_MODES)[number];

/** What a worker token proves about its bearer. */
export interface WorkerPrincipal {
  /** The authenticator that accepted the token. */
  mode: WorkerAuthMode;
  /** The job kinds it may claim. */
  kinds: readonly JobKind[];
  /** Stable name of the credential (`trainer-worker:<label>`, `k8s:<ns>/<sa>/<pod>`, `lease:<orchestrator>/<host>/<lease>`); fences leases. */
  identity: string;
  /** Lease tokens: the host the token is bound to; the claim's worker_id must match it. */
  host?: string | undefined;
  /** Lease tokens: the orchestrator's lease id. */
  lease?: string | undefined;
  /** Lease tokens: the most GPU memory (GB) the worker may report. */
  gpuMemoryGb?: number | undefined;
  /** When the credential stops working (lease tokens, service-account tokens). */
  expiresAt?: Date | undefined;
}

export interface WorkerAuthenticator {
  readonly mode: WorkerAuthMode;
  /**
   * The principal for `token`, or null when it is not a valid token of this
   * kind. Throws ApiError(503) when it cannot decide (fail closed).
   */
  authenticate(token: string): Promise<WorkerPrincipal | null>;
}

/**
 * Tries each authenticator in order; the first match wins. An authenticator
 * that cannot decide does not stop the others, but when none matches its
 * error is rethrown (503), never turned into a 401 or a match.
 */
export const chainWorkerAuthenticators = (
  authenticators: readonly WorkerAuthenticator[],
): WorkerAuthenticator => ({
  mode: authenticators[0]?.mode ?? "static",
  authenticate: async (token) => {
    let failure: unknown = null;
    for (const authenticator of authenticators) {
      try {
        const principal = await authenticator.authenticate(token);
        if (principal) return principal;
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== null) throw failure;

    return null;
  },
});

export const toAuthPrincipal = (worker: WorkerPrincipal): AuthPrincipal => ({
  kind: "worker",
  workspaceId: "_platform",
  actor: worker.identity,
  scopes: ["trainer:worker"],
  workerWorkspaceId: null,
  workerKinds: worker.kinds,
  worker,
});

/**
 * Worker tokens first, then `other` (workspace keys). When the worker chain
 * could not decide and `other` finds nothing either, the chain's error
 * (503) wins over a 401: an outage never looks like a bad token.
 */
export const authenticateWorkerFirst = async (
  workers: WorkerAuthenticator,
  token: string,
  other: () => Promise<AuthPrincipal | null>,
): Promise<AuthPrincipal | null> => {
  let failure: unknown = null;
  try {
    const worker = await workers.authenticate(token);
    if (worker) return toAuthPrincipal(worker);
  } catch (error) {
    failure = error;
  }
  const principal = await other();
  if (principal) return principal;
  if (failure !== null) throw failure;

  return null;
};

const WORKER_SUFFIX_RE = /^[A-Za-z0-9]{1,32}$/;

/**
 * A host-bound token's worker_id is the host id, optionally followed by `-`
 * and one alphanumeric suffix (the trainer appends a random one per
 * process: GRAD_WORKER_ID=<host_id> gives `<host_id>-3fa9c1`).
 */
export const workerIdMatchesHost = (workerId: string, host: string): boolean =>
  workerId === host ||
  (workerId.startsWith(`${host}-`) &&
    WORKER_SUFFIX_RE.test(workerId.slice(host.length + 1)));

/** A claim's host binding and GPU report, checked against the worker's token. */
export const assertClaimAllowed = (
  principal: AuthPrincipal,
  claim: { worker_id: string; gpu?: { memory_gb: number } | null | undefined },
): void => {
  const worker = principal.worker;
  if (!worker) return;
  if (
    worker.host !== undefined &&
    !workerIdMatchesHost(claim.worker_id, worker.host)
  ) {
    throw forbidden(
      "worker_host_mismatch",
      `This worker token is bound to host '${worker.host}': worker_id must be '${worker.host}' or '${worker.host}-<suffix>' (set GRAD_WORKER_ID=${worker.host}).`,
    );
  }
  const reported = claim.gpu?.memory_gb;
  if (
    worker.gpuMemoryGb !== undefined &&
    reported !== undefined &&
    reported > worker.gpuMemoryGb
  ) {
    throw forbidden(
      "gpu_memory_exceeds_token",
      `This worker token allows at most ${worker.gpuMemoryGb} GB of GPU memory; the claim reported ${reported} GB.`,
    );
  }
};

/** The GPU memory a claim filters on: the report, capped by the token's bound. */
export const claimGpuMemoryGb = (
  principal: AuthPrincipal,
  reported: number | null | undefined,
): number | null => {
  const bound = principal.worker?.gpuMemoryGb;
  if (bound === undefined) return reported || null;

  return Math.min(reported || bound, bound);
};
