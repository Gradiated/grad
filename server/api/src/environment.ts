import { z } from "zod";

const EnvironmentSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_URL: z.string().optional(),
  STORAGE_DIR: z.string().default(".grad-data"),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),
  AUTH_MODE: z.enum(["none", "api_key"]).default("none"),
  ADMIN_API_KEY_HASH: z.string().optional(),
  DEFAULT_WORKSPACE_ID: z.string().default("local"),
  DEPLOY_MODE: z.enum(["disabled", "local"]).default("local"),
  ALLOW_WAVE2_RECIPES: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type ServerEnvironment = z.infer<typeof EnvironmentSchema>;

export const parseServerEnvironment = (
  raw: Record<string, string | undefined> = process.env,
): ServerEnvironment => EnvironmentSchema.parse(raw);
