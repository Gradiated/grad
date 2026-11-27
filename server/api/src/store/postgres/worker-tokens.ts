import type { Db } from "./db.js";
import type { WorkerTokenRecord, WorkerTokenRepository } from "../types.js";

type TokenRow = {
  host_id: string;
  lease_id: string;
  kinds: string[];
  gpu_memory_gb: number | null;
  expires_at: Date;
  revoked_at: Date | null;
  created_by: string;
};

const toRecord = (row: TokenRow): WorkerTokenRecord => ({
  hostId: row.host_id,
  leaseId: row.lease_id,
  kinds: row.kinds,
  gpuMemoryGb: row.gpu_memory_gb === null ? null : Number(row.gpu_memory_gb),
  expiresAt: new Date(row.expires_at),
  revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
  createdBy: row.created_by,
});

export const createWorkerTokenRepository = (db: Db): WorkerTokenRepository => ({
  create: async (input) => {
    await db.query(
      `INSERT INTO grad_worker_tokens
         (token_sha256, host_id, lease_id, kinds, gpu_memory_gb, expires_at, created_by, created_at)
       VALUES ($1, $2, $3, $4::text[], $5, $6::timestamptz, $7, $8::timestamptz)`,
      [
        input.tokenSha256,
        input.hostId,
        input.leaseId,
        [...input.kinds],
        input.gpuMemoryGb,
        input.expiresAt.toISOString(),
        input.createdBy,
        input.now.toISOString(),
      ],
    );
  },
  findByHash: async (tokenSha256) => {
    const rows = await db.query<TokenRow>(
      `SELECT host_id, lease_id, kinds, gpu_memory_gb, expires_at, revoked_at, created_by
         FROM grad_worker_tokens WHERE token_sha256 = $1`,
      [tokenSha256],
    );

    return rows[0] ? toRecord(rows[0]) : null;
  },
  revokeLease: async (leaseId, createdBy, now) =>
    (
      await db.query(
        `UPDATE grad_worker_tokens SET revoked_at = $3::timestamptz
          WHERE lease_id = $1 AND created_by = $2 AND revoked_at IS NULL
          RETURNING lease_id`,
        [leaseId, createdBy, now.toISOString()],
      )
    ).length,
  deleteExpired: async (now, limit) =>
    (
      await db.query(
        `DELETE FROM grad_worker_tokens WHERE token_sha256 IN (
           SELECT token_sha256 FROM grad_worker_tokens
            WHERE expires_at < $1::timestamptz LIMIT $2)
         RETURNING lease_id`,
        [now.toISOString(), limit],
      )
    ).length,
});
