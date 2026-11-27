import { invalid } from "../errors.js";
import type { Page } from "./types.js";

export type CursorValue = string | number;

/** Opaque keyset cursor: base64url JSON array of the sort key of the last row. */
export const encodeCursor = (values: readonly CursorValue[]): string =>
  Buffer.from(JSON.stringify(values), "utf8").toString("base64url");

export const decodeCursor = (
  cursor: string | undefined,
  arity: number,
): CursorValue[] | null => {
  if (cursor === undefined) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid("invalid_cursor", "The pagination cursor is malformed.");
  }

  if (
    !Array.isArray(parsed) ||
    (arity >= 0 && parsed.length !== arity) ||
    !parsed.every((v) => typeof v === "string" || typeof v === "number")
  ) {
    throw invalid("invalid_cursor", "The pagination cursor is malformed.");
  }

  return parsed as CursorValue[];
};

/**
 * Trims a `limit + 1` result set to a page, deriving the next cursor from the
 * last returned row.
 */
export const toPage = <T>(
  rows: readonly T[],
  limit: number,
  keyOf: (row: T) => readonly CursorValue[],
): Page<T> => {
  const data = rows.slice(0, limit);
  const last = data[data.length - 1];

  return {
    data,
    next_cursor: rows.length > limit && last ? encodeCursor(keyOf(last)) : null,
  };
};
