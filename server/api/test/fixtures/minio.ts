import { inject } from "vitest";

export interface S3TestTarget {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    s3Target: S3TestTarget | null;
    s3Unavailable: string | null;
  }
}

/**
 * The MinIO (or CI service container) target started by minio-global.ts, or
 * null when S3 tests must be skipped. `GRAD_REQUIRE_S3=1` turns a skip into a
 * failure so CI cannot silently lose coverage.
 */
export const s3Target = (): S3TestTarget | null => {
  const target = inject("s3Target");
  if (!target && process.env.GRAD_REQUIRE_S3 === "1") {
    throw new Error(
      `GRAD_REQUIRE_S3=1 but no S3 endpoint is available: ${inject("s3Unavailable") ?? "unknown reason"}`,
    );
  }

  return target;
};
