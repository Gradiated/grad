import { z } from "zod";

import { cloudUrl } from "./cloud/http.js";
import { DEFAULT_SETTINGS } from "./deps.js";
import { issuesOf } from "./errors.js";
import {
  parseWorkerAuthConfig,
  type WorkerAuthConfig,
} from "./worker-auth/config.js";

const booleanFlag = (fallback: "true" | "false") =>
  z
    .enum(["true", "false", "1", "0"])
    .default(fallback)
    .transform((v) => v === "true" || v === "1");

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const S3_BUCKET_REQUIRED =
  "S3_BUCKET is required: grad-server keeps datasets, checkpoints and artifacts in S3-compatible storage (AWS S3, SeaweedFS, MinIO, R2); set S3_ENDPOINT for a store other than AWS S3";

/** The eval endpoints: eval workers call them; the API only checks they are set. */
const EndpointShape = {
  /** Cloud evals: the inference gateway's OpenAI-compatible base URL and grad's service credential. */
  GRAD_CLOUD_GATEWAY_URL: optionalString,
  GRAD_CLOUD_GATEWAY_TOKEN: optionalString,
  GRAD_INFERENCE_BASE_URL: optionalString,
  GRAD_INFERENCE_API_KEY: optionalString,
  GRAD_JUDGE_BASE_URL: optionalString,
  GRAD_JUDGE_API_KEY: optionalString,
};

type EndpointEnv = {
  [K in keyof typeof EndpointShape]: string | undefined;
};

export interface EvalEndpoints {
  /** Eval generations endpoint (GRAD_INFERENCE_BASE_URL). */
  inferenceBaseUrl: string | undefined;
  inferenceApiKey: string | undefined;
  /** Effective judge endpoint (GRAD_JUDGE_BASE_URL, then the inference endpoint). */
  judgeBaseUrl: string | undefined;
  judgeApiKey: string | undefined;
}

/** The judge endpoint defaults to the inference one (and its key). */
const resolveEndpoints = (env: EndpointEnv): EvalEndpoints => ({
  inferenceBaseUrl: env.GRAD_INFERENCE_BASE_URL,
  inferenceApiKey: env.GRAD_INFERENCE_API_KEY,
  judgeBaseUrl: env.GRAD_JUDGE_BASE_URL ?? env.GRAD_INFERENCE_BASE_URL,
  judgeApiKey:
    env.GRAD_JUDGE_API_KEY ??
    (env.GRAD_JUDGE_BASE_URL ? undefined : env.GRAD_INFERENCE_API_KEY),
});

export const EnvironmentSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_URL: z
    .string({
      error: "DATABASE_URL is required (a Postgres connection string)",
    })
    .trim()
    .min(1, "DATABASE_URL is required (a Postgres connection string)"),
  S3_BUCKET: z
    .string({ error: S3_BUCKET_REQUIRED })
    .trim()
    .min(1, S3_BUCKET_REQUIRED),
  S3_REGION: optionalString,
  /** An S3-compatible endpoint (SeaweedFS, MinIO, R2...); unset: AWS S3. */
  S3_ENDPOINT: optionalString,
  /** The endpoint SDK clients reach for file uploads, when it is not S3_ENDPOINT. */
  S3_PUBLIC_ENDPOINT: optionalString,
  AUTH_MODE: z.enum(["none", "api_key", "cloud"]).default("api_key"),
  ADMIN_API_KEY_HASH: optionalString,
  TRAINER_API_KEY_HASH: optionalString,
  TRAINER_API_KEY: optionalString,
  TRAINER_KEYS_JSON: optionalString,
  /** Worker authenticators, in order: static, kubernetes, lease (default static). */
  GRAD_WORKER_AUTH: optionalString,
  /** kubernetes: `{"<ns>/<service-account>": ["train"], ...}`. */
  GRAD_WORKER_K8S_SERVICE_ACCOUNTS: optionalString,
  /** lease: orchestrator keys for the internal worker-token routes. */
  GRAD_ORCHESTRATOR_KEYS_JSON: optionalString,
  /** Serve the internal routes (lease-token minting) on this port only; unset: off. */
  INTERNAL_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  GRAD_SECRETS_KEY: optionalString,
  GRAD_SECRETS_KEYS_OLD: optionalString,
  DEFAULT_WORKSPACE_ID: z.string().min(1).max(64).default("local"),
  BILLING_MODE: z.enum(["noop", "cloud"]).default("noop"),
  /** Cloud: the product's internal listener (the `gradiated` source's traces:pull). */
  CLOUD_INTERNAL_API_URL: optionalString,
  /** Cloud: the bearer grad sends to the product's internal listener (billing, prices, traces). */
  CLOUD_SERVICE_TOKEN: optionalString,
  /**
   * Cloud: serve the `gradiated` source (the product's traces:pull). Off
   * until the product ships that endpoint: the source answers 501
   * source_unavailable ("coming soon") instead of failing at sync time.
   */
  GRAD_CLOUD_TRACES_ENABLED: booleanFlag("false"),
  ...EndpointShape,
  /** AUTH_MODE=cloud: read-only connection to the product database's auth_principals_v1 view. */
  GRAD_CLOUD_AUTH_DATABASE_URL: optionalString,
  /** AUTH_MODE=cloud: the control plane's JWKS (console and service JWTs). */
  GRAD_CLOUD_JWKS_URL: optionalString,
  GRAD_CLOUD_JWT_ISSUER: optionalString,
  /** BILLING_MODE=cloud: billing's base URL (`/check`, `/usage-events`). */
  GRAD_CLOUD_BILLING_URL: optionalString,
  /** BILLING_MODE=cloud: the versioned price list. */
  GRAD_CLOUD_PRICES_URL: optionalString,
  /** Browser origins (comma-separated, exact `https://host[:port]`) allowed cross-origin on /v1; unset: CORS off. */
  GRAD_CORS_ORIGINS: optionalString,
  /** Seconds between a workspace delete and the purge of its data (default 7 days). */
  GRAD_WORKSPACE_PURGE_DELAY_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .default(DEFAULT_SETTINGS.workspacePurgeDelaySeconds),
  /** An AWS KMS key (id, ARN or alias): workspace secrets use envelope encryption under it. */
  GRAD_SECRETS_KMS_KEY_ID: optionalString,
  GRAD_EXTRA_MODELS_JSON: optionalString,
  GRAD_JUDGE_MODELS_JSON: optionalString,
  MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(DEFAULT_SETTINGS.maxAttempts),
  /** Preempted attempts in a row (SIGTERM, a cloud termination notice) a job survives; separate from MAX_ATTEMPTS. A run's preemption after a checkpoint starts the count again. */
  MAX_PREEMPTIONS: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(DEFAULT_SETTINGS.maxPreemptions),
  /** Workers scale from zero (KEDA): say "a GPU worker is starting". */
  GRAD_WORKER_AUTOSCALING: booleanFlag("false"),
  /** Running jobs per workspace and kind; past it the workspace's jobs wait (fair share). */
  GRAD_MAX_RUNNING_PER_WORKSPACE_TRAIN: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_SETTINGS.queue.maxRunning.train),
  GRAD_MAX_RUNNING_PER_WORKSPACE_IMPORT: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_SETTINGS.queue.maxRunning.import),
  GRAD_MAX_RUNNING_PER_WORKSPACE_EVAL: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_SETTINGS.queue.maxRunning.eval),
  /** Queued jobs per workspace (runs, imports, evals); past it creates answer 429 queue_limit. */
  GRAD_MAX_QUEUED_PER_WORKSPACE: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_SETTINGS.queue.maxQueued),
  MIGRATE_ON_BOOT: booleanFlag("true"),
  AUTH_MODE_NONE_ALLOW_REMOTE: booleanFlag("false"),
  /** A source starts at most one sync per this many seconds (live tests: 0). */
  SOURCE_SYNC_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3600)
    .default(DEFAULT_SETTINGS.sourceSyncIntervalSeconds),
  /** Days job events (metrics) are kept. */
  JOB_EVENT_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .default(DEFAULT_SETTINGS.jobEventRetentionDays),
  /** Days an unreferenced job blob is kept before the sweep deletes it. */
  ORPHAN_BLOB_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .default(DEFAULT_SETTINGS.orphanBlobDays),
  MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(100).default(15_000),
  /** SIGTERM: seconds /health/ready fails while the server keeps serving (Helm: 5). */
  SHUTDOWN_DRAIN_SECONDS: z.coerce.number().int().min(0).max(120).default(0),
  /** The SSE event hub re-reads every followed job this often, in case a NOTIFY was missed. */
  SSE_POLL_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(DEFAULT_SETTINGS.ssePollMs),
  /** Serve Prometheus metrics at /metrics. */
  METRICS_ENABLED: booleanFlag("true"),
  /** Scrapes must send this bearer token. */
  METRICS_TOKEN: optionalString,
  /** Serve /metrics on this port only (keeps it off the API port). */
  METRICS_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  /** Add a workspace label (grad_workspace_jobs): self-hosted, few workspaces. */
  METRICS_WORKSPACE_LABEL: booleanFlag("false"),
  /** Serve the web UI at `/` (default: on, except AUTH_MODE=cloud). */
  UI_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) =>
      v === undefined ? undefined : v === "true" || v === "1",
    ),
  /** A built server/ui directory (default: the image's /app/ui, or server/ui/dist in a checkout). */
  UI_DIR: optionalString,
});

export type RawEnvironment = z.infer<typeof EnvironmentSchema>;

const TrainerKeysSchema = z.array(
  z.strictObject({
    label: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "a lowercase SHA-256 hex digest"),
    kinds: z.array(z.enum(["train", "import", "eval"])).min(1),
  }),
);

export type TrainerKeyConfig = z.infer<typeof TrainerKeysSchema>[number];

const parseTrainerKeys = (raw: string | undefined): TrainerKeyConfig[] => {
  if (!raw) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(
      'TRAINER_KEYS_JSON must be JSON: [{"label": "h100-01", "sha256": "<hex>", "kinds": ["train"]}].',
    );
  }
  const parsed = TrainerKeysSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`Invalid TRAINER_KEYS_JSON: ${issuesOf(parsed.error)}`);
  }
  const labels = parsed.data.map((k) => k.label);
  const dup = labels.find((l, i) => labels.indexOf(l) !== i);
  if (dup) throw new Error(`TRAINER_KEYS_JSON has two keys labelled '${dup}'.`);

  return parsed.data;
};

export interface ServerEnvironment extends RawEnvironment {
  /** GRAD_CORS_ORIGINS, split. */
  corsOrigins: string[];
  /** Labelled, kind-scoped trainer keys from TRAINER_KEYS_JSON. */
  trainerKeys: TrainerKeyConfig[];
  /** How workers authenticate (GRAD_WORKER_AUTH and its settings). */
  workerAuth: WorkerAuthConfig;
  /** Whether to serve the web UI (UI_ENABLED, default off only for AUTH_MODE=cloud). */
  uiEnabled: boolean;
  /** GRAD_INFERENCE_BASE_URL is set: evals can be created (eval workers call it). */
  inferenceConfigured: boolean;
  warnings: string[];
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export const isLoopbackHost = (host: string): boolean => LOOPBACK.has(host);

/**
 * Parses and validates server configuration, failing fast on combinations
 * that could never serve a request or that are unsafe by accident.
 */
export const parseServerEnvironment = (
  raw: Record<string, string | undefined> = process.env,
): ServerEnvironment => {
  const parsed = EnvironmentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid server configuration: ${issuesOf(parsed.error)}`);
  }

  const env = parsed.data;
  const warnings: string[] = [];

  if (env.AUTH_MODE === "api_key" && !env.ADMIN_API_KEY_HASH) {
    throw new Error(
      "AUTH_MODE=api_key requires ADMIN_API_KEY_HASH (sha256 hex of a bootstrap admin key); without it no key could ever be created. For local development only, set AUTH_MODE=none explicitly.",
    );
  }

  if (env.AUTH_MODE === "none") {
    warnings.push(
      "AUTH_MODE=none: authentication is DISABLED and every request is a platform admin. Use this for local development only.",
    );
    if (!isLoopbackHost(env.HOST)) {
      // Every request is a platform admin (trainer:worker included), so refuse to
      // listen beyond loopback unless the operator says the network is private.
      if (!env.AUTH_MODE_NONE_ALLOW_REMOTE) {
        throw new Error(
          `AUTH_MODE=none refuses to listen on non-loopback HOST=${env.HOST}: anyone who can reach this port would have full admin access. Use AUTH_MODE=api_key, listen on 127.0.0.1, or set AUTH_MODE_NONE_ALLOW_REMOTE=true when only trusted hosts can reach the port (for example a compose network published on loopback).`,
        );
      }
      warnings.push(
        `AUTH_MODE=none while listening on non-loopback HOST=${env.HOST} (AUTH_MODE_NONE_ALLOW_REMOTE=true): anyone who can reach this port has full admin access.`,
      );
    }
  }

  const requireAll = (mode: string, names: Array<keyof typeof env>) => {
    const missing = names.filter((n) => !env[n]);
    if (missing.length > 0) {
      throw new Error(`${mode} requires ${missing.join(", ")}.`);
    }
  };
  if (env.AUTH_MODE === "cloud") {
    requireAll("AUTH_MODE=cloud", [
      "GRAD_CLOUD_AUTH_DATABASE_URL",
      "GRAD_CLOUD_JWKS_URL",
      "GRAD_CLOUD_JWT_ISSUER",
    ]);
  }
  if (env.BILLING_MODE === "cloud") {
    requireAll("BILLING_MODE=cloud", [
      "GRAD_CLOUD_BILLING_URL",
      "GRAD_CLOUD_PRICES_URL",
      "CLOUD_SERVICE_TOKEN",
    ]);
  }
  for (const name of [
    "CLOUD_INTERNAL_API_URL",
    "GRAD_CLOUD_JWKS_URL",
    "GRAD_CLOUD_BILLING_URL",
    "GRAD_CLOUD_PRICES_URL",
    "GRAD_CLOUD_GATEWAY_URL",
  ] as const) {
    const value = env[name];
    if (value) cloudUrl(name, value);
  }
  const corsOrigins = (env.GRAD_CORS_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  for (const origin of corsOrigins) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(origin);
    } catch {
      parsed = null;
    }
    if (
      !parsed ||
      parsed.origin !== origin ||
      (parsed.protocol !== "https:" && !isLoopbackHost(parsed.hostname))
    ) {
      throw new Error(
        `GRAD_CORS_ORIGINS: '${origin}' is not an origin like https://console.example.com (https, no path, no trailing slash; http only for localhost).`,
      );
    }
  }
  if (env.GRAD_CLOUD_GATEWAY_URL) {
    requireAll("GRAD_CLOUD_GATEWAY_URL", [
      "CLOUD_INTERNAL_API_URL",
      "CLOUD_SERVICE_TOKEN",
    ]);
  }
  if (env.BILLING_MODE === "cloud" && env.GRAD_INFERENCE_BASE_URL) {
    throw new Error(
      "BILLING_MODE=cloud: evals call the Gradiated gateway, which bills their tokens; set GRAD_CLOUD_GATEWAY_URL instead of GRAD_INFERENCE_BASE_URL.",
    );
  }

  if (env.TRAINER_API_KEY && env.TRAINER_API_KEY_HASH) {
    throw new Error(
      "Set only one of TRAINER_API_KEY and TRAINER_API_KEY_HASH.",
    );
  }

  const endpoints = resolveEndpoints(env);
  // Eval workers (`grad-server worker --kinds eval`) call the endpoints now.
  for (const name of [
    "GRAD_INFERENCE_API_KEY",
    "GRAD_JUDGE_API_KEY",
    "EVAL_CONCURRENCY",
    "EVAL_EXECUTOR",
  ]) {
    if (raw[name]?.trim()) {
      warnings.push(
        `${name} is ignored by the API: evals run on eval workers (grad-server worker --kinds eval); set it there.`,
      );
    }
  }

  if (env.METRICS_PORT !== undefined && env.METRICS_PORT === env.PORT) {
    throw new Error("METRICS_PORT must differ from PORT.");
  }

  const trainerKeys = parseTrainerKeys(env.TRAINER_KEYS_JSON);
  const workerAuth = parseWorkerAuthConfig(
    {
      ...env,
      hasStaticKeys:
        trainerKeys.length > 0 ||
        env.TRAINER_API_KEY !== undefined ||
        env.TRAINER_API_KEY_HASH !== undefined,
      cloudRoutes: env.AUTH_MODE === "cloud",
    },
    warnings,
  );

  return {
    ...env,
    corsOrigins,
    trainerKeys,
    workerAuth,
    uiEnabled: env.UI_ENABLED ?? env.AUTH_MODE !== "cloud",
    inferenceConfigured:
      endpoints.inferenceBaseUrl !== undefined ||
      env.GRAD_CLOUD_GATEWAY_URL !== undefined,
    warnings,
  };
};

export const WorkerEnvironmentSchema = z.object({
  GRAD_SERVER_URL: z.string().trim().min(1).default("http://127.0.0.1:8787"),
  TRAINER_API_KEY: optionalString,
  GRAD_WORKER_ID: optionalString,
  GRAD_LEASE_SECONDS: z.coerce.number().int().min(30).max(3600).default(180),
  GRAD_POLL_INTERVAL_S: z.coerce.number().min(0.05).max(60).default(1),
  /** Concurrent generations per eval. */
  EVAL_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(8),
  /** How long an eval waits for capacity (503 capacity_unavailable) before it fails. */
  GRAD_EVAL_CAPACITY_WAIT_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(86_400)
    .default(720),
  ...EndpointShape,
});

export type EvalWorkerEnvironment = z.infer<typeof WorkerEnvironmentSchema> &
  EvalEndpoints & { warnings: string[] };

/** Configuration of `grad-server worker --kinds eval`. */
export const parseEvalWorkerEnvironment = (
  raw: Record<string, string | undefined> = process.env,
): EvalWorkerEnvironment => {
  const parsed = WorkerEnvironmentSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid eval worker configuration: ${issuesOf(parsed.error)}`,
    );
  }
  const warnings: string[] = [];
  const endpoints = resolveEndpoints(parsed.data);
  if (parsed.data.GRAD_CLOUD_GATEWAY_URL) {
    if (!parsed.data.GRAD_CLOUD_GATEWAY_TOKEN) {
      throw new Error(
        "GRAD_CLOUD_GATEWAY_URL requires GRAD_CLOUD_GATEWAY_TOKEN (grad's gateway service credential).",
      );
    }
    cloudUrl("GRAD_CLOUD_GATEWAY_URL", parsed.data.GRAD_CLOUD_GATEWAY_URL);
  } else if (!endpoints.inferenceBaseUrl) {
    warnings.push(
      "GRAD_INFERENCE_BASE_URL is not set: this eval worker runs only validators, regexes and code scorers (dataset.score()). Set it (and GRAD_JUDGE_BASE_URL for judges) here and on grad-server, which checks it when an eval is created.",
    );
  }

  return { ...parsed.data, ...endpoints, warnings };
};
