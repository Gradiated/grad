import type { EvalReport, RecipeKind } from "@sdk/generated/models.js";

import { int, num, pct } from "./format.js";

export interface ReportRow {
  label: string;
  value: string;
  /** Optional comparison, e.g. the base model's value. */
  hint?: string;
}

type Fmt = (v: unknown) => string;
const n: Fmt = (v) => (typeof v === "number" ? num(v) : "—");
const p: Fmt = (v) => (typeof v === "number" ? pct(v) : "—");
const i: Fmt = (v) => (typeof v === "number" ? int(v) : "—");
const s: Fmt = (v) => (v === null || v === undefined ? "—" : String(v));
const b: Fmt = (v) => (v === true ? "yes" : v === false ? "no" : "—");

type Field = [key: keyof EvalReport & string, label: string, fmt: Fmt];

/** The headline fields of each recipe's report, in reading order. */
const RECIPE_FIELDS: Record<string, Field[]> = {
  sft: [
    ["evalLoss", "Eval loss", n],
    ["evalTokenAccuracy", "Token accuracy", p],
    ["trainedTokenFraction", "Trained token fraction", p],
  ],
  dpo: [
    ["preferenceAccuracy", "Preference accuracy", p],
    ["rewardMargin", "Reward margin", n],
    ["beta", "Beta", n],
    ["trainPairs", "Train pairs", i],
    ["evalPairs", "Eval pairs", i],
  ],
  router: [
    ["fallbackModel", "Fallback model", s],
    ["fallbackQuality", "Fallback quality", n],
    ["routesAnyTraffic", "Routes any traffic", b],
    ["ece", "Calibration error (ECE)", n],
    ["pointwiseBrier", "Brier score", n],
  ],
  cartridge: [
    ["evalKl", "Eval KL", n],
    ["baseKl", "Base KL", n],
    ["noContextKl", "No-context KL", n],
    ["klReduction", "KL reduction", p],
    ["numTokens", "Cartridge tokens", i],
  ],
  embedding: [
    ["recallAt1", "Recall@1", p],
    ["recallAt5", "Recall@5", p],
    ["recallAt10", "Recall@10", p],
    ["mrr", "MRR", n],
    ["corpusSize", "Corpus size", i],
  ],
  distill: [
    ["teacher", "Teacher", s],
    ["rollout", "Rollout", s],
    ["evalKl", "Eval KL to teacher", n],
    ["baseKl", "Base KL to teacher", n],
    ["evalLoss", "Eval loss", n],
  ],
  reward: [
    ["preferenceAccuracy", "Preference accuracy", p],
    ["pointwiseBrier", "Brier score", n],
    ["ece", "Calibration error (ECE)", n],
    ["trainPoints", "Train points", i],
    ["evalPoints", "Eval points", i],
  ],
  decision: [
    ["trainExamples", "Train examples", i],
    ["evalExamples", "Eval examples", i],
  ],
};

const COMMON: Field[] = [
  ["metricName", "Selection metric", s],
  ["selectedStep", "Selected step", i],
  ["bestStep", "Best step", i],
  ["finalStep", "Final step", i],
  ["trainRecords", "Train records", i],
  ["evalRecords", "Eval records", i],
  ["droppedRecords", "Dropped records", i],
  ["truncated", "Truncated", i],
];

export interface RenderedReport {
  headline: ReportRow[];
  details: ReportRow[];
  pareto: ReportRow[];
  heads: { name: string; macroF1: number | null; accuracy: number | null }[];
  warnings: string[];
}

const rows = (report: EvalReport, fields: Field[]): ReportRow[] =>
  fields.filter(([k]) => report[k] !== undefined && report[k] !== null).map(([k, label, fmt]) => ({ label, value: fmt(report[k]) }));

export const renderReport = (kind: RecipeKind | string, report: EvalReport): RenderedReport => {
  const headline = rows(report, RECIPE_FIELDS[kind] ?? []);
  if (kind === "embedding" && report.baseline) {
    for (const row of headline) {
      const key = { "Recall@1": "recallAt1", "Recall@5": "recallAt5", "Recall@10": "recallAt10", MRR: "mrr" }[row.label] as keyof typeof report.baseline | undefined;
      const base = key ? report.baseline[key] : undefined;
      if (typeof base === "number") row.hint = `base ${row.label === "MRR" ? num(base) : pct(base)}`;
    }
  }
  const ps = report.paretoSummary;
  const pareto: ReportRow[] = ps
    ? [
        { label: "Offload rate", value: pct(ps.offloadRate) },
        { label: "Cost savings", value: ps.costSavingsPct === null ? "—" : `${num(ps.costSavingsPct, 3)}%` },
        { label: "Routed quality", value: num(ps.routedQuality) },
        { label: "Quality drop", value: `${num(ps.qualityDrop)} (target ≤ ${num(ps.targetMaxDrop)})` },
      ]
    : [];
  const heads = Object.entries(report.heads ?? {}).map(([name, h]) => ({
    name,
    macroF1: h?.macroF1 ?? null,
    accuracy: h?.accuracy ?? null,
  }));
  return { headline, details: rows(report, COMMON), pareto, heads, warnings: report.warnings ?? [] };
};
