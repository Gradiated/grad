import { ApiError, errorMessage } from "../errors.js";
import { createOpenAICompatibleClient } from "../services/evals/inference.js";
import type { InferenceClients } from "../services/evals/types.js";
import { cloudRequest, cloudUrl, detailOf, isOk } from "./http.js";

/**
 * Evals on Gradiated Cloud. The eval worker calls the inference gateway's
 * OpenAI-compatible API with grad's gateway service credential and says, per
 * call, which workspace it acts for and that it is eval traffic: the gateway
 * serves it in its low-priority eval lane (429 under pressure; the client
 * backs off) and bills the tokens itself, tagged with the eval.
 */
export const GATEWAY_HEADERS = {
  workspace: "X-Gradiated-Workspace",
  source: "X-Gradiated-Source",
  evalId: "X-Gradiated-Eval-Id",
} as const;

export const createGatewayInference = (options: {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}): InferenceClients => {
  const client = createOpenAICompatibleClient({
    baseUrl: cloudUrl("GRAD_CLOUD_GATEWAY_URL", options.baseUrl),
    apiKey: options.token,
    timeoutMs: 120_000,
    // The eval lane sheds load with 429: back off for up to ~30 s.
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
 * Maps an artifact to the name the gateway serves it under. Cloud: the
 * product publishes it as an eval-only Version (pinned, hidden, never
 * promotable) and answers `<org_slug>/<model>/<version>`.
 */
export interface EvalModelResolver {
  servingModel(workspaceId: string, artifactId: string): Promise<string>;
}

export const createEvalModelResolver = (options: {
  internalApiBaseUrl: string;
  serviceToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): EvalModelResolver => {
  const url = `${cloudUrl("CLOUD_INTERNAL_API_URL", options.internalApiBaseUrl)}/api/internal/v1/training/eval-versions`;
  const fetchFn = options.fetchImpl ?? globalThis.fetch;

  return {
    servingModel: async (workspaceId, artifactId) => {
      let res;
      try {
        res = await cloudRequest(fetchFn, url, {
          token: options.serviceToken,
          body: { workspace_id: workspaceId, artifact_id: artifactId },
          timeoutMs: options.timeoutMs ?? 30_000,
        });
      } catch (error) {
        throw new ApiError(
          503,
          "inference_unavailable",
          "Gradiated Cloud inference unavailable",
          `Could not publish artifact '${artifactId}' for evaluation: ${errorMessage(error)}`,
        );
      }
      if (res.status === 409 || res.status === 422) {
        throw new ApiError(
          422,
          "artifact_not_servable",
          "Artifact cannot be served",
          `Gradiated Cloud cannot serve artifact '${artifactId}' for evaluation${detailOf(res)}.`,
        );
      }
      const model = res.json.model;
      if (!isOk(res.status) || typeof model !== "string" || !model.trim()) {
        throw new ApiError(
          503,
          "inference_unavailable",
          "Gradiated Cloud inference unavailable",
          `Publishing artifact '${artifactId}' for evaluation returned HTTP ${res.status}${detailOf(res)}.`,
        );
      }

      return model.trim();
    },
  };
};
