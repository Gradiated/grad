import type {
  AuthAdapter,
  BillingAdapter,
  DeployAdapter,
  ServingAdapter,
} from "./adapters.js";
import type { ModelCatalog } from "./catalog.js";
import type { Clock } from "./clock.js";
import type { EnvWorkerHub } from "./env-hub.js";
import type {
  InferenceClients,
  RegexEvaluator,
} from "./services/evals/types.js";
import type { BlobSigner } from "./storage/signer.js";
import type { ObjectStore } from "./storage/types.js";
import type { Store } from "./store/types.js";

export interface AppSettings {
  allowWave2Recipes: boolean;
  /** Lease expiries tolerated before a job fails (default 3). */
  maxAttempts: number;
  evalConcurrency: number;
  /** SSE metrics stream poll interval (default 1000 ms). */
  ssePollMs?: number;
  /** How long a duplicate keyed POST waits for the first (default 5000 ms). */
  idempotencyWaitMs?: number;
}

export interface AppDependencies {
  store: Store;
  storage: ObjectStore;
  signer: BlobSigner;
  auth: AuthAdapter;
  billing: BillingAdapter;
  deploy: DeployAdapter;
  serving: ServingAdapter;
  catalog: ModelCatalog;
  clock: Clock;
  envHub: EnvWorkerHub;
  /** Null when INFERENCE_BASE_URL is not configured (evals → inference_unavailable). */
  inference: InferenceClients | null;
  regex: RegexEvaluator;
  settings: AppSettings;
}
