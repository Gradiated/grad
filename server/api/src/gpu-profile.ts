import type {
  RecipeKind,
  ResolvedRunConfig,
  TrainableModel,
} from "./contracts.js";
import { MAX_UPLOAD_BYTES } from "./contracts/datasets.js";
import { invalid } from "./errors.js";

/**
 * What one training GPU does with each catalog base, measured with grad-trainer's
 * defaults (LoRA rank 32, gradient checkpointing, chunked cross-entropy, varlen
 * packing) on one H100 80 GB: see "GPU memory and throughput" in
 * server/trainer/README.md. v0 trains on one GPU, so a run must fit one.
 */
const TRAINING_GPU_MEMORY_GB = 80;

interface GpuProfile {
  /** bf16 weight bytes in GB (what a frozen teacher adds to the GPU). */
  weights_gb: number;
  /** SFT training tokens per second (forward + backward, GPU steps only). */
  train_tokens_per_s: number;
  /** Model load before the first step, plus the final export, upload and completion. */
  load_s: number;
  /** Training pause per checkpoint: the in-memory snapshot (writing and upload run in the background). */
  checkpoint_s: number;
}

const PROFILES: Record<string, GpuProfile> = {
  // Measured on an H100 80 GB (r7): train_tokens_per_s is the median SFT step rate; load_s
  // is create-to-first-step plus last-step-to-completed through the stack, less the final
  // eval (8B, 14B and the 0.6B router measured, the rest interpolated).
  "qwen/qwen3-0.6b": {
    weights_gb: 1.5,
    train_tokens_per_s: 19_700,
    load_s: 25,
    checkpoint_s: 1,
  },
  "qwen/qwen3-1.7b": {
    weights_gb: 4.1,
    train_tokens_per_s: 13_700,
    load_s: 35,
    checkpoint_s: 1,
  },
  "qwen/qwen3-4b": {
    weights_gb: 8.8,
    train_tokens_per_s: 7_500,
    load_s: 55,
    checkpoint_s: 1,
  },
  "qwen/qwen3-8b": {
    weights_gb: 16.4,
    train_tokens_per_s: 5_500,
    load_s: 95,
    checkpoint_s: 1,
  },
  "qwen/qwen3-14b": {
    weights_gb: 29.5,
    train_tokens_per_s: 3_600,
    load_s: 135,
    checkpoint_s: 2,
  },
  "qwen/qwen3-32b": {
    weights_gb: 65.5,
    train_tokens_per_s: 1_600,
    load_s: 250,
    checkpoint_s: 3,
  },
  "baai/bge-small-en-v1.5": {
    weights_gb: 0.1,
    train_tokens_per_s: 100_000,
    load_s: 5,
    checkpoint_s: 1,
  },
};

/** Unknown bases (GRAD_EXTRA_MODELS_JSON, linden-1) are estimated like an 8B. */
const FALLBACK = PROFILES["qwen/qwen3-8b"] as GpuProfile;

/** Training throughput relative to SFT on the same base (derived from the recipes' passes). */
const RECIPE_SPEED: Partial<Record<RecipeKind, number>> = {
  sft: 1,
  dpo: 0.75, // plus a forward pass of the frozen reference
  router: 0.85, // prompt only, pooled; padded batches
  decision: 0.85,
  reward: 0.75,
  distill: 0.35, // the student generates before it trains
  cartridge: 0.5,
  embedding: 1,
};

const profile = (modelId: string): GpuProfile => PROFILES[modelId] ?? FALLBACK;

/**
 * GPU memory a run needs: the base's measured requirement at the defaults, plus
 * the weights of a teacher loaded beside it (on-policy distill, cartridge).
 */
export const requiredGpuMemoryGb = (
  model: TrainableModel,
  teacher: TrainableModel | null,
): number | null => {
  if (model.min_gpu_memory_gb === null) return null;
  const extra =
    teacher && teacher.id !== model.id ? profile(teacher.id).weights_gb + 2 : 0;

  return Math.ceil(model.min_gpu_memory_gb + extra);
};

/** 422 when the run can't train on one 80 GB GPU (single-GPU v0). */
export const assertFitsOneGpu = (
  kind: RecipeKind,
  model: TrainableModel,
  teacher: TrainableModel | null,
  required: number | null,
): void => {
  if (required === null || required <= TRAINING_GPU_MEMORY_GB) return;

  const withTeacher =
    teacher && teacher.id !== model.id
      ? ` with teacher '${teacher.id}' loaded beside it`
      : "";
  throw invalid(
    "model_exceeds_gpu_memory",
    `Training '${model.id}'${withTeacher} (recipe '${kind}') needs about ${required} GB of GPU memory; v0 trains on one ${TRAINING_GPU_MEMORY_GB} GB GPU. ${
      withTeacher
        ? "Pick a smaller teacher, or pass rollout=OffPolicy() so the inference endpoint answers for it."
        : "Pick a smaller base model (GET /v1/models lists min_gpu_memory_gb)."
    }`,
  );
};

/**
 * 422 when merge_on_export (SFT and distill export merged) would export more
 * than one upload holds: the merged model is the whole base in bf16.
 * Unprofiled bases are left to the trainer, which checks the loaded weights
 * before the first step.
 */
export const assertMergedExportFits = (
  kind: RecipeKind,
  model: TrainableModel,
  adapter: ResolvedRunConfig["adapter"],
): void => {
  if (kind !== "sft" && kind !== "distill") return;
  if (adapter.kind !== "lora" || !adapter.merge_on_export) return;
  const weightsGb = PROFILES[model.id]?.weights_gb;
  if (weightsGb === undefined || weightsGb * 1e9 <= MAX_UPLOAD_BYTES) return;

  throw invalid(
    "merged_export_too_large",
    `merge_on_export=true would export '${model.id}' as a ${weightsGb} GB merged model, and an artifact is at most ${MAX_UPLOAD_BYTES / 1024 ** 3} GiB. Train with merge_on_export=false and merge the downloaded adapter locally (peft: PeftModel.from_pretrained(base, dir).merge_and_unload()).`,
  );
};

/**
 * Wall-clock estimate in seconds: model load and export, training tokens at the
 * measured rate, held-out evaluation (forward only, about 3x faster per token)
 * and the time each checkpoint takes the loop.
 */
export const estimateDurationS = (input: {
  kind: RecipeKind;
  model: TrainableModel;
  trainTokens: number;
  evalTokens: number;
  evals: number;
  /** Step-cadence checkpoints; the trainer adds one every CHECKPOINT_MINUTES. */
  stepCheckpoints: number;
}): number => {
  const p = profile(input.model.id);
  const rate = p.train_tokens_per_s * (RECIPE_SPEED[input.kind] ?? 1);
  const train = input.trainTokens / rate;
  const evaluate = (input.evals * input.evalTokens) / (3 * rate);
  const checkpoints =
    input.stepCheckpoints +
    Math.floor((train + evaluate) / (CHECKPOINT_MINUTES * 60));

  return Math.ceil(p.load_s + train + evaluate + checkpoints * p.checkpoint_s);
};

/** The trainer's wall-clock checkpoint interval (config.DEFAULT_CHECKPOINT_MINUTES). */
const CHECKPOINT_MINUTES = 5;
