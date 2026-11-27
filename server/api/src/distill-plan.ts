import type { ModelCatalog } from "./catalog.js";
import { isArtifactRef } from "./continued-training.js";
import type {
  DatasetRecord,
  PlanRunRequest,
  PlanRunResponse,
  RolloutSpec,
  TrainableModel,
} from "./contracts.js";
import { invalid } from "./errors.js";
import {
  estimateTextTokens,
  promptTokens,
  type RenderOptions,
} from "./planner.js";
import { recordPromptAndReference } from "./records.js";

/**
 * DistillRecipe planning: teacher checks, the resolved rollout and the token
 * meter shared with the trainer (grad_trainer/recipes/distill.py).
 *
 * On-policy runs meter, per prompt and epoch, the student's tokens twice (it
 * writes an answer, then trains on it) plus the teacher's scoring tokens
 * weighted by teacher price / student price, so every token is billed at the
 * run's (student's) price and the teacher's share at the teacher's price.
 * The teacher also answers each held-out prompt once (generation + scoring)
 * for the selection metric. Off-policy runs train on the teacher's answers
 * from a labeling eval, which is billed as an eval.
 */

export const DEFAULT_MAX_NEW_TOKENS = 256;
/** The eval default for max_tokens, which the teacher's labeling eval uses. */
const OFF_POLICY_MAX_TOKENS = 1024;

export type TeacherPlan = NonNullable<PlanRunResponse["teacher"]>;

export interface DistillPlan {
  rollout: { kind: RolloutSpec["kind"]; max_new_tokens: number };
  /** Teacher tokens are metered at this multiple of the student's price. */
  teacherTokenWeight: number | null;
  /** Billable (student-price) tokens of the whole run. */
  estimatedTokens: number;
  teacher: TeacherPlan | null;
  warnings: string[];
}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);

  return (
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
  );
};

/** "auto": the 95th percentile of the records' answers (rounded up to 32), else 256. */
const resolveMaxNewTokens = (
  rollout: RolloutSpec,
  records: readonly DatasetRecord[],
): number => {
  if (
    rollout.kind === "on_policy" &&
    typeof rollout.max_new_tokens === "number"
  ) {
    return rollout.max_new_tokens;
  }
  const lengths = records
    .map((r) => recordPromptAndReference(r)?.reference)
    .filter(
      (ref): ref is string => typeof ref === "string" && ref.trim() !== "",
    )
    .map((ref) => estimateTextTokens(ref) + 1);
  if (lengths.length === 0) return DEFAULT_MAX_NEW_TOKENS;

  return Math.min(
    1024,
    Math.max(32, Math.ceil(percentile(lengths, 0.95) / 32) * 32),
  );
};

const requireTeacher = (recipe: PlanRunRequest["recipe"]): string => {
  if (recipe.teacher === undefined) {
    throw invalid(
      "distill_teacher_required",
      "DistillRecipe needs teacher=: a larger catalog model (such as qwen/qwen3-14b) or, with rollout=OffPolicy(), an artifact or any model your inference endpoint serves.",
    );
  }

  return recipe.teacher;
};

/** On-policy teachers are loaded by the trainer: catalog llms sharing the student's tokenizer. */
const onPolicyTeacher = (
  recipe: PlanRunRequest["recipe"],
  student: TrainableModel,
  catalog: ModelCatalog,
): TrainableModel => {
  const teacherId = requireTeacher(recipe);
  if (isArtifactRef(teacherId)) {
    throw invalid(
      "distill_teacher_unsupported",
      `On-policy distillation loads the teacher in the trainer, which takes catalog models only; to learn from artifact '${teacherId}', pass rollout=OffPolicy() (the inference endpoint serves it).`,
    );
  }
  const teacher = catalog.find(teacherId);
  if (!teacher || teacher.family !== "llm") {
    throw invalid(
      "unknown_model",
      `Teacher '${teacherId}' is not an llm model in the trainable catalog; run \`grad models list\` (GET /v1/base-models), or pass rollout=OffPolicy() to learn from a model your inference endpoint serves.`,
    );
  }
  if (teacher.template_revision !== student.template_revision) {
    throw invalid(
      "distill_tokenizer_mismatch",
      `Teacher '${teacher.id}' (${teacher.template_revision}) and student '${student.id}' (${student.template_revision}) don't share a tokenizer, which token-level KL needs; pass rollout=OffPolicy() to train on the teacher's answers instead.`,
    );
  }
  if (teacher.id === student.id && recipe.context_text === undefined) {
    throw invalid(
      "distill_teacher_is_student",
      `The teacher is the student ('${student.id}'); pass a larger teacher, or a context= the teacher reads and the student doesn't.`,
    );
  }

  return teacher;
};

const smallerTeacherWarning = (
  teacher: TrainableModel | undefined,
  student: TrainableModel,
): string[] =>
  teacher &&
  teacher.price_per_million_tokens_usd < student.price_per_million_tokens_usd
    ? [
        `Teacher '${teacher.id}' is smaller than the student '${student.id}'; distillation usually copies a larger model.`,
      ]
    : [];

export const planDistill = (
  request: PlanRunRequest,
  student: TrainableModel,
  catalog: ModelCatalog,
  split: { train: readonly DatasetRecord[]; eval: readonly DatasetRecord[] },
  options: RenderOptions,
): DistillPlan => {
  const { recipe } = request;
  const rollout: RolloutSpec = recipe.rollout ?? { kind: "on_policy" };
  const answerTokens = resolveMaxNewTokens(rollout, [
    ...split.train,
    ...split.eval,
  ]);
  const prompts = (records: readonly DatasetRecord[]) =>
    records
      .map((r) => promptTokens(r, options))
      .filter((t): t is number => t !== null);
  const trainPrompts = prompts(split.train);
  const epochs = recipe.epochs;

  if (rollout.kind === "off_policy") {
    const teacher = catalog.find(requireTeacher(recipe));
    // The labeling eval caps answers at max_new_tokens (the eval default without
    // one); the estimate assumes answers as long as the records' own.
    const cap = rollout.max_new_tokens ?? OFF_POLICY_MAX_TOKENS;
    const expected = Math.min(cap, answerTokens);

    return {
      rollout: { kind: "off_policy", max_new_tokens: cap },
      teacherTokenWeight: null,
      estimatedTokens:
        trainPrompts.reduce((sum, p) => sum + p + expected, 0) * epochs,
      teacher: null,
      warnings: smallerTeacherWarning(teacher, student),
    };
  }

  const teacher = onPolicyTeacher(recipe, student, catalog);
  const maxNew = answerTokens;
  const weight =
    teacher.price_per_million_tokens_usd / student.price_per_million_tokens_usd;
  const contextTokens = estimateTextTokens(recipe.context_text ?? "");
  const teacherTrain =
    trainPrompts.reduce((sum, p) => sum + p + contextTokens + maxNew, 0) *
    epochs;
  const teacherEval = prompts(split.eval).reduce(
    (sum, p) => sum + 2 * (p + contextTokens + maxNew),
    0,
  );
  const studentTokens =
    trainPrompts.reduce((sum, p) => sum + 2 * (p + maxNew), 0) * epochs;
  const teacherTokens = teacherTrain + teacherEval;
  const teacherCost =
    (teacherTokens / 1_000_000) * teacher.price_per_million_tokens_usd;

  return {
    rollout: { kind: "on_policy", max_new_tokens: maxNew },
    teacherTokenWeight: Number(weight.toPrecision(6)),
    estimatedTokens: studentTokens + Math.ceil(teacherTokens * weight),
    teacher: {
      model: teacher.id,
      price_per_million_tokens: teacher.price_per_million_tokens_usd,
      estimated_tokens: teacherTokens,
      estimated_cost_usd: Number(teacherCost.toFixed(4)),
    },
    warnings: smallerTeacherWarning(teacher, student),
  };
};
