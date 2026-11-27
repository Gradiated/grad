import type { Clock } from "../../clock.js";
import { newId } from "../../ids.js";
import { decodeCursor, toPage } from "../cursor.js";
import type { ArtifactRepository } from "../types.js";
import { jsonParam, Params, type Db } from "./db.js";
import { toArtifact, toCheckpoint } from "./mappers.js";
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
      `UPDATE grad_artifacts
       SET best = best OR COALESCE(id = $2::text, FALSE),
           final = final OR COALESCE(id = $3::text, FALSE),
           expires_at = NULL
       WHERE kind = 'checkpoint' AND run_id = $1 AND (id = $2::text OR id = $3::text)`,
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
