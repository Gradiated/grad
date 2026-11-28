import type { AuthAdapter, BillingAdapter, TracesAdapter } from "./adapters.js";
import type { EvalModelResolver } from "./cloud/gateway.js";
import type { JwtVerifier } from "./cloud/jwt.js";
import type { CloudPrices } from "./cloud/prices.js";
import type { ModelCatalog } from "./catalog.js";
import type { Clock } from "./clock.js";
import type { SecretsCipher } from "./secrets.js";
import type { ObjectStore } from "./storage/types.js";
import type { JobKind, QueueCaps, Store } from "./store/types.js";
import type { UiBundle } from "./ui.js";

/** Server settings, every one resolved (resolveSettings applies the defaults). */
interface AppSettings {
  /** Attempts that end without a result (a lost lease, a worker error) before a job fails. */
  maxAttempts: number;
  /** Preempted attempts in a row a job survives (MAX_PREEMPTIONS). */
  maxPreemptions: number;
  /** A queued run nobody claimed for this long is waiting_for_compute. */
  waitingForComputeSeconds: number;
  /** Workers scale from zero (KEDA): waiting runs say a worker is starting. */
  workerAutoscaling: boolean;
  /** The SSE event hub's safety poll interval (SSE_POLL_MS). */
  ssePollMs: number;
  /** Event streams one API key may hold open per replica. */
  sseStreamsPerKey: number;
  /** Bill an open attempt once this many tokens are unbilled ... */
  usageFlushTokens: number;
  /** ... or once this long passed since its last usage row. */
  usageFlushSeconds: number;
  /** AUTH_MODE=cloud: /v1/keys answers 501 keys_managed_by_cloud. */
  keysManagedByCloud: boolean;
  /**
   * AUTH_MODE=cloud: the public unpin refuses `inference:` holders (403
   * pin_managed_by_cloud); only the internal service-JWT routes remove them.
   */
  inferencePinsManagedByCloud: boolean;
  /** AUTH_MODE=none: refuse public Host names and cross-site browser requests. */
  unauthenticated: boolean;
  /** Browser origins allowed cross-origin on /v1 (GRAD_CORS_ORIGINS; empty: none). */
  corsOrigins: readonly string[];
  /** Seconds between a workspace delete and its purge. */
  workspacePurgeDelaySeconds: number;
  /** A source starts at most one sync per this long (live tests use 0). */
  sourceSyncIntervalSeconds: number;
  /** A new source's version_interval. */
  sourceVersionIntervalSeconds: number;
  /** Waiting records that commit a scheduled sync's version at once. */
  sourceVersionMaxRecords: number;
  /** Job events (metrics) older than this are deleted. */
  jobEventRetentionDays: number;
  /** Unreferenced job blobs older than this are deleted. */
  orphanBlobDays: number;
  /** The Prometheus endpoint. */
  metrics: MetricsSettings;
  /** Per-workspace queue caps. */
  queue: QueueLimits;
}

export interface QueueLimits {
  /** Running jobs per workspace and kind; past it the workspace's jobs wait. */
  maxRunning: QueueCaps;
  /** Queued jobs per workspace; past it creates answer 429 queue_limit. */
  maxQueued: number;
}

interface MetricsSettings {
  enabled: boolean;
  token?: string | undefined;
  /** Served on METRICS_PORT by main.ts instead of the API app. */
  separatePort?: boolean;
  workspaceLabel?: boolean;
}

/** Every setting's default, in one place (environment.ts defaults its variables from it). */
export const DEFAULT_SETTINGS: AppSettings = {
  maxAttempts: 10,
  maxPreemptions: 20,
  waitingForComputeSeconds: 30,
  workerAutoscaling: false,
  ssePollMs: 2000,
  sseStreamsPerKey: 20,
  usageFlushTokens: 1_000_000,
  usageFlushSeconds: 300,
  keysManagedByCloud: false,
  inferencePinsManagedByCloud: false,
  unauthenticated: false,
  corsOrigins: [],
  workspacePurgeDelaySeconds: 7 * 86_400,
  sourceSyncIntervalSeconds: 60,
  sourceVersionIntervalSeconds: 900,
  sourceVersionMaxRecords: 100_000,
  jobEventRetentionDays: 90,
  orphanBlobDays: 7,
  metrics: { enabled: true },
  queue: { maxRunning: { train: 8, import: 8, eval: 8 }, maxQueued: 500 },
};

/** Settings to override (the queue caps one by one). */
export type SettingsOverrides = Partial<Omit<AppSettings, "queue">> & {
  queue?: {
    maxRunning?: Partial<Record<JobKind, number>>;
    maxQueued?: number;
  };
};

export const resolveSettings = (
  overrides: SettingsOverrides = {},
): AppSettings => {
  const { queue, ...rest } = overrides;

  return {
    ...DEFAULT_SETTINGS,
    ...rest,
    queue: {
      maxRunning: {
        ...DEFAULT_SETTINGS.queue.maxRunning,
        ...queue?.maxRunning,
      },
      maxQueued: queue?.maxQueued ?? DEFAULT_SETTINGS.queue.maxQueued,
    },
  };
};

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
