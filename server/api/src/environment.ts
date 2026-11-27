import { z } from "zod";

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

const EnvironmentSchema = z.object({
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
  CLOUD_INTERNAL_API_URL: optionalString,
  CLOUD_SERVICE_TOKEN: optionalString,
  GRAD_INFERENCE_BASE_URL: optionalString,
  GRAD_INFERENCE_API_KEY: optionalString,
  GRAD_JUDGE_BASE_URL: optionalString,
  GRAD_JUDGE_API_KEY: optionalString,
  /** Deprecated names of the four above (accepted with a warning). */
  INFERENCE_BASE_URL: optionalString,
  INFERENCE_API_KEY: optionalString,
  JUDGE_BASE_URL: optionalString,
  JUDGE_API_KEY: optionalString,
  EVAL_EXECUTOR: booleanFlag("true"),
  EVAL_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(8),
  GRAD_EXTRA_MODELS_JSON: optionalString,
  GRAD_JUDGE_MODELS_JSON: optionalString,
  MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(10),
  /** Preempted attempts (SIGTERM, a cloud termination notice) a job survives; separate from MAX_ATTEMPTS. */
  MAX_PREEMPTIONS: z.coerce.number().int().min(1).max(1000).default(20),
  /** Seconds a queued run waits for a claim before it is waiting_for_compute. */
  WAITING_FOR_COMPUTE_SECONDS: z.coerce.number().int().min(1).default(30),
  /** Workers scale from zero (KEDA): say "a GPU worker is starting". */
  GRAD_WORKER_AUTOSCALING: booleanFlag("false"),
  /** Running jobs per workspace and kind; past it the workspace's jobs wait (fair share). */
  GRAD_MAX_RUNNING_PER_WORKSPACE_TRAIN: z.coerce
    .number()
    .int()
    .min(1)
    .default(8),
  GRAD_MAX_RUNNING_PER_WORKSPACE_IMPORT: z.coerce
    .number()
    .int()
    .min(1)
    .default(8),
  GRAD_MAX_RUNNING_PER_WORKSPACE_EVAL: z.coerce
    .number()
    .int()
    .min(1)
    .default(8),
  /** Queued jobs per workspace (runs, imports, evals); past it creates answer 429 queue_limit. */
  GRAD_MAX_QUEUED_PER_WORKSPACE: z.coerce.number().int().min(1).default(500),
  MIGRATE_ON_BOOT: booleanFlag("true"),
  AUTH_MODE_NONE_ALLOW_REMOTE: booleanFlag("false"),
  /** Bill a running attempt every this many tokens... */
  USAGE_FLUSH_TOKENS: z.coerce.number().int().min(1).default(1_000_000),
  /** ...or every this many seconds, whichever comes first. */
  USAGE_FLUSH_SECONDS: z.coerce.number().int().min(1).default(300),
  /** Cloud: usage rows younger than this are not exported yet. */
  USAGE_EXPORT_LAG_SECONDS: z.coerce.number().int().min(0).default(60),
  /** A source starts at most one sync per this many seconds (live tests: 0). */
  SOURCE_SYNC_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3600)
    .default(60),
  /** A new source's version_interval: seconds between scheduled syncs' versions. */
  SOURCE_VERSION_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .max(7 * 86_400)
    .default(900),
  /** Waiting records that commit a scheduled sync's version at once. */
  SOURCE_VERSION_MAX_RECORDS: z.coerce.number().int().min(1).default(100_000),
  /** Days job events (metrics) are kept. */
  JOB_EVENT_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .default(90),
  /** Days an unreferenced job blob is kept before the sweep deletes it. */
  ORPHAN_BLOB_DAYS: z.coerce.number().int().min(1).max(3650).default(7),
  MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(100).default(15_000),
  /** The SSE event hub re-reads every followed job this often, in case a NOTIFY was missed. */
  SSE_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(2_000),
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
    kinds: z.array(z.enum(["train", "import"])).min(1),
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
    throw new Error(
      `Invalid TRAINER_KEYS_JSON: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const labels = parsed.data.map((k) => k.label);
  const dup = labels.find((l, i) => labels.indexOf(l) !== i);
  if (dup) throw new Error(`TRAINER_KEYS_JSON has two keys labelled '${dup}'.`);

  return parsed.data;
};

export interface ServerEnvironment extends RawEnvironment {
  /** Labelled, kind-scoped trainer keys from TRAINER_KEYS_JSON. */
  trainerKeys: TrainerKeyConfig[];
  /** How workers authenticate (GRAD_WORKER_AUTH and its settings). */
  workerAuth: WorkerAuthConfig;
  /** Whether to serve the web UI (UI_ENABLED, default off only for AUTH_MODE=cloud). */
  uiEnabled: boolean;
  /** Eval generations endpoint (GRAD_INFERENCE_BASE_URL). */
  inferenceBaseUrl: string | undefined;
  inferenceApiKey: string | undefined;
  /** Effective judge endpoint (GRAD_JUDGE_BASE_URL, then the inference endpoint). */
  judgeBaseUrl: string | undefined;
  judgeApiKey: string | undefined;
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
    throw new Error(
      `Invalid server configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
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

  const usesCloud = env.AUTH_MODE === "cloud" || env.BILLING_MODE === "cloud";
  if (usesCloud && (!env.CLOUD_INTERNAL_API_URL || !env.CLOUD_SERVICE_TOKEN)) {
    throw new Error(
      "CLOUD_INTERNAL_API_URL and CLOUD_SERVICE_TOKEN are required when AUTH_MODE or BILLING_MODE is 'cloud'.",
    );
  }

  if (env.TRAINER_API_KEY && env.TRAINER_API_KEY_HASH) {
    throw new Error(
      "Set only one of TRAINER_API_KEY and TRAINER_API_KEY_HASH.",
    );
  }

  // One name per setting (GRAD_*), the same in compose, Helm and the docs;
  // the unprefixed names shipped first and still work, with a warning.
  const named = (current: keyof typeof env, legacy: keyof typeof env) => {
    const value = env[current] as string | undefined;
    const old = env[legacy] as string | undefined;
    if (old !== undefined) {
      warnings.push(
        value === undefined
          ? `${legacy} is deprecated; rename it to ${current}.`
          : `${legacy} is ignored because ${current} is set; remove it.`,
      );
    }

    return value ?? old;
  };
  const inferenceBaseUrl = named(
    "GRAD_INFERENCE_BASE_URL",
    "INFERENCE_BASE_URL",
  );
  const inferenceApiKey = named("GRAD_INFERENCE_API_KEY", "INFERENCE_API_KEY");
  const judgeUrl = named("GRAD_JUDGE_BASE_URL", "JUDGE_BASE_URL");
  const judgeKey = named("GRAD_JUDGE_API_KEY", "JUDGE_API_KEY");
  const judgeBaseUrl = judgeUrl ?? inferenceBaseUrl;
  const judgeApiKey = judgeKey ?? (judgeUrl ? undefined : inferenceApiKey);

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
    },
    warnings,
  );

  return {
    ...env,
    trainerKeys,
    workerAuth,
    uiEnabled: env.UI_ENABLED ?? env.AUTH_MODE !== "cloud",
    inferenceBaseUrl,
    inferenceApiKey,
    judgeBaseUrl,
    judgeApiKey,
    warnings,
  };
};
