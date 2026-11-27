import { createHash } from "node:crypto";

import type { DatasetFilter, DatasetRecord } from "../contracts.js";
import { invalid } from "../errors.js";

type Op = ">=" | "<=" | ">" | "<" | "==" | "!=";

interface Condition {
  name: string;
  op: Op;
  value: number;
}

const CONDITION = /^\s*(>=|<=|==|!=|>|<)?\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s*$/i;

/** Parses `">=0.8"`, `"==1"`, `"0.5"` (means ==) or a number into a condition. */
export const parseCondition = (
  name: string,
  raw: string | number,
): Condition => {
  if (typeof raw === "number") return { name, op: "==", value: raw };
  const match = CONDITION.exec(raw);
  if (!match) {
    throw invalid(
      "invalid_filter",
      `Score condition '${name}: ${raw}' is not '<op><number>' (ops: >=, <=, >, <, ==, !=), for example ">=0.8".`,
    );
  }

  return { name, op: (match[1] ?? "==") as Op, value: Number(match[2]) };
};

const holds = (value: number, { op, value: bound }: Condition): boolean => {
  switch (op) {
    case ">=":
      return value >= bound;
    case "<=":
      return value <= bound;
    case ">":
      return value > bound;
    case "<":
      return value < bound;
    case "==":
      return value === bound;
    default:
      return value !== bound;
  }
};

/** Compiles a filter into a record predicate; throws 422 on a malformed condition. */
export const compileFilter = (
  filter: DatasetFilter,
): ((record: DatasetRecord) => boolean) => {
  const conditions = Object.entries(filter.scores ?? {}).map(([name, raw]) =>
    parseCondition(name, raw),
  );
  const metadata = Object.entries(filter.metadata ?? {});
  const after = filter.created_after ? Date.parse(filter.created_after) : null;
  const before = filter.created_before
    ? Date.parse(filter.created_before)
    : null;
  const ids = filter.ids ? new Set(filter.ids) : null;

  return (record) => {
    if (ids && !(record.id !== undefined && ids.has(record.id))) return false;

    for (const c of conditions) {
      const score = record.scores?.[c.name];
      if (score === undefined || !holds(score, c)) return false;
    }

    for (const [key, want] of metadata) {
      if (record.metadata?.[key] !== want) return false;
    }

    if (after !== null || before !== null) {
      const at = record.timestamp ? Date.parse(record.timestamp) : Number.NaN;
      if (Number.isNaN(at)) return false;
      if (after !== null && at < after) return false;
      if (before !== null && at >= before) return false;
    }

    return true;
  };
};

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }

  return value;
};

/** JSON with sorted keys (Postgres JSONB does not keep key order). */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(canonical(value));

/**
 * The view's default name: the source name plus a hash of (source dataset,
 * version, filter), so re-running the same filter returns the same view.
 */
export const viewName = (
  source: { id: string; name: string },
  version: number,
  filter: DatasetFilter,
): string => {
  const digest = createHash("sha256")
    .update(canonicalJson({ id: source.id, version, filter }))
    .digest("hex")
    .slice(0, 10);

  return `${source.name.slice(0, 51)}-f-${digest}`;
};
