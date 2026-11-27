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

/** Lexicographic comparison of two keys (numbers numerically, strings by code unit). */
export const compareKeys = (
  a: readonly CursorValue[],
  b: readonly CursorValue[],
): number => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") return x - y;

    return String(x) < String(y) ? -1 : 1;
  }

  return 0;
};

export const pageFromSorted = <T>(
  sorted: readonly T[],
  page: { limit: number; cursor?: string | undefined },
  keyOf: (row: T) => readonly CursorValue[],
  direction: "asc" | "desc",
): Page<T> => {
  const first = sorted[0];
  if (first === undefined) {
    decodeCursor(page.cursor, -1);
    return { data: [], next_cursor: null };
  }

  const after = decodeCursor(page.cursor, keyOf(first).length);
  const filtered = after
    ? sorted.filter((row) => {
        const cmp = compareKeys(keyOf(row), after);
        return direction === "asc" ? cmp > 0 : cmp < 0;
      })
    : sorted;

  return toPage(filtered.slice(0, page.limit + 1), page.limit, keyOf);
};
