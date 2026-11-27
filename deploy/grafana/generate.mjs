#!/usr/bin/env node
// Writes the grad Grafana dashboards (overview.json, training.json,
// evals-sources.json) next to this file. `--check` fails if they are stale.
//
//   node deploy/grafana/generate.mjs [--check]
//
// Every query reads grad-server's /metrics. Gauges sampled from Postgres are
// identical on every API replica, so they are read with max(), never sum().
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const DS = { type: "prometheus", uid: "${DS_PROMETHEUS}" };
const RATE = "$__rate_interval";

/** A selector with the dashboard's job filter: sel('kind="train"'). */
const sel = (extra = "") => `{job=~"$job"${extra ? `, ${extra}` : ""}}`;
const q = (expr, legendFormat = "") => ({ expr, legendFormat });
const p95 = (metric, by = "", extra = "") =>
  `histogram_quantile(0.95, sum by (le${by ? `, ${by}` : ""}) (rate(${metric}_bucket${sel(extra)}[${RATE}])))`;
const p50 = (metric, by = "", extra = "") =>
  `histogram_quantile(0.5, sum by (le${by ? `, ${by}` : ""}) (rate(${metric}_bucket${sel(extra)}[${RATE}])))`;

const UNITS = {
  s: "s",
  bytes: "bytes",
  Bps: "Bps",
  ratio: "percentunit",
  reqps: "reqps",
  ops: "ops",
  usd: "currencyUSD",
  none: "short",
};

/** Lays panels out left to right, `w` columns wide, wrapping at 24. */
const layout = (rows) => {
  let id = 1;
  let y = 0;
  const panels = [];
  for (const row of rows) {
    if (row.title) {
      panels.push({
        type: "row",
        id: id++,
        title: row.title,
        collapsed: false,
        gridPos: { h: 1, w: 24, x: 0, y },
        panels: [],
      });
      y += 1;
    }
    let x = 0;
    let rowHeight = 0;
    for (const panel of row.panels) {
      const w = panel.w ?? 8;
      const h = panel.h ?? 8;
      if (x + w > 24) {
        x = 0;
        y += rowHeight;
        rowHeight = 0;
      }
      panels.push(render(panel, id++, { h, w, x, y }));
      x += w;
      rowHeight = Math.max(rowHeight, h);
    }
    y += rowHeight;
  }

  return panels;
};

const render = (panel, id, gridPos) => {
  const stat = panel.type === "stat";
  return {
    type: panel.type ?? "timeseries",
    id,
    title: panel.title,
    description: panel.description ?? "",
    datasource: DS,
    gridPos,
    targets: panel.targets.map((t, i) => ({
      datasource: DS,
      refId: String.fromCharCode(65 + i),
      expr: t.expr,
      legendFormat: t.legendFormat || (stat ? "" : "__auto"),
      range: true,
      instant: false,
    })),
    fieldConfig: {
      defaults: {
        unit: UNITS[panel.unit ?? "none"],
        ...(panel.thresholds
          ? {
              thresholds: {
                mode: "absolute",
                steps: [
                  { color: "green", value: null },
                  ...panel.thresholds.map(([value, color]) => ({ color, value })),
                ],
              },
            }
          : {}),
        ...(stat ? {} : { custom: { drawStyle: "line", fillOpacity: 10, lineWidth: 1, showPoints: "never", stacking: { mode: panel.stack ? "normal" : "none" } } }),
      },
      overrides: [],
    },
    options: stat
      ? { reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false }, colorMode: "background", graphMode: "area", textMode: "auto" }
      : { legend: { displayMode: "list", placement: "bottom", showLegend: true }, tooltip: { mode: "multi", sort: "desc" } },
  };
};

const dashboard = ({ uid, title, description, rows }) => ({
  __inputs: [
    {
      name: "DS_PROMETHEUS",
      label: "Prometheus",
      description: "The Prometheus that scrapes grad-server's /metrics.",
      type: "datasource",
      pluginId: "prometheus",
      pluginName: "Prometheus",
    },
  ],
  __requires: [
    { type: "grafana", id: "grafana", name: "Grafana", version: "11.0.0" },
    { type: "datasource", id: "prometheus", name: "Prometheus", version: "1.0.0" },
    { type: "panel", id: "timeseries", name: "Time series", version: "" },
    { type: "panel", id: "stat", name: "Stat", version: "" },
  ],
  uid,
  title,
  description,
  tags: ["grad", "gradiated"],
  editable: true,
  graphTooltip: 1,
  schemaVersion: 41,
  version: 1,
  refresh: "30s",
  time: { from: "now-6h", to: "now" },
  timepicker: {},
  timezone: "",
  links: [
    { title: "grad dashboards", type: "dashboards", tags: ["grad"], asDropdown: true, includeVars: true, keepTime: true },
  ],
  annotations: { list: [] },
  templating: {
    list: [
      {
        // Resolves ${DS_PROMETHEUS} when the file is provisioned instead of imported.
        name: "DS_PROMETHEUS",
        label: "Data source",
        type: "datasource",
        query: "prometheus",
        current: {},
        hide: 0,
        refresh: 1,
        regex: "",
      },
      {
        name: "job",
        label: "Job",
        type: "query",
        datasource: DS,
        query: { query: "label_values(grad_build_info, job)", refId: "job" },
        definition: "label_values(grad_build_info, job)",
        includeAll: true,
        multi: true,
        allValue: ".*",
        current: { selected: true, text: ["All"], value: ["$__all"] },
        refresh: 2,
        sort: 1,
        hide: 0,
      },
    ],
  },
  panels: layout(rows),
});

const overview = dashboard({
  uid: "grad-overview",
  title: "grad / Overview",
  description: "grad-server: API health, the job queue, workers, throughput and errors.",
  rows: [
    {
      panels: [
        { type: "stat", w: 4, h: 4, title: "Requests/s", unit: "reqps", targets: [q(`sum(rate(grad_http_requests_total${sel()}[${RATE}]))`)] },
        { type: "stat", w: 4, h: 4, title: "5xx ratio", unit: "ratio", thresholds: [[0.01, "orange"], [0.05, "red"]], targets: [q(`sum(rate(grad_http_requests_total${sel('status_class="5xx"')}[${RATE}])) / clamp_min(sum(rate(grad_http_requests_total${sel()}[${RATE}])), 1e-9)`)] },
        { type: "stat", w: 4, h: 4, title: "p95 latency", unit: "s", thresholds: [[1, "orange"], [5, "red"]], targets: [q(p95("grad_http_request_duration_seconds"))] },
        { type: "stat", w: 4, h: 4, title: "Queued jobs", targets: [q(`max(sum by (instance) (grad_jobs${sel('status=~"queued|waiting_for_compute"')}))`)] },
        { type: "stat", w: 4, h: 4, title: "Workers online", thresholds: [], targets: [q(`max(sum by (instance) (grad_workers_online${sel()}))`)] },
        { type: "stat", w: 4, h: 4, title: "Oldest queued job", unit: "s", thresholds: [[600, "orange"], [1800, "red"]], targets: [q(`max(grad_job_oldest_queued_age_seconds${sel()})`)] },
      ],
    },
    {
      title: "API",
      panels: [
        { title: "Requests by status class", unit: "reqps", stack: true, targets: [q(`sum by (status_class) (rate(grad_http_requests_total${sel()}[${RATE}]))`, "{{status_class}}")] },
        { title: "p95 latency by route", unit: "s", targets: [q(`topk(10, ${p95("grad_http_request_duration_seconds", "route")})`, "{{route}}")] },
        { title: "5xx by route", unit: "reqps", targets: [q(`sum by (route) (rate(grad_http_requests_total${sel('status_class="5xx"')}[${RATE}])) > 0`, "{{route}}")] },
        { title: "Requests in flight", targets: [q(`sum by (instance) (grad_http_requests_in_flight${sel()})`, "{{instance}}")] },
      ],
    },
    {
      title: "Queue",
      panels: [
        { title: "Jobs by kind and status", stack: true, targets: [q(`max by (kind, status) (grad_jobs${sel()}) > 0`, "{{kind}} {{status}}")] },
        { title: "Open jobs (KEDA's target)", targets: [q(`max by (kind) (grad_jobs_open${sel()})`, "{{kind}}")] },
        { title: "Oldest queued job by kind", unit: "s", targets: [q(`max by (kind) (grad_job_oldest_queued_age_seconds${sel()})`, "{{kind}}")] },
        { title: "Wait for first claim (p50, p95)", unit: "s", targets: [q(p50("grad_job_claim_latency_seconds", "kind"), "p50 {{kind}}"), q(p95("grad_job_claim_latency_seconds", "kind"), "p95 {{kind}}")] },
        { title: "Jobs finished by kind and status", unit: "ops", stack: true, targets: [q(`sum by (kind, status) (rate(grad_job_duration_seconds_count${sel()}[${RATE}]))`, "{{kind}} {{status}}")] },
        { title: "Requeued attempts by reason", unit: "ops", targets: [q(`sum by (kind, reason) (rate(grad_job_requeues_total${sel()}[${RATE}]))`, "{{kind}} {{reason}}")] },
      ],
    },
    {
      title: "Workers and throughput",
      panels: [
        { title: "Workers online by kind", targets: [q(`max by (kind) (grad_workers_online${sel()})`, "{{kind}}")] },
        { title: "Workers by phase", stack: true, targets: [q(`max by (kind, phase) (grad_worker_phase${sel()})`, "{{kind}} {{phase}}")] },
        { title: "Heartbeats/s", unit: "ops", targets: [q(`sum by (kind) (rate(grad_worker_heartbeats_total${sel()}[${RATE}]))`, "{{kind}}")] },
        { title: "Training tokens/s", targets: [q(`sum(rate(grad_training_tokens_total${sel()}[${RATE}]))`, "server-counted"), q(`max(grad_worker_tokens_per_second${sel('kind="train"')})`, "worker-reported")] },
        { title: "Billed cost per hour", unit: "usd", targets: [q(`sum by (kind) (rate(grad_billed_cost_usd_total${sel()}[${RATE}])) * 3600`, "{{kind}}")] },
        { title: "Import records/s", unit: "ops", targets: [q(`sum by (kind, result) (rate(grad_import_records_total${sel()}[${RATE}]))`, "{{kind}} {{result}}")] },
      ],
    },
    {
      title: "Errors and internals",
      panels: [
        { title: "Maintenance step errors", unit: "ops", targets: [q(`sum by (step) (rate(grad_maintenance_step_errors_total${sel()}[${RATE}]))`, "{{step}}")] },
        { title: "Maintenance step p95", unit: "s", targets: [q(p95("grad_maintenance_step_duration_seconds", "step"), "{{step}}")] },
        { title: "Usage flush lag", unit: "s", targets: [q(`max(grad_usage_flush_lag_seconds${sel()})`, "lag")] },
        { title: "Postgres pool", targets: [q(`sum by (state) (grad_db_pool_connections${sel()})`, "{{state}}")] },
        { title: "Postgres queries (p95, errors/s)", unit: "s", targets: [q(p95("grad_db_query_duration_seconds"), "p95"), q(`sum(rate(grad_db_query_errors_total${sel()}[${RATE}]))`, "errors/s")] },
        { title: "Object storage p95 and errors by op", unit: "s", targets: [q(p95("grad_storage_operation_duration_seconds", "op"), "p95 {{op}}"), q(`sum by (op) (rate(grad_storage_operation_errors_total${sel()}[${RATE}])) > 0`, "errors/s {{op}}")] },
        { title: "Resident memory", unit: "bytes", targets: [q(`process_resident_memory_bytes${sel()}`, "{{instance}}")] },
        { title: "CPU", unit: "none", targets: [q(`rate(process_cpu_seconds_total${sel()}[${RATE}])`, "{{instance}}")] },
        { title: "Event loop lag p99", unit: "s", targets: [q(`nodejs_eventloop_lag_p99_seconds${sel()}`, "{{instance}}")] },
      ],
    },
  ],
});

const training = dashboard({
  uid: "grad-training",
  title: "grad / Training",
  description: "Training runs: status, durations, throughput, interruptions, checkpoints and GPUs.",
  rows: [
    {
      panels: [
        { type: "stat", w: 4, h: 4, title: "Running", targets: [q(`max(grad_jobs${sel('kind="train", status="running"')})`)] },
        { type: "stat", w: 4, h: 4, title: "Queued", targets: [q(`max(sum by (instance) (grad_jobs${sel('kind="train", status=~"queued|waiting_for_compute"')}))`)] },
        { type: "stat", w: 4, h: 4, title: "Waiting for compute", thresholds: [[1, "orange"]], targets: [q(`max(grad_jobs${sel('kind="train", status="waiting_for_compute"')})`)] },
        { type: "stat", w: 4, h: 4, title: "GPU workers online", targets: [q(`max(grad_workers_online${sel('kind="train"')})`)] },
        { type: "stat", w: 4, h: 4, title: "Tokens/s", targets: [q(`sum(rate(grad_training_tokens_total${sel()}[${RATE}]))`)] },
        { type: "stat", w: 4, h: 4, title: "Interruptions (24h)", thresholds: [[1, "orange"], [10, "red"]], targets: [q(`sum(increase(grad_job_requeues_total${sel('kind="train"')}[24h]))`)] },
      ],
    },
    {
      title: "Runs",
      panels: [
        { title: "Runs by status", stack: true, targets: [q(`max by (status) (grad_jobs${sel('kind="train"')}) > 0`, "{{status}}")] },
        { title: "Runs finished by status", unit: "ops", stack: true, targets: [q(`sum by (status) (rate(grad_job_duration_seconds_count${sel('kind="train"')}[${RATE}]))`, "{{status}}")] },
        { title: "Run duration by recipe (p50, p95)", unit: "s", targets: [q(p50("grad_job_duration_seconds", "recipe_kind", 'kind="train"'), "p50 {{recipe_kind}}"), q(p95("grad_job_duration_seconds", "recipe_kind", 'kind="train"'), "p95 {{recipe_kind}}")] },
        { title: "Wait for a GPU (p95) and oldest queued run", unit: "s", targets: [q(p95("grad_job_claim_latency_seconds", "", 'kind="train"'), "p95 first claim"), q(`max(grad_job_oldest_queued_age_seconds${sel('kind="train"')})`, "oldest queued")] },
        { title: "Attempts started and interrupted", unit: "ops", targets: [q(`sum(rate(grad_job_attempts_total${sel('kind="train"')}[${RATE}]))`, "started"), q(`sum by (reason) (rate(grad_job_requeues_total${sel('kind="train"')}[${RATE}]))`, "interrupted: {{reason}}")] },
        { title: "Billed training cost per hour", unit: "usd", targets: [q(`sum(rate(grad_billed_cost_usd_total${sel('kind="run"')}[${RATE}])) * 3600`, "USD/h")] },
      ],
    },
    {
      title: "Throughput and GPUs",
      panels: [
        { title: "Tokens/s by recipe", stack: true, targets: [q(`sum by (recipe_kind) (rate(grad_training_tokens_total${sel()}[${RATE}]))`, "{{recipe_kind}}")] },
        { title: "Tokens/s by model family", stack: true, targets: [q(`sum by (model_family) (rate(grad_training_tokens_total${sel()}[${RATE}]))`, "{{model_family}}")] },
        { title: "Worker-reported tokens/s", targets: [q(`max(grad_worker_tokens_per_second${sel('kind="train"')})`, "all workers")] },
        { title: "GPU utilisation (mean)", unit: "ratio", targets: [q(`max(grad_worker_gpu_utilization_ratio${sel('kind="train"')})`, "mean")] },
        { title: "GPU memory in use", unit: "bytes", targets: [q(`max(grad_worker_gpu_memory_used_bytes${sel('kind="train"')})`, "all workers")] },
        { title: "Workers by phase", stack: true, targets: [q(`max by (phase) (grad_worker_phase${sel('kind="train"')})`, "{{phase}}")] },
      ],
    },
    {
      title: "Checkpoints",
      panels: [
        { title: "Checkpoints by reason", unit: "ops", stack: true, targets: [q(`sum by (reason) (rate(grad_checkpoints_total${sel()}[${RATE}]))`, "{{reason}}")] },
        { title: "Checkpoint upload throughput", unit: "Bps", targets: [q(`sum(rate(grad_checkpoint_upload_bytes_total${sel()}[${RATE}]))`, "bytes/s")] },
        { title: "Checkpoint upload time (p50, p95)", unit: "s", targets: [q(p50("grad_checkpoint_upload_duration_seconds"), "p50"), q(p95("grad_checkpoint_upload_duration_seconds"), "p95")] },
      ],
    },
  ],
});

const evalsSources = dashboard({
  uid: "grad-evals-sources",
  title: "grad / Evals & Sources",
  description: "Evals (generation and judge calls) and source syncs from observability providers.",
  rows: [
    {
      panels: [
        { type: "stat", w: 4, h: 4, title: "Evals running", targets: [q(`max(grad_jobs${sel('kind="eval", status="running"')})`)] },
        { type: "stat", w: 4, h: 4, title: "Evals queued", targets: [q(`max(sum by (instance) (grad_jobs${sel('kind="eval", status=~"queued|blocked"')}))`)] },
        { type: "stat", w: 4, h: 4, title: "Judge error ratio", unit: "ratio", thresholds: [[0.02, "orange"], [0.1, "red"]], targets: [q(`sum(rate(grad_eval_judge_calls_total${sel('result="error"')}[${RATE}])) / clamp_min(sum(rate(grad_eval_judge_calls_total${sel()}[${RATE}])), 1e-9)`)] },
        { type: "stat", w: 4, h: 4, title: "Sources", targets: [q(`max(sum by (instance) (grad_sources${sel()}))`)] },
        { type: "stat", w: 4, h: 4, title: "Paused sources", thresholds: [[1, "red"]], targets: [q(`max(sum by (instance) (grad_sources_paused${sel()}))`)] },
        { type: "stat", w: 4, h: 4, title: "Most consecutive sync failures", thresholds: [[1, "orange"], [5, "red"]], targets: [q(`max(grad_source_consecutive_failures${sel()})`)] },
      ],
    },
    {
      title: "Evals",
      panels: [
        { title: "Evals by status", stack: true, targets: [q(`max by (status) (grad_jobs${sel('kind="eval"')}) > 0`, "{{status}}")] },
        { title: "Eval duration (p50, p95)", unit: "s", targets: [q(p50("grad_job_duration_seconds", "", 'kind="eval"'), "p50"), q(p95("grad_job_duration_seconds", "", 'kind="eval"'), "p95")] },
        { title: "Evals finished by status", unit: "ops", stack: true, targets: [q(`sum by (status) (rate(grad_job_duration_seconds_count${sel('kind="eval"')}[${RATE}]))`, "{{status}}")] },
        { title: "Outputs generated/s", unit: "ops", targets: [q(`sum by (result) (rate(grad_eval_outputs_total${sel()}[${RATE}]))`, "{{result}}")] },
        { title: "Judge calls/s", unit: "ops", targets: [q(`sum by (result) (rate(grad_eval_judge_calls_total${sel()}[${RATE}]))`, "{{result}}")] },
        { title: "Billed eval cost per hour", unit: "usd", targets: [q(`sum(rate(grad_billed_cost_usd_total${sel('kind="eval"')}[${RATE}])) * 3600`, "USD/h")] },
      ],
    },
    {
      title: "Sources",
      panels: [
        { title: "Syncs finished by provider and status", unit: "ops", stack: true, targets: [q(`sum by (provider, status) (rate(grad_source_syncs_total${sel()}[${RATE}]))`, "{{provider}} {{status}}")] },
        { title: "Records synced/s by provider", unit: "ops", targets: [q(`sum by (provider) (rate(grad_source_records_synced_total${sel()}[${RATE}]))`, "{{provider}}")] },
        { title: "Score updates/s by provider", unit: "ops", targets: [q(`sum by (provider) (rate(grad_source_score_updates_total${sel()}[${RATE}]))`, "{{provider}}")] },
        { title: "Consecutive failures by provider", targets: [q(`max by (provider) (grad_source_consecutive_failures${sel()})`, "{{provider}}")] },
        { title: "Paused sources by provider", targets: [q(`max by (provider) (grad_sources_paused${sel()})`, "{{provider}}")] },
        { title: "Sync duration (p95) and open syncs", unit: "s", targets: [q(p95("grad_job_duration_seconds", "", 'kind="sync"'), "p95 duration"), q(`max(sum by (instance) (grad_jobs${sel('kind="sync"')}))`, "open syncs")] },
      ],
    },
    {
      title: "Datasets and imports",
      panels: [
        { title: "Import records/s by result", unit: "ops", targets: [q(`sum by (kind, result) (rate(grad_import_records_total${sel()}[${RATE}]))`, "{{kind}} {{result}}")] },
        { title: "Dataset part bytes written/s", unit: "Bps", targets: [q(`sum by (form) (rate(grad_dataset_part_bytes_total${sel()}[${RATE}]))`, "{{form}}")] },
        { title: "Compression ratio", unit: "none", targets: [q(`sum(rate(grad_dataset_part_bytes_total${sel('form="uncompressed"')}[${RATE}])) / clamp_min(sum(rate(grad_dataset_part_bytes_total${sel('form="compressed"')}[${RATE}])), 1e-9)`, "uncompressed / compressed")] },
      ],
    },
  ],
});

export const DASHBOARDS = {
  "overview.json": overview,
  "training.json": training,
  "evals-sources.json": evalsSources,
};

const main = () => {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [file, body] of Object.entries(DASHBOARDS)) {
    const path = join(DIR, file);
    const text = `${JSON.stringify(body, null, 2)}\n`;
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = "";
    }
    if (current === text) continue;
    if (check) {
      console.error(`${file} is stale: run node deploy/grafana/generate.mjs`);
      stale += 1;
    } else {
      writeFileSync(path, text);
      console.log(`Wrote deploy/grafana/${file}`);
    }
  }
  if (stale) process.exit(1);
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
