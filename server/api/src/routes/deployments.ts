import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import {
  DeployArtifactRequestSchema,
  DeploymentSchema,
  DeploymentStatusSchema,
  EmbedRequestSchema,
  EmbedResponseSchema,
  PageQuerySchema,
  RecordFeedbackRequestSchema,
  RecordFeedbackResponseSchema,
  RouteRequestSchema,
  RouteResponseSchema,
  SlugSchema,
  pageOf,
} from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import type { Services } from "../services/index.js";
import {
  defaultErrors,
  jsonResponse,
  notImplementedError,
  workspaceOf,
  type AppEnv,
} from "./helpers.js";

const NameParamSchema = z.object({ name: SlugSchema });

const jsonBody = <T extends z.ZodType>(schema: T) => ({
  body: {
    required: true,
    content: { "application/json": { schema } },
  },
});

export const registerDeploymentRoutes = (
  app: OpenAPIHono<AppEnv>,
  _deps: AppDependencies,
  services: Services,
): void => {
  const { serving } = services;

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/deployments",
      operationId: "deployArtifact",
      summary: "Deploy or update an artifact under a stable model name",
      tags: ["Deployments"],
      request: jsonBody(DeployArtifactRequestSchema),
      responses: {
        200: jsonResponse(DeploymentSchema, "Active deployment."),
        ...notImplementedError,
        ...defaultErrors,
      },
    }),
    async (c) => {
      const ws = workspaceOf(c, "deployments:write");
      const deployment = await serving.deploy(
        ws,
        c.req.valid("json"),
        c.req.header("idempotency-key"),
      );

      return c.json(deployment, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/deployments",
      operationId: "listDeployments",
      summary: "List deployments",
      tags: ["Deployments"],
      request: { query: PageQuerySchema },
      responses: {
        200: jsonResponse(pageOf(DeploymentSchema), "Deployments."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const ws = workspaceOf(c, "artifacts:read");
      const page = await serving.list(ws, c.req.valid("query"));

      return c.json(page, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/deployments/{name}",
      operationId: "getDeployment",
      summary: "Get deployment status and feedback summary",
      tags: ["Deployments"],
      request: { params: NameParamSchema },
      responses: {
        200: jsonResponse(DeploymentStatusSchema, "Deployment status."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const ws = workspaceOf(c, "artifacts:read");
      const status = await serving.get(ws, c.req.valid("param").name);

      return c.json(status, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/deployments/{name}/rollback",
      operationId: "rollbackDeployment",
      summary: "Roll a deployment back to its previous artifact",
      tags: ["Deployments"],
      request: { params: NameParamSchema },
      responses: {
        200: jsonResponse(DeploymentSchema, "Rolled-back deployment."),
        ...notImplementedError,
        ...defaultErrors,
      },
    }),
    async (c) => {
      const ws = workspaceOf(c, "deployments:write");
      const deployment = await serving.rollback(
        ws,
        c.req.valid("param").name,
        c.req.header("idempotency-key"),
      );

      return c.json(deployment, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/route",
      operationId: "routeRequest",
      summary: "Ask a deployed model router which model to call",
      tags: ["Serving"],
      request: jsonBody(RouteRequestSchema),
      responses: {
        200: jsonResponse(RouteResponseSchema, "Routing decision."),
        ...notImplementedError,
        ...defaultErrors,
      },
    }),
    async (c) => {
      const ws = workspaceOf(c, "artifacts:read");
      const decision = await serving.route(ws, c.req.valid("json"));
      c.header("x-gradiated-inference-id", decision.inference_id);

      return c.json(decision, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/embeddings",
      operationId: "createEmbeddings",
      summary: "Generate embeddings from a deployed embedding artifact",
      tags: ["Serving"],
      request: jsonBody(EmbedRequestSchema),
      responses: {
        200: jsonResponse(EmbedResponseSchema, "Embeddings."),
        ...notImplementedError,
        ...defaultErrors,
      },
    }),
    async (c) => {
      const ws = workspaceOf(c, "artifacts:read");
      const result = await serving.embed(ws, c.req.valid("json"));

      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/feedback",
      operationId: "recordFeedback",
      summary: "Record deduplicated outcome scores and gold corrections",
      tags: ["Feedback"],
      request: jsonBody(RecordFeedbackRequestSchema),
      responses: {
        200: jsonResponse(RecordFeedbackResponseSchema, "Recorded feedback."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const ws = workspaceOf(c, "feedback:write");
      const result = await serving.recordFeedback(
        ws,
        c.req.valid("json").events,
      );

      return c.json(result, 200);
    },
  );
};
