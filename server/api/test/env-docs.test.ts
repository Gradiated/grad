import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EnvironmentSchema,
  WorkerEnvironmentSchema,
} from "../src/environment.js";

const DOCS = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../docs",
);

/** The rows of the first table under `heading`: [names, default cell]. */
const tableRows = (file: string, heading: string) => {
  const text = readFileSync(path.join(DOCS, file), "utf8");
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, `${file}: ${heading}`).toBeGreaterThan(-1);
  const rows: Array<{ names: string[]; defaults: string }> = [];
  let inTable = false;
  for (const line of text.slice(start + heading.length + 2).split("\n")) {
    if (!line.startsWith("|")) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const names = [
      ...(cells[0] ?? "").matchAll(/`([A-Z][A-Z0-9_]*)(=[^`]*)?`/g),
    ].map((m) => m[1] as string);
    if (names.length > 0) rows.push({ names, defaults: cells[1] ?? "" });
  }

  return rows;
};

/** Each schema key's default as the docs write it, or undefined (none). */
const defaultsOf = (schema: {
  shape: Record<
    string,
    { safeParse(v: unknown): { success: boolean; data?: unknown } }
  >;
}) =>
  new Map(
    Object.entries(schema.shape).map(([key, field]) => {
      const parsed = field.safeParse(undefined);
      const value = parsed.success ? parsed.data : undefined;

      return [key, value === undefined ? undefined : String(value)];
    }),
  );

/** `a` / `b` or `a`, `b` default cells, one literal per name ("`8` each" for all). */
const documentedDefaults = (names: string[], cell: string) => {
  const literals = [...cell.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
  if (/^`[^`]*` each$/.test(cell)) return names.map(() => literals[0]);
  const parts = cell.split(/ \/ |, /);
  if (parts.length !== names.length) return names.map(() => undefined);

  return parts.map((p) => /^`([^`]*)`$/.exec(p.trim())?.[1]);
};

// Read outside the schemas (the OpenTelemetry SDK, the worker's token source).
const READ_ELSEWHERE = new Set([
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "GRAD_WORKER_TOKEN",
  "GRAD_WORKER_TOKEN_FILE",
]);

const check = (
  schema: Parameters<typeof defaultsOf>[0],
  rows: ReturnType<typeof tableRows>,
  label: string,
) => {
  const defaults = defaultsOf(schema);
  const documented = new Set(rows.flatMap((r) => r.names));
  const missing = [...defaults.keys()].filter((k) => !documented.has(k));
  expect(missing, `${label}: read but not documented`).toEqual([]);
  const unknown = [...documented].filter(
    (n) => !defaults.has(n) && !READ_ELSEWHERE.has(n),
  );
  expect(unknown, `${label}: documented but not read`).toEqual([]);
  for (const row of rows) {
    documentedDefaults(row.names, row.defaults).forEach((doc, i) => {
      const name = row.names[i] as string;
      const code = defaults.get(name);
      // Prose defaults ("none", "the API port") are checked by reading.
      if (doc !== undefined && code !== undefined) {
        expect(doc, `${label}: ${name}'s default`).toBe(code);
      }
    });
  }
};

describe("the docs' settings tables match the code", () => {
  it("grad-server: SELF_HOSTING.md and CLOUD_MODE.md list every variable, with its default", () => {
    check(
      EnvironmentSchema,
      [
        ...tableRows("SELF_HOSTING.md", "## Server configuration"),
        ...tableRows("CLOUD_MODE.md", "## Settings"),
      ],
      "grad-server",
    );
  });

  it("eval workers: SELF_HOSTING.md's eval worker table", () => {
    const endpoints = tableRows("CLOUD_MODE.md", "## Settings").filter((r) =>
      r.names.some((n) => n.startsWith("GRAD_CLOUD_GATEWAY")),
    );
    check(
      WorkerEnvironmentSchema,
      [...tableRows("SELF_HOSTING.md", "## Eval workers"), ...endpoints],
      "eval worker",
    );
  });
});
