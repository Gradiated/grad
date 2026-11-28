import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { describeMetrics, registry } from "../src/telemetry/metrics.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const GRAFANA = path.join(ROOT, "deploy/grafana");
const DASHBOARDS = ["grad.json"];
/** Labels Prometheus adds when it scrapes (pool: the worker pool, see the PodMonitor), plus histogram buckets. */
const TARGET_LABELS = new Set([
  "job",
  "instance",
  "namespace",
  "pod",
  "service",
  "pool",
  "le",
]);
/** Series from outside grad a panel may read (Kubernetes only), with their labels. */
const EXTERNAL = new Map([
  ["kube_deployment_status_replicas_available", new Set(["deployment"])],
]);
/** The sections the dashboard must keep, in order. */
const SECTIONS = [
  "Overview",
  "Queue & scheduling",
  "Runs & jobs",
  "Workers & GPUs",
  "Evals",
  "Sources",
  "Billing & usage (Cloud)",
  "Auth & security",
  "API & SSE",
  "Dependencies (Postgres, S3)",
  "Logs",
];

interface Panel {
  id: number;
  type: string;
  title: string;
  datasource?: { type: string; uid: string };
  gridPos: { x: number; y: number; w: number; h: number };
  targets?: Array<{ expr: string; datasource: { type: string; uid: string } }>;
}

const load = (file: string) =>
  JSON.parse(readFileSync(path.join(GRAFANA, file), "utf8")) as {
    uid: string;
    schemaVersion: number;
    __inputs: Array<{ name: string; pluginId: string }>;
    title: string;
    templating: { list: Array<{ name: string; type: string }> };
    panels: Panel[];
  };

/** Every series name the server exports, with its labels (histograms expanded). */
const exported = async (): Promise<Map<string, Set<string>>> => {
  const names = new Map<string, Set<string>>();
  for (const m of await describeMetrics()) {
    const labels = new Set(m.labels);
    const series =
      m.type === "histogram"
        ? [`${m.name}_bucket`, `${m.name}_sum`, `${m.name}_count`]
        : [m.name];
    for (const s of series) names.set(s, labels);
  }
  // The workers' grad_trainer_* metrics (grad_trainer/telemetry.py):
  // counters gain _total, histograms _bucket/_sum/_count.
  const telemetry = readFileSync(
    path.join(ROOT, "server/trainer/grad_trainer/telemetry.py"),
    "utf8",
  );
  // Constructor(name, help[, [labels] | labels=[labels]]).
  const TRAINER_METRIC =
    /(Counter|Gauge|Histogram|GaugeMetricFamily)\(\s*"(grad_trainer_\w+)",\s*"(?:[^"\\]|\\.)*"(?:,\s*(?:labels=)?\[([^\]]*)\])?/g;
  let trainerMetrics = 0;
  for (const [, type, name, list] of telemetry.matchAll(TRAINER_METRIC)) {
    const labels = new Set(
      [...(list ?? "").matchAll(/"(\w+)"/g)].map((l) => l[1] as string),
    );
    const series =
      type === "Counter"
        ? [`${name}_total`]
        : type === "Histogram"
          ? [`${name}_bucket`, `${name}_sum`, `${name}_count`]
          : [name as string];
    for (const n of series) names.set(n, labels);
    trainerMetrics += 1;
  }
  if (trainerMetrics < 10) throw new Error("telemetry.py: metrics not found");
  for (const [name, labels] of EXTERNAL) names.set(name, labels);
  // Default process metrics (process_*, nodejs_*), with histogram series.
  for (const m of await registry.getMetricsAsJSON()) {
    if (m.name.startsWith("grad_")) continue;
    names.set(m.name, new Set());
    for (const v of m.values as Array<{
      metricName?: string;
      labels?: Record<string, unknown>;
    }>) {
      names.set(v.metricName ?? m.name, new Set(Object.keys(v.labels ?? {})));
    }
  }

  return names;
};

/** Metric names, and label names used in their selectors, of a PromQL expression. */
const references = (expr: string) => {
  const metrics = [
    ...expr.matchAll(
      /\b((?:grad|process|nodejs|kube)_[a-z0-9_]+)(\{[^}]*\})?/g,
    ),
  ].map((m) => ({
    name: m[1] as string,
    labels: [...(m[2] ?? "").matchAll(/(\w+)\s*(?:=~|!~|!=|=)/g)].map(
      (l) => l[1] as string,
    ),
  }));
  const grouped = [...expr.matchAll(/\bby\s*\(([^)]*)\)/g)].flatMap((m) =>
    (m[1] as string)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  return { metrics, grouped };
};

/** Checks one expression against the exported metrics; returns problems. */
const problems = (expr: string, names: Map<string, Set<string>>): string[] => {
  const { metrics, grouped } = references(expr);
  const out: string[] = [];
  if (metrics.length === 0) out.push(`no grad metric in: ${expr}`);
  const known = new Set<string>(TARGET_LABELS);
  for (const m of metrics) {
    const labels = names.get(m.name);
    if (!labels) {
      out.push(`unknown metric ${m.name}`);
      continue;
    }
    labels.forEach((l) => known.add(l));
    for (const l of m.labels) {
      if (!labels.has(l) && !TARGET_LABELS.has(l))
        out.push(`${m.name} has no label ${l}`);
    }
  }
  for (const l of grouped)
    if (!known.has(l)) out.push(`grouping by unknown label ${l}`);

  return out;
};

describe("Grafana dashboards", () => {
  it("are generated from deploy/grafana/generate.mjs", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [path.join(GRAFANA, "generate.mjs"), "--check"],
        {
          stdio: "pipe",
        },
      ),
    ).not.toThrow();
  });

  it("import anywhere: DS_PROMETHEUS and DS_LOKI inputs, recent schema, unique ids", () => {
    const uids = new Set<string>();
    for (const file of DASHBOARDS) {
      const d = load(file);
      expect(d.schemaVersion, file).toBeGreaterThanOrEqual(39);
      expect(uids.has(d.uid), file).toBe(false);
      uids.add(d.uid);
      expect(d.__inputs).toEqual([
        expect.objectContaining({
          name: "DS_PROMETHEUS",
          pluginId: "prometheus",
        }),
        expect.objectContaining({ name: "DS_LOKI", pluginId: "loki" }),
      ]);
      const vars = Object.fromEntries(
        d.templating.list.map((v) => [v.name, v.type]),
      );
      expect(vars).toEqual({
        DS_PROMETHEUS: "datasource",
        DS_LOKI: "datasource",
        namespace: "query",
        pool: "query",
      });
      expect(
        d.panels.filter((p) => p.type === "row").map((p) => p.title),
      ).toEqual(SECTIONS);
      const ids = new Set<number>();
      for (const panel of d.panels) {
        expect(ids.has(panel.id), `${file} panel id ${panel.id}`).toBe(false);
        ids.add(panel.id);
        expect(
          panel.gridPos.x + panel.gridPos.w,
          panel.title,
        ).toBeLessThanOrEqual(24);
        if (panel.type === "row") continue;
        const uid =
          panel.datasource?.type === "loki" ? "${DS_LOKI}" : "${DS_PROMETHEUS}";
        expect(panel.datasource?.uid, panel.title).toBe(uid);
        expect(panel.targets?.length, panel.title).toBeGreaterThan(0);
        for (const t of panel.targets ?? [])
          expect(t.datasource.uid, panel.title).toBe(uid);
      }
    }
  });

  it("query only metrics and labels the server exports", async () => {
    const names = await exported();
    const found: string[] = [];
    for (const file of DASHBOARDS) {
      for (const panel of load(file).panels) {
        for (const t of panel.targets ?? []) {
          if (t.datasource.type === "loki") continue;
          found.push(
            ...problems(t.expr, names).map(
              (p) => `${file} "${panel.title}": ${p}`,
            ),
          );
          // Every selector honours the namespace variable.
          for (const m of references(t.expr).metrics) {
            if (!m.labels.includes("namespace"))
              found.push(
                `${file} "${panel.title}": ${m.name} ignores $namespace`,
              );
          }
        }
      }
    }
    expect(found).toEqual([]);
  });

  it("alert rules and the KEDA query use exported metrics too", async () => {
    const names = await exported();
    const helm = path.join(ROOT, "server/helm/grad/templates");
    for (const file of ["prometheusrule.yaml", "_helpers.tpl"]) {
      const text = readFileSync(path.join(helm, file), "utf8");
      const used = [...text.matchAll(/\bgrad_[a-z0-9_]+/g)].map((m) => m[0]);
      expect(used.length, file).toBeGreaterThan(0);
      for (const name of used)
        expect(
          names.has(name) || names.has(`${name}_count`),
          `${file}: ${name}`,
        ).toBe(true);
    }
  });

  it("every alert is a warning with a runbook entry in docs/SELF_HOSTING.md", () => {
    const rules = readFileSync(
      path.join(ROOT, "server/helm/grad/templates/prometheusrule.yaml"),
      "utf8",
    );
    const docs = readFileSync(path.join(ROOT, "docs/SELF_HOSTING.md"), "utf8");
    const alerts = [...rules.matchAll(/- alert: (\w+)/g)].map((m) => m[1]);
    expect(alerts.length).toBeGreaterThan(5);
    expect(rules.match(/runbook_url: /g)?.length).toBe(alerts.length);
    expect(rules.match(/severity: warning/g)?.length).toBe(alerts.length);
    expect(rules).not.toMatch(/severity: (critical|page)/);
    for (const alert of alerts) {
      expect(rules, alert).toContain(`#${alert?.toLowerCase()}`);
      expect(docs, `runbook entry for ${alert}`).toContain(`\n#### ${alert}\n`);
    }
  });

  it("catches an unknown metric or label", async () => {
    const names = await exported();
    expect(problems('sum(grad_nope{job=~"$job"})', names)).toEqual([
      "unknown metric grad_nope",
    ]);
    expect(problems('max by (kind) (grad_jobs{color="x"})', names)).toEqual([
      "grad_jobs has no label color",
    ]);
    expect(problems("sum by (color) (grad_jobs)", names)).toEqual([
      "grouping by unknown label color",
    ]);
  });
});

describe("docs/METRICS.md", () => {
  it("lists every exported metric (pnpm -C server/api metrics:docs)", async () => {
    const { OUT_PATH, renderMetricsDoc } = await import(
      "../scripts/emit-metrics-doc.js"
    );
    expect(readFileSync(OUT_PATH, "utf8")).toBe(await renderMetricsDoc());
  });
});
