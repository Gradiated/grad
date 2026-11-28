import type { EvalRubricItem } from "./contracts.js";

/**
 * The built-in benchmarks (`datasets.from_benchmark`): Hugging Face datasets
 * at a pinned revision, turned into chat records by the trainer
 * (`grad_trainer/benchmarks.py`), with the rubric that scores them. An eval
 * on a benchmark dataset without a rubric uses this one.
 */
interface Benchmark {
  repo: string;
  config: string;
  split: string;
  revision: string;
  rows: number;
  rubric: EvalRubricItem[];
}

const answer = (
  name: string,
  validator: "final_number" | "choice",
): EvalRubricItem[] => [{ name, kind: "validator", weight: 1, validator }];

export const BENCHMARKS = {
  gsm8k: {
    repo: "openai/gsm8k",
    config: "main",
    split: "test",
    revision: "740312add88f781978c0658806c59bc2815b9866",
    rows: 1319,
    rubric: answer("gsm8k_answer", "final_number"),
  },
  mmlu: {
    repo: "cais/mmlu",
    config: "all",
    split: "test",
    revision: "c30699e8356da336a370243923dbaf21066bb9fe",
    rows: 14042,
    rubric: answer("mmlu_answer", "choice"),
  },
  mmlu_pro: {
    repo: "TIGER-Lab/MMLU-Pro",
    config: "default",
    split: "test",
    revision: "b189ec765aa7ed75c8acfea42df31fdae71f97be",
    rows: 12032,
    rubric: answer("mmlu_pro_answer", "choice"),
  },
  arc_challenge: {
    repo: "allenai/ai2_arc",
    config: "ARC-Challenge",
    split: "test",
    revision: "210d026faf9955653af8916fad021475a3f00453",
    rows: 1172,
    rubric: answer("arc_answer", "choice"),
  },
} as const satisfies Record<string, Benchmark>;

type BenchmarkName = keyof typeof BENCHMARKS;

export const BENCHMARK_NAMES = Object.keys(BENCHMARKS) as [
  BenchmarkName,
  ...BenchmarkName[],
];

/** The `hf` import source a benchmark import runs as (the worker applies the transform). */
export const benchmarkSource = (
  name: BenchmarkName,
  limit: number | undefined,
): Record<string, unknown> => {
  const b = BENCHMARKS[name];

  return {
    kind: "hf",
    repo: b.repo,
    config: b.config,
    split: b.split,
    revision: b.revision,
    columns: {},
    benchmark: name,
    ...(limit !== undefined ? { limit } : {}),
  };
};

/** Dataset metadata a committed benchmark import sets: what it is and how to score it. */
export const benchmarkMetadata = (
  source: Record<string, unknown>,
): Record<string, unknown> | null => {
  const name = source.benchmark;
  if (typeof name !== "string" || !(name in BENCHMARKS)) return null;
  const b = BENCHMARKS[name as BenchmarkName];

  return {
    benchmark: {
      name,
      repo: b.repo,
      config: b.config,
      split: b.split,
      revision: b.revision,
    },
    rubric: b.rubric,
  };
};
