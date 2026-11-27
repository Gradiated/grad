import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";

import {
  pageOf,
  UsageQuerySchema,
  UsageRecordSchema,
  UsageSummaryQuerySchema,
  UsageSummarySchema,
} from "../contracts.js";
import type { Services } from "../services/index.js";
import {
  defaultErrors,
  jsonResponse,
  workspaceOf,
  type AppEnv,
} from "./helpers.js";

export const registerUsageRoutes = (
  app: OpenAPIHono<AppEnv>,
  services: Services,
): void => {
  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/usage",
      operationId: "listUsage",
      summary:
        "List billed usage, newest first (filter by period, run, eval or kind): one record per billed increment of a run or eval attempt",
      tags: ["Usage"],
      request: { query: UsageQuerySchema },
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

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/usage/summary",
      operationId: "getUsageSummary",
      summary:
        "Total cost and tokens over a period (default: this UTC month), by kind, the top runs and evals, and optional groups",
      tags: ["Usage"],
      request: { query: UsageSummaryQuerySchema },
      responses: {
        200: jsonResponse(UsageSummarySchema, "Usage summary."),
        ...defaultErrors,
      },
    }),
    async (c) => {
      const ws = workspaceOf(c, "runs:read");

      return c.json(
        await services.usage.summary(ws, c.req.valid("query")),
        200,
      );
    },
  );
};
