import { z } from "@hono/zod-openapi";

import { SlugSchema } from "./common.js";

export const EnvWorkerRegisterSchema = z
  .object({
    name: SlugSchema,
    worker_id: z.string().min(1).max(160),
    concurrency: z.number().int().min(1).max(512).default(4),
  })
  .openapi("EnvWorkerRegister");

export const EnvTaskDispatchSchema = z
  .object({
    env_name: SlugSchema,
    task: z.record(z.string(), z.unknown()),
    model_id: z.string().min(1),
    system_prompt: z.string().optional(),
    timeout_s: z.number().int().min(1).max(3600).default(120),
  })
  .openapi("EnvTaskDispatch");

export const EnvTaskResultSchema = z
  .object({
    worker_id: z.string().min(1),
    score: z.number().nullable().optional(),
    scores: z.record(z.string(), z.number()).default({}),
    trajectory: z.record(z.string(), z.unknown()).optional(),
    error: z.string().max(4000).optional(),
  })
  .openapi("EnvTaskResult");
