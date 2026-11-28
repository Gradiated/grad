import type { MetricPoint, Run } from "@sdk/generated/models.js";

import { CODEC, convertKeys, type RunPhase } from "./api.js";

// One run's lifecycle, decoded from `GET /v1/runs/{id}/events` (phase, metric,
// checkpoint, attempt, warning, log, completed) or, on servers without it,
// from `GET /v1/runs/{id}/metrics` (metric + status).

interface Base {
  seq: number;
  attempt: number;
  timestamp: string;
}

export type RunEvent =
  | (Base & { type: "phase"; phase: RunPhase; step: number; workersOnline: number | null; autoscaling: boolean | null; message: string | null; gpu: { name: string; memoryGb: number } | null })
  | (Base & { type: "metric"; step: number; metric: MetricPoint })
  | (Base & { type: "checkpoint"; step: number; checkpointId: string; evalScore: number | null; format: string | null })
  | (Base & { type: "attempt"; event: "started" | "interrupted" | "gave_up"; reason: string | null; step: number | null; resumeStep: number | null; maxAttempts: number; message: string })
  | (Base & { type: "warning" | "log"; step: number | null; message: string })
  | (Base & { type: "completed"; status: Run["status"]; run: Run });

type Wire = Record<string, unknown>;

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const decodeMetric = (wire: unknown): MetricPoint => convertKeys(CODEC, "MetricPoint", wire, "decode") as MetricPoint;
const decodeRun = (wire: unknown): Run => convertKeys(CODEC, "Run", wire, "decode") as Run;

/** Decodes one SSE message; unknown event names return null (old clients ignore them). */
export const decodeEvent = (name: string, data: string): RunEvent | null => {
  let w: Wire;
  try {
    w = JSON.parse(data) as Wire;
  } catch {
    return null;
  }
  if (typeof w !== "object" || w === null) return null;
  const base: Base = { seq: num(w.seq), attempt: num(w.attempt, 1), timestamp: str(w.timestamp) };
  switch (name) {
    case "metric": {
      // /events wraps the point; /metrics sends it bare.
      const metric = decodeMetric(w.metric ?? w);
      return { ...base, seq: num(w.seq, metric.seq), attempt: num(w.attempt, metric.attempt), timestamp: base.timestamp || metric.timestamp, type: "metric", step: num(w.step, metric.step), metric };
    }
    case "phase": {
      const gpu = w.gpu as Wire | null | undefined;
      return {
        ...base,
        type: "phase",
        phase: str(w.phase) as RunPhase,
        step: num(w.step),
        workersOnline: numOrNull(w.workers_online),
        autoscaling: typeof w.autoscaling === "boolean" ? w.autoscaling : null,
        message: typeof w.message === "string" ? w.message : null,
        gpu: gpu ? { name: str(gpu.name), memoryGb: num(gpu.memory_gb) } : null,
      };
    }
    case "checkpoint":
      return { ...base, type: "checkpoint", step: num(w.step), checkpointId: str(w.checkpoint_id), evalScore: numOrNull(w.eval_score), format: typeof w.format === "string" ? w.format : null };
    case "attempt":
      return {
        ...base,
        type: "attempt",
        event: str(w.event) as "started" | "interrupted" | "gave_up",
        reason: typeof w.reason === "string" ? w.reason : null,
        step: numOrNull(w.step),
        resumeStep: numOrNull(w.resume_step),
        maxAttempts: num(w.max_attempts, 1),
        message: str(w.message),
      };
    case "warning":
    case "log":
      return { ...base, type: name, step: numOrNull(w.step), message: str(w.message) };
    case "completed": {
      const run = decodeRun(w.run);
      return { ...base, type: "completed", status: run.status, run };
    }
    case "status": {
      // /metrics' final event carries the Run itself.
      const run = decodeRun(w);
      return { ...base, seq: 0, type: "completed", status: run.status, run, timestamp: run.finishedAt ?? run.updatedAt };
    }
    default:
      return null;
  }
};

/** Eval loss of a point: the field, or `eval_metrics.eval_loss` as workers report it. */
export const evalLossOf = (m: MetricPoint): number | null => m.evalLoss ?? m.evalMetrics?.eval_loss ?? null;

// ------------------------------------------------------------ derived state

/**
 * A run's metric columns. They grow in place (a 1M-step run would otherwise copy
 * every column on each 200 ms batch: 17 s of CPU, measured); `rev` changes
 * whenever they do, so charts and memos key on it rather than array identity.
 */
export interface Series {
  rev: number;
  step: number[];
  loss: number[];
  /** Eval loss at eval steps; null elsewhere so the line connects only real points. */
  evalLoss: (number | null)[];
  lr: (number | null)[];
  tokensPerSec: (number | null)[];
  costUsd: number[];
}

export interface TimelineItem {
  key: string;
  kind: "phase" | "attempt" | "interruption" | "warning" | "log" | "checkpoint" | "completed" | "failure";
  timestamp: string;
  title: string;
  detail?: string;
  step?: number | null;
}

export interface RunStreamState {
  series: Series;
  timeline: TimelineItem[];
  phase: { phase: RunPhase; since: string; step: number; workersOnline: number | null; autoscaling: boolean | null } | null;
  gpu: { name: string; memoryGb: number } | null;
  final: Run | null;
  lastSeq: number;
}

export const emptyStream = (): RunStreamState => ({
  series: { rev: 0, step: [], loss: [], evalLoss: [], lr: [], tokensPerSec: [], costUsd: [] },
  timeline: [],
  phase: null,
  gpu: null,
  final: null,
  lastSeq: 0,
});

export const PHASE_LABEL: Record<RunPhase, string> = {
  queued: "Queued",
  waiting_for_compute: "Waiting for compute",
  starting: "Starting",
  loading_model: "Loading model",
  training: "Training",
  evaluating: "Evaluating",
  checkpointing: "Checkpointing",
  uploading: "Uploading artifact",
  completing: "Completing",
};

export const REASON_LABEL: Record<string, string> = {
  lease_lost: "worker lost",
  preempted: "compute reclaimed",
  worker_error: "worker error",
  oom: "out of memory",
};

const REPEATING = new Set<RunPhase>(["evaluating", "checkpointing"]);

/** Phases that share one "for" clock. */
const FAMILY: Partial<Record<RunPhase, string>> = {
  queued: "queue",
  waiting_for_compute: "queue",
  training: "train",
  evaluating: "train",
  checkpointing: "train",
};

const COLUMNS = ["step", "loss", "evalLoss", "lr", "tokensPerSec", "costUsd"] as const;

/** Applies a batch of events (one React update per batch): a new state object, metric columns grown in place. */
export const applyEvents = (state: RunStreamState, events: RunEvent[]): RunStreamState => {
  if (events.length === 0) return state;
  // Appends are idempotent (a replayed step first drops what it replaces), so a
  // React updater that runs twice (StrictMode) leaves the columns unchanged.
  const series = state.series;
  let metrics = false;
  const timeline = [...state.timeline];
  let { phase, gpu, final, lastSeq } = state;
  const seenTraining = new Set(timeline.filter((t) => t.kind === "phase" && t.title === PHASE_LABEL.training).map((t) => t.key.split(":")[1]));

  for (const ev of events) {
    if (ev.type !== "completed") lastSeq = Math.max(lastSeq, ev.seq);
    switch (ev.type) {
      case "metric": {
        const m = ev.metric;
        // A resumed attempt replays steps from its checkpoint: keep x monotonic.
        metrics = true;
        while (series.step.length > 0 && (series.step[series.step.length - 1] ?? 0) >= ev.step) {
          for (const k of COLUMNS) series[k].pop();
        }
        series.step.push(ev.step);
        series.loss.push(m.loss);
        series.evalLoss.push(evalLossOf(m));
        series.lr.push(m.lr ?? null);
        series.tokensPerSec.push(m.tokensPerSec ?? null);
        series.costUsd.push(m.costUsd);
        break;
      }
      case "phase": {
        // Evals and checkpoints pause training briefly, and waiting_for_compute only says a
        // queued run is still unclaimed: one clock per family, so "Training for" counts from
        // when training began, not from the last eval.
        const family = phase && FAMILY[phase.phase] !== undefined && FAMILY[phase.phase] === FAMILY[ev.phase];
        phase = { phase: ev.phase, since: family && phase ? phase.since : ev.timestamp, step: ev.step, workersOnline: ev.workersOnline, autoscaling: ev.autoscaling };
        if (ev.gpu) gpu = ev.gpu;
        if (REPEATING.has(ev.phase)) break;
        if (ev.phase === "training") {
          if (seenTraining.has(String(ev.attempt))) break;
          seenTraining.add(String(ev.attempt));
        }
        const detail =
          ev.message !== null && (ev.phase === "queued" || ev.phase === "waiting_for_compute")
            ? ev.message
            : ev.phase === "starting" && ev.gpu
            ? `${ev.gpu.name} · ${ev.gpu.memoryGb} GB`
            : ev.phase === "waiting_for_compute" && ev.autoscaling
              ? "Starting a worker (autoscaling from zero)"
              : ev.phase === "waiting_for_compute" && ev.workersOnline !== null
                ? `${ev.workersOnline} worker${ev.workersOnline === 1 ? "" : "s"} online, all busy`
                : ev.phase === "training" && ev.step > 0
                  ? `from step ${ev.step}`
                  : undefined;
        timeline.push({ key: `phase:${ev.attempt}:${ev.seq}`, kind: "phase", timestamp: ev.timestamp, title: PHASE_LABEL[ev.phase] ?? ev.phase, step: ev.step, ...(detail ? { detail } : {}) });
        break;
      }
      case "attempt": {
        const kind = ev.event === "started" ? "attempt" : ev.event === "gave_up" ? "failure" : "interruption";
        const title =
          ev.event === "started"
            ? ev.resumeStep !== null
              ? `Attempt ${ev.attempt} resumed from step ${ev.resumeStep}`
              : `Attempt ${ev.attempt} started`
            : ev.event === "gave_up"
              ? "Gave up"
              : `Attempt ${ev.attempt} interrupted${ev.reason ? ` (${REASON_LABEL[ev.reason] ?? ev.reason})` : ""}`;
        // The server's message often restates the title ("attempt 1 started"): show it only when it adds something.
        const detail = ev.message && ev.message.toLowerCase() !== title.toLowerCase() ? ev.message : undefined;
        timeline.push({ key: `attempt:${ev.seq}`, kind, timestamp: ev.timestamp, title, step: ev.step, ...(detail ? { detail } : {}) });
        break;
      }
      case "checkpoint":
        timeline.push({
          key: `ckpt:${ev.seq}`,
          kind: "checkpoint",
          timestamp: ev.timestamp,
          title: `Checkpoint at step ${ev.step}`,
          step: ev.step,
          ...(ev.evalScore !== null ? { detail: `eval score ${ev.evalScore.toPrecision(4)}` } : {}),
        });
        break;
      case "warning":
      case "log":
        timeline.push({ key: `${ev.type}:${ev.seq}`, kind: ev.type, timestamp: ev.timestamp, title: ev.type === "warning" ? "Warning" : "Log", detail: ev.message, step: ev.step });
        break;
      case "completed": {
        final = ev.run;
        if (!timeline.some((t) => t.key === "completed")) {
          const title = { completed: "Completed", failed: "Failed", cancelled: "Cancelled", stopped_budget: "Stopped at the cost cap", stopped_balance: "Stopped: out of balance" }[ev.status as string] ?? ev.status;
          const kind = ev.status === "completed" ? "completed" : ev.status === "failed" ? "failure" : ev.status === "stopped_budget" || ev.status === "stopped_balance" ? "warning" : "log";
          timeline.push({ key: "completed", kind, timestamp: ev.timestamp, title, ...(ev.run.error ? { detail: ev.run.error } : {}) });
        }
        break;
      }
    }
  }
  return { series: metrics ? { ...series, rev: series.rev + 1 } : series, timeline, phase, gpu, final, lastSeq };
};

/** Folds runs of three or more consecutive checkpoints into one row, so frequent checkpoints don't bury the other events. */
export const foldCheckpoints = (items: TimelineItem[]): TimelineItem[] => {
  const out: TimelineItem[] = [];
  let i = 0;
  while (i < items.length) {
    let j = i;
    while (j < items.length && items[j]?.kind === "checkpoint") j++;
    if (j - i >= 3) {
      const first = items[i] as TimelineItem;
      const last = items[j - 1] as TimelineItem;
      const steps = items.slice(i, j).map((t) => t.step ?? 0);
      const latest = first.timestamp > last.timestamp ? first : last;
      out.push({ key: `ckpts:${first.key}`, kind: "checkpoint", timestamp: latest.timestamp, title: `${j - i} checkpoints`, detail: `steps ${Math.min(...steps)} to ${Math.max(...steps)}`, step: Math.max(...steps) });
      i = j;
    } else {
      out.push(items[i] as TimelineItem);
      i++;
    }
  }
  return out;
};
