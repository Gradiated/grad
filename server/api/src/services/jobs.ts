import { claimableKinds, type AuthPrincipal } from "../adapters.js";
import { addSeconds, leaseGraceCutoff } from "../clock.js";
import type { RecipeKind, TrainerJob } from "../contracts.js";
import type { InterruptionReason } from "../contracts/runs.js";
import type { AppDependencies } from "../deps.js";
import { ApiError, conflict, invalid, notFound } from "../errors.js";
import {
  COMPLETION_STATUSES,
  WORKER_STAT_PHASES,
  type WorkerStatsSchema,
} from "../contracts/trainer-jobs.js";
import {
  metricKind,
  metrics,
  PREEMPTION_LIMIT_MARK,
} from "../telemetry/metrics.js";
import { log } from "../telemetry/log.js";
import { contextFromTraceparent, withSpan } from "../telemetry/tracing.js";
import { claimGpuMemoryGb } from "../worker-auth/principal.js";
import type { z } from "@hono/zod-openapi";
import type {
  JobExpectation,
  JobKind,
  JobPatch,
  JobRow,
  JobStatus,
  QueueSnapshot,
  Store,
} from "../store/types.js";

/**
 * The one job queue (train, import and eval jobs on grad_jobs). Claim,
 * heartbeat, lease expiry and the attempt rule live here once; each kind
 * plugs in what differs (the job it hands a worker, its stop signal, what
 * closing a lost attempt bills).
 */

export type StopReason = "cancelled" | "budget" | "insufficient_balance" | null;

/** Statuses no worker acts on (only a resume re-queues a stopped or failed run). */
const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>([
  "completed",
  "failed",
  "cancelled",
  "stopped_budget",
  "stopped_balance",
]);

export const isTerminal = (status: JobStatus): boolean => TERMINAL.has(status);

/** Terminal and released: the job writes no more events, so its stream can end. */
export const isSettled = (job: Pick<JobRow, "status" | "worker_id">): boolean =>
  isTerminal(job.status) && job.worker_id === null;

/** What a claiming worker says about itself (shown on the run, never its id). */
interface ClaimWorker {
  gpu: { name: string; memory_gb: number } | null;
}

/** Where a queued job stands: ready for the run's phase text. */
interface QueueView {
  /** About how many claimable jobs of its kind start before it. */
  queue_position: number;
  /** "Queued behind 3 runs", a workspace cap or a GPU nobody has; null when next in line. */
  queue_message: string | null;
}

const gb = (n: number): string => `${Number(n.toFixed(1))} GB`;

/**
 * A queued job's position and phase text under fair share. The claim takes
 * the workspace with the fewest running jobs, then its oldest job: a
 * workspace's k-th queued job starts at about "level" running + k. The
 * position counts every job with a lower level (ties: the workspace whose
 * oldest job is older goes first), each workspace limited by its cap.
 * Approximate: it ignores jobs finishing meanwhile and GPU fit.
 */
export const queueView = (
  job: Pick<JobRow, "id" | "workspace_id" | "min_gpu_memory_gb">,
  snapshot: QueueSnapshot,
  cap: number,
  noun: string,
): QueueView => {
  const rank = snapshot.ranks[job.id] ?? 0;
  const mine = snapshot.shares.find((s) => s.workspace_id === job.workspace_id);
  const running = mine?.running ?? 0;
  const level = running + rank;
  let ahead = rank;
  for (const s of snapshot.shares) {
    if (s.workspace_id === job.workspace_id || s.queued === 0) continue;
    const tie =
      s.oldest !== null && mine?.oldest != null && s.oldest < mine.oldest
        ? 1
        : 0;
    ahead += Math.max(
      0,
      Math.min(s.queued, level - s.running + tie, cap - s.running),
    );
  }

  const need = job.min_gpu_memory_gb;
  const gpus = snapshot.workerGpus;
  const unfit =
    need !== null &&
    gpus.length > 0 &&
    gpus.every((m) => m !== null && m < need);
  let message: string | null = null;
  if (running >= cap) {
    message = `Queued: workspace concurrency limit (${running} running)`;
  } else if (unfit) {
    const sizes = [...new Set(gpus as number[])].sort((a, b) => a - b);
    message = `Waiting for a GPU with ≥${gb(need)}; online workers have ${sizes.map(gb).join(", ")}`;
  } else if (ahead > 0) {
    message = `Queued behind ${ahead} ${noun}${ahead === 1 ? "" : "s"}`;
  }

  return { queue_position: ahead, queue_message: message };
};

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

type CompletionStatus = (typeof COMPLETION_STATUSES)[number];

/**
 * How an attempt of each kind may end. `cancelled` is not on the list: a job
 * the user cancelled closes as cancelled whatever its worker reports, and a
 * worker never cancels a job on its own.
 */
const COMPLETIONS: Record<JobKind, readonly CompletionStatus[]> = {
  train: ["completed", "stopped_budget", "failed", "abandoned"],
  eval: ["completed", "failed", "abandoned"],
  import: ["completed", "failed", "abandoned"],
};

/** 422 unsupported_completion, before anything changes, for a status the job's kind doesn't have. */
export const assertCompletion = (
  job: Pick<JobRow, "id" | "kind" | "status">,
  status: CompletionStatus,
): void => {
  const allowed = COMPLETIONS[job.kind];
  if (job.status === "cancelled" || allowed.includes(status)) return;

  throw invalid(
    "unsupported_completion",
    `Job '${job.id}' is a ${job.kind} job: its attempt completes as ${allowed.join(", ")}, not '${status}'.`,
  );
};

export const leaseLost = (id: string): ApiError =>
  conflict(
    "lease_lost",
    `This worker no longer holds the lease on job '${id}' (expired, reclaimed, or finished). Stop work on it.`,
  );

/**
 * The identity of the key behind a worker request, stored on the lease at
 * claim time. Worker ids are not secret (Helm uses the pod name, compose a
 * fixed name), so a worker id alone never authorizes acting on a job: every
 * lease check matches the key too.
 */
export const workerKeyOf = (principal: AuthPrincipal): string =>
  // "@*": leases stored when keys could be workspace-scoped still match.
  `${principal.kind}:${principal.actor}@*`;

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

/**
 * Clears the lease: part of every patch that closes an attempt. worker_key
 * stays (the next claim overwrites it), so a retried /complete is answered
 * only for the credential that closed the attempt (closedBy).
 */
export const RELEASE = {
  worker_id: null,
  lease_expires_at: null,
} as const;

/**
 * True when `attempt` of `job` was closed with a result, by `principal`:
 * a /complete retry whose first response was lost gets that result again.
 */
export const closedBy = (
  principal: AuthPrincipal,
  job: Pick<JobRow, "worker_id" | "worker_key" | "attempt" | "status">,
  attempt: number,
): boolean =>
  job.attempt === attempt &&
  job.worker_id === null &&
  job.status !== "queued" &&
  job.worker_key === workerKeyOf(principal);

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
 * expired, a worker error) counts, and the job fails once max_attempts of
 * them happened since creation or the last resume. Preemptions (a worker
 * told to stop by its platform: SIGTERM, a cloud termination notice) are not the job's
 * fault and lose at most the grace period's work, so they have their own,
 * generous cap instead: on preemptions in a row that saved nothing.
 * `progressed` starts the count again: a run's checkpoint or an eval's
 * outputs from this attempt (the next attempt resumes from them). An import
 * restarts from scratch, so its reclaims always count.
 */
export const requeuePatch = (
  job: Pick<
    JobRow,
    "failed_attempts" | "max_attempts" | "attempt" | "preemptions"
  >,
  what: string,
  now: string,
  preemption?: { maxPreemptions: number; progressed?: boolean },
): JobPatch => {
  if (preemption) {
    const preemptions = preemption.progressed ? 0 : job.preemptions + 1;

    return preemptions >= preemption.maxPreemptions
      ? {
          ...RELEASE,
          status: "failed",
          preemptions,
          finished_at: now,
          error: `${what}; ${PREEMPTION_LIMIT_MARK} ${preemptions} time(s) (limit ${preemption.maxPreemptions}).`,
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
const observeClaim = (job: JobRow, now: Date): void => {
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

/** A job this worker principal may see (its key's workspace and kinds), else 404. */
export const loadForWorker = async (
  store: Pick<Store, "jobs">,
  principal: AuthPrincipal,
  id: string,
): Promise<JobRow> => {
  const job = await store.jobs.getById(id);
  if (!job) throw notFound("trainer_job", id);
  if (claimableKinds(principal, [job.kind]).length === 0) {
    throw notFound("trainer_job", id);
  }

  return job;
};

/**
 * `job` (read once by the caller) if this worker holds `attempt`'s lease on
 * it. The caller writes from this same read, fenced on it: checking one read
 * and writing from another would let a lease taken over in between pass the
 * new holder's fence.
 */
export const leased = <
  T extends Pick<JobRow, "kind" | "worker_id" | "worker_key" | "attempt">,
>(
  principal: AuthPrincipal,
  id: string,
  job: T | null,
  holder: { worker_id: string; attempt: number },
): T => {
  if (!job || claimableKinds(principal, [job.kind]).length === 0) {
    throw notFound("trainer_job", id);
  }
  if (!holdsLease(principal, job, holder.worker_id, holder.attempt)) {
    throw leaseLost(id);
  }

  return job;
};

/**
 * The job behind a worker's download of its data (no worker id on a GET):
 * only the credential holding `attempt`'s lease reads it.
 */
export const loadForReader = async (
  store: Pick<Store, "jobs">,
  principal: AuthPrincipal,
  id: string,
  attempt: number,
): Promise<JobRow> => {
  const job = await loadForWorker(store, principal, id);
  if (
    job.attempt !== attempt ||
    job.worker_id === null ||
    job.worker_key !== workerKeyOf(principal)
  ) {
    throw leaseLost(id);
  }

  return job;
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
      gpu?: ClaimWorker["gpu"] | undefined;
      device?: "cpu" | "gpu" | undefined;
    },
  ): Promise<TrainerJob | null>;
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
  /** Reaper: closes attempts whose lease expired (one heartbeat of grace). */
  expireLeases(now: Date): Promise<number>;
}

export const createJobQueue = (
  deps: AppDependencies,
  handlers: Record<JobKind, JobKindHandler>,
): JobQueue => {
  const { store, clock } = deps;
  const limits = deps.settings.queue;

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
        // Closed without its worker: a late /complete from that worker is
        // lease_lost, never answered as the result it already reported
        // (closedBy matches the key that closed the attempt).
        await store.jobs.update(
          job.id,
          { worker_key: null },
          { attempt: job.attempt, workerId: null },
        );
        observeInterruption(job, "lease_lost");
        closed += 1;
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        // lease_lost: a heartbeat renewed the lease after the read.
        if (error.code !== "lease_lost") {
          log("warn", "expired lease not closed", {
            job_id: job.id,
            kind: job.kind,
            error,
          });
        }
      }
    }

    return closed;
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

  return {
    claim: async (principal, input) => {
      await expireLeases(clock.now());
      const worker: ClaimWorker = { gpu: input.gpu ?? null };
      // A lease token's gpu_memory_gb caps what the worker may be given.
      const gpuMemoryGb = claimGpuMemoryGb(principal, input.gpu?.memory_gb);
      await store.jobs.seeWorker({
        id: input.workerId,
        kinds: input.kinds,
        device: input.device ?? (input.gpu ? "gpu" : null),
        gpuMemoryGb,
        now: clock.now(),
      });

      // A worker retrying a claim whose response was lost gets its job back:
      // only under the same key and kinds as a fresh claim.
      const workerKey = workerKeyOf(principal);
      const held = await store.jobs.heldBy({
        workerId: input.workerId,
        workerKey,
        kinds: input.kinds,
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
          gpuMemoryGb,
          maxRunning: limits.maxRunning,
        });
        if (!job) return null;
        const built = await build(job, worker);
        if (built) return built;
      }
    },

    heartbeat: async (principal, id, body) => {
      const job = await loadForWorker(store, principal, id);
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

    expireLeases,
  };
};
