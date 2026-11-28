import { ApiError, errorMessage } from "../errors.js";
import { createOpenAICompatibleClient } from "../services/evals/inference.js";
import type { InferenceClients } from "../services/evals/types.js";
import { cloudRequest, cloudUrl, detailOf, isOk } from "./http.js";

/**
 * Evals on Gradiated Cloud. The eval worker calls the inference gateway's
 * OpenAI-compatible API with grad's gateway service credential and says, per
 * call, which workspace it acts for and that it is eval traffic: the gateway
 * serves it in its low-priority eval lane (429 under pressure; the client
 * backs off; `503 capacity_unavailable` with Retry-After when a pool at zero
 * did not wake in time, which the eval worker waits out) and bills the
 * tokens itself, tagged with the eval.
 */
export const GATEWAY_HEADERS = {
  workspace: "X-Gradiated-Workspace",
  source: "X-Gradiated-Source",
  evalId: "X-Gradiated-Eval-Id",
} as const;

/** Longer than the gateway's 90 s cold-start hold. */
export const GATEWAY_TIMEOUT_MS = 120_000;

export const createGatewayInference = (options: {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}): InferenceClients => {
  const client = createOpenAICompatibleClient({
    baseUrl: cloudUrl("GRAD_CLOUD_GATEWAY_URL", options.baseUrl),
    apiKey: options.token,
    // A call that finds its pool at zero is held while the pool wakes (at
    // most 90 s) before it answers 503 capacity_unavailable: never abort it
    // first.
    timeoutMs: GATEWAY_TIMEOUT_MS,
    // The eval lane sheds load with 429 eval_lane_limited (Retry-After: 5):
    // the client backs off for ~40 s, then the eval worker waits in place.
    maxAttempts: 6,
    retryDelayMs: 1_000,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    headers: (request) => ({
      [GATEWAY_HEADERS.workspace]: request.workspace,
      [GATEWAY_HEADERS.source]: "eval",
      ...(request.evalId ? { [GATEWAY_HEADERS.evalId]: request.evalId } : {}),
    }),
  });

  return { models: client, judge: client };
};

/**
 * Gradiated Cloud serves evals only from published artifacts (eval-only
 * Versions); a checkpoint (`ckpt_…`) has none, so `recipe.evals` is refused
 * on Cloud. Evaluate `run.artifact` after training instead.
 */
export const checkpointEvalsUnsupported = (): ApiError =>
  new ApiError(
    422,
    "checkpoint_evals_unsupported_on_cloud",
    "Checkpoint evals are not supported on Gradiated Cloud",
    "recipe.evals evaluates each checkpoint during training, which Gradiated Cloud can't serve yet. Drop recipe.evals and run an eval on the run's artifact (run.artifact) after training.",
  );

/**
 * Maps an artifact to the name the gateway serves it under. Cloud: the
 * product publishes it as an eval-only Version (pinned, hidden, never
 * promotable) and answers `<org_slug>/<model>/<version>`.
 */
export interface EvalModelResolver {
  servingModel(workspaceId: string, artifactId: string): Promise<string>;
}

/** The product streams the whole bundle on an artifact's first eval-versions call. */
export const EVAL_VERSION_TIMEOUT_MS = 600_000;
const EVAL_VERSION_TRIES = 3;

export const createEvalModelResolver = (options: {
  internalApiBaseUrl: string;
  serviceToken: string;
  fetchImpl?: typeof fetch;
  /** The whole call, retries included (default 10 min). */
  timeoutMs?: number;
  retryDelayMs?: number;
}): EvalModelResolver => {
  const url = `${cloudUrl("CLOUD_INTERNAL_API_URL", options.internalApiBaseUrl)}/api/internal/v1/training/eval-versions`;
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const budgetMs = options.timeoutMs ?? EVAL_VERSION_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? 1_000;

  const unavailable = (artifactId: string, why: string) =>
    new ApiError(
      503,
      "inference_unavailable",
      "Gradiated Cloud inference unavailable",
      `Could not publish artifact '${artifactId}' for evaluation: ${why}`,
    );

  return {
    // Idempotent per (workspace, artifact) on the product side, so an
    // unreachable or 5xx answer is retried, and so is a retried eval create.
    servingModel: async (workspaceId, artifactId) => {
      const deadline = Date.now() + budgetMs;
      let why = "no answer";
      for (let i = 0; i < EVAL_VERSION_TRIES; i += 1) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        let res;
        try {
          res = await cloudRequest(fetchFn, url, {
            token: options.serviceToken,
            body: { workspace_id: workspaceId, artifact_id: artifactId },
            timeoutMs: left,
          });
        } catch (error) {
          why = errorMessage(error);
          await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** i));
          continue;
        }
        if ([404, 409, 422].includes(res.status)) {
          throw new ApiError(
            422,
            "artifact_not_servable",
            "Artifact cannot be served",
            `Gradiated Cloud cannot serve artifact '${artifactId}' for evaluation${detailOf(res)}.`,
          );
        }
        const model = res.json.model;
        if (isOk(res.status) && typeof model === "string" && model.trim()) {
          return model.trim();
        }
        why = `HTTP ${res.status}${detailOf(res)}`;
        if (isOk(res.status) || res.status < 500) break;
        await new Promise((r) => setTimeout(r, retryDelayMs * 2 ** i));
      }

      throw unavailable(artifactId, why);
    },
  };
};
