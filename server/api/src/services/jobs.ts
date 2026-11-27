import { claimableKinds, type AuthPrincipal } from "../adapters.js";
import { addSeconds, leaseGraceCutoff } from "../clock.js";
import type { RecipeKind, TrainerJob } from "../contracts.js";
import type { InterruptionReason } from "../contracts/runs.js";
import type { AppDependencies } from "../deps.js";
import { ApiError, conflict, notFound } from "../errors.js";
import {
  WORKER_STAT_PHASES,
  type WorkerStatsSchema,
} from "../contracts/trainer-jobs.js";
import { metricKind, metrics } from "../telemetry/metrics.js";
import { contextFromTraceparent, withSpan } from "../telemetry/tracing.js";
import type { z } from "@hono/zod-openapi";
import type {
  JobExpectation,
  JobKind,
  JobPatch,
  JobRow,
  JobStatus,
} from "../store/types.js";

/**
 * The one job queue (train, import and eval jobs on grad_jobs). Claim,
 * heartbeat, lease expiry and the attempt rule live here once; each kind
 * plugs in what differs (the job it hands a worker, its stop signal, what
 * closing a lost attempt bills).
 */

export type StopReason = "cancelled" | "budget" | "insufficient_balance" | null;

/** What a claiming worker says about itself (shown on the run, never its id). */
export interface ClaimWorker {
  gpu: { name: string; memory_gb: number } | null;
}

export interface JobKindHandler {
  /**
   * The worker's job for a fresh claim (`renewed` false) or a claim retried
   * after a lost response. Returns null when the handler closed the job
   * instead (budget exhausted, unbuildable): the queue claims the next one.
   */
  onClaim?(
    job: JobRow,
    renewed: boolean,
    worker: ClaimWorker,
  ): Promise<TrainerJob | null>;
  /** Heartbeat stop signal. */
  stopReason?(job: JobRow): Promise<StopReason>;
  /**
   * Closes an attempt whose lease expired. `fence` must guard the closing
   * update: a heartbeat that landed after the reaper's read wins.
   */
  onLeaseLost(job: JobRow, fence: JobExpectation, now: Date): Promise<void>;
}

export const leaseLost = (id: string): ApiError =>
  conflict(
    "lease_lost",
    `This worker no longer holds the lease on job '${id}' (expired, reclaimed, or finished). Stop work on it.`,
  );

/** Throws 404 when a worker may not see a job (workspace-scoped worker keys). */
export const assertWorkerScope = (
  principal: AuthPrincipal,
  workspaceId: string,
  id: string,
): void => {
  if (
    principal.workerWorkspaceId !== null &&
    principal.workerWorkspaceId !== workspaceId
  ) {
    throw notFound("trainer_job", id);
  }
};

/**
 * The identity of the key behind a worker request, stored on the lease at
 * claim time. Worker ids are not secret (Helm uses the pod name, compose a
 * fixed name), so a worker id alone never authorizes acting on a job: every
 * lease check matches the key too.
 */
export const workerKeyOf = (principal: AuthPrincipal): string =>
  `${principal.kind}:${principal.actor}@${principal.workerWorkspaceId ?? "*"}`;

/** The key of the in-process eval executor's leases. */
export const IN_PROCESS_WORKER_KEY = "in-process";

/** True when `principal` (as `workerId`) holds `attempt`'s lease on `job`. */
export const holdsLease = (
  principal: AuthPrincipal,
  job: Pick<JobRow, "worker_id" | "worker_key" | "attempt">,
  workerId: string,
  attempt: number,
): boolean =>
  job.worker_id === workerId &&
  job.worker_key === workerKeyOf(principal) &&
  job.attempt === attempt;

/** Clears the lease: part of every patch that closes an attempt. */
export const RELEASE = {
  worker_id: null,
  worker_key: null,
  lease_expires_at: null,
} as const;

/** The guard for a write by the holder of `job`'s current attempt. */
export const fenceOf = (
  job: Pick<JobRow, "worker_id" | "attempt">,
  statuses: readonly JobStatus[] = ["running", "cancelled"],
): JobExpectation => ({
  workerId: job.worker_id,
  attempt: job.attempt,
  status: statuses,
});

/** Default cap on preempted attempts (MAX_PREEMPTIONS). */
export const DEFAULT_MAX_PREEMPTIONS = 20;

/**
 * The one attempt rule: an attempt that ends without a result (lease
 * expired, a worker error) counts, and the job fails once max_attempts of
 * them happened since creation or the last resume. Preemptions (a worker
 * told to stop by its platform: SIGTERM, a cloud termination notice) are not the job's
 * fault and lose at most the grace period's work, so they have their own,
 * generous cap instead.
 */
export const requeuePatch = (
  job: Pick<
    JobRow,
    "failed_attempts" | "max_attempts" | "attempt" | "preemptions"
  >,
  what: string,
  now: string,
  preemption?: { maxPreemptions: number },
): JobPatch => {
  if (preemption) {
    const preemptions = job.preemptions + 1;

    return preemptions >= preemption.maxPreemptions
      ? {
          ...RELEASE,
          status: "failed",
          preemptions,
          finished_at: now,
          error: `${what}; its GPU was reclaimed ${preemptions} time(s) (limit ${preemption.maxPreemptions}).`,
        }
      : {
          ...RELEASE,
          status: "queued",
          preemptions,
          error: `${what}; requeued.`,
        };
  }
  const failedAttempts = job.failed_attempts + 1;

  return failedAttempts >= job.max_attempts
    ? {
        ...RELEASE,
        status: "failed",
        failed_attempts: failedAttempts,
        finished_at: now,
        error: `${what}; ${failedAttempts} attempt(s) ended without a result (max_attempts=${job.max_attempts}).`,
      }
    : {
        ...RELEASE,
        status: "queued",
        failed_attempts: failedAttempts,
        error: `${what}; requeued.`,
      };
};

/** Counts a started attempt, and a first claim's wait since creation. */
export const observeClaim = (job: JobRow, now: Date): void => {
  const kind = metricKind(job);
  metrics.attempts.inc({ kind });
  if (job.attempt === 1) {
    metrics.claimLatency.observe(
      { kind },
      Math.max(0, (now.getTime() - Date.parse(job.created_at)) / 1000),
    );
  }
};

/** Counts an attempt that ended without a result. */
export const observeInterruption = (
  job: Pick<JobRow, "kind" | "origin">,
  reason: InterruptionReason,
): void => {
  metrics.requeues.inc({ kind: metricKind(job), reason });
};

const STAT_PHASES = new Set<string>(WORKER_STAT_PHASES);

export interface JobQueue {
  /** Worker claim: its held job again (lost response), else the oldest claimable. */
  claim(
    principal: AuthPrincipal,
    input: {
      workerId: string;
      leaseSeconds: number;
      kinds: readonly JobKind[];
      recipes?: readonly RecipeKind[] | undefined;
      gpu?: ClaimWorker["gpu"] | undefined;
    },
  ): Promise<TrainerJob | null>;
  /** In-process claim (the eval executor): the raw job row. */
  claimRow(input: {
    workerId: string;
    leaseSeconds: number;
    kinds: readonly JobKind[];
  }): Promise<JobRow | null>;
  heartbeat(
    principal: AuthPrincipal,
    id: string,
    body: {
      worker_id: string;
      attempt: number;
      lease_seconds?: number | undefined;
      stats?: z.infer<typeof WorkerStatsSchema> | undefined;
    },
  ): Promise<{
    status: string;
    should_stop: boolean;
    stop_reason: StopReason;
    lease_expires_at: string;
  }>;
  /** Extends `job`'s lease if this holder still has it; false when lost. */
  renew(job: JobRow, leaseSeconds?: number): Promise<JobRow | null>;
  /** The job behind a worker write, if this worker holds `attempt`'s lease. */
  loadLeased(
    principal: AuthPrincipal,
    id: string,
    workerId: string,
    attempt: number,
  ): Promise<JobRow>;
  /** A job visible to this worker principal, or 404. */
  loadForWorker(principal: AuthPrincipal, id: string): Promise<JobRow>;
  /** Reaper: closes attempts whose lease expired (one heartbeat of grace). */
  expireLeases(now: Date): Promise<number>;
}

export const createJobQueue = (
  deps: AppDependencies,
  handlers: Record<JobKind, JobKindHandler>,
): JobQueue => {
  const { store, clock } = deps;

  const renew = (job: JobRow, leaseSeconds = job.lease_seconds) =>
    store.jobs.update(
      job.id,
      {
        lease_expires_at: addSeconds(clock.now(), leaseSeconds).toISOString(),
        lease_seconds: leaseSeconds,
      },
      fenceOf(job),
    );

  const expireLeases = async (now: Date): Promise<number> => {
    let closed = 0;
    for (const job of await store.jobs.listExpiredLeases(now, 100)) {
      try {
        await handlers[job.kind].onLeaseLost(
          job,
          {
            ...fenceOf(job),
            leaseExpiredBefore: leaseGraceCutoff(now, job.lease_seconds),
          },
          now,
        );
        observeInterruption(job, "lease_lost");
        closed += 1;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
      }
    }

    return closed;
  };

  const claimRow: JobQueue["claimRow"] = async (input) => {
    const now = clock.now();
    const job = await store.jobs.claimNext({
      ...input,
      workerKey: IN_PROCESS_WORKER_KEY,
      now,
    });
    if (job) observeClaim(job, now);

    return job;
  };

  /** A fresh claim, in a span of the trace that created the job. */
  const build = (job: JobRow, worker: ClaimWorker) =>
    withSpan(
      "grad.job.claim",
      {
        "grad.job_id": job.id,
        "grad.job.kind": job.kind,
        "grad.job.attempt": job.attempt,
      },
      async () => {
        observeClaim(job, clock.now());
        const built = await handlers[job.kind].onClaim?.(job, false, worker);

        return built ? { ...built, traceparent: job.traceparent } : null;
      },
      { parent: contextFromTraceparent(job.traceparent) },
    );

  const loadForWorker = async (principal: AuthPrincipal, id: string) => {
    const job = await store.jobs.getById(id);
    if (!job || job.kind === "eval") throw notFound("trainer_job", id);
    assertWorkerScope(principal, job.workspace_id, id);
    if (claimableKinds(principal, [job.kind]).length === 0) {
      throw notFound("trainer_job", id);
    }

    return job;
  };

  return {
    claim: async (principal, input) => {
      await expireLeases(clock.now());
      const worker: ClaimWorker = { gpu: input.gpu ?? null };

      // A worker retrying a claim whose response was lost gets its job back:
      // only under the same key, kinds and workspace scope as a fresh claim.
      const workerKey = workerKeyOf(principal);
      const workspaceId = principal.workerWorkspaceId ?? undefined;
      const held = await store.jobs.heldBy({
        workerId: input.workerId,
        workerKey,
        kinds: input.kinds,
        workspaceId,
      });
      const renewed = held && (await renew(held, input.leaseSeconds));
      if (renewed) {
        const job = await handlers[renewed.kind].onClaim?.(
          renewed,
          true,
          worker,
        );
        if (job) return { ...job, traceparent: renewed.traceparent };
      }

      for (;;) {
        const job = await store.jobs.claimNext({
          workerId: input.workerId,
          workerKey,
          leaseSeconds: input.leaseSeconds,
          now: clock.now(),
          kinds: input.kinds,
          recipes: input.recipes,
          workspaceId,
        });
        if (!job) return null;
        const built = await build(job, worker);
        if (built) return built;
      }
    },

    claimRow,

    heartbeat: async (principal, id, body) => {
      const job = await loadForWorker(principal, id);
      if (!holdsLease(principal, job, body.worker_id, body.attempt)) {
        throw leaseLost(id);
      }
      const updated = await renew(job, body.lease_seconds ?? job.lease_seconds);
      if (!updated) throw leaseLost(id);
      metrics.heartbeats.inc({ kind: metricKind(job) });
      if (body.stats) {
        const { phase, ...numbers } = body.stats;
        await store.jobs.recordWorkerStats(id, job.attempt, {
          ...numbers,
          ...(phase ? { phase: STAT_PHASES.has(phase) ? phase : "other" } : {}),
        });
      }
      const reason = (await handlers[job.kind].stopReason?.(updated)) ?? null;

      return {
        status: updated.status,
        should_stop: reason !== null,
        stop_reason: reason,
        lease_expires_at: updated.lease_expires_at as string,
      };
    },

    renew,

    loadLeased: async (principal, id, workerId, attempt) => {
      const job = await loadForWorker(principal, id);
      if (!holdsLease(principal, job, workerId, attempt)) throw leaseLost(id);

      return job;
    },

    loadForWorker,

    expireLeases,
  };
};
