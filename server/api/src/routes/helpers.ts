import type { Context } from "hono";
import { z } from "@hono/zod-openapi";

import {
  hasScope,
  type AuthAdapter,
  type AuthPrincipal,
  type BillingAdapter,
  type DeployAdapter,
} from "../adapters.js";
import {
  DatasetRecordSchema,
  ProblemSchema,
  type ApiKeyScope,
  type ArtifactFormat,
  type DatasetRecord,
} from "../contracts.js";
import type { EnvWorkerHub } from "../env-hub.js";
import type { ObjectStore } from "../storage.js";
import type { TrainingStore } from "../store.js";

export interface AppDependencies {
  store: TrainingStore;
  storage: ObjectStore;
  auth: AuthAdapter;
  billing: BillingAdapter;
  deploy: DeployAdapter;
  envHub: EnvWorkerHub;
  allowWave2Recipes?: boolean;
}

export type AppEnv = {
  Variables: {
    principal: AuthPrincipal;
    requestId: string;
  };
};

export const problemContent = {
  "application/problem+json": { schema: ProblemSchema },
} as const;

export const jsonResponse = <T extends z.ZodType>(
  schema: T,
  description: string,
) => ({
  description,
  content: { "application/json": { schema } },
});

export const defaultErrors = {
  400: { description: "Bad request.", content: problemContent },
  401: { description: "Authentication required.", content: problemContent },
  403: { description: "Insufficient scope.", content: problemContent },
  404: { description: "Resource not found.", content: problemContent },
  409: { description: "Conflict.", content: problemContent },
  422: { description: "Validation failed.", content: problemContent },
};

export const respondProblem = <
  S extends 400 | 401 | 403 | 404 | 409 | 413 | 422 | 501 | 503,
>(
  c: Context<AppEnv>,
  status: S,
  code: string,
  title: string,
  detail: string,
) =>
  c.json(
    {
      type: `https://gradiated.com/problems/${code}`,
      title,
      status,
      detail,
      code,
      request_id: c.get("requestId") ?? "req_unknown",
    },
    status,
    { "Content-Type": "application/problem+json" },
  );

export const requireScope = (c: Context<AppEnv>, scope: ApiKeyScope) => {
  const principal = c.get("principal");
  if (!hasScope(principal, scope)) {
    return respondProblem(
      c,
      403,
      "forbidden",
      "Insufficient scope",
      `This endpoint requires the '${scope}' scope.`,
    );
  }

  return null;
};

export const readDatasetRecords = async (
  storage: ObjectStore,
  storageKey: string,
): Promise<DatasetRecord[]> => {
  const bytes = await storage.get(storageKey);
  const text = Buffer.from(bytes).toString("utf8").trim();
  if (!text) return [];

  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => DatasetRecordSchema.parse(JSON.parse(line)));
};

export const writeDatasetRecords = async (
  storage: ObjectStore,
  storageKey: string,
  records: readonly DatasetRecord[],
): Promise<void> => {
  const jsonl = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;

  await storage.put(storageKey, Buffer.from(jsonl, "utf8"));
};

export const defaultFormatForRecipe = (recipeKind: string): ArtifactFormat => {
  switch (recipeKind) {
    case "cartridge":
      return "cartridge";
    case "embedding":
      return "encoder_safetensors";
    case "router":
      return "router_bundle";
    case "decision":
      return "decision_bundle";
    default:
      return "peft_lora";
  }
};
