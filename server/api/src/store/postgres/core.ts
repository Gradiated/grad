import { randomBytes } from "node:crypto";

import { hashApiKey } from "../../adapters.js";
import type { Clock } from "../../clock.js";
import { newId } from "../../ids.js";
import type {
  DatasetPart,
  DatasetVersion,
  ApiKeyRepository,
  DatasetRepository,
  ImportJobRepository,
  UploadRepository,
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
  toApiKey,
  toDataset,
  toDatasetVersion,
  toImportJob,
  toUpload,
} from "./mappers.js";
import { addSecondsIso, first, listNewest, nowIso } from "./shared.js";

export const createApiKeyRepository = (
  db: Db,
  clock: Clock,
): ApiKeyRepository => ({
  create: async ({ workspaceId, name, scopes }) => {
    const secret = `grad_${randomBytes(24).toString("hex")}`;
    const rows = await db.query(
      `INSERT INTO grad_api_keys (id, workspace_id, name, prefix, key_hash, scopes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz) RETURNING *`,
      [
        newId("key"),
        workspaceId,
        name,
        secret.slice(0, 12),
        hashApiKey(secret),
        JSON.stringify(scopes),
        nowIso(clock),
      ],
    );

    return { key: toApiKey(rows[0] ?? {}), secret };
  },
  list: (workspaceId, page) => {
    const params = new Params();

    return listNewest(db, {
      table: "grad_api_keys",
      where: `workspace_id = ${params.add(workspaceId)}`,
      params,
      page,
      map: toApiKey,
    });
  },
  revoke: async (workspaceId, id) => {
    const rows = await db.query(
      `UPDATE grad_api_keys SET revoked_at = COALESCE(revoked_at, $3::timestamptz)
       WHERE workspace_id = $1 AND id = $2 RETURNING *`,
      [workspaceId, id, nowIso(clock)],
    );
    const row = first(rows);

    return row ? toApiKey(row) : null;
  },
  findActiveByHash: async (hash) => {
    const row = first(
      await db.query(
        "SELECT id, workspace_id, name, scopes FROM grad_api_keys WHERE key_hash = $1 AND revoked_at IS NULL",
        [hash],
      ),
    );
    if (!row) return null;
    const key = toApiKey({ ...row, prefix: "", created_at: new Date(0) });

    return {
      id: key.id,
      workspace_id: key.workspace_id,
      name: key.name,
      scopes: key.scopes,
    };
  },
});

export const createDatasetRepository = (
  db: Db,
  clock: Clock,
): DatasetRepository => {
  const repo: DatasetRepository = {
    create: ({ workspaceId, name, metadata }) =>
      db.atomic(async () => {
        const ts = nowIso(clock);
        const row = first(
          await db.query(
            `INSERT INTO grad_datasets (id, workspace_id, name, version, record_count, metadata, created_at, updated_at)
             VALUES ($1, $2, $3, 0, 0, $4::jsonb, $5::timestamptz, $5::timestamptz)
             ON CONFLICT (workspace_id, name) DO NOTHING RETURNING *`,
            [newId("ds"), workspaceId, name, JSON.stringify(metadata), ts],
          ),
        );
        if (!row) return null;
        const dataset = toDataset(row);
        await db.query(
          `INSERT INTO grad_dataset_versions (dataset_id, version, part_count, record_count, created_at)
           VALUES ($1, 0, 0, 0, $2::timestamptz)`,
          [dataset.id, ts],
        );

        return dataset;
      }),
    getOrCreate: async (input) => {
      const existing = await repo.get(input.workspaceId, input.name);
      if (existing) return existing;
      const created = await repo.create(input);
      if (created) return created;
      const raced = await repo.get(input.workspaceId, input.name);
      if (!raced) throw new Error(`Dataset '${input.name}' vanished.`);

      return raced;
    },
    get: async (workspaceId, name) => {
      const row = first(
        await db.query(
          "SELECT * FROM grad_datasets WHERE workspace_id = $1 AND name = $2",
          [workspaceId, name],
        ),
      );

      return row ? toDataset(row) : null;
    },
    getById: async (workspaceId, id) => {
      const row = first(
        await db.query(
          "SELECT * FROM grad_datasets WHERE workspace_id = $1 AND id = $2",
          [workspaceId, id],
        ),
      );

      return row ? toDataset(row) : null;
    },
    list: (workspaceId, page) => {
      const params = new Params();

      return listNewest(db, {
        table: "grad_datasets",
        where: `workspace_id = ${params.add(workspaceId)}`,
        params,
        page,
        map: toDataset,
      });
    },
    appendVersion: ({ datasetId, parts, metadata }) =>
      db.atomic(async () => {
        const added = parts.reduce((sum, p) => sum + p.count, 0);
        const ts = nowIso(clock);
        const row = first(
          await db.query(
            `UPDATE grad_datasets
             SET version = version + 1, record_count = record_count + $2,
                 metadata = metadata || $3::jsonb, updated_at = $4::timestamptz
             WHERE id = $1 RETURNING *`,
            [datasetId, added, JSON.stringify(metadata ?? {}), ts],
          ),
        );
        if (!row) throw new Error(`Dataset '${datasetId}' not found.`);
        const dataset = toDataset(row);
        const previous = first(
          await db.query(
            "SELECT part_count FROM grad_dataset_versions WHERE dataset_id = $1 AND version = $2",
            [datasetId, dataset.version - 1],
          ),
        );
        const start = Number(previous?.part_count ?? 0);
        for (const [i, part] of parts.entries()) {
          await db.query(
            `INSERT INTO grad_dataset_parts (dataset_id, seq, key, count, sha256, bytes)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              datasetId,
              start + i,
              part.key,
              part.count,
              part.sha256,
              part.bytes,
            ],
          );
        }
        await db.query(
          `INSERT INTO grad_dataset_versions (dataset_id, version, part_count, record_count, created_at)
           VALUES ($1, $2, $3, $4, $5::timestamptz)`,
          [
            datasetId,
            dataset.version,
            start + parts.length,
            dataset.record_count,
            ts,
          ],
        );
        const version = await repo.getVersion(datasetId, dataset.version);

        return { dataset, version: version as DatasetVersion };
      }),
    getVersion: async (datasetId, version) => {
      const row = first(
        await db.query(
          "SELECT * FROM grad_dataset_versions WHERE dataset_id = $1 AND version = $2",
          [datasetId, version],
        ),
      );
      if (!row) return null;
      const parts = await db.query(
        `SELECT key, count, sha256, bytes FROM grad_dataset_parts
         WHERE dataset_id = $1 AND seq < $2 ORDER BY seq`,
        [datasetId, row.part_count],
      );

      return toDatasetVersion(row, parts);
    },
  };

  return repo;
};

const IMPORT_COLUMNS: ColumnTypes = {
  json: new Set(["detected_scores", "drop_reasons", "source"]),
  timestamps: new Set(["lease_expires_at", "updated_at"]),
};

export const createImportJobRepository = (
  db: Db,
  clock: Clock,
): ImportJobRepository => ({
  create: async (input) => {
    const ts = nowIso(clock);
    const rows = await db.query(
      `INSERT INTO grad_import_jobs
         (id, workspace_id, dataset_id, dataset_name, status, source, connector, upload_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'queued', $5::jsonb, $6, $7, $8::timestamptz, $8::timestamptz)
       RETURNING *`,
      [
        newId("imp"),
        input.workspaceId,
        input.datasetId,
        input.datasetName,
        JSON.stringify(input.source),
        input.connector,
        input.uploadKey,
        ts,
      ],
    );

    return toImportJob(rows[0] ?? {});
  },
  get: async (workspaceId, id) => {
    const row = first(
      await db.query(
        "SELECT * FROM grad_import_jobs WHERE workspace_id = $1 AND id = $2",
        [workspaceId, id],
      ),
    );

    return row ? toImportJob(row) : null;
  },
  getById: async (id) => {
    const row = first(
      await db.query("SELECT * FROM grad_import_jobs WHERE id = $1", [id]),
    );

    return row ? toImportJob(row) : null;
  },
  list: (workspaceId, page) => {
    const params = new Params();

    return listNewest(db, {
      table: "grad_import_jobs",
      where: `workspace_id = ${params.add(workspaceId)}`,
      params,
      page,
      map: toImportJob,
    });
  },
  update: async (id, patch, expect) => {
    const params = new Params();
    const sets = setClause(
      { ...patch, updated_at: patch.updated_at ?? nowIso(clock) },
      IMPORT_COLUMNS,
      params,
    );
    const where = `id = ${params.add(id)}${expectClause(expect, params)}`;
    const row = first(
      await db.query(
        `UPDATE grad_import_jobs SET ${sets.join(", ")} WHERE ${where} RETURNING *`,
        params.values,
      ),
    );

    return row ? toImportJob(row) : null;
  },
  claimNext: async ({ workerId, leaseSeconds, now, workspaceId }) => {
    const row = first(
      await db.query(
        `UPDATE grad_import_jobs
         SET status = 'running', attempt = attempt + 1, worker_id = $1,
             lease_expires_at = $2::timestamptz, lease_seconds = $3,
             updated_at = $4::timestamptz
         WHERE id = (
           SELECT id FROM grad_import_jobs
           WHERE status = 'queued' AND ($5::text IS NULL OR workspace_id = $5)
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
        ],
      ),
    );

    return row ? toImportJob(row) : null;
  },
  heldBy: async (workerId) => {
    const row = first(
      await db.query(
        `SELECT * FROM grad_import_jobs WHERE worker_id = $1 AND status IN ('running', 'cancelled')
         ORDER BY updated_at DESC LIMIT 1`,
        [workerId],
      ),
    );

    return row ? toImportJob(row) : null;
  },
  listExpiredLeases: async (now, limit) =>
    (
      await db.query(
        `SELECT * FROM grad_import_jobs
         WHERE worker_id IS NOT NULL AND lease_expires_at < $1::timestamptz
         ORDER BY lease_expires_at LIMIT $2`,
        [now.toISOString(), limit],
      )
    ).map(toImportJob),
  addPart: async ({ importId, attempt, batch, part, dropped }) =>
    (
      await db.query(
        `INSERT INTO grad_import_parts (import_id, attempt, batch, part, dropped)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (import_id, attempt, batch) DO NOTHING RETURNING seq`,
        [importId, attempt, batch, jsonParam(part), dropped],
      )
    ).length > 0,
  listParts: async (importId, attempt) => {
    const rows = await db.query(
      `SELECT part, dropped FROM grad_import_parts WHERE import_id = $1 AND attempt = $2
       ORDER BY batch, seq`,
      [importId, attempt],
    );

    return {
      parts: rows.flatMap((r) => (r.part ? [r.part as DatasetPart] : [])),
      dropped: rows.reduce((sum, r) => sum + Number(r.dropped), 0),
    };
  },
});

export const createUploadRepository = (
  db: Db,
  clock: Clock,
): UploadRepository => ({
  create: async (input) => {
    const rows = await db.query(
      `INSERT INTO grad_uploads
         (id, workspace_id, purpose, job_id, attempt, storage_key, sha256, size_bytes, status, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9::timestamptz, $10::timestamptz)
       RETURNING *`,
      [
        input.id,
        input.workspaceId,
        input.purpose,
        input.jobId,
        input.attempt,
        input.storageKey,
        input.sha256,
        input.sizeBytes,
        nowIso(clock),
        input.expiresAt,
      ],
    );

    return toUpload(rows[0] ?? {});
  },
  get: async (id) => {
    const row = first(
      await db.query("SELECT * FROM grad_uploads WHERE id = $1", [id]),
    );

    return row ? toUpload(row) : null;
  },
  markUploaded: async (id) => {
    const row = first(
      await db.query(
        "UPDATE grad_uploads SET status = 'uploaded' WHERE id = $1 AND status = 'pending' RETURNING *",
        [id],
      ),
    );

    return row ? toUpload(row) : null;
  },
  consume: async (id, consumedBy) => {
    const row = first(
      await db.query(
        `UPDATE grad_uploads SET status = 'consumed', consumed_by = $2
         WHERE id = $1 AND status <> 'consumed' RETURNING *`,
        [id, consumedBy],
      ),
    );

    return row ? toUpload(row) : null;
  },
  listExpired: async (now, limit) =>
    (
      await db.query(
        `SELECT * FROM grad_uploads
         WHERE status <> 'consumed' AND expires_at < $1::timestamptz
         ORDER BY expires_at LIMIT $2`,
        [now.toISOString(), limit],
      )
    ).map(toUpload),
  delete: async (id) => {
    await db.query("DELETE FROM grad_uploads WHERE id = $1", [id]);
  },
});
