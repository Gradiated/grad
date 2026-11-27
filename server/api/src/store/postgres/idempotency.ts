import { randomUUID } from "node:crypto";

import type {
  IdempotencyClaim,
  IdempotencyRepository,
  IdempotencyScope,
  StoredResponse,
} from "../types.js";
import type { Db, Row } from "./db.js";
import { first } from "./shared.js";

const SCOPE_WHERE =
  "workspace_id = $1 AND principal = $2 AND method = $3 AND path = $4 AND idempotency_key = $5";

const scopeParams = (scope: IdempotencyScope): string[] => [
  scope.workspaceId,
  scope.principal,
  scope.method,
  scope.path,
  scope.key,
];

const toClaim = (row: Row, requestHash: string): IdempotencyClaim => {
  if (row.request_hash !== requestHash) return { outcome: "mismatch" };
  if (row.status !== "completed") return { outcome: "in_progress" };

  const response: StoredResponse = {
    status: Number(row.response_status),
    headers: (row.response_headers ?? {}) as Record<string, string>,
    body: String(row.response_body ?? ""),
  };

  return { outcome: "completed", response };
};

/** Bounded retries when a competing claim is released between our statements. */
const CLAIM_ATTEMPTS = 3;

/**
 * Postgres idempotency rows. The primary key serializes concurrent claims
 * across API replicas: the second INSERT waits for the first, then sees its
 * row and reports it.
 */
export const createIdempotencyRepository = (db: Db): IdempotencyRepository => ({
  claim: async (scope, requestHash, at) => {
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
      const claimId = randomUUID();
      const claimed = first(
        await db.query(
          `INSERT INTO grad_idempotency_keys AS k
             (workspace_id, principal, method, path, idempotency_key, claim_id,
              request_hash, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'in_progress', $8::timestamptz, $8::timestamptz)
           ON CONFLICT (workspace_id, principal, method, path, idempotency_key) DO UPDATE
             SET claim_id = EXCLUDED.claim_id, request_hash = EXCLUDED.request_hash,
                 status = 'in_progress', response_status = NULL, response_headers = NULL,
                 response_body = NULL, created_at = EXCLUDED.created_at,
                 updated_at = EXCLUDED.updated_at
             WHERE k.created_at < $9::timestamptz
                OR (k.status = 'in_progress' AND k.updated_at < $10::timestamptz)
           RETURNING claim_id`,
          [
            ...scopeParams(scope),
            claimId,
            requestHash,
            at.now.toISOString(),
            at.expiredBefore.toISOString(),
            at.abandonedBefore.toISOString(),
          ],
        ),
      );
      if (claimed) return { outcome: "claimed", claimId };

      const existing = first(
        await db.query(
          `SELECT request_hash, status, response_status, response_headers, response_body
           FROM grad_idempotency_keys WHERE ${SCOPE_WHERE}`,
          scopeParams(scope),
        ),
      );
      if (existing) return toClaim(existing, requestHash);
    }

    return { outcome: "in_progress" };
  },
  complete: async (scope, claimId, response, now) => {
    await db.query(
      `UPDATE grad_idempotency_keys
       SET status = 'completed', response_status = $7, response_headers = $8::jsonb,
           response_body = $9, updated_at = $10::timestamptz
       WHERE ${SCOPE_WHERE} AND claim_id = $6`,
      [
        ...scopeParams(scope),
        claimId,
        response.status,
        JSON.stringify(response.headers),
        response.body,
        now.toISOString(),
      ],
    );
  },
  release: async (scope, claimId) => {
    await db.query(
      `DELETE FROM grad_idempotency_keys WHERE ${SCOPE_WHERE} AND claim_id = $6`,
      [...scopeParams(scope), claimId],
    );
  },
  deleteExpired: async (before) =>
    Number(
      first(
        await db.query(
          `WITH deleted AS (
             DELETE FROM grad_idempotency_keys WHERE created_at < $1::timestamptz RETURNING 1
           )
           SELECT count(*)::int AS n FROM deleted`,
          [before.toISOString()],
        ),
      )?.n ?? 0,
    ),
});
