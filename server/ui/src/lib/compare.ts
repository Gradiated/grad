import type { MetricPoint, Run } from "@sdk/generated/models.js";

import { smooth, type ChartColor, type ChartSeries } from "../components/chart.js";
import { CODEC, convertKeys } from "./api.js";
import { evalLossOf } from "./events.js";

// Run comparison: each run's thinned curve (GET /v1/runs/{id}/metrics?max_points=),
// one metric overlaid on a shared step axis, and the settings that differ.

/** Runs one comparison overlays: five palette colours, solid then dashed. */
export const MAX_COMPARE = 10;
/** Points per run the server thins each curve to. */
export const CURVE_POINTS = 1000;

const PALETTE: ChartColor[] = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"];

export const runStyle = (i: number): { color: ChartColor; dashed: boolean } => ({ color: PALETTE[i % PALETTE.length] as ChartColor, dashed: i >= PALETTE.length });

/** `?ids=a,b,c` → distinct ids, at most MAX_COMPARE. */
export const parseIds = (raw: string | null): string[] => [...new Set((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean))].slice(0, MAX_COMPARE);

export const compareHref = (ids: readonly string[]): string => `/runs/compare?ids=${ids.map(encodeURIComponent).join(",")}`;

export interface MetricDef {
  key: string;
  label: string;
  /** Formats axis and readout values. */
  kind: "number" | "usd" | "rate";
  of: (m: MetricPoint) => number | null;
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const FIXED: MetricDef[] = [
  { key: "loss", label: "Train loss", kind: "number", of: (m) => finite(m.loss) },
  { key: "eval_loss", label: "Eval loss", kind: "number", of: (m) => finite(evalLossOf(m)) },
  { key: "lr", label: "Learning rate", kind: "number", of: (m) => finite(m.lr) },
  { key: "grad_norm", label: "Grad norm", kind: "number", of: (m) => finite(m.gradNorm) },
  { key: "tokens_per_sec", label: "Throughput (tok/s)", kind: "rate", of: (m) => finite(m.tokensPerSec) },
  { key: "cost_usd", label: "Cost", kind: "usd", of: (m) => finite(m.costUsd) },
];

const evalMetric = (name: string): MetricDef => ({ key: `eval.${name}`, label: `Eval ${name.replace(/_/g, " ")}`, kind: "number", of: (m) => finite(m.evalMetrics?.[name]) });

/** The metrics at least one curve has: the fixed ones in order, each eval metric after eval loss. */
export const metricsOf = (curves: readonly MetricPoint[][]): MetricDef[] => {
  const names = new Set<string>();
  for (const points of curves) for (const m of points) for (const k of Object.keys(m.evalMetrics ?? {})) if (k !== "eval_loss") names.add(k);
  const all = [...FIXED.slice(0, 2), ...[...names].sort().map(evalMetric), ...FIXED.slice(2)];
  return all.filter((d) => curves.some((points) => points.some((m) => d.of(m) !== null)));
};

export const metricByKey = (key: string): MetricDef => FIXED.find((d) => d.key === key) ?? (key.startsWith("eval.") ? evalMetric(key.slice(5)) : (FIXED[0] as MetricDef));

/** The newest value of a metric on a curve. */
export const lastOf = (points: readonly MetricPoint[], def: MetricDef): number | null => {
  for (let i = points.length - 1; i >= 0; i--) {
    const v = def.of(points[i] as MetricPoint);
    if (v !== null) return v;
  }
  return null;
};

export interface Overlay {
  x: number[];
  series: ChartSeries[];
}

/**
 * One metric of every run on the union of their steps: each run's values are
 * smoothed over its own points first, then placed at its steps (null
 * elsewhere, which the chart spans), so runs logged at different steps line up.
 */
export const overlay = (runs: readonly { label: string; points: readonly MetricPoint[] }[], def: MetricDef, weight: number): Overlay => {
  const per = runs.map((r) => {
    const steps: number[] = [];
    const values: (number | null)[] = [];
    for (const m of r.points) {
      const v = def.of(m);
      if (v === null) continue;
      steps.push(m.step);
      values.push(v);
    }
    return { steps, values: weight > 0 ? smooth(values, weight) : values };
  });
  const x = [...new Set(per.flatMap((p) => p.steps))].sort((a, b) => a - b);
  const at = new Map(x.map((s, i) => [s, i]));
  const series = per.map((p, i) => {
    const aligned: (number | null)[] = new Array<number | null>(x.length).fill(null);
    p.steps.forEach((s, j) => (aligned[at.get(s) as number] = p.values[j] ?? null));
    const { color, dashed } = runStyle(i);
    const label = runs[i]?.label ?? "";
    // Sparse curves (an eval every N steps) draw their points.
    return { label, values: aligned, color, dashed, sparse: p.steps.length <= 60 };
  });
  return { x, series };
};

/** Distinct labels: a run's name, with its id when two runs share the name. */
export const labelsOf = (runs: readonly Pick<Run, "id" | "name">[]): string[] =>
  runs.map((r) => (runs.filter((o) => o.name === r.name).length > 1 ? `${r.name} (${r.id})` : r.name));

/** `{a: {b: 1}, c: [1, 2]}` → `[["a.b", "1"], ["c", "[1,2]"]]`; arrays stay whole. */
export const flatten = (value: unknown, prefix = ""): [string, string][] => {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
  }
  return [[prefix, value === undefined || value === null ? "—" : typeof value === "string" ? value : JSON.stringify(value)]];
};

export interface ConfigRow {
  key: string;
  values: string[];
  /** Some run's value is not the first run's. */
  differs: boolean;
}

/** Every resolved setting of the runs (wire names), one row each, in first-seen order; `name` is the column header. */
export const configRows = (runs: readonly Run[]): ConfigRow[] => {
  const maps = runs.map((r) => new Map(flatten(convertKeys(CODEC, "ResolvedRunConfig", r.resolvedConfig, "encode"))));
  const keys = [...new Set(maps.flatMap((m) => [...m.keys()]))].filter((k) => k !== "name");
  return keys.map((key) => {
    const values = maps.map((m) => m.get(key) ?? "—");
    return { key, values, differs: values.some((v) => v !== values[0]) };
  });
};
