import { invalid } from "../errors.js";
import type { Page } from "./types.js";

type CursorValue = string | number;

/** Opaque keyset cursor: base64url JSON array of the sort key of the last row. */
export const encodeCursor = (values: readonly CursorValue[]): string =>
  Buffer.from(JSON.stringify(values), "utf8").toString("base64url");

const malformed = () =>
  invalid("invalid_cursor", "The pagination cursor is malformed.");

/** A cursor field: an integer, a string, or an ISO timestamp (a string). */
type CursorField = "int" | "text" | "time";

type Decoded<F extends readonly CursorField[]> = {
  [K in keyof F]: F[K] extends "int" ? number : string;
};

const fits = (field: CursorField, value: unknown): boolean =>
  field === "int"
    ? Number.isSafeInteger(value)
    : typeof value === "string" &&
      (field === "text" || !Number.isNaN(Date.parse(value)));

/**
 * The sort key a cursor holds, one value per `fields` entry. A cursor that
 * isn't one (tampered, or from another list) is a 422 invalid_cursor, never
 * a value the query would choke on.
 */
export const decodeCursor = <const F extends readonly CursorField[]>(
  cursor: string | undefined,
  fields: F,
): Decoded<F> | null => {
  if (cursor === undefined) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw malformed();
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length !== fields.length ||
    !fields.every((field, i) => fits(field, parsed[i]))
  ) {
    throw malformed();
  }

  return parsed as Decoded<F>;
};

/** A cursor holding one non-negative integer (an offset or an event seq); 0 without one. */
export const decodeIntCursor = (cursor: string | undefined): number => {
  const value = decodeCursor(cursor, ["int"])?.[0] ?? 0;
  if (value < 0) throw malformed();

  return value;
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
