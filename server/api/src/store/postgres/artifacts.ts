import type { Clock } from "../../clock.js";
import { newId } from "../../ids.js";
import { decodeCursor, toPage } from "../cursor.js";
import type { ArtifactRepository } from "../types.js";
import { jsonParam, Params, type Db } from "./db.js";
import { toArtifact, toArtifactPin, toCheckpoint } from "./mappers.js";
import { first, listNewest, nowIso } from "./shared.js";

const UNEXPIRED = "(expires_at IS NULL OR expires_at > $NOW::timestamptz)";

export const createArtifactRepository = (
  db: Db,
  clock: Clock,
): ArtifactRepository => ({
  insertCheckpoint: (input) =>
    db.atomic(async () => {
      const inserted = first(
        await db.query(
          `INSERT INTO grad_artifacts
             (id, workspace_id, kind, run_id, attempt, step, eval_score, format, base_model,
              recipe_kind, storage_key, sha256, size_bytes, manifest, expires_at, created_at)
           VALUES ($1, $2, 'checkpoint', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb,
                   $14::timestamptz, $15::timestamptz)
           ON CONFLICT (run_id, attempt, step) WHERE kind = 'checkpoint' DO NOTHING
           RETURNING *`,
          [
            newId("ckpt"),
            input.workspaceId,
            input.runId,
            input.attempt,
            input.step,
            input.evalScore,
            input.format,
            input.baseModel,
            input.recipeKind,
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
          `SELECT * FROM grad_artifacts
           WHERE kind = 'checkpoint' AND run_id = $1 AND attempt = $2 AND step = $3`,
          [input.runId, input.attempt, input.step],
        ),
      );

      return { checkpoint: toCheckpoint(existing ?? {}), created: false };
    }),
  getCheckpoint: async (workspaceId, id) => {
    const row = first(
      await db.query(
        "SELECT * FROM grad_artifacts WHERE kind = 'checkpoint' AND workspace_id = $1 AND id = $2",
        [workspaceId, id],
      ),
    );

    return row ? toCheckpoint(row) : null;
  },
  listCheckpoints: async (workspaceId, runId, page, now) => {
    const params = new Params();
    const nowRef = params.add(now.toISOString());
    let where = `kind = 'checkpoint' AND workspace_id = ${params.add(workspaceId)} AND run_id = ${params.add(runId)} AND ${UNEXPIRED.replace("$NOW", nowRef)}`;
    const after = decodeCursor(page.cursor, 3);
    if (after) {
      where += ` AND (step, attempt, id COLLATE "C") > (${params.add(Number(after[0]))}::int, ${params.add(Number(after[1]))}::int, ${params.add(String(after[2]))}::text)`;
    }
    const rows = await db.query(
      `SELECT * FROM grad_artifacts WHERE ${where}
       ORDER BY step, attempt, id COLLATE "C" LIMIT ${params.add(page.limit + 1)}`,
      params.values,
    );

    return toPage(rows.map(toCheckpoint), page.limit, (c) => [
      c.step,
      c.attempt,
      c.id,
    ]);
  },
  allCheckpoints: async (runId, now) =>
    (
      await db.query(
        `SELECT * FROM grad_artifacts
         WHERE kind = 'checkpoint' AND run_id = $1 AND ${UNEXPIRED.replace("$NOW", "$2")}
         ORDER BY step, attempt`,
        [runId, now.toISOString()],
      )
    ).map(toCheckpoint),
  expireCheckpoints: async (runId, ids, at) => {
    if (ids.length === 0) return;
    await db.query(
      `UPDATE grad_artifacts SET expires_at = $3::timestamptz
       WHERE kind = 'checkpoint' AND run_id = $1 AND id = ANY($2::text[])
         AND NOT best AND NOT final AND expires_at IS NOT NULL`,
      [runId, ids, at.toISOString()],
    );
  },
  pinCheckpoints: async (runId, { bestId, finalId }) => {
    await db.query(
      // One best and one final per run: a resumed run's new ones take the flags over.
      // A checkpoint pinned by an earlier attempt keeps expires_at NULL (kept forever).
      `UPDATE grad_artifacts
       SET best = COALESCE(id = $2::text, FALSE),
           final = COALESCE(id = $3::text, FALSE),
           expires_at = CASE WHEN id = $2::text OR id = $3::text THEN NULL ELSE expires_at END
       WHERE kind = 'checkpoint' AND run_id = $1
         AND (best OR final OR id = $2::text OR id = $3::text)`,
      [runId, bestId, finalId],
    );
  },
  deleteExpiredCheckpoints: async (now, limit) => {
    const deleted = await db.query<{ storage_key: string }>(
      `DELETE FROM grad_artifacts WHERE (workspace_id, id) IN (
         SELECT workspace_id, id FROM grad_artifacts
         WHERE kind = 'checkpoint' AND expires_at IS NOT NULL AND expires_at <= $1::timestamptz
         ORDER BY expires_at LIMIT $2)
       RETURNING storage_key`,
      [now.toISOString(), limit],
    );
    const keys = [...new Set(deleted.map((r) => r.storage_key))];
    if (keys.length === 0) return [];
    // A release promoted from a checkpoint shares its blob: keep those.
    const shared = new Set(
      (
        await db.query<{ storage_key: string }>(
          "SELECT DISTINCT storage_key FROM grad_artifacts WHERE storage_key = ANY($1::text[])",
          [keys],
        )
      ).map((r) => r.storage_key),
    );

    return keys.filter((key) => !shared.has(key));
  },

  createRelease: (input) =>
    db.atomic(async () => {
      const at = clock.now();
      const day = at.toISOString().slice(0, 10);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `artifact:${input.workspaceId}:${input.name}`,
      ]);
      const seqRow = first(
        await db.query(
          `SELECT COALESCE(MAX(version_seq), 0) AS seq FROM grad_artifacts
           WHERE kind = 'release' AND workspace_id = $1 AND name = $2 AND version_day = $3`,
          [input.workspaceId, input.name, day],
        ),
      );
      const seq = Number(seqRow?.seq ?? 0) + 1;
      const version = `${day}-${seq}`;
      const rows = await db.query(
        `INSERT INTO grad_artifacts
           (id, workspace_id, kind, name, version, version_day, version_seq, run_id, source_id,
            base_model, recipe_kind, format, storage_key, sha256, size_bytes, manifest,
            eval_report, created_at)
         VALUES ($1, $2, 'release', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15::jsonb, $16::jsonb, $17::timestamptz)
         ON CONFLICT (workspace_id, source_id, name) WHERE kind = 'release' DO NOTHING
         RETURNING *`,
        [
          `${input.name}@${version}`,
          input.workspaceId,
          input.name,
          version,
          day,
          seq,
          input.runId,
          input.sourceId,
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
      // Natural key (checkpoint, name): a duplicate promote gets the first.
      const row =
        rows[0] ??
        first(
          await db.query(
            `SELECT * FROM grad_artifacts
             WHERE kind = 'release' AND workspace_id = $1 AND source_id = $2 AND name = $3`,
            [input.workspaceId, input.sourceId, input.name],
          ),
        );
      if (!row) throw new Error(`Release '${input.name}' was not created.`);

      return toArtifact(row);
    }),
  get: async (workspaceId, reference) => {
    const row = reference.endsWith("@latest")
      ? first(
          await db.query(
            `SELECT * FROM grad_artifacts
             WHERE kind = 'release' AND workspace_id = $1 AND name = $2
             ORDER BY version_day DESC, version_seq DESC LIMIT 1`,
            [workspaceId, reference.slice(0, -"@latest".length)],
          ),
        )
      : first(
          await db.query(
            "SELECT * FROM grad_artifacts WHERE kind = 'release' AND workspace_id = $1 AND id = $2",
            [workspaceId, reference],
          ),
        );

    return row ? toArtifact(row) : null;
  },
  pin: (input) =>
    db.atomic(async () => {
      const inserted = first(
        await db.query(
          `INSERT INTO grad_artifact_pins (workspace_id, artifact_id, holder, reason, created_at)
           SELECT $1, $2, $3, $4, $5::timestamptz
           WHERE EXISTS (SELECT 1 FROM grad_artifacts
                         WHERE kind = 'release' AND workspace_id = $1 AND id = $2)
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [
            input.workspaceId,
            input.artifactId,
            input.holder,
            input.reason,
            nowIso(clock),
          ],
        ),
      );
      if (inserted) return { pin: toArtifactPin(inserted), created: true };
      const existing = first(
        await db.query(
          "SELECT * FROM grad_artifact_pins WHERE workspace_id = $1 AND artifact_id = $2 AND holder = $3",
          [input.workspaceId, input.artifactId, input.holder],
        ),
      );

      return existing ? { pin: toArtifactPin(existing), created: false } : null;
    }),
  unpin: async (workspaceId, artifactId, holder) =>
    (
      await db.query(
        `DELETE FROM grad_artifact_pins
         WHERE workspace_id = $1 AND artifact_id = $2 AND holder = $3 RETURNING holder`,
        [workspaceId, artifactId, holder],
      )
    ).length > 0,
  lockBlob: async (key, mode) => {
    await db.query(
      mode === "shared"
        ? "SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))"
        : "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`blob:${key}`],
    );
  },
  pins: async (workspaceId, artifactId) =>
    (
      await db.query(
        `SELECT * FROM grad_artifact_pins WHERE workspace_id = $1 AND artifact_id = $2
         ORDER BY created_at, holder`,
        [workspaceId, artifactId],
      )
    ).map(toArtifactPin),
  deleteRelease: (workspaceId, id) =>
    db.atomic(async () => {
      // The row lock serializes with a concurrent pin (its FK check takes a
      // KEY SHARE lock on this row): a pin either commits first and is seen
      // here, or fails its FK check once the row is gone.
      const row = first(
        await db.query<{ storage_key: string }>(
          `SELECT storage_key FROM grad_artifacts
           WHERE kind = 'release' AND workspace_id = $1 AND id = $2 FOR UPDATE`,
          [workspaceId, id],
        ),
      );
      if (!row) return null;
      const pins = (
        await db.query(
          `SELECT * FROM grad_artifact_pins WHERE workspace_id = $1 AND artifact_id = $2
           ORDER BY created_at, holder`,
          [workspaceId, id],
        )
      ).map(toArtifactPin);
      if (pins.length > 0) return { pins, orphanKey: null };
      // Before the reference check: a release being created on the same
      // bundle (it holds the lock shared) commits first and is seen below.
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `blob:${row.storage_key}`,
      ]);
      await db.query(
        "DELETE FROM grad_artifacts WHERE kind = 'release' AND workspace_id = $1 AND id = $2",
        [workspaceId, id],
      );
      await db.query(
        `UPDATE grad_runs r SET artifact_id = NULL FROM grad_jobs j
         WHERE j.id = r.id AND j.workspace_id = $1 AND r.artifact_id = $2`,
        [workspaceId, id],
      );
      const shared = await db.query(
        "SELECT 1 FROM grad_artifacts WHERE storage_key = $1 LIMIT 1",
        [row.storage_key],
      );

      return {
        pins: [],
        orphanKey: shared.length > 0 ? null : row.storage_key,
      };
    }),
  list: (workspaceId, filter, page) => {
    const params = new Params();
    let where = `kind = 'release' AND workspace_id = ${params.add(workspaceId)}`;
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
