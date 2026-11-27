import type {
  BenchmarkSpec,
  DatasetRecord,
  EvalOutput,
  EvalRun,
  EvalStatus,
  EvalTaskOutcome,
  PlanEvalRequest,
  PlanEvalResponse,
} from "../generated/models.js";
import { LIST_EVAL_OUTPUTS_LIMIT_MAX } from "../generated/client.js";
import { APIUserAbortError, type RequestOptions } from "../transport.js";
import type { Core } from "../core.js";
import { EvalFailedError, GradUsageError } from "../errors.js";
import { collect, pages, Paginator } from "../pagination.js";
import { Pending } from "../pending.js";
import { pollUntil, type WaitOptions } from "../polling.js";
import { toRubric, type RubricInput, type ScoreFn } from "../rubrics.js";
import { artifactRef, type ArtifactRef } from "./artifacts.js";
import { Dataset, datasetName, pushRecords, type DatasetRef } from "./datasets.js";

export const TERMINAL_EVAL_STATUSES: readonly EvalStatus[] = ["completed", "stopped_budget", "failed", "cancelled"];

export interface EvalParams {
  name?: string;
  models: ArtifactRef[];
  baseline?: ArtifactRef;
  dataset?: DatasetRef;
  datasetVersion?: number;
  /** Server-side checks, judges, and local functions (scored by `wait()` in this process). */
  rubric?: RubricInput;
  samples?: number;
  temperature?: number;
  maxTokens?: number;
  limit?: number;
  passThreshold?: number | null;
  maxCostUsd?: number;
  benchmarks?: BenchmarkSpec[];
}

export interface EvalWaitOptions extends WaitOptions {
  /** Local scorer functions, when the eval was created elsewhere (e.g. by another process). */
  rubric?: RubricInput;
  onStatus?: (status: EvalStatus, evalRun: Eval) => void | Promise<void>;
}

const buildEvalBody = (params: EvalParams): { body: PlanEvalRequest; local: Map<string, ScoreFn> } => {
  const rubric = params.rubric !== undefined ? toRubric(params.rubric) : undefined;
  if (params.models.length === 0) throw new GradUsageError("evals need at least one model.", "invalid_eval");
  return {
    body: {
      models: params.models.map(artifactRef),
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.baseline !== undefined ? { baseline: artifactRef(params.baseline) } : {}),
      ...(params.dataset !== undefined ? { dataset: datasetName(params.dataset) } : {}),
      ...(params.datasetVersion !== undefined ? { datasetVersion: params.datasetVersion } : {}),
      ...(rubric ? { rubric: rubric.wire } : {}),
      ...(params.samples !== undefined ? { samples: params.samples } : {}),
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...(params.maxTokens !== undefined ? { maxTokens: params.maxTokens } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.passThreshold !== undefined ? { passThreshold: params.passThreshold } : {}),
      ...(params.maxCostUsd !== undefined ? { maxCostUsd: params.maxCostUsd } : {}),
      ...(params.benchmarks !== undefined ? { benchmarks: params.benchmarks } : {}),
    },
    local: rubric?.local ?? new Map(),
  };
};

const toScore = (name: string, value: number | boolean): number => {
  const score = typeof value === "boolean" ? (value ? 1 : 0) : value;
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new GradUsageError(`Scorer '${name}' returned ${String(value)}; return a finite number in [0, 1] or a boolean.`, "invalid_score");
  }
  return score;
};

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** Failing tasks of an eval; `toDataset()` saves their records for the next training round. */
export class EvalFailures {
  readonly #core: Core;
  readonly evalId: string;
  readonly data: EvalTaskOutcome[];

  constructor(core: Core, evalId: string, data: EvalTaskOutcome[]) {
    this.#core = core;
    this.evalId = evalId;
    this.data = data;
  }

  get length(): number {
    return this.data.length;
  }

  [Symbol.iterator](): Iterator<EvalTaskOutcome> {
    return this.data[Symbol.iterator]();
  }

  /** Pushes the failing records (deduplicated by task) to `name`, creating it if needed. */
  async toDataset(name: string, options: { metadata?: Record<string, unknown> } & RequestOptions = {}): Promise<Dataset> {
    const seen = new Set<string>();
    const records: DatasetRecord[] = [];
    for (const outcome of this.data) {
      if (seen.has(outcome.taskId)) continue;
      seen.add(outcome.taskId);
      records.push(outcome.record);
    }
    if (records.length === 0) throw new GradUsageError(`Eval ${this.evalId} has no failures to save.`, "empty_push");
    const { metadata, ...request } = options;
    return new Dataset(
      this.#core,
      await pushRecords(this.#core, name, records, { ...request, metadata: { source: `eval:${this.evalId}`, ...(metadata ?? {}) } }),
    );
  }
}

/** A standalone evaluation. `wait()` also runs your local scorers when the server asks for them. */
export interface Eval extends EvalRun {}
export class Eval {
  readonly #core: Core;
  #local: Map<string, ScoreFn>;

  constructor(core: Core, data: EvalRun, local: Map<string, ScoreFn> = new Map()) {
    this.#core = core;
    this.#local = local;
    Object.assign(this, data);
  }

  async refresh(options?: RequestOptions): Promise<this> {
    Object.assign(this, await this.#core.api.getEval(this.id, options));
    return this;
  }

  /**
   * Waits for `completed` (or `stopped_budget`: generation stopped at
   * `maxCostUsd`, with partial results). While the eval is `awaiting_scores`,
   * pulls the outputs your local scorers have not scored yet, scores them here
   * and posts the scores. Throws EvalFailedError on `failed`/`cancelled`.
   */
  async wait(options: EvalWaitOptions = {}): Promise<this> {
    if (options.rubric !== undefined) {
      for (const [name, fn] of toRubric(options.rubric).local) this.#local.set(name, fn);
    }
    let lastStatus: EvalStatus | undefined;
    await pollUntil(
      `eval ${this.id}`,
      (signal) => this.#core.api.getEval(this.id, { signal }),
      (ev) => TERMINAL_EVAL_STATUSES.includes(ev.status),
      options,
      this.#core.poll,
      async (ev) => {
        Object.assign(this, ev);
        if (ev.status !== lastStatus) {
          lastStatus = ev.status;
          await options.onStatus?.(ev.status, this);
        }
        if (ev.status === "awaiting_scores") await this.scoreLocal(options.signal);
      },
    );
    if (this.status === "failed" || this.status === "cancelled") throw new EvalFailedError(this);
    return this;
  }

  private async scoreLocal(signal: AbortSignal | undefined): Promise<void> {
    const missing = this.localScorers.filter((name) => !this.#local.has(name));
    if (missing.length > 0) {
      throw new GradUsageError(
        `Eval ${this.id} needs local scores for ${missing.join(", ")}, but no function was given. Pass the same Rubric: ev.wait({ rubric }).`,
        "missing_local_scorer",
      );
    }
    for (const name of this.localScorers) {
      const fn = this.#local.get(name) as ScoreFn;
      const scored = new Set<string>();
      while (true) {
        if (signal?.aborted) throw new APIUserAbortError(`Stopped scoring eval ${this.id}.`, { code: "aborted", cause: signal.reason });
        const page = await this.#core.api.listEvalOutputs(this.id, { missingScorer: name, limit: LIST_EVAL_OUTPUTS_LIMIT_MAX }, { signal });
        if (page.data.length === 0) break;
        if (page.data.some((out) => scored.has(out.id))) {
          throw new GradUsageError(`Eval ${this.id}: the server still lists outputs already scored by '${name}'; stopping instead of re-posting.`, "score_not_recorded");
        }
        const scores = [];
        for (const out of page.data as EvalOutput[]) {
          const value = await fn(out.output, {
            output: out.output,
            expectedOutput: out.expectedOutput,
            record: out.record,
            input: out.input,
            model: out.model,
            taskId: out.taskId,
            sampleIndex: out.sampleIndex,
          });
          scores.push({ outputId: out.id, scorer: name, score: toScore(name, value) });
          scored.add(out.id);
        }
        const posted = await this.#core.api.postEvalScores(this.id, { scores }, { signal });
        if (posted.status !== "awaiting_scores") return;
      }
    }
  }

  async cancel(options?: RequestOptions): Promise<this> {
    Object.assign(this, await this.#core.api.cancelEval(this.id, options));
    return this;
  }

  /** Failing tasks (score below `threshold`, default the eval's pass threshold). */
  async failures(options: { model?: string; threshold?: number } & RequestOptions = {}): Promise<EvalFailures> {
    return new EvalsResource(this.#core).failures(this.id, options);
  }

  results(options: { model?: string; limit?: number } & RequestOptions = {}): Paginator<EvalTaskOutcome> {
    return new EvalsResource(this.#core).results(this.id, options);
  }

  /** A plain-text table: model, overall, 95% CI, pass@k, delta vs baseline, tasks, errors, cost. */
  summaryTable(): string {
    const ks = [...new Set(this.summary.flatMap((s) => Object.keys(s.passAtK)))].sort();
    const header = ["model", "overall", "95% CI", ...ks, ...(this.baseline ? [`vs ${this.baseline}`] : []), "tasks", "errors", "$/1k tasks"];
    const rows = this.summary.map((s) => [
      s.model,
      pct(s.overall),
      `${pct(s.ciLow)}-${pct(s.ciHigh)}`,
      ...ks.map((k) => (s.passAtK[k] === undefined ? "-" : pct(s.passAtK[k] as number))),
      ...(this.baseline
        ? [
            s.model === this.baseline || !s.vsBaseline
              ? "baseline"
              : `${s.vsBaseline.delta >= 0 ? "+" : ""}${pct(s.vsBaseline.delta)} (${pct(s.vsBaseline.ciLow)}..${pct(s.vsBaseline.ciHigh)})`,
          ]
        : []),
      String(s.tasks),
      String(s.errors),
      s.costPer1kTasksUsd === null ? "-" : `$${s.costPer1kTasksUsd.toFixed(2)}`,
    ]);
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
    const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
    return [line(header), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
  }

  toJSON(): EvalRun {
    return { ...this } as EvalRun;
  }
}

export type PendingEval = Pending<Eval, Eval, EvalWaitOptions>;

export class EvalsResource {
  constructor(private readonly core: Core) {}

  /** Estimates tasks, model and judge calls, and cost; nothing runs. */
  async plan(params: EvalParams, options?: RequestOptions): Promise<PlanEvalResponse> {
    return this.core.api.planEval(buildEvalBody(params).body, options);
  }

  /** Starts an eval: `await` it for the Eval, or chain `.wait()` (which also runs local scorers). */
  create(params: EvalParams, options?: RequestOptions): PendingEval {
    return new Pending(
      (async () => {
        const { body, local } = buildEvalBody(params);
        return new Eval(this.core, await this.core.api.createEval(body, options), local);
      })(),
    );
  }

  async get(id: string, options?: RequestOptions): Promise<Eval> {
    return new Eval(this.core, await this.core.api.getEval(id, options));
  }

  list(options: { limit?: number } & RequestOptions = {}): Paginator<Eval> {
    const { limit, ...request } = options;
    return new Paginator(async (cursor) => {
      const page = await this.core.api.listEvals({ ...(limit !== undefined ? { limit } : {}), ...(cursor ? { cursor } : {}) }, request);
      return { data: page.data.map((e) => new Eval(this.core, e)), nextCursor: page.nextCursor };
    }, request.signal);
  }

  async wait(id: string, options?: EvalWaitOptions): Promise<Eval> {
    return (await this.get(id)).wait(options);
  }

  async cancel(id: string, options?: RequestOptions): Promise<Eval> {
    return new Eval(this.core, await this.core.api.cancelEval(id, options));
  }

  async failures(id: string, options: { model?: string; threshold?: number } & RequestOptions = {}): Promise<EvalFailures> {
    const { model, threshold, ...request } = options;
    const fetchPage = (cursor: string | undefined) =>
      this.core.api.listEvalFailures(
        id,
        { ...(model !== undefined ? { model } : {}), ...(threshold !== undefined ? { threshold } : {}), ...(cursor ? { cursor } : {}) },
        request,
      );
    const data = await collect(pages(fetchPage, request.signal));
    return new EvalFailures(this.core, id, data);
  }

  results(id: string, options: { model?: string; limit?: number } & RequestOptions = {}): Paginator<EvalTaskOutcome> {
    const { model, limit, ...request } = options;
    return new Paginator(async (cursor) => {
      const page = await this.core.api.listEvalResults(
        id,
        { ...(model !== undefined ? { model } : {}), ...(limit !== undefined ? { limit } : {}), ...(cursor ? { cursor } : {}) },
        request,
      );
      return { data: page.data, nextCursor: page.nextCursor };
    }, request.signal);
  }

  outputs(id: string, options: { model?: string; limit?: number } & RequestOptions = {}): Paginator<EvalOutput> {
    const { model, limit, ...request } = options;
    return new Paginator(async (cursor) => {
      const page = await this.core.api.listEvalOutputs(
        id,
        { ...(model !== undefined ? { model } : {}), ...(limit !== undefined ? { limit } : {}), ...(cursor ? { cursor } : {}) },
        request,
      );
      return { data: page.data, nextCursor: page.nextCursor };
    }, request.signal);
  }
}
