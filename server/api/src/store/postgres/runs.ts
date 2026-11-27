import type { Clock } from "../../clock.js";
import { newId } from "../../ids.js";
import { decodeCursor, toPage } from "../cursor.js";
import type {
  ArtifactRepository,
  BillingOutboxRepository,
  CheckpointRepository,
  MetricsRepository,
  RunRepository,
} from "../types.js";
import {
  expectClause,
  jsonParam,
  Params,
  setClause,
  type ColumnTypes,
  type Db,
} from "./db.js";
import {
  toArtifact,
  toBilling,
  toCheckpoint,
  toMetric,
  toRun,
} from "./mappers.js";
import { addSecondsIso, first, listNewest, nowIso } from "./shared.js";

const RUN_COLUMNS: ColumnTypes = {
  json: new Set(["latest_metric", "eval_report", "resolved_config"]),
  timestamps: new Set(["lease_expires_at", "updated_at", "finished_at"]),
};

export const createRunRepository = (db: Db, clock: Clock): RunRepository => ({
  create: async (input) => {
    const ts = nowIso(clock);
    const rows = await db.query(
      `INSERT INTO grad_runs
         (id, workspace_id, name, dataset_id, dataset_name, dataset_version, recipe_kind, status,
          resolved_config, max_cost_usd, price_per_million_tokens, total_steps, max_attempts,
          created_at, updated_at, waiting_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', $8::jsonb, $9, $10, $11, $12,
               $13::timestamptz, $13::timestamptz, $14)
       RETURNING *`,
      [
        newId("run"),
        input.workspaceId,
        input.name,
        input.datasetId,
        input.datasetName,
        input.datasetVersion,
        input.recipeKind,
        JSON.stringify(input.resolvedConfig),
        input.maxCostUsd,
        input.pricePerMillionTokens,
        input.totalSteps,
        input.maxAttempts,
        ts,
        input.waitingOn ?? null,
      ],
    );

    return toRun(rows[0] ?? {});
  },
  get: async (workspaceId, id) => {
    const row = first(
      await db.query(
        "SELECT * FROM grad_runs WHERE workspace_id = $1 AND id = $2",
        [workspaceId, id],
      ),
    );

    return row ? toRun(row) : null;
  },
  getById: async (id) => {
    const row = first(
      await db.query("SELECT * FROM grad_runs WHERE id = $1", [id]),
    );

    return row ? toRun(row) : null;
  },
  list: (workspaceId, page) => {
    const params = new Params();

    return listNewest(db, {
      table: "grad_runs",
      where: `workspace_id = ${params.add(workspaceId)}`,
      params,
      page,
      map: toRun,
    });
  },
  listWaitingOn: async (runId) =>
    (
      await db.query(
        `SELECT * FROM grad_runs WHERE waiting_on = $1 AND status = 'queued'
         ORDER BY created_at, id COLLATE "C"`,
        [runId],
      )
    ).map(toRun),
  update: async (id, patch, expect) => {
    const params = new Params();
    const sets = setClause(
      { ...patch, updated_at: patch.updated_at ?? nowIso(clock) },
      RUN_COLUMNS,
      params,
    );
    const where = `id = ${params.add(id)}${expectClause(expect, params)}`;
    const row = first(
      await db.query(
        `UPDATE grad_runs SET ${sets.join(", ")} WHERE ${where} RETURNING *`,
        params.values,
      ),
    );

    return row ? toRun(row) : null;
  },
  claimNext: async ({ workerId, leaseSeconds, now, workspaceId, recipes }) => {
    const row = first(
      await db.query(
        `UPDATE grad_runs
         SET status = 'running', attempt = attempt + 1, attempt_tokens = 0,
             worker_id = $1, lease_expires_at = $2::timestamptz, lease_seconds = $3,
             updated_at = $4::timestamptz
         WHERE id = (
           SELECT id FROM grad_runs
           WHERE status = 'queued' AND waiting_on IS NULL
             AND ($5::text IS NULL OR workspace_id = $5)
             AND ($6::text[] IS NULL OR recipe_kind = ANY($6::text[]))
           ORDER BY created_at, id COLLATE "C"
           LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [
          workerId,
          addSecondsIso(now, leaseSeconds),
          leaseSeconds,
          now.toISOString(),
          workspaceId ?? null,
          recipes ? [...recipes] : null,
        ],
      ),
    );

    return row ? toRun(row) : null;
  },
  heldBy: async (workerId) => {
    const row = first(
      await db.query(
        `SELECT * FROM grad_runs WHERE worker_id = $1 AND status IN ('running', 'cancelled')
         ORDER BY updated_at DESC LIMIT 1`,
        [workerId],
      ),
    );

    return row ? toRun(row) : null;
  },
  listExpiredLeases: async (now, limit) =>
    (
      await db.query(
        `SELECT * FROM grad_runs
         WHERE worker_id IS NOT NULL
           AND lease_expires_at + make_interval(secs => lease_seconds / 3.0) < $1::timestamptz
         ORDER BY lease_expires_at LIMIT $2`,
        [now.toISOString(), limit],
      )
    ).map(toRun),
});

export const createMetricsRepository = (db: Db): MetricsRepository => ({
  append: async (runId, attempt, point) => {
    const inserted = first(
      await db.query(
        `INSERT INTO grad_run_metrics (run_id, attempt, step, point) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (run_id, attempt, step) DO NOTHING RETURNING *`,
        [runId, attempt, point.step, JSON.stringify(point)],
      ),
    );
    if (inserted) return toMetric(inserted);
    const existing = first(
      await db.query(
        "SELECT * FROM grad_run_metrics WHERE run_id = $1 AND attempt = $2 AND step = $3",
        [runId, attempt, point.step],
      ),
    );

    return toMetric(existing ?? {});
  },
  list: async (runId, afterSeq, limit) =>
    (
      await db.query(
        `SELECT * FROM grad_run_metrics WHERE run_id = $1 AND seq > $2
         ORDER BY seq LIMIT $3`,
        [runId, afterSeq, limit],
      )
    ).map(toMetric),
});

const UNEXPIRED = "(expires_at IS NULL OR expires_at > $NOW::timestamptz)";

export const createCheckpointRepository = (
  db: Db,
  clock: Clock,
): CheckpointRepository => ({
  insert: (input) =>
    db.atomic(async () => {
      const inserted = first(
        await db.query(
          `INSERT INTO grad_checkpoints
             (id, workspace_id, run_id, attempt, step, eval_score, format, storage_key, sha256,
              size_bytes, metadata, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::timestamptz, $13::timestamptz)
           ON CONFLICT (run_id, attempt, step) DO NOTHING
           RETURNING *`,
          [
            newId("ckpt"),
            input.workspaceId,
            input.runId,
            input.attempt,
            input.step,
            input.evalScore,
            input.format,
            input.storageKey,
            input.sha256,
            input.sizeBytes,
            JSON.stringify(input.metadata),
            input.expiresAt,
            nowIso(clock),
          ],
        ),
      );
      if (inserted)
        return { checkpoint: toCheckpoint(inserted), created: true };

      const existing = first(
        await db.query(
          "SELECT * FROM grad_checkpoints WHERE run_id = $1 AND attempt = $2 AND step = $3",
          [input.runId, input.attempt, input.step],
        ),
      );

      return { checkpoint: toCheckpoint(existing ?? {}), created: false };
    }),
  get: async (workspaceId, id) => {
    const row = first(
      await db.query(
        "SELECT * FROM grad_checkpoints WHERE workspace_id = $1 AND id = $2",
        [workspaceId, id],
      ),
    );

    return row ? toCheckpoint(row) : null;
  },
  listByRun: async (workspaceId, runId, page, now) => {
    const params = new Params();
    const nowRef = params.add(now.toISOString());
    let where = `workspace_id = ${params.add(workspaceId)} AND run_id = ${params.add(runId)} AND ${UNEXPIRED.replace("$NOW", nowRef)}`;
    const after = decodeCursor(page.cursor, 3);
    if (after) {
      where += ` AND (step, attempt, id COLLATE "C") > (${params.add(Number(after[0]))}::int, ${params.add(Number(after[1]))}::int, ${params.add(String(after[2]))}::text)`;
    }
    const rows = await db.query(
      `SELECT * FROM grad_checkpoints WHERE ${where}
       ORDER BY step, attempt, id COLLATE "C" LIMIT ${params.add(page.limit + 1)}`,
      params.values,
    );

    return toPage(rows.map(toCheckpoint), page.limit, (c) => [
      c.step,
      c.attempt,
      c.id,
    ]);
  },
  latestForRun: async (runId, now) => {
    const row = first(
      await db.query(
        `SELECT * FROM grad_checkpoints WHERE run_id = $1 AND ${UNEXPIRED.replace("$NOW", "$2")}
         ORDER BY step DESC, attempt DESC LIMIT 1`,
        [runId, now.toISOString()],
      ),
    );

    return row ? toCheckpoint(row) : null;
  },
  listAllForRun: async (runId, now) =>
    (
      await db.query(
        `SELECT * FROM grad_checkpoints WHERE run_id = $1 AND ${UNEXPIRED.replace("$NOW", "$2")}
         ORDER BY step, attempt`,
        [runId, now.toISOString()],
      )
    ).map(toCheckpoint),
  pinRetention: async (runId, { bestId, finalId }) => {
    await db.query(
      `UPDATE grad_checkpoints
       SET best = best OR COALESCE(id = $2::text, FALSE),
           final = final OR COALESCE(id = $3::text, FALSE),
           expires_at = NULL
       WHERE run_id = $1 AND (id = $2::text OR id = $3::text)`,
      [runId, bestId, finalId],
    );
  },
  listExpired: async (now, limit) =>
    (
      await db.query(
        `SELECT * FROM grad_checkpoints
         WHERE expires_at IS NOT NULL AND expires_at <= $1::timestamptz
         ORDER BY expires_at LIMIT $2`,
        [now.toISOString(), limit],
      )
    ).map(toCheckpoint),
  delete: async (id) => {
    await db.query("DELETE FROM grad_checkpoints WHERE id = $1", [id]);
  },
});

export const createArtifactRepository = (
  db: Db,
  clock: Clock,
): ArtifactRepository => ({
  create: (input) =>
    db.atomic(async () => {
      const at = clock.now();
      const day = at.toISOString().slice(0, 10);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `artifact:${input.workspaceId}:${input.name}`,
      ]);
      const seqRow = first(
        await db.query(
          `SELECT COALESCE(MAX(version_seq), 0) AS seq FROM grad_artifacts
           WHERE workspace_id = $1 AND name = $2 AND version_day = $3`,
          [input.workspaceId, input.name, day],
        ),
      );
      const seq = Number(seqRow?.seq ?? 0) + 1;
      const version = `${day}-${seq}`;
      const rows = await db.query(
        `INSERT INTO grad_artifacts
           (id, workspace_id, name, version, version_day, version_seq, run_id, checkpoint_id,
            base_model, recipe_kind, format, storage_key, sha256, size_bytes, manifest,
            eval_report, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb,
                 $16::jsonb, $17::timestamptz)
         RETURNING *`,
        [
          `${input.name}@${version}`,
          input.workspaceId,
          input.name,
          version,
          day,
          seq,
          input.runId,
          input.checkpointId,
          input.baseModel,
          input.recipeKind,
          input.format,
          input.storageKey,
          input.sha256,
          input.sizeBytes,
          JSON.stringify(input.manifest),
          jsonParam(input.evalReport),
          at.toISOString(),
        ],
      );

      return toArtifact(rows[0] ?? {});
    }),
  get: async (workspaceId, reference) => {
    if (reference.endsWith("@latest")) {
      const row = first(
        await db.query(
          `SELECT * FROM grad_artifacts WHERE workspace_id = $1 AND name = $2
           ORDER BY version_day DESC, version_seq DESC LIMIT 1`,
          [workspaceId, reference.slice(0, -"@latest".length)],
        ),
      );

      return row ? toArtifact(row) : null;
    }

    const row = first(
      await db.query(
        "SELECT * FROM grad_artifacts WHERE workspace_id = $1 AND id = $2",
        [workspaceId, reference],
      ),
    );

    return row ? toArtifact(row) : null;
  },
  list: (workspaceId, filter, page) => {
    const params = new Params();
    let where = `workspace_id = ${params.add(workspaceId)}`;
    if (filter.name) where += ` AND name = ${params.add(filter.name)}`;

    return listNewest(db, {
      table: "grad_artifacts",
      where,
      params,
      page,
      map: toArtifact,
    });
  },
});

export const createBillingOutboxRepository = (
  db: Db,
  clock: Clock,
): BillingOutboxRepository => ({
  enqueue: async (input) => {
    const ts = nowIso(clock);
    const inserted = first(
      await db.query(
        `INSERT INTO grad_billing_outbox
           (id, idempotency_key, workspace_id, run_id, attempt, tokens, cost_usd, status,
            next_attempt_at, created_at, kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8::timestamptz, $8::timestamptz, $9)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [
          newId("bill"),
          input.idempotencyKey,
          input.workspaceId,
          input.runId,
          input.attempt,
          input.tokens,
          input.costUsd,
          ts,
          input.kind,
        ],
      ),
    );
    if (inserted) return toBilling(inserted);

    const existing = first(
      await db.query(
        "SELECT * FROM grad_billing_outbox WHERE idempotency_key = $1",
        [input.idempotencyKey],
      ),
    );

    return toBilling(existing ?? {});
  },
  claimDue: async (now, limit, lockSeconds) =>
    (
      await db.query(
        `UPDATE grad_billing_outbox
         SET next_attempt_at = $2::timestamptz, attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM grad_billing_outbox
           WHERE status = 'pending' AND next_attempt_at <= $1::timestamptz
           ORDER BY created_at LIMIT $3 FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [now.toISOString(), addSecondsIso(now, lockSeconds), limit],
      )
    )
      .map(toBilling)
      .sort((a, b) =>
        a.created_at === b.created_at
          ? a.id < b.id
            ? -1
            : 1
          : a.created_at < b.created_at
            ? -1
            : 1,
      ),
  markSent: async (id) => {
    await db.query(
      `UPDATE grad_billing_outbox SET status = 'sent', sent_at = $2::timestamptz, last_error = NULL
       WHERE id = $1`,
      [id, nowIso(clock)],
    );
  },
  markFailed: async (id, error, nextAttemptAt) => {
    await db.query(
      `UPDATE grad_billing_outbox SET last_error = $2, next_attempt_at = $3::timestamptz
       WHERE id = $1`,
      [id, error.slice(0, 2000), nextAttemptAt.toISOString()],
    );
  },
  listByRun: async (runId) =>
    (
      await db.query(
        "SELECT * FROM grad_billing_outbox WHERE run_id = $1 ORDER BY attempt, created_at",
        [runId],
      )
    ).map(toBilling),
});
