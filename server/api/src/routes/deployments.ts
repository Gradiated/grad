import {
  createRoute,
  type OpenAPIHono,
  type RouteConfig,
  z,
} from "@hono/zod-openapi";

import {
  DEPLOY_DISABLED_DETAIL,
  INFERENCE_DISABLED_DETAIL,
} from "../adapters.js";
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
  UsageRecordSchema,
  pageOf,
} from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { ApiError } from "../errors.js";
import type { Services } from "../services/index.js";
import {
  defaultErrors,
  jsonResponse,
  notImplementedError,
  workspaceOf,
  type AppEnv,
} from "./helpers.js";

const NameParamSchema = z.object({ name: SlugSchema });

const CLOUD_NOTE =
  " Served by Gradiated Cloud (api.gradiated.com); grad-server answers 501.";

const jsonBody = <T extends z.ZodType>(schema: T) => ({
  body: { required: true, content: { "application/json": { schema } } },
});

/**
 * Paths served by Gradiated Cloud (the product API and the inference
 * gateway), documented here so the SDKs stay typed against them. grad-server
 * keeps no serving state and answers 501 with what to do instead.
 */
const cloudOnly = (
  app: OpenAPIHono<AppEnv>,
  route: Omit<RouteConfig, "responses"> & {
    summary: string;
    ok: ReturnType<typeof jsonResponse>;
  },
  code: "deploy_unavailable" | "inference_unavailable",
): void => {
  const { ok, summary, ...rest } = route;
  app.openapi(
    createRoute({
      ...rest,
      summary,
      description: `${summary}.${CLOUD_NOTE}`,
      responses: { 200: ok, ...notImplementedError, ...defaultErrors },
    }),
    () => {
      throw new ApiError(
        501,
        code,
        code === "deploy_unavailable"
          ? "Deployments are served by Gradiated Cloud"
          : "Inference is served by Gradiated Cloud",
        code === "deploy_unavailable"
          ? DEPLOY_DISABLED_DETAIL
          : INFERENCE_DISABLED_DETAIL,
      );
    },
  );
};

export const registerDeploymentRoutes = (
  app: OpenAPIHono<AppEnv>,
  _deps: AppDependencies,
  services: Services,
): void => {
  cloudOnly(
    app,
    {
      method: "post",
      path: "/v1/deployments",
      operationId: "deployArtifact",
      summary: "Deploy or update an artifact under a stable model name",
      tags: ["Deployments"],
      request: jsonBody(DeployArtifactRequestSchema),
      ok: jsonResponse(DeploymentSchema, "Active deployment."),
    },
    "deploy_unavailable",
  );
  cloudOnly(
    app,
    {
      method: "get",
      path: "/v1/deployments",
      operationId: "listDeployments",
      summary: "List deployments",
      tags: ["Deployments"],
      request: { query: PageQuerySchema },
      ok: jsonResponse(pageOf(DeploymentSchema), "Deployments."),
    },
    "deploy_unavailable",
  );
  cloudOnly(
    app,
    {
      method: "get",
      path: "/v1/deployments/{name}",
      operationId: "getDeployment",
      summary: "Get deployment status and feedback summary",
      tags: ["Deployments"],
      request: { params: NameParamSchema },
      ok: jsonResponse(DeploymentStatusSchema, "Deployment status."),
    },
    "deploy_unavailable",
  );
  cloudOnly(
    app,
    {
      method: "post",
      path: "/v1/deployments/{name}/rollback",
      operationId: "rollbackDeployment",
      summary: "Roll a deployment back to its previous artifact",
      tags: ["Deployments"],
      request: { params: NameParamSchema },
      ok: jsonResponse(DeploymentSchema, "Rolled-back deployment."),
    },
    "deploy_unavailable",
  );
  cloudOnly(
    app,
    {
      method: "post",
      path: "/v1/route",
      operationId: "routeRequest",
      summary: "Ask a deployed model router which model to call",
      tags: ["Serving"],
      request: jsonBody(RouteRequestSchema),
      ok: jsonResponse(RouteResponseSchema, "Routing decision."),
    },
    "inference_unavailable",
  );
  cloudOnly(
    app,
    {
      method: "post",
      path: "/v1/embeddings",
      operationId: "createEmbeddings",
      summary: "Generate embeddings from a deployed embedding artifact",
      tags: ["Serving"],
      request: jsonBody(EmbedRequestSchema),
      ok: jsonResponse(EmbedResponseSchema, "Embeddings."),
    },
    "inference_unavailable",
  );
  cloudOnly(
    app,
    {
      method: "post",
      path: "/v1/feedback",
      operationId: "recordFeedback",
      summary: "Record deduplicated outcome scores and gold corrections",
      tags: ["Feedback"],
      request: jsonBody(RecordFeedbackRequestSchema),
      ok: jsonResponse(RecordFeedbackResponseSchema, "Recorded feedback."),
    },
    "inference_unavailable",
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/usage",
      operationId: "listUsage",
      summary:
        "List billed usage, newest first: one record per run or eval attempt",
      tags: ["Usage"],
      request: { query: PageQuerySchema },
      responses: {
        200: jsonResponse(pageOf(UsageRecordSchema), "Usage records."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const ws = workspaceOf(c, "runs:read");

      return c.json(await services.usage.list(ws, c.req.valid("query")), 200);
    },
  );
};
