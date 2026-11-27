import { DEPLOY_DISABLED_DETAIL } from "../adapters.js";
import {
  NON_DEPLOYABLE_FORMATS,
  type ChatMessage,
  type Deployment,
  type EmbedResponse,
  type FeedbackRecord,
  type RouteResponse,
} from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { ApiError, conflict, invalid, notFound } from "../errors.js";
import { newId } from "../ids.js";
import type {
  ArtifactRecord,
  FeedbackInsert,
  Page,
  PageRequest,
  Repositories,
} from "../store/types.js";

export interface DeployInput {
  artifact: string;
  name?: string | undefined;
  fallback?: string | undefined;
  explore_rate: number;
}

export interface DeploymentStatus {
  deployment: Deployment;
  feedback_count: number;
  average_score: number | null;
}

export interface FeedbackEvent {
  inference_id?: string | undefined;
  session_id?: string | undefined;
  deployment_name?: string | undefined;
  idempotency_key: string;
  score?: number | undefined;
  expected_output?: unknown;
  metrics?: Record<string, number> | undefined;
}

export interface ServingService {
  readonly mode: "disabled" | "cloud";
  deploy(workspaceId: string, input: DeployInput): Promise<Deployment>;
  rollback(workspaceId: string, name: string): Promise<Deployment>;
  get(workspaceId: string, name: string): Promise<DeploymentStatus>;
  list(workspaceId: string, page: PageRequest): Promise<Page<Deployment>>;
  route(
    workspaceId: string,
    input: {
      deployment: string;
      messages: ChatMessage[];
      tools?: Array<Record<string, unknown>> | undefined;
      session_id?: string | undefined;
    },
  ): Promise<RouteResponse>;
  embed(
    workspaceId: string,
    input: { model: string; input: string | string[] },
  ): Promise<EmbedResponse>;
  recordFeedback(
    workspaceId: string,
    events: readonly FeedbackEvent[],
  ): Promise<{
    accepted: number;
    deduplicated: number;
    records: FeedbackRecord[];
  }>;
}

const deployUnavailable = (): ApiError =>
  new ApiError(
    501,
    "deploy_unavailable",
    "Hosted serving is not available",
    DEPLOY_DISABLED_DETAIL,
  );

export const createServingService = (deps: AppDependencies): ServingService => {
  const { store } = deps;

  const requireEnabled = (): void => {
    if (deps.deploy.mode === "disabled" || deps.serving.mode === "disabled") {
      throw deployUnavailable();
    }
  };

  const publish = async (
    tx: Repositories,
    workspaceId: string,
    name: string,
    artifact: ArtifactRecord,
    fallbackModel: string | null,
    exploreRate: number,
  ): Promise<Deployment> => {
    if (NON_DEPLOYABLE_FORMATS.includes(artifact.format)) {
      throw conflict(
        "artifact_not_deployable",
        `Artifact '${artifact.id}' has format '${artifact.format}', which cannot be served. Retrain with a real training backend.`,
      );
    }

    await tx.deployments.lock(workspaceId, name);
    const { modelId } = await deps.deploy.publishAndPromote({
      workspaceId,
      name,
      artifact,
      fallbackModel,
    });

    return tx.deployments.upsert({
      workspaceId,
      name,
      modelId,
      activeArtifactId: artifact.id,
      fallbackModel,
      exploreRate,
    });
  };

  const getDeployment = async (
    workspaceId: string,
    name: string,
  ): Promise<Deployment> => {
    const deployment = await store.deployments.get(workspaceId, name);
    if (!deployment) throw notFound("deployment", name);

    return deployment;
  };

  const activeArtifact = async (
    workspaceId: string,
    deployment: Deployment,
  ): Promise<ArtifactRecord> => {
    const artifact = await store.artifacts.get(
      workspaceId,
      deployment.active_artifact_id,
    );
    if (!artifact) throw notFound("artifact", deployment.active_artifact_id);

    return artifact;
  };

  return {
    mode: deps.deploy.mode,

    deploy: async (workspaceId, input) => {
      requireEnabled();
      const artifact = await store.artifacts.get(workspaceId, input.artifact);
      if (!artifact) throw notFound("artifact", input.artifact);

      return store.transaction((tx) =>
        publish(
          tx,
          workspaceId,
          input.name ?? artifact.name,
          artifact,
          input.fallback ?? null,
          input.explore_rate,
        ),
      );
    },

    rollback: async (workspaceId, name) => {
      requireEnabled();
      const deployment = await getDeployment(workspaceId, name);
      if (!deployment.previous_artifact_id) {
        throw conflict(
          "no_previous_artifact",
          `Deployment '${name}' has no previous artifact to roll back to.`,
        );
      }
      const previous = await store.artifacts.get(
        workspaceId,
        deployment.previous_artifact_id,
      );
      if (!previous)
        throw notFound("artifact", deployment.previous_artifact_id);

      return store.transaction((tx) =>
        publish(
          tx,
          workspaceId,
          name,
          previous,
          deployment.fallback_model,
          deployment.explore_rate,
        ),
      );
    },

    get: async (workspaceId, name) => {
      const deployment = await getDeployment(workspaceId, name);
      const stats = await store.feedback.stats(workspaceId, name);

      return {
        deployment,
        feedback_count: stats.count,
        average_score: stats.average_score,
      };
    },

    list: (workspaceId, page) => store.deployments.list(workspaceId, page),

    route: async (workspaceId, input) => {
      requireEnabled();
      const deployment = await getDeployment(workspaceId, input.deployment);
      const artifact = await activeArtifact(workspaceId, deployment);
      if (artifact.recipe_kind !== "router") {
        throw conflict(
          "not_a_router",
          `Deployment '${deployment.name}' serves a '${artifact.recipe_kind}' artifact; /v1/route needs a router artifact.`,
        );
      }

      const inferenceId = newId("inf");
      const decision = await deps.serving.route({
        workspaceId,
        inferenceId,
        deploymentName: deployment.name,
        modelId: deployment.model_id,
        artifactId: artifact.id,
        fallbackModel: deployment.fallback_model,
        exploreRate: deployment.explore_rate,
        messages: input.messages,
        tools: input.tools,
        sessionId: input.session_id,
      });

      await store.inferences.create({
        id: inferenceId,
        workspace_id: workspaceId,
        deployment_name: deployment.name,
        artifact_id: artifact.id,
        model: decision.model,
      });

      return {
        inference_id: inferenceId,
        deployment: deployment.name,
        artifact_id: artifact.id,
        model: decision.model,
        is_exploration: decision.is_exploration,
        confidence: decision.confidence,
        scores: decision.scores,
      };
    },

    embed: async (workspaceId, input) => {
      requireEnabled();
      const deployment = await getDeployment(workspaceId, input.model);
      const artifact = await activeArtifact(workspaceId, deployment);
      if (artifact.recipe_kind !== "embedding") {
        throw conflict(
          "not_an_embedding_model",
          `Deployment '${deployment.name}' serves a '${artifact.recipe_kind}' artifact, not an embedding model.`,
        );
      }

      const inputs = Array.isArray(input.input) ? input.input : [input.input];
      const result = await deps.serving.embed({
        workspaceId,
        deploymentName: deployment.name,
        modelId: deployment.model_id,
        inputs,
      });

      return {
        model: deployment.name,
        data: result.embeddings.map((embedding, index) => ({
          index,
          embedding,
        })),
        usage: result.usage,
      };
    },

    recordFeedback: async (workspaceId, events) => {
      const inferenceIds = [
        ...new Set(
          events
            .map((e) => e.inference_id)
            .filter((id): id is string => id !== undefined),
        ),
      ];
      const inferences = new Map(
        (await store.inferences.getMany(workspaceId, inferenceIds)).map((r) => [
          r.id,
          r,
        ]),
      );
      const unknown = inferenceIds.filter((id) => !inferences.has(id));
      if (unknown.length > 0) {
        throw invalid(
          "unknown_inference_id",
          `Unknown inference_id(s): ${unknown.slice(0, 20).join(", ")}.`,
        );
      }

      const explicitNames = [
        ...new Set(
          events
            .map((e) => e.deployment_name)
            .filter((n): n is string => n !== undefined),
        ),
      ];
      for (const name of explicitNames) {
        if (!(await store.deployments.get(workspaceId, name))) {
          throw invalid(
            "unknown_deployment",
            `Deployment '${name}' does not exist in this workspace.`,
          );
        }
      }

      const inserts: FeedbackInsert[] = events.map((event) => {
        const inference = event.inference_id
          ? inferences.get(event.inference_id)
          : undefined;
        if (
          inference &&
          event.deployment_name !== undefined &&
          event.deployment_name !== inference.deployment_name
        ) {
          throw invalid(
            "deployment_mismatch",
            `inference_id '${inference.id}' belongs to deployment '${inference.deployment_name}', not '${event.deployment_name}'.`,
          );
        }

        return {
          workspaceId,
          inferenceId: event.inference_id ?? null,
          sessionId: event.session_id ?? null,
          deploymentName:
            event.deployment_name ?? inference?.deployment_name ?? null,
          idempotencyKey: event.idempotency_key,
          score: event.score ?? null,
          expectedOutput: event.expected_output ?? null,
          metrics: event.metrics ?? {},
        };
      });

      const outcomes = await store.feedback.insertMany(inserts);
      const deduplicated = outcomes.filter((o) => o.deduplicated).length;

      return {
        accepted: outcomes.length - deduplicated,
        deduplicated,
        records: outcomes.map((o) => o.record),
      };
    },
  };
};
