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

/** The LoRA settings an artifact was trained with (from its manifest). */
const artifactAdapter = (
  artifact: Pick<Artifact, "id" | "manifest">,
): { rank: number; alpha: number } => {
  const adapter = artifact.manifest.adapter as
    | { kind?: unknown; rank?: unknown; alpha?: unknown }
    | undefined;
  if (
    adapter?.kind !== "lora" ||
    typeof adapter.rank !== "number" ||
    typeof adapter.alpha !== "number"
  ) {
    throw invalid(
      "continued_training_unsupported",
      `Artifact '${artifact.id}' does not record its LoRA settings (manifest.adapter), so it can't be continued.`,
    );
  }

  return { rank: adapter.rank, alpha: adapter.alpha };
};

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
      `Artifact '${recipe.model}' was not found in this workspace; pass an artifact id ('name@version' or 'name@latest') or a base model id from GET /v1/models.`,
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

  const model = catalog.find(artifact.base_model);
  if (!model) {
    throw invalid(
      "unknown_model",
      `Artifact '${artifact.id}' was trained on '${artifact.base_model}', which is no longer in the trainable catalog.`,
    );
  }

  const inherited = artifactAdapter(artifact);
  const requested = recipe.adapter;
  if (
    requested !== undefined &&
    (requested.kind !== "lora" ||
      requested.rank !== inherited.rank ||
      requested.alpha !== inherited.alpha)
  ) {
    throw invalid(
      "adapter_conflict",
      `Continued training keeps the starting artifact's adapter (LoRA rank ${inherited.rank}, alpha ${inherited.alpha}); omit recipe.adapter or match it.`,
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
    base: {
      id: artifact.id,
      recipe_kind: artifact.recipe_kind,
      format: "peft_lora",
      sha256: artifact.sha256,
    },
  };
};
