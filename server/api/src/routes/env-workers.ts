import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";

import {
  EnvTaskDispatchSchema,
  EnvTaskResultSchema,
  EnvWorkerRegisterSchema,
  SlugSchema,
} from "../contracts.js";
import {
  defaultErrors,
  jsonResponse,
  requireScope,
  respondProblem,
  type AppEnv,
} from "./helpers.js";
import type { AppDependencies } from "../deps.js";

export const registerEnvWorkerRoutes = (
  app: OpenAPIHono<AppEnv>,
  deps: AppDependencies,
): void => {
  const registerEnvWorkerRoute = createRoute({
    method: "post",
    path: "/v1/env-workers/register",
    operationId: "registerEnvWorker",
    summary: "Register or heartbeat an outbound `grad env serve` worker",
    tags: ["Environments"],
    "x-internal": true,
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: EnvWorkerRegisterSchema } },
      },
    },
    responses: {
      200: jsonResponse(
        z.object({
          name: SlugSchema,
          worker_id: z.string(),
          concurrency: z.number().int(),
          last_heartbeat_at: z.string(),
        }),
        "Registered environment worker.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(registerEnvWorkerRoute, (c) => {
    requireScope(c, "env:serve");

    const body = c.req.valid("json");
    const worker = deps.envHub.register(
      c.get("principal").workspaceId,
      body.name,
      body.worker_id,
      body.concurrency,
    );

    return c.json(worker, 200);
  });

  const dispatchEnvTaskRoute = createRoute({
    method: "post",
    path: "/v1/env-workers/tasks",
    operationId: "dispatchEnvTask",
    summary:
      "Dispatch an evaluation or rollout task to a connected `grad env serve` worker",
    tags: ["Environments"],
    "x-internal": true,
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: EnvTaskDispatchSchema } },
      },
    },
    responses: {
      202: jsonResponse(
        z.object({
          id: z.string(),
          env_name: SlugSchema,
          status: z.string(),
          active_workers: z.number().int().min(0),
        }),
        "Queued environment task.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(dispatchEnvTaskRoute, (c) => {
    requireScope(c, "runs:write");

    const body = c.req.valid("json");
    const workspaceId = c.get("principal").workspaceId;
    const task = deps.envHub.dispatch({
      workspaceId,
      envName: body.env_name,
      task: body.task,
      modelId: body.model_id,
      ...(body.system_prompt ? { systemPrompt: body.system_prompt } : {}),
      timeoutS: body.timeout_s,
    });
    const activeWorkers = deps.envHub.listActiveWorkers(
      workspaceId,
      body.env_name,
    ).length;

    return c.json(
      {
        id: task.id,
        env_name: task.env_name,
        status: task.status,
        active_workers: activeWorkers,
      },
      202,
    );
  });

  const claimEnvTaskRoute = createRoute({
    method: "post",
    path: "/v1/env-workers/{name}/claim",
    operationId: "claimEnvTask",
    summary:
      "Long-poll for the next task assigned to a `grad env serve` worker",
    tags: ["Environments"],
    "x-internal": true,
    request: {
      params: z.object({ name: SlugSchema }),
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              worker_id: z.string().min(1),
              wait_ms: z.number().int().min(0).max(30_000).default(0),
            }),
          },
        },
      },
    },
    responses: {
      200: jsonResponse(
        z.object({
          task: z.record(z.string(), z.unknown()).nullable(),
        }),
        "Claimed environment task or null.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(claimEnvTaskRoute, async (c) => {
    requireScope(c, "env:serve");

    const { name } = c.req.valid("param");
    const body = c.req.valid("json");
    const claimed = await deps.envHub.claim(
      c.get("principal").workspaceId,
      name,
      body.worker_id,
      body.wait_ms,
      c.req.raw.signal,
    );

    return c.json(
      { task: claimed as unknown as Record<string, unknown> | null },
      200,
    );
  });

  const completeEnvTaskRoute = createRoute({
    method: "post",
    path: "/v1/env-workers/tasks/{id}/complete",
    operationId: "completeEnvTask",
    summary: "Submit scored trajectory output for an environment task",
    tags: ["Environments"],
    "x-internal": true,
    request: {
      params: z.object({ id: z.string().min(1) }),
      body: {
        required: true,
        content: { "application/json": { schema: EnvTaskResultSchema } },
      },
    },
    responses: {
      200: jsonResponse(
        z.record(z.string(), z.unknown()),
        "Completed environment task.",
      ),
      ...defaultErrors,
    },
  });

  app.openapi(completeEnvTaskRoute, (c) => {
    requireScope(c, "env:serve");

    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const completed = deps.envHub.complete(
      c.get("principal").workspaceId,
      id,
      body,
    );
    if (!completed) {
      return respondProblem(
        c,
        404,
        "env_task_not_found",
        "Environment task not found",
        `Environment task '${id}' was not found.`,
      );
    }

    return c.json(completed as unknown as Record<string, unknown>, 200);
  });

  const getEnvTaskRoute = createRoute({
    method: "get",
    path: "/v1/env-workers/tasks/{id}",
    operationId: "getEnvTask",
    summary: "Inspect an environment task and its result",
    tags: ["Environments"],
    "x-internal": true,
    request: { params: z.object({ id: z.string().min(1) }) },
    responses: {
      200: jsonResponse(z.record(z.string(), z.unknown()), "Environment task."),
      ...defaultErrors,
    },
  });

  app.openapi(getEnvTaskRoute, (c) => {
    requireScope(c, "runs:read");

    const { id } = c.req.valid("param");
    const task = deps.envHub.getTask(c.get("principal").workspaceId, id);
    if (!task) {
      return respondProblem(
        c,
        404,
        "env_task_not_found",
        "Environment task not found",
        `Environment task '${id}' was not found.`,
      );
    }

    return c.json(task as unknown as Record<string, unknown>, 200);
  });
};
