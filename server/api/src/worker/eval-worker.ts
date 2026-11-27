import type { z } from "@hono/zod-openapi";

import {
  RECORD_MODEL,
  type EvalCallCountsSchema,
  type EvalOutputInputSchema,
  type TrainerJob,
} from "../contracts.js";
import { errorMessage } from "../errors.js";
import {
  recordPromptAndReference,
  recordPromptAndResponse,
} from "../records.js";
import { buildTasks } from "../services/evals/planner.js";
import { scoreOutput, type ScoringContext } from "../services/evals/scoring.js";
import type {
  ChatCompletionClient,
  InferenceClients,
  RegexEvaluator,
} from "../services/evals/types.js";
import { mergeRecords } from "../services/record-merge.js";
import type { EvalTask } from "../store/types.js";
import { log } from "../telemetry/log.js";
import {
  LeaseLost,
  ServerUnavailable,
  type AttemptRef,
  type WorkerClient,
} from "./client.js";

/**
 * The eval worker (`grad-server worker --kinds eval`): claims eval jobs
 * (evals, dataset.score(), router labelling, checkpoint evals) from the job
 * queue, generates and scores each (task, model, sample) against the
 * OpenAI-compatible inference and judge endpoints, and posts the outputs in
 * batches. grad-server prices and bills them, and aggregates the eval when
 * the worker completes the attempt.
 */

type EvalJob = NonNullable<TrainerJob["eval"]>;
type OutputInput = z.input<typeof EvalOutputInputSchema>;
type CallCounts = z.infer<typeof EvalCallCountsSchema>;

export interface EvalWorkerOptions {
  client: WorkerClient;
  inference: InferenceClients;
  regex: RegexEvaluator;
  /** Concurrent generations per eval (EVAL_CONCURRENCY). */
  concurrency: number;
  leaseSeconds?: number;
  /** Outputs per batch (at most 200). */
  batchSize?: number;
  /** A batch is sent after this long even when not full. */
  batchMaxAgeMs?: number;
}

export interface EvalWorker {
  /** Claims and runs eval jobs until none is claimable; returns how many ran. */
  drain(): Promise<number>;
  /** Claims and runs jobs, polling every `pollMs`, until `stop()`. */
  run(pollMs: number): Promise<void>;
  /** Hands an eval in progress back to the queue and ends `run`/`drain`. */
  stop(): Promise<void>;
}

const TASK_PAGE = 200;
const DEFAULT_LEASE_SECONDS = 180;

const doneKey = (model: string, index: number) => `${model}\u0000${index}`;

const runPool = async <T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> => {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next] as T;
        next += 1;
        await fn(item);
      }
    },
  );
  await Promise.all(workers);
};

const emptyCounts = (): CallCounts => ({
  model_ok: 0,
  model_error: 0,
  judge_ok: 0,
  judge_error: 0,
});

/** Counts a client's calls into `counts[ok|error]`. */
const counted = (
  client: ChatCompletionClient,
  counts: () => CallCounts,
  prefix: "model" | "judge",
): ChatCompletionClient => ({
  complete: async (input) => {
    try {
      const reply = await client.complete(input);
      counts()[`${prefix}_ok`] += 1;

      return reply;
    } catch (error) {
      counts()[`${prefix}_error`] += 1;
      throw error;
    }
  },
});

const KINDS = ["eval"];

/** `--kinds eval` (the default; the trainer image runs train and import jobs). */
export const parseWorkerArgs = (args: readonly string[]): string[] => {
  let kinds = KINDS;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const value = arg.startsWith("--kinds=")
      ? arg.slice("--kinds=".length)
      : arg === "--kinds"
        ? args[(i += 1)]
        : undefined;
    if (value === undefined) {
      throw new Error(
        `Unknown worker argument '${arg}'. Usage: worker [--kinds eval]`,
      );
    }
    kinds = value
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
  }
  const other = kinds.filter((k) => !KINDS.includes(k));
  if (kinds.length === 0 || other.length > 0) {
    throw new Error(
      `grad-server worker runs eval jobs only, not ${other.join(", ") || "nothing"}; train and import jobs run on the grad-trainer image.`,
    );
  }

  return kinds;
};

/**
 * Clients for a worker without GRAD_INFERENCE_BASE_URL: validators, regexes
 * and code scorers still run (dataset.score()); every model call fails.
 */
export const unconfiguredInference = (): InferenceClients => {
  const client: ChatCompletionClient = {
    complete: async () => {
      throw new Error(
        "This eval worker has no model endpoint: set GRAD_INFERENCE_BASE_URL (and GRAD_JUDGE_BASE_URL for judges) on it.",
      );
    },
  };

  return { models: client, judge: client };
};

/** The eval's tasks: the usable records of its pinned dataset version. */
export const evalTasks = (
  ev: Pick<EvalJob, "limit" | "mode" | "rubric">,
  rawRecords: Parameters<typeof mergeRecords>[0],
): EvalTask[] =>
  buildTasks(
    mergeRecords(rawRecords),
    ev.limit ?? undefined,
    ev.mode === "score" ? ev.rubric.map((r) => r.name) : null,
  ).tasks;

export const createEvalWorker = (options: EvalWorkerOptions): EvalWorker => {
  const { client } = options;
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const batchSize = Math.min(200, options.batchSize ?? 25);
  const batchMaxAgeMs = options.batchMaxAgeMs ?? 5_000;
  let counts = emptyCounts();
  const inference: InferenceClients = {
    models: counted(options.inference.models, () => counts, "model"),
    judge: counted(options.inference.judge, () => counts, "judge"),
  };
  let stopping = false;
  let running: Promise<unknown> | null = null;

  const scoreOne = async (
    ev: EvalJob,
    task: EvalTask,
    ctx: ScoringContext,
  ): Promise<OutputInput> => {
    const parts = recordPromptAndResponse(task.record);
    const base: OutputInput = {
      model: RECORD_MODEL,
      task_index: task.task_index,
      task_id: task.task_id,
      sample_index: 0,
      record: task.record,
      input: parts?.prompt ?? [],
      output: parts?.response ?? null,
      expected_output: task.record.expected_output ?? null,
      scores: {},
      error: null,
      prompt_tokens: 0,
      completion_tokens: 0,
      judge_tokens: {},
    };
    if (!parts || parts.response === null) {
      return { ...base, error: "record has no answer to score" };
    }

    const scored = await scoreOutput(
      ev.rubric,
      {
        prompt: parts.prompt,
        output: parts.response,
        reference: parts.expected,
      },
      ctx,
    );
    const judgeTokens = Object.values(scored.judgeTokens).reduce(
      (a, b) => a + b,
      0,
    );

    return {
      ...base,
      scores: Object.fromEntries(
        Object.entries(scored.scores).filter(
          ([name]) => !scored.failed.includes(name),
        ),
      ),
      error:
        scored.errors.length > 0
          ? scored.errors.join("; ").slice(0, 2000)
          : null,
      // A scoring job's tokens are its judges' (it calls no model).
      prompt_tokens: judgeTokens,
      judge_tokens: scored.judgeTokens,
    };
  };

  const generateOne = async (
    ev: EvalJob,
    task: EvalTask,
    model: string,
    sampleIndex: number,
    ctx: ScoringContext,
  ): Promise<OutputInput> => {
    if (ev.mode === "score") return scoreOne(ev, task, ctx);
    const pr = recordPromptAndReference(task.record);
    const target = ev.model_targets[model];
    const base: OutputInput = {
      model,
      task_index: task.task_index,
      task_id: task.task_id,
      sample_index: sampleIndex,
      record: task.record,
      input: pr?.prompt ?? [],
      output: null,
      expected_output: task.record.expected_output ?? pr?.reference ?? null,
      scores: {},
      error: null,
      prompt_tokens: 0,
      completion_tokens: 0,
      judge_tokens: {},
    };
    if (!pr || !target) {
      return { ...base, error: "record has no usable prompt" };
    }

    let completion;
    try {
      completion = await inference.models.complete({
        model: target.inference_model,
        workspace: ev.workspace_id,
        messages: pr.prompt,
        temperature: ev.temperature,
        max_tokens: ev.max_tokens,
        tools: task.record.tools ?? task.record.input?.tools,
      });
    } catch (error) {
      return { ...base, error: errorMessage(error).slice(0, 2000) };
    }

    const scored = await scoreOutput(
      ev.rubric,
      { prompt: pr.prompt, output: completion.text, reference: pr.reference },
      ctx,
    );

    return {
      ...base,
      output: completion.text,
      scores: scored.scores,
      error:
        scored.errors.length > 0
          ? scored.errors.join("; ").slice(0, 2000)
          : null,
      prompt_tokens: completion.usage.prompt_tokens,
      completion_tokens: completion.usage.completion_tokens,
      judge_tokens: scored.judgeTokens,
    };
  };

  const runJob = async (job: TrainerJob): Promise<void> => {
    const ev = job.eval;
    const ref: AttemptRef = { id: job.id, attempt: job.attempt };
    if (!ev || !job.dataset) {
      await client
        .complete(ref, {
          status: "failed",
          error: "The claimed eval job carries no eval or dataset.",
        })
        .catch(() => undefined);
      return;
    }
    // lost: the lease is gone, drop everything; cancelled: post what is in
    // flight, then close the attempt.
    let halt: "lost" | "cancelled" | null = null;
    const beat = async () => {
      try {
        const res = await client.heartbeat(ref, { phase: "evaluating" });
        if (res.should_stop) halt ??= "cancelled";
      } catch (error) {
        if (error instanceof LeaseLost) halt = "lost";
      }
    };
    const heartbeat = setInterval(() => void beat(), (leaseSeconds * 1000) / 3);
    heartbeat.unref();

    // Outputs go out in batches; one send at a time.
    let buffer: OutputInput[] = [];
    let lastSent = Date.now();
    let sending: Promise<void> = Promise.resolve();
    const send = () => {
      sending = sending.then(async () => {
        const outputs = buffer;
        buffer = [];
        lastSent = Date.now();
        const calls = counts;
        counts = emptyCounts();
        if (halt === "lost" || outputs.length === 0) return;
        try {
          const res = await client.postOutputs(ref, { outputs, calls });
          if (res.should_stop) halt ??= "cancelled";
        } catch (error) {
          if (!(error instanceof LeaseLost)) throw error;
          halt = "lost";
        }
      });

      return sending;
    };
    const add = async (output: OutputInput) => {
      buffer.push(output);
      if (
        buffer.length >= batchSize ||
        Date.now() - lastSent >= batchMaxAgeMs
      ) {
        await send();
      }
    };

    // Regex items that timed out once score 0 without running again.
    const ctx: ScoringContext = {
      regex: options.regex,
      timedOutRegex: new Set(),
      judge: inference.judge,
      workspace: ev.workspace_id,
      judgeTargets: ev.judge_targets,
    };

    try {
      const tasks = evalTasks(
        ev,
        await client.datasetRecords(job.dataset.download_url),
      );
      const done = new Set(
        Object.entries(ev.done).flatMap(([model, indices]) =>
          indices.map((i) => doneKey(model, i)),
        ),
      );

      for (let start = 0; start < tasks.length; start += TASK_PAGE) {
        const work: Array<{ task: EvalTask; model: string; sample: number }> =
          [];
        for (const task of tasks.slice(start, start + TASK_PAGE)) {
          for (const model of ev.models) {
            for (let sample = 0; sample < ev.samples; sample += 1) {
              const index = task.task_index * ev.samples + sample;
              if (!done.has(doneKey(model, index))) {
                work.push({ task, model, sample });
              }
            }
          }
        }
        await runPool(work, options.concurrency, async (item) => {
          if (halt !== null || stopping) return;
          await add(
            await generateOne(ev, item.task, item.model, item.sample, ctx),
          );
        });
        await send();
        if (halt !== null || stopping) break;
      }
      if (halt === "lost") return;

      // A graceful stop (deploy, scale-down) hands the eval back: the next
      // attempt resumes after the outputs already stored.
      await client.complete(
        ref,
        halt === "cancelled"
          ? { status: "cancelled" }
          : stopping
            ? { status: "abandoned", reason: "compute_reclaimed" }
            : { status: "completed" },
      );
    } catch (error) {
      if (error instanceof LeaseLost || halt === "lost") return;
      log("warn", "eval attempt failed", {
        job_id: job.id,
        attempt: job.attempt,
        error: errorMessage(error),
      });
      // grad-server unreachable: hand the attempt back (counted), or let
      // its lease expire; anything else is the eval's failure.
      await client
        .complete(
          ref,
          error instanceof ServerUnavailable
            ? {
                status: "abandoned",
                reason: "worker_error",
                error: errorMessage(error).slice(0, 4000),
              }
            : { status: "failed", error: errorMessage(error).slice(0, 4000) },
        )
        .catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
    }
  };

  const drainOnce = async (): Promise<number> => {
    let ran = 0;
    while (!stopping) {
      const job = await client.claim(["eval"], leaseSeconds);
      if (!job) break;
      await runJob(job);
      ran += 1;
    }

    return ran;
  };

  const drain = async (): Promise<number> => {
    const current = drainOnce();
    running = current;
    try {
      return await current;
    } finally {
      if (running === current) running = null;
    }
  };

  return {
    drain,

    run: async (pollMs) => {
      while (!stopping) {
        try {
          await drain();
        } catch (error) {
          log("warn", "eval worker claim failed", {
            error: errorMessage(error),
          });
        }
        if (!stopping) await new Promise((r) => setTimeout(r, pollMs));
      }
    },

    stop: async () => {
      stopping = true;
      await running?.catch(() => undefined);
    },
  };
};
