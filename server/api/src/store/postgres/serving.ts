import type { Clock } from "../../clock.js";
import { newId } from "../../ids.js";
import type {
  DeploymentRepository,
  FeedbackRepository,
  InferenceRepository,
} from "../types.js";
import { Params, type Db } from "./db.js";
import { toDeployment, toFeedback, toInference } from "./mappers.js";
import { first, listNewest, nowIso } from "./shared.js";

export const createDeploymentRepository = (
  db: Db,
  clock: Clock,
): DeploymentRepository => ({
  get: async (workspaceId, name) => {
    const row = first(
      await db.query(
        "SELECT * FROM grad_deployments WHERE workspace_id = $1 AND name = $2",
        [workspaceId, name],
      ),
    );

    return row ? toDeployment(row) : null;
  },
  list: (workspaceId, page) => {
    const params = new Params();

    return listNewest(db, {
      table: "grad_deployments",
      where: `workspace_id = ${params.add(workspaceId)}`,
      params,
      page,
      map: toDeployment,
    });
  },
  upsert: async (input) => {
    const rows = await db.query(
      `INSERT INTO grad_deployments AS d
         (id, workspace_id, name, model_id, active_artifact_id, previous_artifact_id,
          fallback_model, explore_rate, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, 'active', $8::timestamptz, $8::timestamptz)
       ON CONFLICT (workspace_id, name) DO UPDATE SET
         model_id = EXCLUDED.model_id,
         previous_artifact_id = CASE
           WHEN d.active_artifact_id <> EXCLUDED.active_artifact_id THEN d.active_artifact_id
           ELSE d.previous_artifact_id END,
         active_artifact_id = EXCLUDED.active_artifact_id,
         fallback_model = EXCLUDED.fallback_model,
         explore_rate = EXCLUDED.explore_rate,
         status = 'active',
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        newId("dep"),
        input.workspaceId,
        input.name,
        input.modelId,
        input.activeArtifactId,
        input.fallbackModel,
        input.exploreRate,
        nowIso(clock),
      ],
    );

    return toDeployment(rows[0] ?? {});
  },
  lock: async (workspaceId, name) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `deploy:${workspaceId}:${name}`,
    ]);
  },
});

export const createInferenceRepository = (
  db: Db,
  clock: Clock,
): InferenceRepository => ({
  create: async (input) => {
    const rows = await db.query(
      `INSERT INTO grad_inferences (id, workspace_id, deployment_name, artifact_id, model, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz) RETURNING *`,
      [
        input.id,
        input.workspace_id,
        input.deployment_name,
        input.artifact_id,
        input.model,
        nowIso(clock),
      ],
    );

    return toInference(rows[0] ?? {});
  },
  getMany: async (workspaceId, ids) => {
    if (ids.length === 0) return [];
    const rows = (
      await db.query(
        "SELECT * FROM grad_inferences WHERE workspace_id = $1 AND id = ANY($2::text[])",
        [workspaceId, [...ids]],
      )
    ).map(toInference);
    const byId = new Map(rows.map((r) => [r.id, r]));

    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  },
});

export const createFeedbackRepository = (
  db: Db,
  clock: Clock,
): FeedbackRepository => ({
  insertMany: async (events) => {
    if (events.length === 0) return [];
    const ts = nowIso(clock);
    const pairKey = (ws: string, key: string) => `${ws}\u0000${key}`;
    const firstIndex = new Map<string, number>();
    events.forEach((e, i) => {
      const k = pairKey(e.workspaceId, e.idempotencyKey);
      if (!firstIndex.has(k)) firstIndex.set(k, i);
    });

    const candidates = [...firstIndex.values()].map((i) => {
      const e = events[i]!;
      return {
        id: newId("fb"),
        workspace_id: e.workspaceId,
        inference_id: e.inferenceId,
        session_id: e.sessionId,
        deployment_name: e.deploymentName,
        idempotency_key: e.idempotencyKey,
        score: e.score,
        expected_output: e.expectedOutput ?? null,
        metrics: e.metrics,
        created_at: ts,
      };
    });

    const inserted = await db.query(
      `INSERT INTO grad_feedback
         (id, workspace_id, inference_id, session_id, deployment_name, idempotency_key, score,
          expected_output, metrics, created_at)
       SELECT x.id, x.workspace_id, x.inference_id, x.session_id, x.deployment_name,
              x.idempotency_key, x.score, NULLIF(x.expected_output, 'null'::jsonb),
              COALESCE(x.metrics, '{}'::jsonb), x.created_at
       FROM jsonb_to_recordset($1::jsonb) AS x(
         id text, workspace_id text, inference_id text, session_id text, deployment_name text,
         idempotency_key text, score double precision, expected_output jsonb, metrics jsonb,
         created_at timestamptz)
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
       RETURNING id, workspace_id, idempotency_key`,
      [JSON.stringify(candidates)],
    );
    const fresh = new Set(
      inserted.map((r) =>
        pairKey(String(r.workspace_id), String(r.idempotency_key)),
      ),
    );

    const stored = (
      await db.query(
        `SELECT f.* FROM grad_feedback f
         JOIN jsonb_to_recordset($1::jsonb) AS x(workspace_id text, idempotency_key text)
           ON f.workspace_id = x.workspace_id AND f.idempotency_key = x.idempotency_key`,
        [
          JSON.stringify(
            candidates.map((c) => ({
              workspace_id: c.workspace_id,
              idempotency_key: c.idempotency_key,
            })),
          ),
        ],
      )
    ).map(toFeedback);
    const byKey = new Map(
      stored.map((r) => [pairKey(r.workspace_id, r.idempotency_key), r]),
    );

    return events.map((e, i) => {
      const k = pairKey(e.workspaceId, e.idempotencyKey);
      const record = byKey.get(k);
      if (!record)
        throw new Error(`Feedback '${e.idempotencyKey}' was not stored.`);

      return {
        record,
        deduplicated: !(fresh.has(k) && firstIndex.get(k) === i),
      };
    });
  },
  stats: async (workspaceId, deploymentName) => {
    const row = first(
      await db.query(
        `SELECT COUNT(*) AS count, AVG(score) AS avg FROM grad_feedback
         WHERE workspace_id = $1 AND deployment_name = $2`,
        [workspaceId, deploymentName],
      ),
    );
    const avg =
      row?.avg === null || row?.avg === undefined ? null : Number(row.avg);

    return {
      count: Number(row?.count ?? 0),
      average_score: avg === null ? null : Number(avg.toFixed(4)),
    };
  },
});
