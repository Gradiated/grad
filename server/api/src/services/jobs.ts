import { claimableKinds, type AuthPrincipal } from "../adapters.js";
import { addSeconds, leaseGraceCutoff } from "../clock.js";
import type { RecipeKind, TrainerJob } from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { ApiError, conflict, notFound } from "../errors.js";
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

export interface JobKindHandler {
  /**
   * The worker's job for a fresh claim (`renewed` false) or a claim retried
   * after a lost response. Returns null when the handler closed the job
   * instead (budget exhausted, unbuildable): the queue claims the next one.
   */
  onClaim?(job: JobRow, renewed: boolean): Promise<TrainerJob | null>;
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

/** Clears the lease: part of every patch that closes an attempt. */
export const RELEASE = { worker_id: null, lease_expires_at: null } as const;

/** The guard for a write by the holder of `job`'s current attempt. */
export const fenceOf = (
  job: Pick<JobRow, "worker_id" | "attempt">,
  statuses: readonly JobStatus[] = ["running", "cancelled"],
): JobExpectation => ({
  workerId: job.worker_id,
  attempt: job.attempt,
  status: statuses,
});

/**
 * The one attempt rule: an attempt that ends without a result (lease
 * expired, or abandoned by a preempted worker) counts, and the job fails once
 * max_attempts of them happened since creation or the last resume.
 */
export const requeuePatch = (
  job: Pick<JobRow, "failed_attempts" | "max_attempts" | "attempt">,
  what: string,
  now: string,
): JobPatch => {
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

export interface JobQueue {
  /** Worker claim: its held job again (lost response), else the oldest claimable. */
  claim(
    principal: AuthPrincipal,
    input: {
      workerId: string;
      leaseSeconds: number;
      kinds: readonly JobKind[];
      recipes?: readonly RecipeKind[] | undefined;
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
        closed += 1;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
      }
    }

    return closed;
  };

  const claimRow: JobQueue["claimRow"] = (input) =>
    store.jobs.claimNext({ ...input, now: clock.now() });

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

      // A worker retrying a claim whose response was lost gets its job back.
      const held = await store.jobs.heldBy(input.workerId, input.kinds);
      const renewed = held && (await renew(held, input.leaseSeconds));
      if (renewed) {
        const job = await handlers[renewed.kind].onClaim?.(renewed, true);
        if (job) return job;
      }

      for (;;) {
        const job = await store.jobs.claimNext({
          workerId: input.workerId,
          leaseSeconds: input.leaseSeconds,
          now: clock.now(),
          kinds: input.kinds,
          recipes: input.recipes,
          workspaceId: principal.workerWorkspaceId ?? undefined,
        });
        if (!job) return null;
        const built = await handlers[job.kind].onClaim?.(job, false);
        if (built) return built;
      }
    },

    claimRow,

    heartbeat: async (principal, id, body) => {
      const job = await loadForWorker(principal, id);
      if (job.worker_id !== body.worker_id || job.attempt !== body.attempt) {
        throw leaseLost(id);
      }
      const updated = await renew(job, body.lease_seconds ?? job.lease_seconds);
      if (!updated) throw leaseLost(id);
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
      if (job.worker_id !== workerId || job.attempt !== attempt) {
        throw leaseLost(id);
      }

      return job;
    },

    loadForWorker,

    expireLeases,
  };
};
