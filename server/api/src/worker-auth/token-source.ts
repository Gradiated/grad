import { readFileSync } from "node:fs";

/**
 * The worker side of worker auth, for TypeScript workers (the eval worker):
 * GRAD_WORKER_TOKEN, else GRAD_WORKER_TOKEN_FILE re-read on every call (so a
 * rotated projected service-account token or re-minted lease token is
 * picked up), else TRAINER_API_KEY. Never logs the token.
 */
export const workerTokenSource = (
  env: Record<string, string | undefined> = process.env,
): (() => string | undefined) => {
  const fixed = env.GRAD_WORKER_TOKEN?.trim();
  if (fixed) return () => fixed;
  const path = env.GRAD_WORKER_TOKEN_FILE?.trim();
  if (path) {
    return () => {
      try {
        return readFileSync(path, "utf8").trim() || undefined;
      } catch {
        return undefined;
      }
    };
  }
  const key = env.TRAINER_API_KEY?.trim() || undefined;

  return () => key;
};
