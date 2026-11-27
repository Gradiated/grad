import { randomUUID } from "node:crypto";

import type {
  IdempotencyRepository,
  IdempotencyScope,
  StoredResponse,
} from "./types.js";

export interface MemoryIdempotencyRow {
  claimId: string;
  requestHash: string;
  response: StoredResponse | null;
  createdAt: number;
  updatedAt: number;
}

const rowKey = (scope: IdempotencyScope): string =>
  JSON.stringify([
    scope.workspaceId,
    scope.principal,
    scope.method,
    scope.path,
    scope.key,
  ]);

/** Idempotency rows over a map owned by the memory store's state. */
export const createMemoryIdempotencyRepository = (
  rows: () => Map<string, MemoryIdempotencyRow>,
): IdempotencyRepository => ({
  claim: async (scope, requestHash, at) => {
    const key = rowKey(scope);
    const existing = rows().get(key);
    const takeover =
      !existing ||
      existing.createdAt < at.expiredBefore.getTime() ||
      (existing.response === null &&
        existing.updatedAt < at.abandonedBefore.getTime());
    if (takeover) {
      const claimId = randomUUID();
      const ts = at.now.getTime();
      rows().set(key, {
        claimId,
        requestHash,
        response: null,
        createdAt: ts,
        updatedAt: ts,
      });

      return { outcome: "claimed", claimId };
    }

    if (existing.requestHash !== requestHash) return { outcome: "mismatch" };
    if (existing.response === null) return { outcome: "in_progress" };

    return {
      outcome: "completed",
      response: structuredClone(existing.response),
    };
  },
  complete: async (scope, claimId, response, now) => {
    const row = rows().get(rowKey(scope));
    if (row?.claimId !== claimId) return;
    row.response = structuredClone(response);
    row.updatedAt = now.getTime();
  },
  release: async (scope, claimId) => {
    const key = rowKey(scope);
    if (rows().get(key)?.claimId === claimId) rows().delete(key);
  },
  deleteExpired: async (before) => {
    let deleted = 0;
    for (const [key, row] of rows()) {
      if (row.createdAt < before.getTime()) {
        rows().delete(key);
        deleted += 1;
      }
    }

    return deleted;
  },
});
