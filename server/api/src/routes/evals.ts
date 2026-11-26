import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import {
  EvalRunSchema,
  EvalTaskOutcomeSchema,
  PlanEvalRequestSchema,
  PlanEvalResponseSchema,
  type DatasetRecord,
} from "../contracts.js";
import { planEval, runDeterministicEval } from "../evals.js";
import {
  defaultErrors,
  jsonResponse,
  readDatasetRecords,
  requireScope,
  respondProblem,
  type AppDependencies,
  type AppEnv,
} from "./helpers.js";

export const registerEvalRoutes = (
  app: OpenAPIHono<AppEnv>,
  deps: AppDependencies,
): void => {
  const planEvalRoute = createRoute({
    method: "post",
    path: "/v1/evals/plan",
    operationId: "planEval",
    summary:
      "Estimate tasks, model/judge calls, and cost before running an eval",
    tags: ["Evals"],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: PlanEvalRequestSchema } },
      },
    },
    responses: {
      200: jsonResponse(PlanEvalResponseSchema, "Estimated eval plan."),
      ...defaultErrors,
    },
  });

  app.openapi(planEvalRoute, async (c) => {
    const denied = requireScope(c, "runs:read");
    if (denied) return denied;

    const body = c.req.valid("json");
    const workspaceId = c.get("principal").workspaceId;
    let records: DatasetRecord[] = [];
    if (body.dataset) {
      const ds = await deps.store.getDataset(workspaceId, body.dataset);
      if (!ds) {
        return respondProblem(
          c,
          404,
          "dataset_not_found",
          "Dataset not found",
          `Dataset '${body.dataset}' was not found.`,
        );
      }
      records = await readDatasetRecords(deps.storage, ds.storage_key);
    }

    try {
      const plan = planEval(body, records);

      return c.json(plan, 200);
    } catch (error) {
      return respondProblem(
        c,
        422,
        "eval_plan_error",
        "Invalid evaluation configuration",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  const createEvalRoute = createRoute({
    method: "post",
    path: "/v1/evals",
    operationId: "createEval",
    summary: "Run a standalone evaluation across models, tasks, and a rubric",
    tags: ["Evals"],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: PlanEvalRequestSchema } },
      },
    },
    responses: {
      201: jsonResponse(EvalRunSchema, "Completed evaluation run."),
      ...defaultErrors,
    },
  });

  app.openapi(createEvalRoute, async (c) => {
    const denied = requireScope(c, "runs:write");
    if (denied) return denied;

    const body = c.req.valid("json");
    const workspaceId = c.get("principal").workspaceId;
    let records: DatasetRecord[] = [];
    if (body.dataset) {
      const ds = await deps.store.getDataset(workspaceId, body.dataset);
      if (!ds) {
        return respondProblem(
          c,
          404,
          "dataset_not_found",
          "Dataset not found",
          `Dataset '${body.dataset}' was not found.`,
        );
      }
      records = await readDatasetRecords(deps.storage, ds.storage_key);
    }

    let outcome;
    try {
      outcome = runDeterministicEval(body, records);
    } catch (error) {
      return respondProblem(
        c,
        422,
        "eval_error",
        "Invalid evaluation configuration",
        error instanceof Error ? error.message : String(error),
      );
    }

    const evalRun = await deps.store.createEval({
      workspaceId,
      name: body.name,
      models: body.models,
      baseline: body.baseline ?? null,
      taskSource: outcome.task_source,
      rubric: body.rubric,
      samples: body.samples,
      passThreshold: body.pass_threshold,
      judgeModels: outcome.judge_models,
      summary: outcome.summary,
      results: outcome.results,
      totalCostUsd: outcome.total_cost_usd,
    });

    return c.json(evalRun, 201);
  });

  const listEvalsRoute = createRoute({
    method: "get",
    path: "/v1/evals",
    operationId: "listEvals",
    summary: "List evaluation runs",
    tags: ["Evals"],
    responses: {
      200: jsonResponse(
        z.object({ data: z.array(EvalRunSchema) }),
        "Evaluation runs.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(listEvalsRoute, async (c) => {
    const denied = requireScope(c, "runs:read");
    if (denied) return denied;

    const data = await deps.store.listEvals(c.get("principal").workspaceId);

    return c.json({ data }, 200);
  });

  const getEvalRoute = createRoute({
    method: "get",
    path: "/v1/evals/{id}",
    operationId: "getEval",
    summary: "Get an evaluation run by ID",
    tags: ["Evals"],
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: {
      200: jsonResponse(EvalRunSchema, "Evaluation run."),
      ...defaultErrors,
    },
  });

  app.openapi(getEvalRoute, async (c) => {
    const denied = requireScope(c, "runs:read");
    if (denied) return denied;

    const { id } = c.req.valid("param");
    const evalRun = await deps.store.getEval(
      c.get("principal").workspaceId,
      id,
    );
    if (!evalRun) {
      return respondProblem(
        c,
        404,
        "eval_not_found",
        "Eval not found",
        `Eval '${id}' was not found.`,
      );
    }

    return c.json(evalRun, 200);
  });

  const listEvalFailuresRoute = createRoute({
    method: "get",
    path: "/v1/evals/{id}/failures",
    operationId: "listEvalFailures",
    summary: "List failing task records from an evaluation run for mining",
    tags: ["Evals"],
    request: {
      params: z.object({ id: z.string().min(1) }),
      query: z.object({
        model: z.string().optional(),
        threshold: z.coerce.number().min(0).max(1).default(0.8),
      }),
    },
    responses: {
      200: jsonResponse(
        z.object({
          eval_id: z.string(),
          data: z.array(EvalTaskOutcomeSchema),
        }),
        "Failing task outcomes.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(listEvalFailuresRoute, async (c) => {
    const denied = requireScope(c, "runs:read");
    if (denied) return denied;

    const { id } = c.req.valid("param");
    const { model, threshold } = c.req.valid("query");
    const evalRun = await deps.store.getEval(
      c.get("principal").workspaceId,
      id,
    );
    if (!evalRun) {
      return respondProblem(
        c,
        404,
        "eval_not_found",
        "Eval not found",
        `Eval '${id}' was not found.`,
      );
    }

    const failures = evalRun.results.filter(
      (item) => item.score < threshold && (!model || item.model === model),
    );

    return c.json({ eval_id: evalRun.id, data: failures }, 200);
  });
};
