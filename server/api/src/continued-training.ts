import type { ModelCatalog } from "./catalog.js";
import type {
  AdapterSpec,
  Artifact,
  BaseArtifact,
  RecipeKind,
  RecipeSpec,
  Run,
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

/** Where a continued run starts: a finished artifact or a chained run's future one. */
interface StartSource {
  /** For messages: "Artifact 'x@1'" or "Run 'run_1'". */
  label: string;
  recipe_kind: RecipeKind;
  base_model: string;
  adapter: unknown;
  /** null for a dependency run that has not produced its artifact yet. */
  format: Artifact["format"] | null;
}

const loraOf = (source: StartSource): { rank: number; alpha: number } => {
  const adapter = source.adapter as
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
      `${source.label} has no recorded LoRA adapter (rank and alpha), so it can't be continued.`,
    );
  }
  if (adapter.merge_on_export === true) {
    throw invalid(
      "continued_training_unsupported",
      `${source.label} exports a merged model (merge_on_export=true), which can't be continued; train it with merge_on_export=false.`,
    );
  }

  return { rank: adapter.rank, alpha: adapter.alpha };
};

const continueFrom = (
  recipe: RecipeSpec,
  source: StartSource,
  catalog: ModelCatalog,
): Omit<Continuation, "base"> => {
  if (!CONTINUABLE_RECIPES.includes(recipe.kind)) {
    throw invalid(
      "continued_training_unsupported",
      `Recipe '${recipe.kind}' trains from a base model; continuing from an artifact works for ${CONTINUABLE_RECIPES.join(" and ")} (LoRA adapters).`,
    );
  }
  if (source.format !== null && source.format !== "peft_lora") {
    throw invalid(
      "continued_training_unsupported",
      `${source.label} has format '${source.format}'; continued training loads PEFT LoRA adapters (a merged export can't be continued, train it with merge_on_export=false).`,
    );
  }
  if (!CONTINUABLE_RECIPES.includes(source.recipe_kind)) {
    throw invalid(
      "continued_training_unsupported",
      `${source.label} comes from recipe '${source.recipe_kind}'; only ${CONTINUABLE_RECIPES.join(" and ")} adapters can be continued.`,
    );
  }

  const model = catalog.find(source.base_model);
  if (!model) {
    throw invalid(
      "unknown_model",
      `${source.label} was trained on '${source.base_model}', which is no longer in the trainable catalog.`,
    );
  }

  const inherited = loraOf(source);
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
  };
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
      `Artifact '${recipe.model}' was not found in this workspace; pass an artifact id ('name@version' or 'name@latest') or a base model id from GET /v1/models.`,
    );
  }
  const start = continueFrom(
    recipe,
    {
      label: `Artifact '${artifact.id}'`,
      recipe_kind: artifact.recipe_kind,
      base_model: artifact.base_model,
      adapter: artifact.manifest.adapter,
      format: artifact.format,
    },
    catalog,
  );

  return { ...start, base: toBaseArtifact(artifact) };
};

/** A chained run's start: the dependency run's model and adapter (artifact pending). */
export const resolveChainedStart = (
  recipe: RecipeSpec,
  dependency: Pick<Run, "id" | "recipe_kind" | "resolved_config">,
  catalog: ModelCatalog,
): Omit<Continuation, "base"> =>
  continueFrom(
    recipe,
    {
      label: `Run '${dependency.id}'`,
      recipe_kind: dependency.recipe_kind,
      base_model: dependency.resolved_config.model,
      adapter: dependency.resolved_config.adapter,
      format: null,
    },
    catalog,
  );
