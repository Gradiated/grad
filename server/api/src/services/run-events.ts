import type {
  InterruptionReason,
  MetricPoint,
  RunEvent,
  RunInterruption,
  RunPhase,
} from "../contracts.js";
import type { JobEvent, JobRepository } from "../store/types.js";

export const toMetricPoint = (event: {
  seq: number;
  attempt: number;
  payload: Record<string, unknown>;
}): MetricPoint =>
  ({ ...event.payload, seq: event.seq, attempt: event.attempt }) as MetricPoint;

/**
 * Run lifecycle events on grad_job_events: phases, attempts, checkpoints,
 * warnings and logs next to the metrics, one seq for all of them. Each has a
 * natural key per (job, attempt, type), so a replayed write is stored once.
 */

// User-facing: neutral wording, never how the compute was bought.
export const REASON_TEXT: Record<InterruptionReason, string> = {
  lease_lost: "the worker was lost",
  compute_reclaimed: "the GPU was reclaimed",
  worker_error: "the worker hit an error",
  oom: "the GPU ran out of memory",
};

export const appendPhase = (
  jobs: Pick<JobRepository, "appendEvent">,
  input: {
    jobId: string;
    attempt: number;
    phase: RunPhase;
    step?: number;
    info?: Record<string, unknown>;
  },
) => {
  const step = input.step ?? 0;

  return jobs.appendEvent({
    jobId: input.jobId,
    attempt: input.attempt,
    type: "phase",
    step,
    key: `${input.phase}@${step}`,
    payload: { phase: input.phase, ...input.info },
  });
};

export interface AttemptInput {
  jobId: string;
  attempt: number;
  event: "started" | "interrupted" | "gave_up";
  reason?: InterruptionReason | null;
  step?: number | null;
  resumeStep?: number | null;
  maxAttempts: number;
}

export const attemptMessage = (input: AttemptInput): string => {
  const resume =
    input.resumeStep === null || input.resumeStep === undefined
      ? "from scratch"
      : `from step ${input.resumeStep}`;
  const why = input.reason ? `: ${REASON_TEXT[input.reason]}` : "";
  const at =
    input.step === null || input.step === undefined
      ? ""
      : ` at step ${input.step}`;
  switch (input.event) {
    case "started":
      return input.attempt === 1 && input.resumeStep == null
        ? "attempt 1 started"
        : `attempt ${input.attempt} started, resuming ${resume}`;
    case "interrupted":
      return `attempt ${input.attempt} interrupted${at}${why}; resuming ${resume} on a new worker`;
    case "gave_up":
      return `giving up after attempt ${input.attempt}${why}; no attempts left`;
  }
};

export const appendAttempt = (
  jobs: Pick<JobRepository, "appendEvent">,
  input: AttemptInput,
) =>
  jobs.appendEvent({
    jobId: input.jobId,
    attempt: input.attempt,
    type: "attempt",
    step: input.step ?? 0,
    key: input.event,
    payload: {
      event: input.event,
      reason: input.reason ?? null,
      step: input.step ?? null,
      resume_step: input.resumeStep ?? null,
      max_attempts: input.maxAttempts,
      message: attemptMessage(input),
    },
  });

/** A warning or log line; `key` is the sender's natural key (e.g. "plan:0"). */
export const appendNote = (
  jobs: Pick<JobRepository, "appendEvent">,
  input: {
    jobId: string;
    attempt: number;
    type: "warning" | "log";
    key: string;
    message: string;
    step?: number | null;
  },
) =>
  jobs.appendEvent({
    jobId: input.jobId,
    attempt: input.attempt,
    type: input.type,
    step: input.step ?? 0,
    key: input.key,
    payload: { message: input.message, step: input.step ?? null },
  });

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const bool = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : null;

/** A stored event as the public RunEvent (null for unknown types). */
export const toRunEvent = (
  runId: string,
  event: JobEvent,
): Exclude<RunEvent, { type: "completed" }> | null => {
  const p = event.payload;
  const base = {
    run_id: runId,
    seq: event.seq,
    attempt: Math.max(1, event.attempt),
    timestamp: event.created_at,
  };
  switch (event.type) {
    case "metric": {
      const metric = toMetricPoint(event);
      return {
        type: "metric",
        ...base,
        timestamp: metric.timestamp,
        step: metric.step,
        metric,
      };
    }
    case "phase":
      return {
        type: "phase",
        ...base,
        phase: p.phase as RunPhase,
        step: event.step,
        workers_online: num(p.workers_online),
        autoscaling: bool(p.autoscaling),
        queue_position: num(p.queue_position),
        message: typeof p.message === "string" ? p.message : null,
        gpu:
          p.gpu && typeof p.gpu === "object"
            ? (p.gpu as { name: string; memory_gb: number })
            : null,
      };
    case "attempt":
      return {
        type: "attempt",
        ...base,
        event: p.event as "started" | "interrupted" | "gave_up",
        reason: (p.reason ?? null) as InterruptionReason | null,
        step: num(p.step),
        resume_step: num(p.resume_step),
        max_attempts: num(p.max_attempts) ?? 1,
        message: String(p.message ?? ""),
      };
    case "checkpoint":
      return {
        type: "checkpoint",
        ...base,
        step: event.step,
        checkpoint_id: String(p.checkpoint_id),
        eval_score: num(p.eval_score),
        format: (p.format ?? null) as never,
      };
    case "warning":
    case "log":
      return {
        type: event.type,
        ...base,
        step: num(p.step),
        message: String(p.message ?? ""),
      };
    default:
      return null;
  }
};

/** The run object's view of its latest interruption event. */
export const toInterruption = (
  event: JobEvent | null,
): RunInterruption | null => {
  if (!event) return null;
  const p = event.payload;

  return {
    attempt: event.attempt,
    reason: (p.reason ?? "lease_lost") as InterruptionReason,
    step: num(p.step) ?? 0,
    resume_step: num(p.resume_step),
    at: event.created_at,
    message: String(p.message ?? ""),
  };
};
