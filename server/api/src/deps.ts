import type { AuthAdapter, BillingAdapter, TracesAdapter } from "./adapters.js";
import type { ModelCatalog } from "./catalog.js";
import type { Clock } from "./clock.js";
import type { SecretsCipher } from "./secrets.js";
import type {
  InferenceClients,
  RegexEvaluator,
} from "./services/evals/types.js";
import type { BlobSigner } from "./storage/signer.js";
import type { ObjectStore } from "./storage/types.js";
import type { Store } from "./store/types.js";
import type { UiBundle } from "./ui.js";

export interface AppSettings {
  /** Lease expiries tolerated before a job fails (default 3). */
  maxAttempts: number;
  evalConcurrency: number;
  /** SSE metrics stream poll interval (default 1000 ms). */
  ssePollMs?: number;
  /** Bill an open attempt once this many tokens are unbilled (default 1M). */
  usageFlushTokens?: number;
  /** ... or once this long passed since its last usage row (default 300 s). */
  usageFlushSeconds?: number;
  /** Cloud usage export lag (default 60 s; tests use 0). */
  usageExportLagSeconds?: number;
  /** A source starts at most one sync per this long (default 60 s; live tests use 0). */
  sourceSyncIntervalSeconds?: number;
  /** Job events (metrics) older than this are deleted (default 90 days). */
  jobEventRetentionDays?: number;
  /** Prometheus endpoint (default: on, on the API port, no token). */
  metrics?: MetricsSettings;
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
  signer: BlobSigner;
  auth: AuthAdapter;
  billing: BillingAdapter;
  catalog: ModelCatalog;
  clock: Clock;
  /** Null when INFERENCE_BASE_URL is not configured (evals → inference_unavailable). */
  inference: InferenceClients | null;
  regex: RegexEvaluator;
  settings: AppSettings;
  /** Null or absent when GRAD_SECRETS_KEY is unset (secret writes → 501). */
  secrets?: SecretsCipher | null | undefined;
  /** Cloud only: gateway traces for the `gradiated` source. */
  traces?: TracesAdapter | null | undefined;
  /** The built web UI, served at `/` (null or absent: UI disabled or not built). */
  ui?: UiBundle | null | undefined;
}
