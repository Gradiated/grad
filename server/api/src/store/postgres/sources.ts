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

const nn = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

const toSecret = (r: Row): Secret & { id: string } => ({
  id: String(r.id),
  name: String(r.name),
  workspace_id: String(r.workspace_id),
  allowed_hosts: Array.isArray(r.allowed_hosts)
    ? r.allowed_hosts.map(String)
    : [],
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
});

const toSealed = (row: Row): SealedSecretRow => ({
  keyId: String(row.key_id),
  nonce: row.nonce as Buffer,
  ciphertext: row.ciphertext as Buffer,
  wrappedKey: (row.wrapped_key as Buffer | null) ?? null,
});

const SECRET_COLUMNS =
  "id, workspace_id, name, allowed_hosts, created_at, updated_at";

const publicSecret = ({
  id: _id,
  ...secret
}: Secret & { id: string }): Secret => secret;

export const createSecretRepository = (
  db: Db,
  clock: Clock,
): SecretRepository => ({
  put: async ({ workspaceId, name, sealed, allowedHosts }) => {
    const now = nowIso(clock);
    const rows = await db.query(
      `INSERT INTO grad_secrets
         (id, workspace_id, name, key_id, nonce, ciphertext, allowed_hosts, created_at, updated_at,
          wrapped_key)
       VALUES ($1, $2, $3, $4, $5, $6, $8::text[], $7::timestamptz, $7::timestamptz, $9)
       ON CONFLICT (workspace_id, name) DO UPDATE
         SET key_id = EXCLUDED.key_id, nonce = EXCLUDED.nonce,
             ciphertext = EXCLUDED.ciphertext, allowed_hosts = EXCLUDED.allowed_hosts,
             wrapped_key = EXCLUDED.wrapped_key, updated_at = EXCLUDED.updated_at
       RETURNING ${SECRET_COLUMNS}`,
      [
        newId("sec"),
        workspaceId,
        name,
        sealed.keyId,
        sealed.nonce,
        sealed.ciphertext,
        now,
        [...allowedHosts],
        sealed.wrappedKey ?? null,
      ],
    );

    return publicSecret(toSecret(rows[0] ?? {}));
  },
  get: async (workspaceId, name) => {
    const row = first(
      await db.query(
        `SELECT ${SECRET_COLUMNS} FROM grad_secrets WHERE workspace_id = $1 AND name = $2`,
        [workspaceId, name],
      ),
    );

    return row ? publicSecret(toSecret(row)) : null;
  },
  getSealed: async (workspaceId, name) => {
    const row = first(
      await db.query(
        "SELECT key_id, nonce, ciphertext, wrapped_key FROM grad_secrets WHERE workspace_id = $1 AND name = $2",
        [workspaceId, name],
      ),
    );

    return row ? toSealed(row) : null;
  },
  listSealedNotUnder: async (keyId, afterId, limit) =>
    (
      await db.query(
        `SELECT id, workspace_id, name, key_id, nonce, ciphertext, wrapped_key FROM grad_secrets
          WHERE key_id <> $1 AND id > $2 ORDER BY id LIMIT $3`,
        [keyId, afterId, limit],
      )
    ).map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      name: String(row.name),
      sealed: toSealed(row),
    })),
  replaceSealed: async (workspaceId, name, fromKeyId, sealed) =>
    (
      await db.query(
        `UPDATE grad_secrets SET key_id = $4, nonce = $5, ciphertext = $6, wrapped_key = $7
          WHERE workspace_id = $1 AND name = $2 AND key_id = $3 RETURNING id`,
        [
          workspaceId,
          name,
          fromKeyId,
          sealed.keyId,
          sealed.nonce,
          sealed.ciphertext,
          sealed.wrappedKey ?? null,
        ],
      )
    ).length > 0,
  list: async (workspaceId, page) => {
    const params = new Params();
    const result = await listNewest(db, {
      table: `(SELECT ${SECRET_COLUMNS} FROM grad_secrets) secrets`,
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
  sample_rate: Number(r.sample_rate ?? 1),
  max_records_per_sync: nn(r.max_records_per_sync),
  max_records_per_day: nn(r.max_records_per_day),
  records_today: Number(r.records_today ?? 0),
  records_day: sn(r.records_day),
  version_interval: Number(r.version_interval ?? 900),
  last_version_at: isoN(r.last_version_at),
  pending_records: Number(r.pending_records ?? 0),
  schedule: sn(r.schedule),
  next_sync_at: isoN(r.next_sync_at),
  watermark: (r.watermark as Record<string, unknown> | null) ?? null,
  sync_job_id: sn(r.sync_job_id),
  last_synced_at: isoN(r.last_synced_at),
  pending_full: r.pending_full === true,
  status: r.status === "paused" ? "paused" : "active",
  paused_reason: sn(r.paused_reason),
  last_error: sn(r.last_error),
  last_error_at: isoN(r.last_error_at),
  consecutive_failures: Number(r.consecutive_failures ?? 0),
  created_at: iso(r.created_at),
  updated_at: iso(r.updated_at),
});

const SOURCE_COLUMNS = {
  json: new Set(["watermark", "filters"]),
  timestamps: new Set([
    "next_sync_at",
    "last_synced_at",
    "last_error_at",
    "last_version_at",
    "updated_at",
  ]),
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
            schedule, next_sync_at, idempotency_key, request_hash, created_at, updated_at,
            sample_rate, max_records_per_sync, max_records_per_day, version_interval)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::timestamptz, $11, $12,
                 $13::timestamptz, $13::timestamptz, $14, $15, $16, $17)`,
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
          input.sampleRate,
          input.maxRecordsPerSync,
          input.maxRecordsPerDay,
          input.versionInterval,
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
        "status = 'active' AND next_sync_at IS NOT NULL AND next_sync_at <= $1::timestamptz",
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
