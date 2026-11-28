import type {
  JobKind,
  WorkspaceRepository,
  WorkspaceStateName,
  WorkspaceStateRecord,
} from "../types.js";
import type { Db, Row } from "./db.js";
import { iso, isoN } from "./mappers.js";
import { first } from "./shared.js";

const PAUSED_REASON = "workspace_suspended";

const toState = (r: Row): WorkspaceStateRecord => ({
  workspace_id: String(r.workspace_id),
  state: String(r.state) as WorkspaceStateName,
  purge_after: isoN(r.purge_after),
  purged_at: isoN(r.purged_at),
  last_error: r.last_error === null ? null : String(r.last_error),
  updated_at: iso(r.updated_at),
});

const count = async (db: Db, sql: string, params: unknown[]) =>
  Number(first(await db.query(sql, params))?.n ?? 0);

/** Rows deleted by `sql` (a DELETE ... RETURNING 1). */
const deleted = async (db: Db, sql: string, params: unknown[]) =>
  (await db.query(sql, params)).length;

/** Artifacts no holder pins (the pin guard every deletion path runs). */
const UNPINNED = `NOT EXISTS (SELECT 1 FROM grad_artifact_pins p
  WHERE p.workspace_id = a.workspace_id AND p.artifact_id = a.id)`;

export const createWorkspaceRepository = (db: Db): WorkspaceRepository => ({
  get: async (workspaceId) => {
    const row = first(
      await db.query(
        "SELECT * FROM grad_workspace_states WHERE workspace_id = $1",
        [workspaceId],
      ),
    );

    return row ? toState(row) : null;
  },
  state: async (workspaceId) => {
    const row = first(
      await db.query(
        "SELECT state FROM grad_workspace_states WHERE workspace_id = $1",
        [workspaceId],
      ),
    );

    return row ? (String(row.state) as WorkspaceStateName) : "active";
  },
  set: async (workspaceId, state, purgeAfter) => {
    const row = first(
      await db.query(
        `INSERT INTO grad_workspace_states
           (workspace_id, state, purge_after, next_purge_at, updated_at)
         VALUES ($1, $2, $3::timestamptz, $3::timestamptz, now())
         ON CONFLICT (workspace_id) DO UPDATE
           SET state = EXCLUDED.state, purge_after = EXCLUDED.purge_after,
               next_purge_at = EXCLUDED.next_purge_at, updated_at = now()
           WHERE grad_workspace_states.state <> 'deleted'
             AND grad_workspace_states.state <> EXCLUDED.state
         RETURNING *`,
        [workspaceId, state, purgeAfter?.toISOString() ?? null],
      ),
    );
    if (row) return toState(row);

    return toState(
      first(
        await db.query(
          "SELECT * FROM grad_workspace_states WHERE workspace_id = $1",
          [workspaceId],
        ),
      ) ?? {},
    );
  },
  pauseSources: (workspaceId) =>
    deleted(
      db,
      `UPDATE grad_sources SET status = 'paused', paused_reason = $2, updated_at = now()
        WHERE workspace_id = $1 AND status = 'active' RETURNING 1`,
      [workspaceId, PAUSED_REASON],
    ),
  resumeSources: (workspaceId) =>
    deleted(
      db,
      `UPDATE grad_sources SET status = 'active', paused_reason = NULL, updated_at = now()
        WHERE workspace_id = $1 AND status = 'paused' AND paused_reason = $2 RETURNING 1`,
      [workspaceId, PAUSED_REASON],
    ),
  openJobs: async (workspaceId, kinds) =>
    (
      await db.query(
        `SELECT id, kind, status FROM grad_jobs
          WHERE workspace_id = $1 AND kind = ANY($2::text[])
            AND status IN ('queued', 'running', 'awaiting_scores')
          ORDER BY created_at, id`,
        [workspaceId, [...kinds]],
      )
    ).map((r) => ({
      id: String(r.id),
      kind: String(r.kind) as JobKind,
      status: String(r.status),
    })),
  claimPurge: async (now, leaseSeconds) => {
    const row = first(
      await db.query(
        `UPDATE grad_workspace_states
            SET next_purge_at = $1::timestamptz + make_interval(secs => $2)
          WHERE workspace_id = (
            SELECT workspace_id FROM grad_workspace_states
             WHERE state = 'deleted' AND purged_at IS NULL AND next_purge_at <= $1::timestamptz
             ORDER BY next_purge_at LIMIT 1 FOR UPDATE SKIP LOCKED)
          RETURNING workspace_id`,
        [now.toISOString(), leaseSeconds],
      ),
    );

    return row ? String(row.workspace_id) : null;
  },
  purgeRows: (workspaceId, limit) =>
    db.atomic(async () => {
      const ws = [workspaceId];
      let rows = 0;
      for (const table of ["grad_sources", "grad_secrets", "grad_api_keys"]) {
        rows += await deleted(
          db,
          `DELETE FROM ${table} WHERE workspace_id = $1 RETURNING 1`,
          ws,
        );
      }
      // Finished jobs, with their runs, evals, outputs, events and staged
      // parts (ON DELETE CASCADE); a running job waits for its stop.
      rows += await deleted(
        db,
        `DELETE FROM grad_jobs WHERE id IN (
           SELECT id FROM grad_jobs WHERE workspace_id = $1 AND status <> 'running'
           LIMIT $2) RETURNING 1`,
        [workspaceId, limit],
      );
      rows += await deleted(
        db,
        `DELETE FROM grad_artifacts a WHERE (a.workspace_id, a.id) IN (
           SELECT a.workspace_id, a.id FROM grad_artifacts a
            WHERE a.workspace_id = $1 AND ${UNPINNED} LIMIT $2) RETURNING 1`,
        [workspaceId, limit],
      );
      rows += await deleted(
        db,
        `DELETE FROM grad_datasets d WHERE d.id IN (
           SELECT d.id FROM grad_datasets d WHERE d.workspace_id = $1
              AND NOT EXISTS (SELECT 1 FROM grad_runs r WHERE r.dataset_id = d.id)
            LIMIT $2) RETURNING 1`,
        [workspaceId, limit],
      );

      const runningJobs = await count(
        db,
        "SELECT COUNT(*)::int AS n FROM grad_jobs WHERE workspace_id = $1 AND status = 'running'",
        ws,
      );
      const kept = await db.query(
        `SELECT a.storage_key, ${UNPINNED} AS unpinned FROM grad_artifacts a
          WHERE a.workspace_id = $1`,
        ws,
      );
      const remaining =
        (await count(
          db,
          `SELECT ((SELECT COUNT(*) FROM grad_jobs WHERE workspace_id = $1)
                 + (SELECT COUNT(*) FROM grad_datasets WHERE workspace_id = $1))::int AS n`,
          ws,
        )) + kept.filter((k) => k.unpinned === true).length;

      return {
        deletedRows: rows,
        runningJobs,
        pinnedArtifacts: kept.filter((k) => k.unpinned !== true).length,
        remainingRows: remaining,
        keepKeys: kept
          .map((k) => k.storage_key)
          .filter((k): k is string => typeof k === "string"),
      };
    }),
  finishPurge: async (workspaceId, outcome) => {
    await db.query(
      `UPDATE grad_workspace_states
          SET purged_at = CASE WHEN $2 THEN $5::timestamptz ELSE NULL END,
              next_purge_at = $3::timestamptz, last_error = $4, updated_at = $5::timestamptz
        WHERE workspace_id = $1`,
      [
        workspaceId,
        outcome.done,
        outcome.nextAt.toISOString(),
        outcome.error,
        outcome.now.toISOString(),
      ],
    );
  },
});
