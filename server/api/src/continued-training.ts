import type { ModelCatalog } from "./catalog.js";
import type {
  AdapterSpec,
  Artifact,
  BaseArtifact,
  RecipeKind,
  RecipeSpec,
  TrainableModel,
} from "./contracts.js";
import { invalid } from "./errors.js";

/** Recipes that can keep training a LoRA adapter from an earlier artifact. */
export const CONTINUABLE_RECIPES: readonly RecipeKind[] = ["sft", "dpo"];

export const isArtifactRef = (model: string | undefined): model is string =>
  model?.includes("@") ?? false;

export interface Continuation {
  model: TrainableModel;
  adapter: Extract<AdapterSpec, { kind: "lora" }>;
  base: BaseArtifact;
}

const loraOf = (artifact: Artifact): { rank: number; alpha: number } => {
  const adapter = artifact.manifest.adapter as
    | {
        kind?: unknown;
        rank?: unknown;
        alpha?: unknown;
        merge_on_export?: unknown;
      }
    | undefined;
  if (
    adapter?.kind !== "lora" ||
    typeof adapter.rank !== "number" ||
    typeof adapter.alpha !== "number"
  ) {
    throw invalid(
      "continued_training_unsupported",
      `Artifact '${artifact.id}' has no recorded LoRA adapter (rank and alpha), so it can't be continued.`,
    );
  }
  if (adapter.merge_on_export === true) {
    throw invalid(
      "continued_training_unsupported",
      `Artifact '${artifact.id}' exports a merged model (merge_on_export=true), which can't be continued; train it with merge_on_export=false.`,
    );
  }

  return { rank: adapter.rank, alpha: adapter.alpha };
};

export const toBaseArtifact = (artifact: Artifact): BaseArtifact => ({
  id: artifact.id,
  recipe_kind: artifact.recipe_kind,
  format: "peft_lora",
  sha256: artifact.sha256,
});

/**
 * Continued training (`recipe.model` = an artifact): the base model and the
 * LoRA adapter come from the starting artifact, which the trainer loads before
 * training. Only PEFT LoRA artifacts of LoRA recipes can be continued.
 */
export const resolveContinuation = (
  recipe: RecipeSpec,
  artifact: Artifact | null,
  catalog: ModelCatalog,
): Continuation => {
  if (!artifact) {
    throw invalid(
      "unknown_model",
      `Artifact '${recipe.model}' was not found in this workspace; pass an artifact id ('name@version' or 'name@latest') or a base model id from GET /v1/base-models.`,
    );
  }
  if (!CONTINUABLE_RECIPES.includes(recipe.kind)) {
    throw invalid(
      "continued_training_unsupported",
      `Recipe '${recipe.kind}' trains from a base model; continuing from an artifact works for ${CONTINUABLE_RECIPES.join(" and ")} (LoRA adapters).`,
    );
  }
  if (artifact.format !== "peft_lora") {
    throw invalid(
      "continued_training_unsupported",
      `Artifact '${artifact.id}' has format '${artifact.format}'; continued training loads PEFT LoRA adapters (a merged export can't be continued, train it with merge_on_export=false).`,
    );
  }
  if (!CONTINUABLE_RECIPES.includes(artifact.recipe_kind)) {
    throw invalid(
      "continued_training_unsupported",
      `Artifact '${artifact.id}' comes from recipe '${artifact.recipe_kind}'; only ${CONTINUABLE_RECIPES.join(" and ")} adapters can be continued.`,
    );
  }

  const model = catalog.find(artifact.base_model);
  if (!model) {
    throw invalid(
      "unknown_model",
      `Artifact '${artifact.id}' was trained on '${artifact.base_model}', which is no longer in the trainable catalog.`,
    );
  }

  const inherited = loraOf(artifact);
  const requested = recipe.adapter;
  if (
    requested !== undefined &&
    (requested.kind !== "lora" ||
      requested.rank !== inherited.rank ||
      requested.alpha !== inherited.alpha)
  ) {
    throw invalid(
      "adapter_conflict",
      `Continued training keeps the starting adapter (LoRA rank ${inherited.rank}, alpha ${inherited.alpha}); omit recipe.adapter or match it.`,
    );
  }

  return {
    model,
    adapter: {
      kind: "lora",
      ...inherited,
      merge_on_export:
        requested?.kind === "lora" ? requested.merge_on_export : false,
    },
    base: toBaseArtifact(artifact),
  };
};
