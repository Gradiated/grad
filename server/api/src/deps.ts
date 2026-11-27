import type { AuthAdapter, BillingAdapter, TracesAdapter } from "./adapters.js";
import type { EvalModelResolver } from "./cloud/gateway.js";
import type { JwtVerifier } from "./cloud/jwt.js";
import type { CloudPrices } from "./cloud/prices.js";
import type { ModelCatalog } from "./catalog.js";
import type { Clock } from "./clock.js";
import type { SecretsCipher } from "./secrets.js";
import type { ObjectStore } from "./storage/types.js";
import type { Store } from "./store/types.js";
import type { UiBundle } from "./ui.js";

export interface AppSettings {
  /** Lease expiries tolerated before a job fails (default 3). */
  maxAttempts: number;
  /** Preempted attempts tolerated before a job fails (default 20). */
  maxPreemptions?: number;
  /** A queued run nobody claimed for this long is waiting_for_compute (default 30 s). */
  waitingForComputeSeconds?: number;
  /** Workers scale from zero (KEDA): waiting runs say a worker is starting. */
  workerAutoscaling?: boolean;
  /** The SSE event hub's safety poll interval (SSE_POLL_MS, default 2000 ms). */
  ssePollMs?: number;
  /** Event streams one API key may hold open per replica (default 20). */
  sseStreamsPerKey?: number;
  /** Bill an open attempt once this many tokens are unbilled (default 1M). */
  usageFlushTokens?: number;
  /** ... or once this long passed since its last usage row (default 300 s). */
  usageFlushSeconds?: number;
  /** AUTH_MODE=cloud: /v1/keys answers 501 keys_managed_by_cloud. */
  keysManagedByCloud?: boolean;
  /** AUTH_MODE=none: refuse public Host names and cross-site browser requests. */
  unauthenticated?: boolean;
  /** Browser origins allowed cross-origin on /v1 (GRAD_CORS_ORIGINS; default none). */
  corsOrigins?: readonly string[];
  /** Seconds between a workspace delete and its purge (default 7 days). */
  workspacePurgeDelaySeconds?: number;
  /** A source starts at most one sync per this long (default 60 s; live tests use 0). */
  sourceSyncIntervalSeconds?: number;
  /** A new source's version_interval (default 900 s). */
  sourceVersionIntervalSeconds?: number;
  /** Waiting records that commit a scheduled sync's version at once (default 100k). */
  sourceVersionMaxRecords?: number;
  /** Job events (metrics) older than this are deleted (default 90 days). */
  jobEventRetentionDays?: number;
  /** Unreferenced job blobs older than this are deleted (default 7 days). */
  orphanBlobDays?: number;
  /** Prometheus endpoint (default: on, on the API port, no token). */
  metrics?: MetricsSettings;
  /** Per-workspace queue caps (defaults: 8 running per kind, 500 queued). */
  queue?: QueueSettings;
}

export interface QueueSettings {
  /** Running jobs per workspace and kind; past it the workspace's jobs wait. */
  maxRunning?: Partial<Record<"train" | "import" | "eval", number>>;
  /** Queued jobs per workspace; past it creates answer 429 queue_limit. */
  maxQueued?: number;
}

export interface MetricsSettings {
  enabled: boolean;
  token?: string | undefined;
  /** Served on METRICS_PORT by main.ts instead of the API app. */
  separatePort?: boolean;
  workspaceLabel?: boolean;
}

export interface AppDependencies {
  store: Store;
  storage: ObjectStore;
  auth: AuthAdapter;
  billing: BillingAdapter;
  catalog: ModelCatalog;
  clock: Clock;
  /**
   * GRAD_INFERENCE_BASE_URL is set, so eval workers have a model endpoint
   * (false: evals → inference_unavailable). The API makes no model calls.
   */
  inferenceConfigured: boolean;
  settings: AppSettings;
  /** Null or absent when GRAD_SECRETS_KEY is unset (secret writes → 501). */
  secrets?: SecretsCipher | null | undefined;
  /** Cloud only: the gateway names of artifacts under evaluation (eval-only Versions). */
  evalModels?: EvalModelResolver | null | undefined;
  /** Cloud only: verifies control-plane JWTs (the internal listener's service tokens). */
  jwt?: JwtVerifier | null | undefined;
  /** Cloud only: the versioned price list (polled by the maintenance tick). */
  prices?: CloudPrices | null | undefined;
  /** Cloud only: gateway traces for the `gradiated` source. */
  traces?: TracesAdapter | null | undefined;
  /** The built web UI, served at `/` (null or absent: UI disabled or not built). */
  ui?: UiBundle | null | undefined;
}
