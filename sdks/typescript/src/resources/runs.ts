import { CODEC } from "../generated/client.js";
import type {
  Artifact as ArtifactData,
  Checkpoint as CheckpointData,
  MetricPoint,
  PlanRunResponse,
  RecipeSpec,
  ResolvedRunConfig,
  Run as RunData,
  RunCounts,
  RunEvent,
  RunStatus,
  SplitSpec,
} from "../generated/models.js";
import { APIConnectionError, convertKeys, GradError, type RequestOptions } from "../transport.js";
import type { Core } from "../core.js";
import { GradUsageError, RunFailedError, WaitTimeoutError } from "../errors.js";
import { formatPlan } from "../format.js";
import { collect, pages, Paginator, statusQuery } from "../pagination.js";
import { Pending } from "../pending.js";
import { isTransient, pollUntil, type WaitOptions } from "../polling.js";
import { type Recipe, toRecipeSpec } from "../recipes.js";
import { Artifact, downloadArtifact, type DownloadOptions, type DownloadResult } from "./artifacts.js";
import { datasetName, type DatasetRef } from "./datasets.js";

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "failed", "cancelled", "stopped_budget", "stopped_balance"];
const isTerminal = (status: RunStatus): boolean => TERMINAL_RUN_STATUSES.includes(status);

export interface RunParams {
  dataset: DatasetRef;
  name: string;
  recipe: Recipe | RecipeSpec;
  split?: SplitSpec;
  /** Spend cap; the run stops with `stopped_budget` and keeps a checkpoint. */
  maxCostUsd?: number;
}

export interface RunWaitOptions extends WaitOptions {
  /** Every lifecycle event while waiting (phases, metrics, checkpoints, attempts, warnings, logs, completed). */
  onEvent?: (event: RunEvent) => void | Promise<void>;
  /** Streams each metric point while waiting (from the run's event stream). */
  onMetric?: (metric: MetricPoint) => void | Promise<void>;
  /** Called with every status or phase change. */
  onStatus?: (status: RunStatus, run: Run) => void | Promise<void>;
}

export interface EventsOptions extends RequestOptions {
  /** Keep the stream open until the run finishes (SSE; reconnects with Last-Event-ID). */
  follow?: boolean;
  /** Page size of the JSON pages (without `follow`). */
  limit?: number;
}

const RUN_EVENT_TYPES = new Set<string>(["phase", "metric", "checkpoint", "attempt", "warning", "log", "completed"]);
/**
 * Dropped or refused event streams in a row before `events({ follow })` gives up (the same in all four SDKs).
 * It applies once the stream has been open: a first connection that fails (after the client's usual
 * request retries) throws at once.
 */
export const MAX_EVENT_RECONNECTS = 20;
const WAITING_PHASES = new Set<string>(["queued", "waiting_for_compute"]);

export interface MetricsOptions extends RequestOptions {
  /** Keep the stream open until the run finishes (SSE with automatic reconnect). */
  follow?: boolean;
  /** Only points after this step (JSON pages). */
  afterStep?: number;
}

/** A dry-run plan: resolved settings, warnings and cost before you spend anything. */
export interface RunPlan extends PlanRunResponse {}
export class RunPlan {
  constructor(data: PlanRunResponse) {
    Object.assign(this, data);
  }

  /** Alias of `resolvedConfig` (the docs' name). */
  get resolvedRecipe(): ResolvedRunConfig {
    return this.resolvedConfig;
  }

  /** The readout the Python and Go SDKs and the CLI print; `console.log(plan)` uses it. */
  toString(): string {
    return formatPlan(this);
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

const buildRunBody = async (params: RunParams) => {
  if (!params.name) throw new GradUsageError("runs need a name.", "invalid_run");
  return {
    dataset: datasetName(params.dataset),
    name: params.name,
    recipe: await toRecipeSpec(params.recipe),
    ...(params.split !== undefined ? { split: params.split } : {}),
    ...(params.maxCostUsd !== undefined ? { maxCostUsd: params.maxCostUsd } : {}),
  };
};

const decodeEvent = (data: string): RunEvent => convertKeys(CODEC, "RunEvent", JSON.parse(data), "decode") as RunEvent;

/** A checkpoint saved during a run; `promote()` turns it into a kept artifact. */
export interface Checkpoint extends CheckpointData {}
export class Checkpoint {
  readonly #core: Core;

  constructor(core: Core, data: CheckpointData) {
    this.#core = core;
    Object.assign(this, data);
  }

  async promote(options: { name?: string } & RequestOptions = {}): Promise<Artifact> {
    const { name, ...request } = options;
    return new Artifact(this.#core, await this.#core.api.promoteCheckpoint(this.id, name !== undefined ? { name } : {}, request));
  }

  toJSON(): CheckpointData {
    return { ...this } as CheckpointData;
  }
}

/** A training run. After `wait()`, `artifact` holds the produced artifact. */
export interface Run extends RunData {}
export class Run {
  readonly #core: Core;
  /** The produced artifact, loaded by `wait()` when the run completes. */
  artifact: Artifact | undefined;

  constructor(core: Core, data: RunData) {
    this.#core = core;
    this.artifact = undefined;
    Object.assign(this, data);
  }

  private update(data: RunData): void {
    Object.assign(this, data);
  }

  async refresh(options?: RequestOptions): Promise<this> {
    this.update(await this.#core.api.getRun(this.id, options));
    return this;
  }

  /**
   * Waits for a terminal status. Resolves for `completed` (with `artifact`
   * loaded); throws RunFailedError for `failed`, `cancelled` and
   * `stopped_budget` (resume with a raised cap) and `stopped_balance` (top up, then resume).
   */
  async wait(options: RunWaitOptions = {}): Promise<CompletedRun> {
    let last: string | undefined;
    const notify = async () => {
      const key = `${this.status}/${this.phase ?? ""}`;
      if (key !== last) {
        last = key;
        await options.onStatus?.(this.status, this);
      }
    };
    if (options.onMetric || options.onEvent) {
      await this.followUntilDone(options, notify);
    } else {
      await pollUntil(
        `run ${this.id}`,
        (signal) => this.#core.api.getRun(this.id, { signal }),
        (run) => isTerminal(run.status),
        options,
        this.#core.poll,
        async (run) => {
          this.update(run);
          await notify();
        },
      );
    }
    if (this.status !== "completed") throw new RunFailedError(this);
    if (!this.artifactId) {
      throw new GradError(`Run ${this.id} completed without an artifact; this is a server bug, please report it.`, { code: "missing_artifact" });
    }
    if (!this.artifact || this.artifact.id !== this.artifactId) {
      this.artifact = new Artifact(this.#core, await this.#core.api.getArtifact(this.artifactId, { signal: options.signal }));
    }
    return this as CompletedRun;
  }

  private async followUntilDone(options: RunWaitOptions, notify: () => Promise<void>): Promise<void> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer =
      options.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(new WaitTimeoutError(`run ${this.id}`, options.timeoutMs ?? 0)), options.timeoutMs);
    try {
      for await (const event of this.events({ follow: true, signal: controller.signal })) {
        await options.onEvent?.(event);
        if (event.type === "metric" && event.metric) await options.onMetric?.(event.metric);
        if (event.type === "phase") await notify();
      }
      // events({ follow }) only returns after the final `completed` event, which updated this run.
      await notify();
    } catch (error) {
      if (controller.signal.reason instanceof WaitTimeoutError) throw controller.signal.reason;
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * Metric points. With `follow: true` they stream live (the metric events of
   * `events({ follow: true })`) and end when the run finishes.
   */
  async *metrics(options: MetricsOptions = {}): AsyncGenerator<MetricPoint, void, undefined> {
    const { follow = false, afterStep, ...request } = options;
    if (!follow) {
      const fetchPage = (cursor: string | undefined) =>
        this.#core.api.listRunMetrics(this.id, { ...(afterStep !== undefined ? { afterStep } : {}), ...(cursor ? { cursor } : {}) }, request);
      for await (const page of pages(fetchPage, request.signal)) {
        // The spec marks MetricPoint nullable, so page items are typed `| null`; the server never sends null.
        for (const point of page.data) if (point !== null) yield point;
      }
      return;
    }
    // The events stream carries every metric (and ends after `completed`, which refreshes this run).
    for await (const event of this.events({ ...request, follow: true })) {
      if (event.type === "metric" && (afterStep === undefined || event.metric.step > afterStep)) yield event.metric;
    }
  }

  /**
   * The run's lifecycle events, typed by `type` (phase, metric, checkpoint,
   * attempt, warning, log, completed). With `follow: true` this streams live
   * over SSE, reconnects with `Last-Event-ID` after drops (never repeating an
   * event) and ends after `completed`, which also refreshes this run.
   */
  async *events(options: EventsOptions = {}): AsyncGenerator<RunEvent, void, undefined> {
    const { follow = false, limit, ...request } = options;
    if (!follow) {
      const fetchPage = (cursor: string | undefined) =>
        this.#core.api.listRunEvents(this.id, { ...(cursor ? { cursor } : {}), ...(limit !== undefined ? { limit } : {}) }, request);
      for await (const page of pages(fetchPage, request.signal)) {
        for (const event of page.data) {
          this.observe(event);
          yield event;
        }
      }
      return;
    }
    let lastEventId: string | undefined;
    let lastSeq = 0;
    let failures = 0;
    let connected = false;
    let lastError: unknown;
    const onOpen = () => {
      connected = true;
    };
    while (true) {
      try {
        for await (const sse of this.#core.api.listRunEventsStream(this.id, {}, { ...request, onOpen, ...(lastEventId !== undefined ? { lastEventId } : {}) })) {
          failures = 0;
          lastError = undefined;
          if (!RUN_EVENT_TYPES.has(sse.event)) continue;
          const event = decodeEvent(sse.data);
          if (event.type !== "completed") {
            if (sse.id !== undefined) lastEventId = sse.id;
            if (event.seq <= lastSeq) continue;
            lastSeq = event.seq;
          }
          this.observe(event);
          yield event;
          if (event.type === "completed") return;
        }
        // The stream closed without `completed` (proxy timeout, deploy): reconnect.
      } catch (error) {
        if (request.signal?.aborted || !connected || !isTransient(error)) throw error;
        lastError = error;
      }
      failures += 1;
      if (failures > MAX_EVENT_RECONNECTS) {
        throw lastError ?? new APIConnectionError(`Lost the event stream for run ${this.id} ${failures} times in a row.`, { code: "connection_error" });
      }
      await this.#core.poll.sleep(Math.min(500 * 2 ** Math.min(failures - 1, 4), 5_000), request.signal);
    }
  }

  /** Keeps this run's phase and status in step with the events it streams. */
  private observe(event: RunEvent): void {
    if (event.type === "completed") {
      this.update(event.run);
    } else if (event.type === "phase") {
      this.phase = event.phase;
      this.phaseSince = event.timestamp;
      if (!isTerminal(this.status)) this.status = WAITING_PHASES.has(event.phase) ? "queued" : "running";
    } else if (event.type === "attempt" && event.event === "interrupted" && event.reason !== null) {
      this.lastInterruption = {
        attempt: event.attempt,
        reason: event.reason,
        step: event.step ?? 0,
        resumeStep: event.resumeStep,
        at: event.timestamp,
        message: event.message,
      };
    }
  }

  async cancel(options?: RequestOptions): Promise<this> {
    this.update(await this.#core.api.cancelRun(this.id, options));
    return this;
  }

  /** Re-queues a stopped run from its last checkpoint (raise `maxCostUsd` after a budget stop). */
  async resume(options: { maxCostUsd?: number } & RequestOptions = {}): Promise<this> {
    const { maxCostUsd, ...request } = options;
    this.update(await this.#core.api.resumeRun(this.id, maxCostUsd !== undefined ? { maxCostUsd } : {}, request));
    return this;
  }

  async checkpoints(options: RequestOptions = {}): Promise<Checkpoint[]> {
    const fetchPage = (cursor: string | undefined) => this.#core.api.listRunCheckpoints(this.id, cursor ? { cursor } : {}, options);
    return (await collect(pages(fetchPage, options.signal))).map((c) => new Checkpoint(this.#core, c));
  }

  private requireArtifact(action: string): string {
    if (!this.artifactId) {
      throw new GradUsageError(`Run ${this.id} has no artifact to ${action} (status ${this.status}); wait() for it to complete first.`, "no_artifact");
    }
    return this.artifactId;
  }

  /** Streams the run's artifact to disk with SHA-256 verification. */
  async download(dest: string, options?: DownloadOptions): Promise<DownloadResult> {
    return downloadArtifact(this.#core, this.requireArtifact("download"), dest, options);
  }

  toJSON(): RunData & { artifact?: ArtifactData } {
    const { artifact, ...rest } = this as unknown as RunData & { artifact?: Artifact };
    return { ...rest, ...(artifact ? { artifact: artifact.toJSON() } : {}) } as RunData & { artifact?: ArtifactData };
  }
}

/** A run that finished `completed`, with its artifact loaded. */
export type CompletedRun = Run & { artifact: Artifact; artifactId: string };

export type PendingRun = Pending<Run, CompletedRun, RunWaitOptions>;

export class RunsResource {
  constructor(private readonly core: Core) {}

  /** Validates the dataset, resolves defaults and estimates tokens and cost; nothing is billed. */
  async plan(params: RunParams, options?: RequestOptions): Promise<RunPlan> {
    return new RunPlan(await this.core.api.planRun(await buildRunBody(params), options));
  }

  /**
   * Queues a run: `await` it for the Run, or chain `.wait()`. The plan's warnings (such as
   * another queued or running run with this name) are on `run.warnings` and go to console.warn.
   */
  create(params: RunParams, options?: RequestOptions): PendingRun {
    return new Pending(
      (async () => {
        const run = new Run(this.core, await this.core.api.createRun(await buildRunBody(params), options));
        for (const warning of run.warnings ?? []) console.warn(`grad: ${warning}`);
        return run;
      })(),
    );
  }

  async get(id: string, options?: RequestOptions): Promise<Run> {
    return new Run(this.core, await this.core.api.getRun(id, options));
  }

  /** Runs, newest first; `status` keeps these statuses, `search` names containing it (any case) or the exact id. */
  list(options: { status?: RunStatus | readonly RunStatus[]; search?: string; limit?: number } & RequestOptions = {}): Paginator<Run> {
    const { status, search, limit, ...request } = options;
    const filters = { status: statusQuery(status), q: search, limit };
    return new Paginator(async (cursor) => {
      const page = await this.core.api.listRuns({ ...filters, cursor }, request);
      return { data: page.data.map((r) => new Run(this.core, r)), nextCursor: page.nextCursor };
    }, request.signal);
  }

  /** Runs per status (`{ total, byStatus: { failed, ... } }`), optionally of the runs `search` matches. */
  counts(options: { search?: string } & RequestOptions = {}): Promise<RunCounts> {
    const { search, ...request } = options;
    return this.core.api.countRuns({ q: search }, request);
  }

  async wait(id: string, options?: RunWaitOptions): Promise<CompletedRun> {
    return (await this.get(id)).wait(options);
  }

  async cancel(id: string, options?: RequestOptions): Promise<Run> {
    return new Run(this.core, await this.core.api.cancelRun(id, options));
  }

  async resume(id: string, options: { maxCostUsd?: number } & RequestOptions = {}): Promise<Run> {
    const { maxCostUsd, ...request } = options;
    return new Run(this.core, await this.core.api.resumeRun(id, maxCostUsd !== undefined ? { maxCostUsd } : {}, request));
  }

  metrics(id: string, options?: MetricsOptions): AsyncGenerator<MetricPoint, void, undefined> {
    return new Run(this.core, { id } as RunData).metrics(options);
  }

  checkpoints(id: string, options?: RequestOptions): Promise<Checkpoint[]> {
    return new Run(this.core, { id } as RunData).checkpoints(options);
  }

  /** A run's lifecycle events; `for await (const ev of grad.runs.events(id, { follow: true }))`. */
  events(id: string, options?: EventsOptions): AsyncGenerator<RunEvent, void, undefined> {
    return new Run(this.core, { id } as RunData).events(options);
  }
}

export class CheckpointsResource {
  constructor(private readonly core: Core) {}

  /** Copies a checkpoint into a versioned artifact you keep. */
  promote(id: string, options: { name?: string } & RequestOptions = {}): Promise<Artifact> {
    return new Checkpoint(this.core, { id } as CheckpointData).promote(options);
  }
}
