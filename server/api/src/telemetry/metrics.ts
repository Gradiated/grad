import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from "@prometheus-io/client";

/**
 * grad-server's Prometheus metrics: one registry for the process, `grad_`
 * names, and low-cardinality labels only (kinds, statuses, route templates,
 * providers; never run, dataset or workspace ids). The cardinality test
 * holds every label name to LABELS below.
 */

/** Every label a grad_ metric may carry (the cardinality guard's allowlist). */
export const LABELS = [
  "code",
  "error_code",
  "form",
  "kind",
  "method",
  "mode",
  "model_family",
  "op",
  "phase",
  "provider",
  "reason",
  "recipe_kind",
  "result",
  "route",
  "state",
  "status",
  "status_class",
  "step",
  "target",
  "version",
  // Only grad_workspace_jobs, and only with METRICS_WORKSPACE_LABEL=true.
  "workspace",
] as const;

export type LabelName = (typeof LABELS)[number];

/** Metric `kind` label: the job kind, with source syncs split from imports. */
export type MetricJobKind = "train" | "import" | "sync" | "eval";

export const registry = new Registry();

interface PoolCounts {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

const pools = new Set<PoolCounts>();

/** Reports a pg Pool's connections on grad_db_pool_connections until the returned call. */
export const watchPool = (pool: PoolCounts): (() => void) => {
  pools.add(pool);

  return () => {
    pools.delete(pool);
  };
};
/** Reads the Cloud price list's age (seconds since last confirmed; null: never fetched). */
let priceListAge: (() => number | null) | null = null;

/** Reports a price list's age on grad_price_list_age_seconds (Cloud mode). */
export const watchPriceList = (age: () => number | null): void => {
  priceListAge = age;
};

collectDefaultMetrics({ register: registry });

const BUCKETS = {
  /** Requests, DB queries, storage calls and maintenance steps. */
  fast: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  /** Waiting for a worker. */
  queue: [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600, 7200, 21600, 86400],
  /** Whole jobs. */
  job: [10, 30, 60, 300, 600, 1800, 3600, 7200, 14400, 28800, 86400, 172800],
  /** Checkpoint uploads. */
  upload: [0.5, 1, 5, 15, 30, 60, 120, 300, 600, 1800],
};

const counter = <L extends LabelName>(
  name: string,
  help: string,
  labelNames: readonly L[] = [],
) => new Counter<L>({ name, help, labelNames, registers: [registry] });

const gauge = <L extends LabelName>(
  name: string,
  help: string,
  labelNames: readonly L[] = [],
) => new Gauge<L>({ name, help, labelNames, registers: [registry] });

const histogram = <L extends LabelName>(
  name: string,
  help: string,
  labelNames: readonly L[],
  buckets: number[],
) =>
  new Histogram<L>({ name, help, labelNames, buckets, registers: [registry] });

export const metrics = {
  buildInfo: gauge("grad_build_info", "Always 1; the server version.", [
    "version",
  ]),

  // HTTP
  httpRequests: counter(
    "grad_http_requests_total",
    "HTTP requests by route template, method and status class.",
    ["method", "route", "status_class"],
  ),
  httpDuration: histogram(
    "grad_http_request_duration_seconds",
    "HTTP request duration by route template, method and status class.",
    ["method", "route", "status_class"],
    BUCKETS.fast,
  ),
  httpInFlight: gauge(
    "grad_http_requests_in_flight",
    "HTTP requests being served.",
  ),
  httpErrors: counter(
    "grad_http_errors_total",
    "problem+json error responses by error code (queue_limit, lease_lost, auth_unavailable, ...).",
    ["code"],
  ),

  // Queue (gauges refreshed from the database every maintenance tick)
  jobs: gauge(
    "grad_jobs",
    "Open jobs by kind and status: queued (claimable), blocked (waiting on another job), waiting_for_compute, running, awaiting_scores.",
    ["kind", "status"],
  ),
  jobsOpen: gauge(
    "grad_jobs_open",
    "Claimable queued plus leased jobs by kind: what KEDA scales workers on.",
    ["kind"],
  ),
  oldestQueuedAge: gauge(
    "grad_job_oldest_queued_age_seconds",
    "Age of the oldest claimable queued job by kind (0 when none).",
    ["kind"],
  ),
  fairShareWait: gauge(
    "grad_job_fair_share_wait_seconds",
    "Longest wait of a job next in its workspace's fair share (the oldest claimable job of a workspace below its running cap), by kind (0 when none).",
    ["kind"],
  ),
  jobsOverLimit: gauge(
    "grad_jobs_over_workspace_limit",
    "Queued jobs that wait because their workspace is at its running cap (GRAD_MAX_RUNNING_PER_WORKSPACE_*), by kind; not counted in grad_jobs_open.",
    ["kind"],
  ),
  jobsUnfit: gauge(
    "grad_jobs_unfit",
    "Queued train jobs that need more GPU memory (min_gpu_memory_gb) than any online train worker has.",
  ),
  queueLimitRejections: counter(
    "grad_queue_limit_rejections_total",
    "Creates refused with 429 queue_limit (GRAD_MAX_QUEUED_PER_WORKSPACE), by the kind of job refused.",
    ["kind"],
  ),
  claimLatency: histogram(
    "grad_job_claim_latency_seconds",
    "Time from creating a job to its first claim.",
    ["kind"],
    BUCKETS.queue,
  ),
  jobDuration: histogram(
    "grad_job_duration_seconds",
    "Time from creating a job to its terminal status, by kind, recipe and status.",
    ["kind", "recipe_kind", "status"],
    BUCKETS.job,
  ),
  jobFailures: counter(
    "grad_job_failures_total",
    "Jobs that ended failed, by kind, recipe and error code (attempts_exhausted, preemptions_exhausted, invalid_artifact, source_unavailable, job_error).",
    ["kind", "recipe_kind", "error_code"],
  ),
  attempts: counter(
    "grad_job_attempts_total",
    "Job attempts started (claims).",
    ["kind"],
  ),
  requeues: counter(
    "grad_job_requeues_total",
    "Attempts that ended without a result, by reason (lease_lost, compute_reclaimed, worker_error, oom).",
    ["kind", "reason"],
  ),
  workersOnline: gauge(
    "grad_workers_online",
    "Workers holding an unexpired lease, by job kind.",
    ["kind"],
  ),
  heartbeats: counter(
    "grad_worker_heartbeats_total",
    "Worker heartbeats received.",
    ["kind"],
  ),
  workerPhase: gauge(
    "grad_worker_phase",
    "Leased workers by the phase their last heartbeat reported.",
    ["kind", "phase"],
  ),
  workerTokensPerSecond: gauge(
    "grad_worker_tokens_per_second",
    "Sum of the tokens/s leased workers last reported.",
    ["kind"],
  ),
  workerGpuMemory: gauge(
    "grad_worker_gpu_memory_used_bytes",
    "Sum of the GPU memory leased workers last reported.",
    ["kind"],
  ),
  workerGpuUtilization: gauge(
    "grad_worker_gpu_utilization_ratio",
    "Mean GPU utilisation (0-1) leased workers last reported.",
    ["kind"],
  ),

  // Training
  trainingTokens: counter(
    "grad_training_tokens_total",
    "Tokens processed by training attempts, by recipe and model family.",
    ["recipe_kind", "model_family"],
  ),
  billedTokens: counter(
    "grad_billed_tokens_total",
    "Tokens written to the usage ledger, by usage kind (run, eval).",
    ["kind"],
  ),
  billedCost: counter(
    "grad_billed_cost_usd_total",
    "Cost written to the usage ledger in USD, by usage kind (run, eval).",
    ["kind"],
  ),
  // Gradiated Cloud
  usageExportPending: gauge(
    "grad_usage_export_pending_rows",
    "Cloud: usage ledger rows not yet pushed to billing.",
  ),
  usageExportLag: gauge(
    "grad_usage_export_lag_seconds",
    "Cloud: age of the oldest usage row not yet pushed to billing (0 when none).",
  ),
  usageParkedRows: gauge(
    "grad_usage_parked_rows",
    "Cloud: usage ledger rows billing refused for good (422/409), parked and never pushed until retried by hand (docs/CLOUD_MODE.md).",
  ),
  usageExportFailures: counter(
    "grad_usage_export_failures_total",
    "Cloud: usage pushes to billing that failed (the rows stay and are retried).",
  ),
  billingChecks: counter(
    "grad_billing_checks_total",
    "Cloud: balance checks, by op (start: a new run or eval; continue: a running job's heartbeat) and result (allowed, refused, error). A refused continue stops the job (stopped_balance).",
    ["op", "result"],
  ),
  priceListAge: new Gauge({
    name: "grad_price_list_age_seconds",
    help: "Cloud: seconds since the price list was last confirmed (new work is refused past 24 h).",
    registers: [registry],
    collect() {
      const age = priceListAge?.();
      if (age !== null && age !== undefined) this.set(age);
    },
  }),
  cloudAuthLookups: counter(
    "grad_cloud_auth_lookups_total",
    "Cloud: API-key lookups in the auth view, by result (found, not_found, inactive, error, stale: the view unreachable and the last answer reused).",
    ["result"],
  ),
  workerAuth: counter(
    "grad_worker_auth_total",
    "Worker-protocol requests by auth mode (static, kubernetes, lease; none: no worker credential) and result (ok, rejected, unavailable).",
    ["mode", "result"],
  ),
  authCache: counter(
    "grad_auth_cache_lookups_total",
    "Credential cache lookups, by mode (cloud_key, kubernetes) and result (hit, miss).",
    ["mode", "result"],
  ),
  tokenReviews: counter(
    "grad_token_reviews_total",
    "Kubernetes TokenReviews, by result (authenticated, rejected, error, saturated: refused because 8 were in flight).",
    ["result"],
  ),
  tokenReviewDuration: histogram(
    "grad_token_review_duration_seconds",
    "Kubernetes TokenReview call duration.",
    [],
    BUCKETS.fast,
  ),
  tokenReviewsInFlight: gauge(
    "grad_token_reviews_in_flight",
    "Kubernetes TokenReviews in flight on this replica.",
  ),
  checkpoints: counter(
    "grad_checkpoints_total",
    "Checkpoints registered, by recipe and reason (periodic, emergency).",
    ["recipe_kind", "reason"],
  ),
  checkpointBytes: counter(
    "grad_checkpoint_upload_bytes_total",
    "Bytes of registered checkpoint bundles.",
    ["recipe_kind"],
  ),
  checkpointUploadDuration: histogram(
    "grad_checkpoint_upload_duration_seconds",
    "Checkpoint upload time the worker reported.",
    ["recipe_kind"],
    BUCKETS.upload,
  ),

  // Evals
  evalOutputs: counter(
    "grad_eval_outputs_total",
    "Model outputs evals generated, by result (ok, error).",
    ["result"],
  ),
  judgeCalls: counter(
    "grad_eval_judge_calls_total",
    "Judge calls evals made, by result (ok, error).",
    ["result"],
  ),
  evalInferenceErrors: counter(
    "grad_eval_inference_errors_total",
    "Failed eval model and judge calls (after retries), by target (model, judge) and reason (rate_limited, capacity_unavailable, timeout, unreachable, server_error, rejected, malformed).",
    ["target", "reason"],
  ),

  // Sources
  sourceSyncs: counter(
    "grad_source_syncs_total",
    "Source syncs finished, by provider and status.",
    ["provider", "status"],
  ),
  sourceRecords: counter(
    "grad_source_records_synced_total",
    "Records source syncs added, by provider.",
    ["provider"],
  ),
  sourceScoreUpdates: counter(
    "grad_source_score_updates_total",
    "Score updates source syncs added, by provider.",
    ["provider"],
  ),
  sources: gauge("grad_sources", "Sources by provider.", ["provider"]),
  sourceFailures: gauge(
    "grad_source_consecutive_failures",
    "The most consecutive failed syncs of any source, by provider.",
    ["provider"],
  ),
  sourceSyncLag: gauge(
    "grad_source_sync_lag_seconds",
    "Longest time an active scheduled source has gone without a successful sync, by provider.",
    ["provider"],
  ),
  sourcesPaused: gauge(
    "grad_sources_paused",
    "Sources paused after repeated failed syncs, by provider.",
    ["provider"],
  ),

  // Datasets and imports
  partBytes: counter(
    "grad_dataset_part_bytes_total",
    "Bytes of dataset parts written, by form (compressed, uncompressed).",
    ["form"],
  ),
  importRecords: counter(
    "grad_import_records_total",
    "Records import workers posted, by kind (import, sync) and result (accepted, dropped).",
    ["kind", "result"],
  ),

  // Internals
  maintenanceDuration: histogram(
    "grad_maintenance_step_duration_seconds",
    "Maintenance step duration.",
    ["step"],
    BUCKETS.fast,
  ),
  maintenanceErrors: counter(
    "grad_maintenance_step_errors_total",
    "Maintenance steps that failed.",
    ["step"],
  ),
  maintenanceLastTick: gauge(
    "grad_maintenance_last_tick_timestamp_seconds",
    "Unix time the maintenance loop last finished a tick (lease expiry, requeues, gauges, usage).",
  ),
  usageFlushLag: gauge(
    "grad_usage_flush_lag_seconds",
    "Longest time a running attempt has gone without writing usage.",
  ),
  dbPool: new Gauge<"state">({
    name: "grad_db_pool_connections",
    help: "Postgres pool connections by state (in_use, idle, waiting).",
    labelNames: ["state"],
    registers: [registry],
    // Read at scrape time from the pools' own counters: no query.
    collect() {
      let total = 0;
      let idle = 0;
      let waiting = 0;
      for (const pool of pools) {
        total += pool.totalCount;
        idle += pool.idleCount;
        waiting += pool.waitingCount;
      }
      this.set({ state: "in_use" }, total - idle);
      this.set({ state: "idle" }, idle);
      this.set({ state: "waiting" }, waiting);
    },
  }),
  dbQueryDuration: histogram(
    "grad_db_query_duration_seconds",
    "Postgres query duration.",
    [],
    BUCKETS.fast,
  ),
  dbQueryErrors: counter(
    "grad_db_query_errors_total",
    "Postgres queries that failed.",
  ),
  sseStreams: gauge(
    "grad_sse_streams",
    "Open SSE event streams (run events and metrics) on this replica.",
  ),
  sseHubFetches: counter(
    "grad_sse_hub_fetches_total",
    "Event hub fetches (one state and one events query per 100 jobs), by reason: notify (a LISTEN notification or a new stream) or poll (the safety poll).",
    ["reason"],
  ),
  sseHubNotifications: counter(
    "grad_sse_hub_notifications_total",
    "grad_job_events notifications the event hub received.",
  ),
  sseHubListening: gauge(
    "grad_sse_hub_listening",
    "1 while the event hub's LISTEN connection is up (0: streams rely on the safety poll).",
  ),
  sseDispatchLatency: histogram(
    "grad_sse_dispatch_latency_seconds",
    "Time from an event's write to the event hub handing it to this replica's streams.",
    [],
    BUCKETS.fast,
  ),
  storageDuration: histogram(
    "grad_storage_operation_duration_seconds",
    "Object storage operation duration, by operation.",
    ["op"],
    BUCKETS.fast,
  ),
  storageErrors: counter(
    "grad_storage_operation_errors_total",
    "Object storage operations that failed, by operation.",
    ["op"],
  ),
  workspaceJobs: gauge(
    "grad_workspace_jobs",
    "Open jobs by workspace, kind and status (only with METRICS_WORKSPACE_LABEL=true).",
    ["workspace", "kind", "status"],
  ),
};

// Series alerts and panels rate() over start at 0, so their first event counts.
for (const result of ["authenticated", "rejected", "error", "saturated"]) {
  metrics.tokenReviews.inc({ result }, 0);
}
for (const code of [
  "lease_lost",
  "queue_limit",
  "auth_unavailable",
  "worker_auth_unavailable",
  "database_unavailable",
  "internal_error",
]) {
  metrics.httpErrors.inc({ code }, 0);
}

/** The phrase a job failed for too many preemptions carries in its error (requeuePatch). */
export const PREEMPTION_LIMIT_MARK = "its GPU was reclaimed";

/** A job's `kind` label: imports a source started are `sync`. */
export const metricKind = (job: {
  kind: "train" | "import" | "eval";
  origin?: "api" | "source";
}): MetricJobKind =>
  job.kind === "import" && job.origin === "source" ? "sync" : job.kind;

/**
 * A registered checkpoint: its bytes, its reason (the worker marks a
 * SIGTERM save `metadata.emergency: true`) and the upload time it reported
 * (`metadata.upload_seconds`).
 */
export const observeCheckpoint = (
  recipeKind: string,
  bytes: number,
  metadata: Record<string, unknown>,
): void => {
  const emergency =
    metadata.emergency === true || metadata.reason === "emergency";
  metrics.checkpoints.inc({
    recipe_kind: recipeKind,
    reason: emergency ? "emergency" : "periodic",
  });
  metrics.checkpointBytes.inc({ recipe_kind: recipeKind }, bytes);
  const seconds = metadata.upload_seconds;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
    metrics.checkpointUploadDuration.observe(
      { recipe_kind: recipeKind },
      seconds,
    );
  }
};

/** `2xx`, `4xx`, ... */
export const statusClass = (status: number): string =>
  `${Math.floor(status / 100)}xx`;

/** The model family label: `qwen/qwen3-8b` -> `qwen3`. */
export const modelFamily = (model: string): string =>
  (model.split("/").pop() ?? model).split(/[-_:@]/)[0]?.toLowerCase() ||
  "unknown";

/** Seconds since `start` (a `performance.now()` reading). */
export const secondsSince = (start: number): number =>
  (performance.now() - start) / 1000;

/** Runs `fn`, observing its duration (and failure) on the given metrics. */
export const timed = async <T>(
  observe: (seconds: number, failed: boolean) => void,
  fn: () => Promise<T>,
): Promise<T> => {
  const start = performance.now();
  try {
    const value = await fn();
    observe(secondsSince(start), false);

    return value;
  } catch (error) {
    observe(secondsSince(start), true);
    throw error;
  }
};

export interface MetricDescription {
  name: string;
  type: string;
  help: string;
  labels: string[];
}

/** Every grad_ metric this server exports (docs and dashboard checks). */
export const describeMetrics = async (): Promise<MetricDescription[]> =>
  (await registry.getMetricsAsJSON())
    .filter((m) => m.name.startsWith("grad_"))
    .map((m) => {
      const metric = registry.getSingleMetric(m.name) as unknown as {
        labelNames?: string[];
      };

      return {
        name: m.name,
        type: String(m.type),
        help: m.help,
        labels: [...(metric.labelNames ?? [])],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
