import type { Clock } from "../../clock.js";
import type {
  ImportJobRecord,
  ImportJobRepository,
  RunRecord,
  RunRepository,
} from "../types.js";
import type { Db } from "./db.js";
import { createJobBackedRepository } from "./jobs.js";
import { toImportPayload, toJob, toRunDomain } from "./mappers.js";

export const createRunRepository = (db: Db, clock: Clock): RunRepository => {
  const repo = createJobBackedRepository<RunRecord>(db, clock, {
    kind: "train",
    table: "grad_runs",
    types: {
      json: new Set(["latest_metric", "eval_report", "resolved_config"]),
      timestamps: new Set(),
    },
    map: (row) => ({ ...toJob(row), ...toRunDomain(row) }),
  });

  return {
    get: repo.get,
    getById: repo.getById,
    list: repo.list,
    update: repo.update,
    create: (input) =>
      repo.insert(
        {
          prefix: "run",
          kind: "train",
          workspaceId: input.workspaceId,
          maxAttempts: input.maxAttempts,
          waitingOn: input.waitingOn,
          idempotency: input.idempotency,
        },
        {
          name: input.name,
          dataset_id: input.datasetId,
          dataset_name: input.datasetName,
          dataset_version: input.datasetVersion,
          recipe_kind: input.recipeKind,
          resolved_config: input.resolvedConfig,
          max_cost_usd: input.maxCostUsd,
          price_per_million_tokens: input.pricePerMillionTokens,
          total_steps: input.totalSteps,
        },
      ),
  };
};

export const createImportJobRepository = (
  db: Db,
  clock: Clock,
): ImportJobRepository => {
  const repo = createJobBackedRepository<ImportJobRecord>(db, clock, {
    kind: "import",
    table: null,
    types: { json: new Set(), timestamps: new Set() },
    map: (row) => ({ ...toJob(row), ...toImportPayload(row) }),
  });

  return {
    get: repo.get,
    getById: repo.getById,
    findByUpload: (datasetId, sha256) =>
      repo.find(
        "payload->>'dataset_id' = $1 AND payload->'source'->>'sha256' = $2 AND payload->'source'->>'kind' = 'upload'",
        [datasetId, sha256],
      ),
    list: repo.list,
    update: repo.update,
    create: (input) =>
      repo.insert(
        {
          prefix: "imp",
          kind: "import",
          workspaceId: input.workspaceId,
          maxAttempts: input.maxAttempts,
          idempotency: input.idempotency,
          payload: {
            dataset_id: input.datasetId,
            dataset: input.datasetName,
            source: input.source,
            connector: input.connector,
            upload_key: input.uploadKey,
            imported_count: 0,
            dropped_count: 0,
            detected_scores: [],
            drop_reasons: [],
            dataset_version: null,
          },
        },
        null,
      ),
  };
};
