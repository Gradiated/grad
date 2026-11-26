import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import {
  ArtifactSchema,
  DeployArtifactRequestSchema,
  DeploymentSchema,
  EmbedRequestSchema,
  EmbedResponseSchema,
  FeedbackRecordSchema,
  RecordFeedbackRequestSchema,
  RouteRequestSchema,
  RouteResponseSchema,
  SlugSchema,
} from "../contracts.js";
import { estimateTextTokens } from "../planner.js";
import { computeDeterministicEmbedding, selectRoute } from "../serving.js";
import {
  defaultErrors,
  jsonResponse,
  problemContent,
  requireScope,
  respondProblem,
  type AppDependencies,
  type AppEnv,
} from "./helpers.js";

export const registerArtifactAndServingRoutes = (
  app: OpenAPIHono<AppEnv>,
  deps: AppDependencies,
): void => {
  const listArtifactsRoute = createRoute({
    method: "get",
    path: "/v1/artifacts",
    operationId: "listArtifacts",
    summary: "List immutable artifacts",
    tags: ["Artifacts"],
    request: { query: z.object({ name: SlugSchema.optional() }) },
    responses: {
      200: jsonResponse(
        z.object({ data: z.array(ArtifactSchema) }),
        "Artifacts.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(listArtifactsRoute, async (c) => {
    const denied = requireScope(c, "artifacts:read");
    if (denied) return denied;

    const { name } = c.req.valid("query");
    const data = await deps.store.listArtifacts(
      c.get("principal").workspaceId,
      name,
    );

    return c.json({ data }, 200);
  });

  const getArtifactRoute = createRoute({
    method: "get",
    path: "/v1/artifacts/{id}",
    operationId: "getArtifact",
    summary: "Get an artifact by ID or name@latest",
    tags: ["Artifacts"],
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: {
      200: jsonResponse(ArtifactSchema, "Artifact metadata."),
      ...defaultErrors,
    },
  });

  app.openapi(getArtifactRoute, async (c) => {
    const denied = requireScope(c, "artifacts:read");
    if (denied) return denied;

    const { id } = c.req.valid("param");
    const artifact = await deps.store.getArtifact(
      c.get("principal").workspaceId,
      id,
    );
    if (!artifact) {
      return respondProblem(
        c,
        404,
        "artifact_not_found",
        "Artifact not found",
        `Artifact '${id}' was not found.`,
      );
    }

    return c.json(artifact, 200);
  });

  const downloadArtifactRoute = createRoute({
    method: "get",
    path: "/v1/artifacts/{id}/download",
    operationId: "downloadArtifact",
    summary: "Download an artifact archive",
    tags: ["Artifacts"],
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: {
      200: {
        description: "Artifact binary archive.",
        content: {
          "application/octet-stream": {
            schema: z.string().openapi({ format: "binary" }),
          },
        },
      },
      ...defaultErrors,
    },
  });

  app.openapi(downloadArtifactRoute, async (c) => {
    const denied = requireScope(c, "artifacts:read");
    if (denied) return denied;

    const { id } = c.req.valid("param");
    const artifact = await deps.store.getArtifact(
      c.get("principal").workspaceId,
      id,
    );
    if (!artifact) {
      return respondProblem(
        c,
        404,
        "artifact_not_found",
        "Artifact not found",
        `Artifact '${id}' was not found.`,
      );
    }

    const bytes = await deps.storage.get(artifact.storage_key);

    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "X-Artifact-Sha256": artifact.sha256,
        "Content-Disposition": `attachment; filename="${artifact.name}-${artifact.version}.grad.tar.gz"`,
      },
    });
  });

  const deployArtifactRoute = createRoute({
    method: "post",
    path: "/v1/deployments",
    operationId: "deployArtifact",
    summary: "Deploy or update an artifact under a stable model name",
    tags: ["Deployments"],
    request: {
      body: {
        required: true,
        content: {
          "application/json": { schema: DeployArtifactRequestSchema },
        },
      },
    },
    responses: {
      200: jsonResponse(DeploymentSchema, "Active deployment."),
      501: {
        description: "Deploy disabled in self-hosted mode.",
        content: problemContent,
      },
      ...defaultErrors,
    },
  });

  app.openapi(deployArtifactRoute, async (c) => {
    const denied = requireScope(c, "deployments:write");
    if (denied) return denied;

    if (!deps.deploy.enabled) {
      return respondProblem(
        c,
        501,
        "deploy_disabled",
        "Hosted deploy is disabled",
        "Hosted deploy() is not enabled on this self-hosted instance. Download weights with `grad artifacts download`.",
      );
    }

    const body = c.req.valid("json");
    const workspaceId = c.get("principal").workspaceId;
    const artifact = await deps.store.getArtifact(workspaceId, body.artifact);
    if (!artifact) {
      return respondProblem(
        c,
        404,
        "artifact_not_found",
        "Artifact not found",
        `Artifact '${body.artifact}' was not found.`,
      );
    }

    const deploymentName = body.name ?? artifact.name;
    const published = await deps.deploy.publishAndPromote({
      workspaceId,
      name: deploymentName,
      artifact,
      fallbackModel: body.fallback ?? null,
    });

    const deployment = await deps.store.upsertDeployment({
      workspaceId,
      name: deploymentName,
      modelId: published.modelId,
      activeArtifactId: artifact.id,
      fallbackModel: body.fallback ?? null,
      exploreRate: body.explore_rate,
    });

    return c.json(deployment, 200);
  });

  const listDeploymentsRoute = createRoute({
    method: "get",
    path: "/v1/deployments",
    operationId: "listDeployments",
    summary: "List active deployments",
    tags: ["Deployments"],
    responses: {
      200: jsonResponse(
        z.object({ data: z.array(DeploymentSchema) }),
        "Deployments.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(listDeploymentsRoute, async (c) => {
    const denied = requireScope(c, "artifacts:read");
    if (denied) return denied;

    const data = await deps.store.listDeployments(
      c.get("principal").workspaceId,
    );

    return c.json({ data }, 200);
  });

  const getDeploymentRoute = createRoute({
    method: "get",
    path: "/v1/deployments/{name}",
    operationId: "getDeployment",
    summary: "Get deployment status and feedback summary",
    tags: ["Deployments"],
    request: { params: z.object({ name: SlugSchema }) },
    responses: {
      200: jsonResponse(
        z.object({
          deployment: DeploymentSchema,
          feedback_count: z.number().int().min(0),
          average_score: z.number().nullable(),
        }),
        "Deployment status.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(getDeploymentRoute, async (c) => {
    const denied = requireScope(c, "artifacts:read");
    if (denied) return denied;

    const { name } = c.req.valid("param");
    const workspaceId = c.get("principal").workspaceId;
    const deployment = await deps.store.getDeployment(workspaceId, name);
    if (!deployment) {
      return respondProblem(
        c,
        404,
        "deployment_not_found",
        "Deployment not found",
        `Deployment '${name}' was not found.`,
      );
    }

    const feedback = await deps.store.listFeedback(workspaceId, name);
    const scored = feedback.filter((f) => f.score !== null);
    const averageScore =
      scored.length > 0
        ? Number(
            (
              scored.reduce((acc, item) => acc + (item.score ?? 0), 0) /
              scored.length
            ).toFixed(4),
          )
        : null;

    return c.json(
      {
        deployment,
        feedback_count: feedback.length,
        average_score: averageScore,
      },
      200,
    );
  });

  const routeModelRoute = createRoute({
    method: "post",
    path: "/v1/route",
    operationId: "routeRequest",
    summary: "Ask a deployed model router which model to call",
    tags: ["Serving"],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: RouteRequestSchema } },
      },
    },
    responses: {
      200: jsonResponse(RouteResponseSchema, "Routing decision."),
      ...defaultErrors,
    },
  });

  app.openapi(routeModelRoute, async (c) => {
    const denied = requireScope(c, "artifacts:read");
    if (denied) return denied;

    const body = c.req.valid("json");
    const workspaceId = c.get("principal").workspaceId;
    const deployment = await deps.store.getDeployment(
      workspaceId,
      body.deployment,
    );
    if (!deployment) {
      return respondProblem(
        c,
        404,
        "deployment_not_found",
        "Deployment not found",
        `Deployment '${body.deployment}' was not found.`,
      );
    }

    const artifact = await deps.store.getArtifact(
      workspaceId,
      deployment.active_artifact_id,
    );
    if (!artifact) {
      return respondProblem(
        c,
        404,
        "artifact_not_found",
        "Artifact not found",
        `Active artifact '${deployment.active_artifact_id}' was not found.`,
      );
    }

    const decision = selectRoute({
      deployment,
      artifact,
      messages: body.messages,
      ...(body.session_id ? { sessionId: body.session_id } : {}),
    });

    c.header("x-gradiated-inference-id", decision.inference_id);

    return c.json(decision, 200);
  });

  const embeddingsRoute = createRoute({
    method: "post",
    path: "/v1/embeddings",
    operationId: "createEmbeddings",
    summary: "Generate embeddings from a deployed embedding artifact",
    tags: ["Serving"],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: EmbedRequestSchema } },
      },
    },
    responses: {
      200: jsonResponse(EmbedResponseSchema, "Normalized embeddings."),
      ...defaultErrors,
    },
  });

  app.openapi(embeddingsRoute, async (c) => {
    const denied = requireScope(c, "artifacts:read");
    if (denied) return denied;

    const body = c.req.valid("json");
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const promptTokens = inputs.reduce(
      (sum, text) => sum + estimateTextTokens(text),
      0,
    );

    const data = inputs.map((text, index) => ({
      index,
      embedding: computeDeterministicEmbedding(text, body.model),
    }));

    return c.json(
      {
        model: body.model,
        data,
        usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
      },
      200,
    );
  });

  const recordFeedbackRoute = createRoute({
    method: "post",
    path: "/v1/feedback",
    operationId: "recordFeedback",
    summary: "Record deduplicated outcome scores and gold corrections",
    tags: ["Feedback"],
    request: {
      body: {
        required: true,
        content: {
          "application/json": { schema: RecordFeedbackRequestSchema },
        },
      },
    },
    responses: {
      200: jsonResponse(
        z.object({
          accepted: z.number().int().min(0),
          deduplicated: z.number().int().min(0),
          records: z.array(FeedbackRecordSchema),
        }),
        "Recorded feedback events.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(recordFeedbackRoute, async (c) => {
    const denied = requireScope(c, "feedback:write");
    if (denied) return denied;

    const body = c.req.valid("json");
    const workspaceId = c.get("principal").workspaceId;
    const records = [];
    let accepted = 0;
    let deduplicated = 0;

    for (const event of body.events) {
      const outcome = await deps.store.recordFeedback({
        workspaceId,
        inferenceId: event.inference_id ?? null,
        sessionId: event.session_id ?? null,
        deploymentName: event.deployment_name ?? null,
        idempotencyKey: event.idempotency_key,
        score: event.score ?? null,
        expectedOutput: event.expected_output,
        metrics: event.metrics ?? {},
      });
      records.push(outcome.record);
      if (outcome.deduplicated) deduplicated += 1;
      else accepted += 1;
    }

    return c.json({ accepted, deduplicated, records }, 200);
  });
};
