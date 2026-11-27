import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import {
  EvalOutputSchema,
  EvalRunSchema,
  EvalTaskOutcomeSchema,
  NextCursorSchema,
  PageQuerySchema,
  pageOf,
  PlanEvalRequestSchema,
  PlanEvalResponseSchema,
  PostEvalScoresRequestSchema,
  PostEvalScoresResponseSchema,
} from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import type { Services } from "../services/index.js";
import {
  defaultErrors,
  IdParamSchema,
  jsonResponse,
  notImplementedError,
  workspaceOf,
  type AppEnv,
} from "./helpers.js";

const jsonBody = <T extends z.ZodType>(schema: T) => ({
  body: {
    required: true,
    content: { "application/json": { schema } },
  },
});

const ModelFilterSchema = z.string().min(1).max(200).optional();

export const registerEvalRoutes = (
  app: OpenAPIHono<AppEnv>,
  _deps: AppDependencies,
  services: Services,
): void => {
  const evals = services.evals;

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/evals/plan",
      operationId: "planEval",
      summary:
        "Estimate tasks, model/judge calls, and cost before running an eval",
      tags: ["Evals"],
      request: jsonBody(PlanEvalRequestSchema),
      responses: {
        200: jsonResponse(PlanEvalResponseSchema, "Estimated eval plan."),
        ...defaultErrors,
        ...notImplementedError,
      },
    }),
    async (c) =>
      c.json(
        await evals.plan(workspaceOf(c, "runs:read"), c.req.valid("json")),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/evals",
      operationId: "createEval",
      summary:
        "Queue an evaluation across models on a pinned dataset version (executed by the server)",
      tags: ["Evals"],
      request: jsonBody(PlanEvalRequestSchema),
      responses: {
        202: jsonResponse(EvalRunSchema, "Queued evaluation run."),
        ...defaultErrors,
        ...notImplementedError,
      },
    }),
    async (c) =>
      c.json(
        await evals.create(workspaceOf(c, "runs:write"), c.req.valid("json")),
        202,
      ),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/evals",
      operationId: "listEvals",
      summary: "List evaluation runs",
      tags: ["Evals"],
      request: { query: PageQuerySchema },
      responses: {
        200: jsonResponse(pageOf(EvalRunSchema), "Evaluation runs."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const { limit, cursor } = c.req.valid("query");

      return c.json(
        await evals.list(workspaceOf(c, "runs:read"), { limit, cursor }),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/evals/{id}",
      operationId: "getEval",
      summary: "Get an evaluation run by ID",
      tags: ["Evals"],
      request: { params: IdParamSchema },
      responses: {
        200: jsonResponse(EvalRunSchema, "Evaluation run."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await evals.get(workspaceOf(c, "runs:read"), c.req.valid("param").id),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/evals/{id}/outputs",
      operationId: "listEvalOutputs",
      summary:
        "Page through generated model outputs (filter by model or by a code scorer that still needs a score)",
      tags: ["Evals"],
      request: {
        params: IdParamSchema,
        query: PageQuerySchema.extend({
          model: ModelFilterSchema,
          missing_scorer: z.string().min(1).max(80).optional(),
        }),
      },
      responses: {
        200: jsonResponse(pageOf(EvalOutputSchema), "Eval outputs."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const query = c.req.valid("query");

      return c.json(
        await evals.listOutputs(
          workspaceOf(c, "runs:read"),
          c.req.valid("param").id,
          {
            limit: query.limit,
            cursor: query.cursor,
            model: query.model,
            missingScorer: query.missing_scorer,
          },
        ),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/evals/{id}/scores",
      operationId: "postEvalScores",
      summary:
        "Post scores computed by local (SDK-side) code scorers; the eval completes when none are missing",
      tags: ["Evals"],
      request: {
        params: IdParamSchema,
        ...jsonBody(PostEvalScoresRequestSchema),
      },
      responses: {
        200: jsonResponse(PostEvalScoresResponseSchema, "Accepted scores."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await evals.postScores(
          workspaceOf(c, "runs:write"),
          c.req.valid("param").id,
          c.req.valid("json").scores,
        ),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/evals/{id}/results",
      operationId: "listEvalResults",
      summary: "Per-task, per-model results of a completed evaluation",
      tags: ["Evals"],
      request: {
        params: IdParamSchema,
        query: PageQuerySchema.extend({ model: ModelFilterSchema }),
      },
      responses: {
        200: jsonResponse(pageOf(EvalTaskOutcomeSchema), "Task outcomes."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const query = c.req.valid("query");

      return c.json(
        await evals.listResults(
          workspaceOf(c, "runs:read"),
          c.req.valid("param").id,
          {
            limit: query.limit,
            cursor: query.cursor,
            model: query.model,
          },
        ),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/evals/{id}/failures",
      operationId: "listEvalFailures",
      summary: "List failing task records from an evaluation run for mining",
      tags: ["Evals"],
      request: {
        params: IdParamSchema,
        query: PageQuerySchema.extend({
          model: ModelFilterSchema,
          threshold: z.coerce.number().min(0).max(1).optional(),
        }),
      },
      responses: {
        200: jsonResponse(
          z.object({
            eval_id: z.string(),
            data: z.array(EvalTaskOutcomeSchema),
            next_cursor: NextCursorSchema,
          }),
          "Failing task outcomes.",
        ),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const query = c.req.valid("query");
      const page = await evals.listFailures(workspaceOf(c, "runs:read"), id, {
        limit: query.limit,
        cursor: query.cursor,
        model: query.model,
        threshold: query.threshold,
      });

      return c.json({ eval_id: id, ...page }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/evals/{id}/cancel",
      operationId: "cancelEval",
      summary: "Cancel a queued, running or awaiting_scores evaluation",
      tags: ["Evals"],
      request: { params: IdParamSchema },
      responses: {
        200: jsonResponse(EvalRunSchema, "Cancelled evaluation run."),
        ...defaultErrors,
      },
    }),
    async (c) =>
      c.json(
        await evals.cancel(
          workspaceOf(c, "runs:write"),
          c.req.valid("param").id,
        ),
        200,
      ),
  );
};
