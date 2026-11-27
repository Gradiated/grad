import { randomBytes } from "node:crypto";

import { hashApiKey } from "../../adapters.js";
import type { Clock } from "../../clock.js";
import { newId } from "../../ids.js";
import type {
  ApiKeyRepository,
  DatasetPart,
  DatasetRepository,
  IdempotentHit,
} from "../types.js";
import { Params, type Db } from "./db.js";
import { toApiKey, toDataset, toPart } from "./mappers.js";
import { first, listNewest, nowIso } from "./shared.js";

const findHit = async (
  db: Db,
  sql: string,
  params: unknown[],
): Promise<IdempotentHit | null> =>
  first(await db.query<{ id: string; request_hash: string }>(sql, params));

export const createApiKeyRepository = (
  db: Db,
  clock: Clock,
): ApiKeyRepository => ({
  create: async ({ workspaceId, name, scopes, idempotency }) => {
    const secret = `grad_${randomBytes(24).toString("hex")}`;
    const rows = await db.query(
      `INSERT INTO grad_api_keys
         (id, workspace_id, name, prefix, key_hash, scopes, idempotency_key, request_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::timestamptz) RETURNING *`,
      [
        newId("key"),
        workspaceId,
        name,
        secret.slice(0, 12),
        hashApiKey(secret),
        JSON.stringify(scopes),
        idempotency?.key ?? null,
        idempotency?.hash ?? null,
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
    const row = first(
      await db.query(
        `UPDATE grad_api_keys SET revoked_at = COALESCE(revoked_at, $3::timestamptz)
         WHERE workspace_id = $1 AND id = $2 RETURNING *`,
        [workspaceId, id, nowIso(clock)],
      ),
    );

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
  findIdempotent: (workspaceId, key) =>
    findHit(
      db,
      "SELECT id, request_hash FROM grad_api_keys WHERE workspace_id = $1 AND idempotency_key = $2",
      [workspaceId, key],
    ),
});

export const createDatasetRepository = (
  db: Db,
  clock: Clock,
): DatasetRepository => {
  /** Inserts committed parts as `version`. */
  const insertParts = async (
    datasetId: string,
    version: number,
    parts: readonly DatasetPart[],
    idempotency: { key: string; hash: string } | undefined,
  ) => {
    for (const [i, part] of parts.entries()) {
      await db.query(
        `INSERT INTO grad_dataset_parts
           (dataset_id, version, key, count, sha256, bytes, idempotency_key, request_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
        [
          datasetId,
          version,
          part.key,
          part.count,
          part.sha256,
          part.bytes,
          i === 0 ? (idempotency?.key ?? null) : null,
          i === 0 ? (idempotency?.hash ?? null) : null,
          nowIso(clock),
        ],
      );
    }
  };

  /** Bumps the version by one and the count by `added`; returns the row (locked). */
  const bump = async (
    datasetId: string,
    added: number,
    metadata: Record<string, unknown> | undefined,
  ) => {
    const row = first(
      await db.query(
        `UPDATE grad_datasets
         SET version = version + 1, record_count = record_count + $2,
             metadata = metadata || $3::jsonb, updated_at = $4::timestamptz
         WHERE id = $1 RETURNING *`,
        [datasetId, added, JSON.stringify(metadata ?? {}), nowIso(clock)],
      ),
    );
    if (!row) throw new Error(`Dataset '${datasetId}' not found.`);

    return toDataset(row);
  };

  const repo: DatasetRepository = {
    create: async ({ workspaceId, name, metadata, idempotency }) => {
      const ts = nowIso(clock);
      const row = first(
        await db.query(
          `INSERT INTO grad_datasets
             (id, workspace_id, name, version, record_count, metadata, idempotency_key, request_hash,
              created_at, updated_at)
           VALUES ($1, $2, $3, 0, 0, $4::jsonb, $5, $6, $7::timestamptz, $7::timestamptz)
           ON CONFLICT (workspace_id, name) DO NOTHING RETURNING *`,
          [
            newId("ds"),
            workspaceId,
            name,
            JSON.stringify(metadata),
            idempotency?.key ?? null,
            idempotency?.hash ?? null,
            ts,
          ],
        ),
      );

      return row ? toDataset(row) : null;
    },
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
    findIdempotent: (workspaceId, key) =>
      findHit(
        db,
        "SELECT id, request_hash FROM grad_datasets WHERE workspace_id = $1 AND idempotency_key = $2",
        [workspaceId, key],
      ),
    appendVersion: ({
      datasetId,
      parts,
      metadata,
      idempotency,
      countRecords = true,
    }) =>
      db.atomic(async () => {
        const counted = countRecords
          ? parts
          : parts.map((p) => ({ ...p, count: 0 }));
        const added = counted.reduce((sum, p) => sum + p.count, 0);
        const dataset = await bump(datasetId, added, metadata);
        await insertParts(datasetId, dataset.version, counted, idempotency);

        return dataset;
      }),
    findIdempotentPush: (datasetId, key) =>
      findHit(
        db,
        "SELECT dataset_id AS id, request_hash FROM grad_dataset_parts WHERE dataset_id = $1 AND idempotency_key = $2",
        [datasetId, key],
      ),
    getVersion: async (datasetId, version) => {
      const dataset = first(
        await db.query("SELECT version FROM grad_datasets WHERE id = $1", [
          datasetId,
        ]),
      );
      if (!dataset || version < 0 || version > Number(dataset.version)) {
        return null;
      }
      const parts = (
        await db.query(
          `SELECT * FROM grad_dataset_parts
           WHERE dataset_id = $1 AND version BETWEEN 1 AND $2 AND key IS NOT NULL
           ORDER BY version, batch, id`,
          [datasetId, version],
        )
      ).map(toPart);

      return {
        dataset_id: datasetId,
        version,
        parts,
        record_count: parts.reduce((sum, p) => sum + p.count, 0),
      };
    },
    stagePart: async ({ datasetId, jobId, attempt, batch, part, dropped }) =>
      (
        await db.query(
          `INSERT INTO grad_dataset_parts
             (dataset_id, job_id, attempt, batch, key, count, sha256, bytes, dropped, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
           ON CONFLICT (job_id, attempt, batch) DO NOTHING RETURNING id`,
          [
            datasetId,
            jobId,
            attempt,
            batch,
            part?.key ?? null,
            part?.count ?? 0,
            part?.sha256 ?? null,
            part?.bytes ?? 0,
            dropped,
            nowIso(clock),
          ],
        )
      ).length > 0,
    listStaged: async (jobId, attempt) => {
      const rows = await db.query(
        `SELECT * FROM grad_dataset_parts WHERE job_id = $1 AND attempt = $2 ORDER BY batch`,
        [jobId, attempt],
      );

      return {
        parts: rows.filter((r) => r.key !== null).map(toPart),
        dropped: rows.reduce((sum, r) => sum + Number(r.dropped), 0),
        count: rows.reduce((sum, r) => sum + Number(r.count), 0),
      };
    },
    commitStaged: ({ datasetId, jobId, attempt, metadata }) =>
      db.atomic(async () => {
        const staged = await db.query(
          `SELECT count FROM grad_dataset_parts
           WHERE job_id = $1 AND attempt = $2 AND version IS NULL AND key IS NOT NULL`,
          [jobId, attempt],
        );
        const added = staged.reduce((sum, r) => sum + Number(r.count), 0);
        const dataset = await bump(datasetId, added, metadata);
        await db.query(
          `UPDATE grad_dataset_parts SET version = $3
           WHERE job_id = $1 AND attempt = $2 AND version IS NULL`,
          [jobId, attempt, dataset.version],
        );
        const orphans = await db.query<{ key: string | null }>(
          `DELETE FROM grad_dataset_parts
           WHERE job_id = $1 AND version IS NULL RETURNING key`,
          [jobId],
        );

        return {
          dataset,
          orphanKeys: orphans.flatMap((r) => (r.key ? [r.key] : [])),
        };
      }),
    discardStaged: async (jobId) =>
      (
        await db.query<{ key: string | null }>(
          "DELETE FROM grad_dataset_parts WHERE job_id = $1 AND version IS NULL RETURNING key",
          [jobId],
        )
      ).flatMap((r) => (r.key ? [r.key] : [])),
  };

  return repo;
};
