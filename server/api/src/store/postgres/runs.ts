import type { Clock } from "../../clock.js";
import type {
  ImportJobRecord,
  ImportJobRepository,
  RunRecord,
  RunRepository,
} from "../types.js";
import type { Db } from "./db.js";
import { createJobBackedRepository } from "./jobs.js";
import {
  toImportPayload,
  toJob,
  toRunDomain,
  toRunEventsView,
} from "./mappers.js";

/** The latest event of a type (and key) as `<prefix>_*` columns. */
const latestEvent = (prefix: string, where: string) =>
  `LEFT JOIN LATERAL (
     SELECT e.seq AS ${prefix}_seq, e.attempt AS ${prefix}_attempt, e.type AS ${prefix}_type,
            e.step AS ${prefix}_step, e.payload AS ${prefix}_payload, e.created_at AS ${prefix}_at
     FROM grad_job_events e WHERE e.job_id = grad_jobs.id AND ${where}
     ORDER BY e.seq DESC LIMIT 1) ${prefix} ON true`;

/** Runs with their latest phase and interruption (index: job, type, seq). */
const RUNS_FROM = `grad_jobs JOIN grad_runs USING (id)
  ${latestEvent("ph", "e.type = 'phase'")}
  ${latestEvent("it", "e.type = 'attempt' AND e.key = 'interrupted'")}`;

export const createRunRepository = (db: Db, clock: Clock): RunRepository => {
  const repo = createJobBackedRepository<RunRecord>(db, clock, {
    kind: "train",
    table: "grad_runs",
    from: RUNS_FROM,
    types: {
      json: new Set([
        "latest_metric",
        "eval_report",
        "resolved_config",
        "checkpoint_evals",
      ]),
      timestamps: new Set(),
    },
    map: (row) => ({
      ...toJob(row),
      ...toRunDomain(row),
      ...toRunEventsView(row),
    }),
  });

  return {
    get: repo.get,
    getById: repo.getById,
    list: repo.list,
    listActiveByName: (workspaceId, name, limit) =>
      repo.findAll(
        "workspace_id = $1 AND name = $2 AND status IN ('queued', 'running')",
        [workspaceId, name],
        limit,
      ),
    update: repo.update,
    appendCheckpointEval: async (id, result) => {
      // The job row's lock first, like every run write (grad_jobs, then
      // grad_runs): an eval's finalize records this and a job event in one
      // transaction, and the opposite order deadlocks the run's progress.
      await db.query(
        `UPDATE grad_runs r SET checkpoint_evals = r.checkpoint_evals || $2::jsonb
         FROM (SELECT id FROM grad_jobs WHERE id = $1 FOR NO KEY UPDATE) j
         WHERE r.id = j.id AND NOT r.checkpoint_evals @> $3::jsonb`,
        [
          id,
          JSON.stringify([result]),
          JSON.stringify([
            { eval_id: result.eval_id, step: result.step, name: result.name },
          ]),
        ],
      );
    },
    create: (input) =>
      repo.insert(
        {
          kind: "train",
          workspaceId: input.workspaceId,
          maxAttempts: input.maxAttempts,
          maxQueued: input.maxQueued,
          minGpuMemoryGb: input.minGpuMemoryGb,
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
          price_version: input.priceVersion ?? null,
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
    list: (workspaceId, page) =>
      repo.list(workspaceId, page, "NOT (payload ? 'artifact')"),
    update: repo.update,
    createArtifactImport: (input) =>
      repo.insert(
        {
          kind: "import",
          workspaceId: input.workspaceId,
          maxAttempts: input.maxAttempts,
          idempotency: input.idempotency,
          payload: {
            artifact: input.artifact,
            upload_key: input.uploadKey,
          },
        },
        null,
      ),
    create: (input) =>
      repo.insert(
        {
          kind: "import",
          workspaceId: input.workspaceId,
          maxAttempts: input.maxAttempts,
          maxQueued: input.maxQueued,
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
