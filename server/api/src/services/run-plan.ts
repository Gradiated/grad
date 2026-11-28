import { checkpointEvalsUnsupported, evalsOnCloud } from "../cloud/gateway.js";
import { isArtifactRef } from "../continued-training.js";
import {
  PlanEvalRequestSchema,
  type CheckpointEvalSpec,
  type PlanRunRequest,
  type PlanRunResponse,
} from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { invalid, unavailable } from "../errors.js";
import { planRun } from "../planner.js";
import { assertSecretHost, loggerUrl } from "../secret-hosts.js";
import type { RunRecord } from "../store/types.js";
import { toPublicArtifact } from "./artifacts.js";
import type { DatasetService } from "./datasets.js";
import { assertNonEmptyPlan, planEvalRequest } from "./evals/planner.js";
import type { EvalService } from "./evals/service.js";
import { labelingEvalRequest, toLabelingPlan } from "./router-labels.js";

/**
 * Planning a run: resolving its dataset and recipe into a plan (planner.ts)
 * and checking what the plan alone can't (checkpoint evals, logger
 * secrets, the workers online). `create` and `plan` share it.
 */

/**
 * Run names aren't unique (artifacts get versioned names), so a second run
 * under a busy name only warns: "run support-sft is already running (run_abc);
 * this starts a second one".
 */
const sameNameWarning = (
  active: readonly Pick<RunRecord, "id" | "name" | "status">[],
): string => {
  const [first] = active;
  if (active.length === 1 && first) {
    return `run ${first.name} is already ${first.status} (${first.id}); this starts a second one.`;
  }

  return `${active.length} runs named ${first?.name ?? ""} are already queued or running (${active.map((r) => r.id).join(", ")}); this starts another one.`;
};

/** Base models up to this much GPU memory (an encoder) train fine on a CPU worker. */
const CPU_TRAINABLE_GB = 4;

/**
 * A plan reads at most this many records (spread over the version) and
 * scales its counts: 1M records read whole took 1.9 GB of a 1 GiB API pod.
 */
const PLAN_SAMPLE_RECORDS = 100_000;

export const createRunPlanner = (
  deps: AppDependencies,
  collaborators: { datasets: DatasetService; evals: EvalService },
) => {
  const { store, catalog, clock } = deps;
  const { datasets, evals } = collaborators;

  const planFor = async (workspaceId: string, request: PlanRunRequest) => {
    const resolved = await datasets.resolve(workspaceId, request.dataset);
    // A bounded sample of a big version: the plan never holds it all.
    const { records, total } = await datasets.sample(
      resolved.version,
      PLAN_SAMPLE_RECORDS,
    );
    const baseArtifact = isArtifactRef(request.recipe.model)
      ? await store.artifacts.get(workspaceId, request.recipe.model)
      : null;
    const labelRequest = labelingEvalRequest(request, resolved.version.version);
    if (labelRequest && !deps.inferenceConfigured) {
      throw unavailable(
        "inference_unavailable",
        request.recipe.kind === "router"
          ? 'This router labels your prompts with an eval (it replays them through recipe.models and scores the answers), which needs a model endpoint: set GRAD_INFERENCE_BASE_URL on the server (for `grad local up`, export it before starting the stack), or train on scores already in your records (rubric="resolved", a score name).'
          : "Off-policy distillation generates the teacher's answers with an eval, which needs a model endpoint: set GRAD_INFERENCE_BASE_URL on the server (for `grad local up`, export it before starting the stack), or use rollout=OnPolicy(...).",
      );
    }
    const labeling = labelRequest
      ? toLabelingPlan(await evals.plan(workspaceId, labelRequest))
      : null;
    const plan = planRun(request, records, {
      catalog,
      datasetVersion: resolved.version.version,
      totalRecords: total,
      baseArtifact: baseArtifact && toPublicArtifact(baseArtifact),
      labeling,
    });
    await planCheckpointEvals(workspaceId, request, plan);
    const active = await store.runs.listActiveByName(
      workspaceId,
      request.name,
      20,
    );
    if (active.length > 0) plan.warnings.unshift(sameNameWarning(active));
    const cpuOnly = await cpuOnlyWarning(plan);
    if (cpuOnly) plan.warnings.push(cpuOnly);
    if (request.recipe.loggers) {
      plan.resolved_config.loggers = request.recipe.loggers;
      plan.warnings.push(...(await loggerWarnings(workspaceId, request)));
    }

    return { plan, dataset: resolved.dataset, labelRequest };
  };

  /**
   * recipe.evals: pins each eval's dataset version and rubric into the
   * resolved config (judges need an inference endpoint, code scorers can't
   * run during training) and warns with the cost per checkpoint.
   */
  const planCheckpointEvals = async (
    workspaceId: string,
    request: PlanRunRequest,
    plan: PlanRunResponse,
  ): Promise<void> => {
    const specs = request.recipe.evals;
    if (!specs) return;
    // Gradiated Cloud serves evals only from published artifacts, never a
    // checkpoint (ckpt_…): fail at plan and create, not at the first one.
    if (evalsOnCloud(deps)) throw checkpointEvalsUnsupported();

    const names = specs.map((s) => s.name ?? s.dataset);
    if (new Set(names).size !== names.length) {
      throw invalid(
        "duplicate_checkpoint_eval",
        `recipe.evals names must be unique (got ${names.join(", ")}); pass name= to tell evals on the same dataset apart.`,
      );
    }
    const pinned: CheckpointEvalSpec[] = [];
    let costPerCheckpoint = 0;
    for (const [i, spec] of specs.entries()) {
      // Planned against the base model: the checkpoints share its price.
      const evalPlan = await planEvalRequest(
        deps,
        datasets,
        workspaceId,
        PlanEvalRequestSchema.parse({
          name: names[i],
          models: [plan.resolved_config.model],
          dataset: spec.dataset,
          ...(spec.version !== undefined
            ? { dataset_version: spec.version }
            : {}),
          ...(spec.rubric ? { rubric: spec.rubric } : {}),
          ...(spec.limit !== undefined ? { limit: spec.limit } : {}),
          samples: 1,
          temperature: 0,
        }),
      );
      if (evalPlan.localScorers.length > 0) {
        throw invalid(
          "checkpoint_eval_code_scorer",
          `recipe.evals '${names[i]}' has code scorers (${evalPlan.localScorers.join(", ")}); evals during training take judges, regexes and validators. Run code scorers in an eval on run.artifact after training.`,
        );
      }
      assertNonEmptyPlan(evalPlan);
      pinned.push({
        name: names[i] as string,
        dataset: evalPlan.dataset.dataset.name,
        dataset_version: evalPlan.dataset.version.version,
        rubric: evalPlan.rubric,
        limit: spec.limit ?? null,
      });
      costPerCheckpoint += evalPlan.response.estimated_cost_usd;
    }
    plan.resolved_config.checkpoint_evals = pinned;
    const points = Math.max(
      1,
      Math.ceil(plan.estimated_steps / plan.resolved_config.eval_every_steps),
    );
    const evalsUsd = costPerCheckpoint * points;
    plan.cost_breakdown.eval_usd = Number(
      (plan.cost_breakdown.eval_usd + evalsUsd).toFixed(4),
    );
    plan.estimated_cost_usd = Number(
      (plan.estimated_cost_usd + evalsUsd).toFixed(4),
    );
    plan.warnings.push(
      `recipe.evals run ${pinned.length} eval(s) on each checkpoint (about ${points}), estimated $${costPerCheckpoint.toFixed(4)} per checkpoint, billed as evals and not capped by max_cost_usd.`,
    );
  };

  /**
   * A GPU-sized base model when every online training worker is CPU-only (`grad local up`
   * without --gpu): the run would download the full model and crawl, or run out of memory.
   */
  const cpuOnlyWarning = async (
    plan: PlanRunResponse,
  ): Promise<string | null> => {
    const need = plan.min_gpu_memory_gb;
    if (need === null || need <= CPU_TRAINABLE_GB) return null;
    const { workerGpus, cpuWorkers } = await store.jobs.queueSnapshot(
      "train",
      [],
      clock.now(),
    );
    if (workerGpus.length === 0 || cpuWorkers < workerGpus.length) return null;
    const model = plan.resolved_config.model;
    return `Every online training worker is CPU-only, and ${model} is sized for a GPU (about ${Math.ceil(need)} GB): on a CPU it downloads the full model and trains very slowly, if it fits in memory at all. Add a GPU worker (\`grad local up --gpu\`), or try the workflow on a dev model (\`grad local up --dev-models\`, then model test/tiny-qwen3).`;
  };

  /**
   * Plan warnings for loggers whose secret this server can't read; 422
   * secret_host_not_allowed for a secret that may not go to the logger's host.
   */
  const loggerWarnings = async (
    workspaceId: string,
    request: PlanRunRequest,
  ): Promise<string[]> => {
    const warnings: string[] = [];
    for (const logger of request.recipe.loggers ?? []) {
      if (logger.secret === undefined) continue;
      const secret = deps.secrets
        ? await store.secrets.get(workspaceId, logger.secret)
        : null;
      if (!deps.secrets) {
        warnings.push(
          `Logger '${logger.kind}' needs secret '${logger.secret}', but workspace secrets are not configured (GRAD_SECRETS_KEY); the run trains without it.`,
        );
      } else if (!secret) {
        warnings.push(
          `Logger '${logger.kind}': no secret named '${logger.secret}' (store it with 'grad secrets set ${logger.secret}'); the run trains without it.`,
        );
      } else {
        assertSecretHost(secret, loggerUrl(logger), `${logger.kind} logger`);
      }
    }

    return warnings;
  };

  return planFor;
};
