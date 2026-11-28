#!/usr/bin/env node
// Writes the grad Grafana dashboard (grad.json) next to this file. `--check`
// fails if it is stale (or a dashboard file it doesn't write is present).
//
//   node deploy/grafana/generate.mjs [--check]
//
// One dashboard, one section per operational question. grad-server's
// /metrics carries the grad_* series, the workers' /metrics the
// grad_trainer_* ones, and Loki (when the Grafana has one) the logs. Gauges
// sampled from Postgres are identical on every API replica, so they are read
// with max(), never sum(). Variables: the Prometheus and Loki data sources,
// the namespace, and the worker pool (grad_trainer_* and worker Deployments).
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const PROM = { type: "prometheus", uid: "${DS_PROMETHEUS}" };
const LOKI = { type: "loki", uid: "${DS_LOKI}" };
const RATE = "$__rate_interval";

/** grad-server series of this namespace: s('kind="train"'). */
const s = (extra = "") => `{namespace=~"$namespace"${extra ? `, ${extra}` : ""}}`;
/** Worker series of this namespace and pool. */
const w = (extra = "") =>
  `{namespace=~"$namespace", pool=~"$pool"${extra ? `, ${extra}` : ""}}`;
const q = (expr, legendFormat = "") => ({ expr, legendFormat });
const quantile = (p, metric, by = "", extra = "", sel = s) =>
  `histogram_quantile(${p}, sum by (le${by ? `, ${by}` : ""}) (rate(${metric}_bucket${sel(extra)}[${RATE}])))`;
const p95 = (metric, by, extra, sel) => quantile(0.95, metric, by, extra, sel);
const p50 = (metric, by, extra, sel) => quantile(0.5, metric, by, extra, sel);
const rate = (metric, by = "", extra = "", sel = s) =>
  `sum${by ? ` by (${by})` : ""} (rate(${metric}${sel(extra)}[${RATE}]))`;
/** A ratio that is 0 instead of NaN when nothing happened. */
const ratio = (num, den) => `(${num}) / clamp_min(${den}, 1e-9)`;

/** The grad containers' log streams (kubelet, Alloy and Promtail all label `namespace` and `container`). */
const LOG_STREAMS = `{namespace=~"$namespace", container=~"grad-server|grad-eval-worker|grad-trainer|migrate"}`;

const AUTH_CODES =
  "unauthorized|forbidden|auth_unavailable|worker_auth_unavailable|worker_host_mismatch|gpu_memory_exceeds_token|job_kind_forbidden|workspace_suspended|workspace_deleted";

const UNITS = {
  s: "s",
  bytes: "bytes",
  Bps: "Bps",
  ratio: "percentunit",
  reqps: "reqps",
  ops: "ops",
  usd: "currencyUSD",
  dateTimeFromNow: "dateTimeFromNow",
  none: "short",
};

/** Lays panels out left to right, `w` columns wide, wrapping at 24. */
const layout = (rows) => {
  let id = 1;
  let y = 0;
  const panels = [];
  for (const row of rows) {
    panels.push({
      type: "row",
      id: id++,
      title: row.title,
      collapsed: false,
      gridPos: { h: 1, w: 24, x: 0, y },
      panels: [],
    });
    y += 1;
    let x = 0;
    let rowHeight = 0;
    for (const panel of row.panels) {
      const width = panel.w ?? 8;
      const h = panel.h ?? 8;
      if (x + width > 24) {
        x = 0;
        y += rowHeight;
        rowHeight = 0;
      }
      panels.push(render(panel, id++, { h, w: width, x, y }));
      x += width;
      rowHeight = Math.max(rowHeight, h);
    }
    y += rowHeight;
  }

  return panels;
};

const render = (panel, id, gridPos) => {
  const type = panel.type ?? "timeseries";
  const ds = type === "logs" || panel.loki ? LOKI : PROM;
  const base = {
    type,
    id,
    title: panel.title,
    description: panel.description ?? "",
    datasource: ds,
    gridPos,
    targets: panel.targets.map((t, i) => ({
      datasource: ds,
      refId: String.fromCharCode(65 + i),
      expr: t.expr,
      legendFormat: t.legendFormat || (type === "timeseries" ? "__auto" : ""),
      ...(ds === LOKI ? { queryType: "range" } : { range: true, instant: false }),
    })),
  };
  if (type === "logs") {
    return {
      ...base,
      options: {
        dedupStrategy: "none",
        enableLogDetails: true,
        prettifyLogMessage: false,
        showCommonLabels: false,
        showLabels: false,
        showTime: true,
        sortOrder: "Descending",
        wrapLogMessage: true,
      },
    };
  }
  const stat = type === "stat";

  return {
    ...base,
    fieldConfig: {
      defaults: {
        unit: UNITS[panel.unit ?? "none"],
        // Ratios stay on a 0-100% axis (an all-zero series would auto-scale).
        ...(panel.unit === "ratio" ? { min: 0, max: 1 } : {}),
        ...(panel.decimals !== undefined ? { decimals: panel.decimals } : {}),
        ...(panel.noValue ? { noValue: panel.noValue } : {}),
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
        ...(stat
          ? {}
          : {
              custom: {
                drawStyle: "line",
                fillOpacity: 10,
                lineWidth: 1,
                showPoints: "never",
                stacking: { mode: panel.stack ? "normal" : "none" },
              },
            }),
      },
      overrides: [],
    },
    options: stat
      ? {
          reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
          colorMode: panel.thresholds ? "background" : "value",
          graphMode: "area",
          textMode: "auto",
        }
      : {
          legend: { displayMode: "list", placement: "bottom", showLegend: true },
          tooltip: { mode: "multi", sort: "desc" },
        },
  };
};

const datasourceVar = (name, label, type) => ({
  name,
  label,
  type: "datasource",
  query: type,
  current: {},
  hide: 0,
  refresh: 1,
  regex: "",
});

const queryVar = (name, label, query) => ({
  name,
  label,
  type: "query",
  datasource: PROM,
  query: { query, refId: name },
  definition: query,
  includeAll: true,
  multi: true,
  allValue: ".*",
  current: { selected: true, text: ["All"], value: ["$__all"] },
  refresh: 2,
  sort: 1,
  hide: 0,
});

const dashboard = ({ uid, title, description, rows }) => ({
  __inputs: [
    {
      name: "DS_PROMETHEUS",
      label: "Prometheus",
      description: "The Prometheus that scrapes grad-server's and the workers' /metrics.",
      type: "datasource",
      pluginId: "prometheus",
      pluginName: "Prometheus",
    },
    {
      name: "DS_LOKI",
      label: "Loki",
      description: "The Loki with the grad pods' logs (optional: only the Logs section uses it).",
      type: "datasource",
      pluginId: "loki",
      pluginName: "Loki",
    },
  ],
  __requires: [
    { type: "grafana", id: "grafana", name: "Grafana", version: "11.0.0" },
    { type: "datasource", id: "prometheus", name: "Prometheus", version: "1.0.0" },
    { type: "datasource", id: "loki", name: "Loki", version: "1.0.0" },
    { type: "panel", id: "timeseries", name: "Time series", version: "" },
    { type: "panel", id: "stat", name: "Stat", version: "" },
    { type: "panel", id: "logs", name: "Logs", version: "" },
  ],
  uid,
  title,
  description,
  tags: ["grad", "gradiated", "training"],
  editable: true,
  graphTooltip: 1,
  schemaVersion: 41,
  version: 1,
  refresh: "30s",
  time: { from: "now-6h", to: "now" },
  timepicker: {},
  timezone: "",
  links: [],
  annotations: { list: [] },
  templating: {
    list: [
      // Resolve ${DS_*} when the file is provisioned instead of imported.
      datasourceVar("DS_PROMETHEUS", "Prometheus", "prometheus"),
      datasourceVar("DS_LOKI", "Loki", "loki"),
      queryVar("namespace", "Namespace", "label_values(grad_build_info, namespace)"),
      queryVar("pool", "Worker pool", "label_values(grad_trainer_phase, pool)"),
    ],
  },
  panels: layout(rows),
});

const KIND_NOTE = "kind: train, import (uploads and Hugging Face imports), sync (source syncs) or eval.";

const platform = dashboard({
  uid: "grad",
  title: "grad / Training platform",
  description:
    "grad-server, its job queue and workers: one section per question. Cloud-only sections (Billing, Cloud auth) stay empty on self-hosted servers.",
  rows: [
    {
      title: "Overview",
      panels: [
        { type: "stat", w: 3, h: 4, title: "API replicas", description: "grad-server replicas Prometheus scrapes (0: down, or the scrape is broken).", noValue: "0", targets: [q(`count(grad_build_info${s()})`)] },
        { type: "stat", w: 3, h: 4, title: "5xx ratio", unit: "ratio", thresholds: [[0.01, "orange"], [0.05, "red"]], description: "Share of API requests answered with a 5xx.", targets: [q(ratio(`${rate("grad_http_requests_total", "", 'status_class="5xx"')} or vector(0)`, rate("grad_http_requests_total")))] },
        { type: "stat", w: 3, h: 4, title: "p95 latency", unit: "s", thresholds: [[1, "orange"], [5, "red"]], targets: [q(p95("grad_http_request_duration_seconds"))] },
        { type: "stat", w: 3, h: 4, title: "Jobs waiting", description: "Claimable queued jobs, plus runs waiting for a GPU that fits.", targets: [q(`sum(max by (kind, status) (grad_jobs${s('status=~"queued|waiting_for_compute"')}))`)] },
        { type: "stat", w: 3, h: 4, title: "Oldest waiting", unit: "s", thresholds: [[600, "orange"], [1800, "red"]], targets: [q(`max(grad_job_oldest_queued_age_seconds${s()})`)] },
        { type: "stat", w: 3, h: 4, title: "Workers online", targets: [q(`sum(max by (kind) (grad_workers_online${s()}))`)] },
        { type: "stat", w: 3, h: 4, title: "Failed jobs (1h)", unit: "ratio", thresholds: [[0.1, "orange"], [0.25, "red"]], description: "Failed jobs over finished jobs in the last hour.", targets: [q(ratio(`sum(increase(grad_job_failures_total${s()}[1h])) or vector(0)`, `sum(increase(grad_job_duration_seconds_count${s()}[1h]))`))] },
        { type: "stat", w: 3, h: 4, title: "Last tick", unit: "s", thresholds: [[60, "orange"], [300, "red"]], description: "Seconds since the maintenance loop (lease expiry, gauges, usage, syncs) last finished a tick; it runs every 15 s.", targets: [q(`time() - max(grad_maintenance_last_tick_timestamp_seconds${s()})`)] },
      ],
    },
    {
      title: "Queue & scheduling",
      panels: [
        { title: "Jobs by kind and state", stack: true, description: `Open jobs. ${KIND_NOTE} blocked: waiting on another job; waiting_for_compute: no online worker has a GPU that fits.`, targets: [q(`max by (kind, status) (grad_jobs${s()}) > 0`, "{{kind}} {{status}}")] },
        { title: "Open jobs (KEDA's target)", description: "Claimable queued plus leased jobs per kind, minus those held back by their workspace's running cap.", targets: [q(`max by (kind) (grad_jobs_open${s()})`, "{{kind}}")] },
        { title: "Oldest claimable job by kind", unit: "s", targets: [q(`max by (kind) (grad_job_oldest_queued_age_seconds${s()})`, "{{kind}}")] },
        { title: "Wait for first claim (p50, p95)", unit: "s", targets: [q(p50("grad_job_claim_latency_seconds", "kind"), "p50 {{kind}}"), q(p95("grad_job_claim_latency_seconds", "kind"), "p95 {{kind}}")] },
        { title: "Fair share: wait and capped jobs", description: "Longest wait of a workspace's next job (workspaces below their running cap), and jobs held back by GRAD_MAX_RUNNING_PER_WORKSPACE_*.", targets: [q(`max by (kind) (grad_job_fair_share_wait_seconds${s()})`, "wait s {{kind}}"), q(`max by (kind) (grad_jobs_over_workspace_limit${s()}) > 0`, "capped {{kind}}")] },
        { title: "Rejected creates (429 queue_limit) and unfit runs", description: "Creates refused because a workspace hit GRAD_MAX_QUEUED_PER_WORKSPACE, and queued runs no online GPU can fit.", targets: [q(`${rate("grad_queue_limit_rejections_total", "kind")} * 60`, "429/min {{kind}}"), q(`max(grad_jobs_unfit${s()})`, "unfit runs")] },
      ],
    },
    {
      title: "Runs & jobs",
      panels: [
        { title: "Jobs finished by kind and status", unit: "ops", stack: true, targets: [q(rate("grad_job_duration_seconds_count", "kind, status"), "{{kind}} {{status}}")] },
        { title: "Failures by kind, recipe and error code", unit: "ops", stack: true, description: "attempts_exhausted: max_attempts attempts ended without a result (crashes, OOM, lost workers); preemptions_exhausted: compute reclaimed too often; invalid_artifact / source_unavailable: artifact imports; job_error: the worker reported the failure.", targets: [q(`${rate("grad_job_failures_total", "kind, recipe_kind, error_code")} > 0`, "{{kind}} {{recipe_kind}} {{error_code}}")] },
        { title: "Failure ratio by kind", unit: "ratio", targets: [q(ratio(rate("grad_job_failures_total", "kind"), rate("grad_job_duration_seconds_count", "kind")), "{{kind}}")] },
        { title: "Run duration by recipe (p50, p95)", unit: "s", description: "Creation to terminal status, queue wait included.", targets: [q(p50("grad_job_duration_seconds", "recipe_kind", 'kind="train"'), "p50 {{recipe_kind}}"), q(p95("grad_job_duration_seconds", "recipe_kind", 'kind="train"'), "p95 {{recipe_kind}}")] },
        { title: "Time per run phase (p50, p95)", unit: "s", description: "How long run attempts spend in each phase. queued and waiting_for_compute: waiting for a worker; starting: claim to the worker's first report; loading_model: claim to the first step (dataset and weight downloads, loading the weights, tokenizing); then training, evaluating, checkpointing, uploading (the final export) and completing.", targets: [q(p50("grad_run_phase_duration_seconds", "phase"), "p50 {{phase}}"), q(p95("grad_run_phase_duration_seconds", "phase"), "p95 {{phase}}")] },
        { title: "Leased GPU time by phase", unit: "percentunit", stack: true, description: "Share of the time workers hold a run (claim to completion) spent in each phase. Everything but training (and the evaluations the run asked for) is dead time on a GPU: setup, the final export and upload, completing.", targets: [q(ratio(rate("grad_run_phase_duration_seconds_sum", "phase", 'phase!~"queued|waiting_for_compute"'), rate("grad_run_phase_duration_seconds_sum", "", 'phase!~"queued|waiting_for_compute"')), "{{phase}}")] },
        { title: "Attempts started and interrupted", unit: "ops", description: "Interruptions by reason: compute_reclaimed (preemption, handed back), lease_lost (lease expired: a lost worker), worker_error, oom.", targets: [q(rate("grad_job_attempts_total", "kind"), "started {{kind}}"), q(rate("grad_job_requeues_total", "kind, reason"), "{{kind}} {{reason}}")] },
        { title: "Reclaims and emergency checkpoints", unit: "ops", description: "Train attempts handed back because compute was reclaimed, the emergency checkpoints that made it in, and those workers failed to save (grad_trainer_*: scraped workers only).", targets: [q(rate("grad_job_requeues_total", "", 'kind="train", reason="compute_reclaimed"'), "reclaimed"), q(rate("grad_checkpoints_total", "", 'reason="emergency"'), "emergency checkpoints saved"), q(rate("grad_trainer_checkpoints_total", "", 'reason="emergency", result="failed"', w), "emergency checkpoints failed")] },
        { title: "Lease expiries and fencing rejections", unit: "ops", description: "Leases the reaper expired, and worker writes refused because the attempt's lease is gone or bound elsewhere (409 lease_lost, 403 worker_host_mismatch).", targets: [q(rate("grad_job_requeues_total", "kind", 'reason="lease_lost"'), "expired {{kind}}"), q(rate("grad_http_errors_total", "code", 'code=~"lease_lost|worker_host_mismatch|wrong_job_kind"'), "{{code}}")] },
        { title: "Usage flush lag", unit: "s", description: "Longest a running attempt has gone without writing usage (a stalled worker or failing billing writes).", targets: [q(`max(grad_usage_flush_lag_seconds${s()})`, "lag")] },
      ],
    },
    {
      title: "Workers & GPUs",
      panels: [
        { title: "Workers online by kind", description: "Workers holding an unexpired lease (server view).", targets: [q(`max by (kind) (grad_workers_online${s()})`, "{{kind}}")] },
        { title: "Worker pods ready by pool", description: "Kubernetes only (kube-state-metrics).", targets: [q(`sum by (deployment) (kube_deployment_status_replicas_available{namespace=~"$namespace", deployment=~".+-worker-$pool"})`, "{{deployment}}")] },
        { title: "Workers by phase", stack: true, targets: [q(`max by (kind, phase) (grad_worker_phase${s()})`, "{{kind}} {{phase}}")] },
        { title: "Heartbeats/s", unit: "ops", targets: [q(rate("grad_worker_heartbeats_total", "kind"), "{{kind}}")] },
        { title: "Training throughput (tokens/s)", description: "Server-counted from usage, by recipe, and the sum workers last reported.", targets: [q(rate("grad_training_tokens_total", "recipe_kind"), "{{recipe_kind}}"), q(`max(grad_worker_tokens_per_second${s('kind="train"')})`, "worker-reported")] },
        { title: "Step time (p50, p95)", unit: "s", description: "Time between training steps (scraped workers).", targets: [q(p50("grad_trainer_step_duration_seconds", "", "", w), "p50"), q(p95("grad_trainer_step_duration_seconds", "", "", w), "p95")] },
        { title: "GPU utilisation", unit: "ratio", description: "Per GPU from NVML on scraped workers; the server's mean over heartbeats otherwise. Install NVIDIA's dcgm-exporter for SM occupancy, temperatures and XID errors.", targets: [q(`max by (pod, gpu) (grad_trainer_gpu_utilization_ratio${w()})`, "{{pod}} gpu{{gpu}}"), q(`max(grad_worker_gpu_utilization_ratio${s('kind="train"')})`, "heartbeat mean")] },
        { title: "GPU memory in use", unit: "bytes", targets: [q(`max by (pod, gpu) (grad_trainer_gpu_memory_used_bytes${w()})`, "{{pod}} gpu{{gpu}}"), q(`max(grad_worker_gpu_memory_used_bytes${s('kind="train"')})`, "heartbeat sum")] },
        { title: "Checkpoints by reason and result", unit: "ops", description: "Registered checkpoints (server) and those scraped workers failed to save.", targets: [q(rate("grad_checkpoints_total", "reason"), "registered {{reason}}"), q(`${rate("grad_trainer_checkpoints_total", "reason", 'result="failed"', w)} > 0`, "failed {{reason}}")] },
        { title: "Checkpoint upload throughput", unit: "Bps", targets: [q(rate("grad_checkpoint_upload_bytes_total"), "bytes/s")] },
        { title: "Checkpoint upload time (p50, p95)", unit: "s", targets: [q(p50("grad_checkpoint_upload_duration_seconds"), "p50"), q(p95("grad_checkpoint_upload_duration_seconds"), "p95")] },
        { title: "Worker jobs finished by status", unit: "ops", description: "Attempts scraped workers finished, by kind and status.", targets: [q(rate("grad_trainer_jobs_total", "kind, status", "", w), "{{kind}} {{status}}")] },
      ],
    },
    {
      title: "Evals",
      panels: [
        { title: "Evals by state", stack: true, targets: [q(`max by (status) (grad_jobs${s('kind="eval"')}) > 0`, "{{status}}")] },
        { title: "Evals finished by status", unit: "ops", stack: true, targets: [q(rate("grad_job_duration_seconds_count", "status", 'kind="eval"'), "{{status}}")] },
        { title: "Eval duration and wait (p50, p95)", unit: "s", targets: [q(p50("grad_job_duration_seconds", "", 'kind="eval"'), "duration p50"), q(p95("grad_job_duration_seconds", "", 'kind="eval"'), "duration p95"), q(p95("grad_job_claim_latency_seconds", "", 'kind="eval"'), "wait p95")] },
        { title: "Model outputs and judge calls/s", unit: "ops", targets: [q(rate("grad_eval_outputs_total", "result"), "outputs {{result}}"), q(rate("grad_eval_judge_calls_total", "result"), "judge {{result}}")] },
        { title: "Inference errors by reason", unit: "ops", description: "Failed model and judge calls after retries: rate_limited (429 from the gateway's eval lane), capacity_unavailable (no serving capacity, e.g. a pool waking from zero), timeout, unreachable, server_error, rejected (4xx), malformed.", targets: [q(`${rate("grad_eval_inference_errors_total", "target, reason")} > 0`, "{{target}} {{reason}}")] },
        { title: "Inference error ratio", unit: "ratio", targets: [q(ratio(rate("grad_eval_outputs_total", "", 'result="error"'), rate("grad_eval_outputs_total")), "model"), q(ratio(rate("grad_eval_judge_calls_total", "", 'result="error"'), rate("grad_eval_judge_calls_total")), "judge")] },
      ],
    },
    {
      title: "Sources",
      panels: [
        { title: "Syncs finished by provider and status", unit: "ops", stack: true, targets: [q(rate("grad_source_syncs_total", "provider, status"), "{{provider}} {{status}}")] },
        { title: "Records and score updates/s", unit: "ops", targets: [q(rate("grad_source_records_synced_total", "provider"), "records {{provider}}"), q(rate("grad_source_score_updates_total", "provider"), "scores {{provider}}")] },
        { title: "Sync lag by provider", unit: "s", description: "Longest an active scheduled source has gone without a successful sync.", targets: [q(`max by (provider) (grad_source_sync_lag_seconds${s()})`, "{{provider}}")] },
        { title: "Failing and paused sources", description: "Most consecutive failed syncs of any source, and sources paused after repeated failures.", targets: [q(`max by (provider) (grad_source_consecutive_failures${s()})`, "failures {{provider}}"), q(`max by (provider) (grad_sources_paused${s()})`, "paused {{provider}}")] },
        { title: "Sync duration (p95) and open syncs", unit: "s", targets: [q(p95("grad_job_duration_seconds", "", 'kind="sync"'), "p95 duration"), q(`sum(max by (status) (grad_jobs${s('kind="sync"')}))`, "open syncs")] },
        { title: "Import records/s and dataset bytes", unit: "ops", targets: [q(rate("grad_import_records_total", "kind, result"), "{{kind}} {{result}}"), q(rate("grad_dataset_part_bytes_total", "form"), "bytes/s {{form}}")] },
      ],
    },
    {
      title: "Billing & usage (Cloud)",
      panels: [
        { title: "Usage push lag and backlog", unit: "s", description: "Cloud: age of the oldest ledger row not yet pushed to billing, and the rows waiting.", targets: [q(`max(grad_usage_export_lag_seconds${s()})`, "lag s"), q(`max(grad_usage_export_pending_rows${s()})`, "pending rows")] },
        { title: "Usage push failures/min", targets: [q(`${rate("grad_usage_export_failures_total")} * 60`, "failures/min")] },
        { title: "Parked usage rows", description: "Cloud: ledger rows billing ingest refused for good (422/409). The rest keep exporting; retry these by hand once the cause is fixed (CLOUD_MODE.md).", targets: [q(`max(grad_usage_parked_rows${s()})`, "parked rows")] },
        { title: "Balance checks by op and result", unit: "ops", description: "start: a new run or eval (refused: 402-style insufficient balance); continue: a running job's heartbeat (refused: the job stops as stopped_balance). Errors never stop running work.", targets: [q(rate("grad_billing_checks_total", "op, result"), "{{op}} {{result}}")] },
        { title: "Balance stops", unit: "ops", description: "Runs that stopped because the workspace ran out of balance.", targets: [q(rate("grad_job_duration_seconds_count", "kind", 'status="stopped_balance"'), "{{kind}}")] },
        { title: "Price list age", unit: "s", description: "Cloud: since the price list was last confirmed; past 24 h new runs and evals are refused (503 billing_unavailable).", targets: [q(`max(grad_price_list_age_seconds${s()})`, "oldest replica")] },
        { title: "Billed cost per hour", unit: "usd", targets: [q(`${rate("grad_billed_cost_usd_total", "kind")} * 3600`, "{{kind}}")] },
      ],
    },
    {
      title: "Auth & security",
      panels: [
        { title: "Worker auth by mode and result", unit: "ops", description: "Worker-protocol requests: mode static, kubernetes (TokenReview) or lease; none = no worker credential (rejected).", targets: [q(rate("grad_worker_auth_total", "mode, result"), "{{mode}} {{result}}")] },
        { title: "TokenReviews by result", unit: "ops", description: "saturated: refused because 8 reviews were already in flight on the replica (503 worker_auth_unavailable).", targets: [q(rate("grad_token_reviews_total", "result"), "{{result}}"), q(`max(grad_token_reviews_in_flight${s()})`, "in flight (max)")] },
        { title: "TokenReview latency (p50, p95)", unit: "s", targets: [q(p50("grad_token_review_duration_seconds"), "p50"), q(p95("grad_token_review_duration_seconds"), "p95")] },
        { title: "Credential cache hit ratio", unit: "ratio", description: "cloud_key: the Cloud API-key cache (5 s); kubernetes: reviewed service-account tokens (60 s).", targets: [q(ratio(rate("grad_auth_cache_lookups_total", "mode", 'result="hit"'), rate("grad_auth_cache_lookups_total", "mode")), "{{mode}}")] },
        { title: "Auth errors by code", unit: "ops", description: "401/403/503 answers about credentials: unauthorized, forbidden (scope), auth_unavailable (Cloud auth view down), worker_auth_unavailable, workspace_suspended, ...", targets: [q(`${rate("grad_http_errors_total", "code", `code=~"${AUTH_CODES}"`)} > 0`, "{{code}}")] },
        { title: "Cloud API-key lookups", unit: "ops", targets: [q(rate("grad_cloud_auth_lookups_total", "result"), "{{result}}")] },
      ],
    },
    {
      title: "API & SSE",
      panels: [
        { title: "Requests by status class", unit: "reqps", stack: true, targets: [q(rate("grad_http_requests_total", "status_class"), "{{status_class}}")] },
        { title: "p95 latency by route", unit: "s", targets: [q(`topk(10, ${p95("grad_http_request_duration_seconds", "route")})`, "{{route}}")] },
        { title: "5xx by route", unit: "reqps", targets: [q(`${rate("grad_http_requests_total", "route", 'status_class="5xx"')} > 0`, "{{route}}")] },
        { title: "Errors by code", unit: "reqps", description: "Every problem+json error response by its code.", targets: [q(`topk(10, ${rate("grad_http_errors_total", "code")} > 0)`, "{{code}}")] },
        { title: "Requests in flight", targets: [q(`sum by (pod) (grad_http_requests_in_flight${s()})`, "{{pod}}")] },
        { title: "Open SSE streams", description: "Run event and metric streams per replica; a replica whose event hub isn't LISTENing falls back to the safety poll.", targets: [q(`sum by (pod) (grad_sse_streams${s()})`, "{{pod}}"), q(`sum by (pod) (1 - grad_sse_hub_listening${s()}) > 0`, "not listening {{pod}}")] },
        { title: "Event hub fetches and notifications/s", unit: "ops", targets: [q(rate("grad_sse_hub_fetches_total", "reason"), "fetches {{reason}}"), q(rate("grad_sse_hub_notifications_total"), "notifications")] },
        { title: "Event dispatch latency (p50, p95)", unit: "s", targets: [q(p50("grad_sse_dispatch_latency_seconds"), "p50"), q(p95("grad_sse_dispatch_latency_seconds"), "p95")] },
      ],
    },
    {
      title: "Dependencies (Postgres, S3)",
      panels: [
        { title: "Postgres pool", description: "Connections per state; waiting > 0 means requests queue for a connection.", targets: [q(`sum by (state) (grad_db_pool_connections${s()})`, "{{state}}")] },
        { title: "Postgres queries (p95) and errors/s", unit: "s", targets: [q(p95("grad_db_query_duration_seconds"), "p95"), q(rate("grad_db_query_errors_total"), "errors/s")] },
        { title: "Object storage p95 by op", unit: "s", targets: [q(p95("grad_storage_operation_duration_seconds", "op"), "{{op}}")] },
        { title: "Object storage errors/s by op", unit: "ops", targets: [q(`${rate("grad_storage_operation_errors_total", "op")} > 0`, "{{op}}")] },
        { title: "Maintenance step errors and p95", unit: "s", targets: [q(p95("grad_maintenance_step_duration_seconds", "step"), "p95 {{step}}"), q(`${rate("grad_maintenance_step_errors_total", "step")} > 0`, "errors/s {{step}}")] },
        { title: "grad-server memory", unit: "bytes", w: 4, description: "Resident memory per API replica.", targets: [q(`max by (pod) (process_resident_memory_bytes${s()} and on (pod, instance) grad_build_info${s()})`, "{{pod}}")] },
        { title: "Event loop lag (p99)", unit: "s", w: 4, targets: [q(`max by (pod) (nodejs_eventloop_lag_p99_seconds${s()})`, "{{pod}}")] },
      ],
    },
    {
      title: "Logs",
      panels: [
        { title: "Log lines by level", loki: true, w: 24, h: 6, stack: true, description: "Needs a Loki data source with the grad pods' logs (labels namespace and container).", targets: [q(`sum by (level) (count_over_time(${LOG_STREAMS} | json level [$__auto]))`, "{{level}}")] },
        { type: "logs", w: 24, h: 10, title: "Errors and warnings", description: "JSON lines with level warn or error; each carries request_id, job_id, workspace_id and trace_id where they apply, and errors their stack.", targets: [q(`${LOG_STREAMS} | json level | level=~"warn|error"`)] },
        { type: "logs", w: 24, h: 12, title: "All grad logs", targets: [q(LOG_STREAMS)] },
      ],
    },
  ],
});

export const DASHBOARDS = { "grad.json": platform };

const main = () => {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const file of readdirSync(DIR)) {
    if (file.endsWith(".json") && !(file in DASHBOARDS)) {
      console.error(`${file} is not generated by generate.mjs: delete it`);
      stale += 1;
    }
  }
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
