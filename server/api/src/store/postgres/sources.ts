import type { Clock } from "../../clock.js";
import type { Secret, SourceProviderKind } from "../../contracts.js";
import { newId } from "../../ids.js";
import type {
  SealedSecretRow,
  SecretRepository,
  SourceRecord,
  SourceRepository,
} from "../types.js";
import { Params, setClause, type Db, type Row } from "./db.js";
import { first, listNewest, nowIso } from "./shared.js";

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
const isoN = (v: unknown): string | null =>
  v === null || v === undefined ? null : iso(v);
const sn = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);

const toSecret = (r: Row): Secret & { id: string } => ({
  id: String(r.id),
  name: String(r.name),
  workspace_id: String(r.workspace_id),
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
});

const publicSecret = ({
  id: _id,
  ...secret
}: Secret & { id: string }): Secret => secret;

export const createSecretRepository = (
  db: Db,
  clock: Clock,
): SecretRepository => ({
  put: async ({ workspaceId, name, sealed }) => {
    const now = nowIso(clock);
    const rows = await db.query(
      `INSERT INTO grad_secrets
         (id, workspace_id, name, key_id, nonce, ciphertext, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz)
       ON CONFLICT (workspace_id, name) DO UPDATE
         SET key_id = EXCLUDED.key_id, nonce = EXCLUDED.nonce,
             ciphertext = EXCLUDED.ciphertext, updated_at = EXCLUDED.updated_at
       RETURNING id, workspace_id, name, created_at, updated_at`,
      [
        newId("sec"),
        workspaceId,
        name,
        sealed.keyId,
        sealed.nonce,
        sealed.ciphertext,
        now,
      ],
    );

    return publicSecret(toSecret(rows[0] ?? {}));
  },
  get: async (workspaceId, name) => {
    const row = first(
      await db.query(
        "SELECT id, workspace_id, name, created_at, updated_at FROM grad_secrets WHERE workspace_id = $1 AND name = $2",
        [workspaceId, name],
      ),
    );

    return row ? publicSecret(toSecret(row)) : null;
  },
  getSealed: async (workspaceId, name) => {
    const row = first(
      await db.query(
        "SELECT key_id, nonce, ciphertext FROM grad_secrets WHERE workspace_id = $1 AND name = $2",
        [workspaceId, name],
      ),
    );

    return row
      ? ({
          keyId: String(row.key_id),
          nonce: row.nonce as Buffer,
          ciphertext: row.ciphertext as Buffer,
        } satisfies SealedSecretRow)
      : null;
  },
  list: async (workspaceId, page) => {
    const params = new Params();
    const result = await listNewest(db, {
      table:
        "(SELECT id, workspace_id, name, created_at, updated_at FROM grad_secrets) secrets",
      where: `workspace_id = ${params.add(workspaceId)}`,
      params,
      page,
      map: toSecret,
    });

    return {
      data: result.data.map(publicSecret),
      next_cursor: result.next_cursor,
    };
  },
  delete: async (workspaceId, name) =>
    (
      await db.query(
        "DELETE FROM grad_secrets WHERE workspace_id = $1 AND name = $2 RETURNING id",
        [workspaceId, name],
      )
    ).length > 0,
});

const SOURCE_VIEW = `(SELECT s.*, d.name AS dataset
   FROM grad_sources s JOIN grad_datasets d ON d.id = s.dataset_id) src`;

const toSource = (r: Row): SourceRecord => ({
  id: String(r.id),
  workspace_id: String(r.workspace_id),
  dataset_id: String(r.dataset_id),
  dataset: String(r.dataset),
  provider: String(r.provider) as SourceProviderKind,
  host: sn(r.host),
  secret_name: sn(r.secret_name),
  project: sn(r.project),
  filters: (r.filters as Record<string, unknown> | null) ?? {},
  schedule: sn(r.schedule),
  next_sync_at: isoN(r.next_sync_at),
  watermark: (r.watermark as Record<string, unknown> | null) ?? null,
  sync_job_id: sn(r.sync_job_id),
  last_synced_at: isoN(r.last_synced_at),
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
});

const SOURCE_COLUMNS = {
  json: new Set(["watermark"]),
  timestamps: new Set(["next_sync_at", "last_synced_at", "updated_at"]),
};

export const createSourceRepository = (
  db: Db,
  clock: Clock,
): SourceRepository => {
  const select = async (
    where: string,
    params: unknown[],
    suffix = "",
  ): Promise<SourceRecord[]> =>
    (
      await db.query(
        `SELECT * FROM ${SOURCE_VIEW} WHERE ${where}${suffix}`,
        params,
      )
    ).map(toSource);

  const locked = async (
    where: string,
    params: unknown[],
    suffix: string,
  ): Promise<SourceRecord[]> => {
    // FOR UPDATE can't lock through the join: lock the base rows first.
    const ids = (
      await db.query<{ id: string }>(
        `SELECT id FROM grad_sources WHERE ${where}${suffix}`,
        params,
      )
    ).map((r) => r.id);
    if (ids.length === 0) return [];
    const rows = await select("id = ANY($1::text[])", [ids]);

    return ids.flatMap((id) => rows.filter((r) => r.id === id));
  };

  return {
    create: async (input) => {
      const now = nowIso(clock);
      const id = newId("src");
      await db.query(
        `INSERT INTO grad_sources
           (id, workspace_id, dataset_id, provider, host, secret_name, project, filters,
            schedule, next_sync_at, idempotency_key, request_hash, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::timestamptz, $11, $12,
                 $13::timestamptz, $13::timestamptz)`,
        [
          id,
          input.workspaceId,
          input.datasetId,
          input.provider,
          input.host,
          input.secretName,
          input.project,
          JSON.stringify(input.filters),
          input.schedule,
          input.nextSyncAt,
          input.idempotency?.key ?? null,
          input.idempotency?.hash ?? null,
          now,
        ],
      );
      const [created] = await select("id = $1", [id]);
      if (!created) throw new Error(`source ${id} vanished after insert`);

      return created;
    },
    get: async (workspaceId, id) =>
      first(await select("workspace_id = $1 AND id = $2", [workspaceId, id])),
    getById: async (id) => first(await select("id = $1", [id])),
    lock: async (workspaceId, id) =>
      first(
        await locked(
          "workspace_id = $1 AND id = $2",
          [workspaceId, id],
          " FOR UPDATE",
        ),
      ),
    list: (workspaceId, filter, page) => {
      const params = new Params();
      let where = `workspace_id = ${params.add(workspaceId)}`;
      if (filter.datasetId)
        where += ` AND dataset_id = ${params.add(filter.datasetId)}`;

      return listNewest(db, {
        table: SOURCE_VIEW,
        where,
        params,
        page,
        map: toSource,
      });
    },
    delete: async (workspaceId, id) =>
      (
        await db.query(
          "DELETE FROM grad_sources WHERE workspace_id = $1 AND id = $2 RETURNING id",
          [workspaceId, id],
        )
      ).length > 0,
    findIdempotent: async (workspaceId, key) =>
      first(
        await db.query<{ id: string; request_hash: string }>(
          "SELECT id, request_hash FROM grad_sources WHERE workspace_id = $1 AND idempotency_key = $2",
          [workspaceId, key],
        ),
      ),
    lockDue: (now, limit) =>
      locked(
        "next_sync_at IS NOT NULL AND next_sync_at <= $1::timestamptz",
        [now, limit],
        " ORDER BY next_sync_at, id LIMIT $2 FOR UPDATE SKIP LOCKED",
      ),
    update: async (id, patch, expectJobId) => {
      const params = new Params();
      const sets = setClause(
        { ...patch, updated_at: nowIso(clock) },
        SOURCE_COLUMNS,
        params,
      );
      let where = `id = ${params.add(id)}`;
      if (expectJobId !== undefined) {
        where += ` AND sync_job_id = ${params.add(expectJobId)}`;
      }
      const rows = await db.query<{ id: string }>(
        `UPDATE grad_sources SET ${sets.join(", ")} WHERE ${where} RETURNING id`,
        params.values,
      );
      if (rows.length === 0) return null;

      return first(await select("id = $1", [id]));
    },
    usingSecret: async (workspaceId, secretName) =>
      (
        await db.query<{ id: string }>(
          "SELECT id FROM grad_sources WHERE workspace_id = $1 AND secret_name = $2 ORDER BY id",
          [workspaceId, secretName],
        )
      ).map((r) => r.id),
  };
};
