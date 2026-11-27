import { z } from "zod";

const booleanFlag = (fallback: "true" | "false") =>
  z
    .enum(["true", "false", "1", "0"])
    .default(fallback)
    .transform((v) => v === "true" || v === "1");

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : undefined));

const EnvironmentSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_URL: optionalString,
  STORAGE_DIR: z.string().default(".grad-data"),
  S3_BUCKET: optionalString,
  S3_REGION: optionalString,
  S3_ENDPOINT: optionalString,
  AUTH_MODE: z.enum(["none", "api_key", "cloud"]).default("api_key"),
  ADMIN_API_KEY_HASH: optionalString,
  TRAINER_API_KEY_HASH: optionalString,
  TRAINER_API_KEY: optionalString,
  DEFAULT_WORKSPACE_ID: z.string().min(1).max(64).default("local"),
  DEPLOY_MODE: z.enum(["disabled", "cloud", "local"]).default("disabled"),
  BILLING_MODE: z.enum(["noop", "cloud"]).default("noop"),
  CLOUD_INTERNAL_API_URL: optionalString,
  CLOUD_SERVICE_TOKEN: optionalString,
  ALLOW_WAVE2_RECIPES: booleanFlag("false"),
  INFERENCE_BASE_URL: optionalString,
  INFERENCE_API_KEY: optionalString,
  JUDGE_BASE_URL: optionalString,
  JUDGE_API_KEY: optionalString,
  GRAD_JUDGE_BASE_URL: optionalString,
  EVAL_EXECUTOR: booleanFlag("true"),
  EVAL_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(8),
  GRAD_EXTRA_MODELS_JSON: optionalString,
  BLOB_SIGNING_SECRET: optionalString,
  MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  MAINTENANCE_INTERVAL_MS: z.coerce.number().int().min(100).default(15_000),
});

export type RawEnvironment = z.infer<typeof EnvironmentSchema>;

export interface ServerEnvironment extends Omit<RawEnvironment, "DEPLOY_MODE"> {
  DEPLOY_MODE: "disabled" | "cloud";
  /** Effective judge endpoint (JUDGE_BASE_URL, GRAD_JUDGE_BASE_URL, then inference). */
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

  if (env.DEPLOY_MODE === "local") {
    throw new Error(
      "DEPLOY_MODE=local was removed: it pretended to deploy without serving anything. Use DEPLOY_MODE=disabled (self-hosted: download artifacts and serve them on vLLM/SGLang) or DEPLOY_MODE=cloud.",
    );
  }

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
      warnings.push(
        `AUTH_MODE=none while listening on non-loopback HOST=${env.HOST}: anyone who can reach this port has full admin access.`,
      );
    }
  }

  const usesCloud =
    env.AUTH_MODE === "cloud" ||
    env.BILLING_MODE === "cloud" ||
    env.DEPLOY_MODE === "cloud";
  if (usesCloud && (!env.CLOUD_INTERNAL_API_URL || !env.CLOUD_SERVICE_TOKEN)) {
    throw new Error(
      "CLOUD_INTERNAL_API_URL and CLOUD_SERVICE_TOKEN are required when AUTH_MODE, BILLING_MODE or DEPLOY_MODE is 'cloud'.",
    );
  }

  if (env.TRAINER_API_KEY && env.TRAINER_API_KEY_HASH) {
    throw new Error(
      "Set only one of TRAINER_API_KEY and TRAINER_API_KEY_HASH.",
    );
  }

  if (!env.DATABASE_URL) {
    warnings.push(
      "DATABASE_URL is not set: using the in-memory store; all data is lost on restart and only one replica is supported.",
    );
  }

  const judgeBaseUrl =
    env.JUDGE_BASE_URL ?? env.GRAD_JUDGE_BASE_URL ?? env.INFERENCE_BASE_URL;
  const judgeApiKey =
    env.JUDGE_API_KEY ??
    (env.JUDGE_BASE_URL || env.GRAD_JUDGE_BASE_URL
      ? undefined
      : env.INFERENCE_API_KEY);

  return {
    ...env,
    DEPLOY_MODE: env.DEPLOY_MODE,
    judgeBaseUrl,
    judgeApiKey,
    warnings,
  };
};
