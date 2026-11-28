import { createHash } from "node:crypto";

import { addSeconds } from "../clock.js";
import type { UploadTicket } from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { type ApiError, conflict, invalid } from "../errors.js";

/**
 * Uploads keep no rows. Keys are content-addressed and scoped:
 * - released artifact bundles: `artifacts/<ws>/<sha256>` (the only prefix
 *   serving reads; checkpoints stay under their job until promoted);
 * - worker blobs: `ws/<ws>/jobs/<job>/<attempt>/<sha256>`;
 * - user files for imports: `uploads/<ws>/<sha256>` (the staging prefix).
 * A presigned PUT binds Content-Length and x-amz-checksum-sha256, so the
 * store rejects any other body (verified on AWS S3, SeaweedFS and MinIO by
 * test/storage-contract.test.ts). Committing an upload derives the key from
 * the caller's own scope (so it can only name its own prefix), HEADs the
 * object and checks its sha256 itself, on any backend: the checksum HEAD
 * reports, else a streamed hash of the object. Staged user files are swept
 * after STAGING_TTL_SECONDS.
 */

const UPLOAD_URL_TTL_SECONDS = 6 * 3600;
const DOWNLOAD_URL_TTL_SECONDS = 3600;
/** User uploads expire this long after upload (the import must be claimed by then). */
const STAGING_TTL_SECONDS = 7 * 86_400;
const STAGING_PREFIX = "uploads";
export const ARTIFACTS_PREFIX = "artifacts";

const SHA256_RE = /^[0-9a-f]{64}$/;

const ws = (workspaceId: string): string => encodeURIComponent(workspaceId);

export const jobBlobKey = (
  job: { workspace_id: string; id: string },
  attempt: number,
  sha256: string,
): string => `ws/${ws(job.workspace_id)}/jobs/${job.id}/${attempt}/${sha256}`;

export const artifactKey = (workspaceId: string, sha256: string): string =>
  `${ARTIFACTS_PREFIX}/${ws(workspaceId)}/${sha256}`;

export const stagingKey = (workspaceId: string, sha256: string): string =>
  `${STAGING_PREFIX}/${ws(workspaceId)}/${sha256}`;

interface VerifiedBlob {
  key: string;
  sha256: string;
  sizeBytes: number;
}

export interface UploadService {
  /**
   * A presigned PUT ticket for `key`, whose last segment is the sha256.
   * `forClient`: an SDK client uploads it (signed for S3_PUBLIC_ENDPOINT).
   */
  ticket(
    key: string,
    sizeBytes: number,
    options?: { forClient?: boolean },
  ): Promise<UploadTicket>;
  /**
   * The uploaded object at `key` (an `upload_id` resolved in the caller's
   * scope): it must exist and its bytes must hash to the upload id.
   */
  commit(
    uploadId: string,
    keyFor: (sha256: string) => string,
  ): Promise<VerifiedBlob>;
  /** Presigned GET URL (for workers). */
  downloadUrl(key: string, expiresInSeconds?: number): Promise<string>;
  /** Deletes staged user uploads older than STAGING_TTL_SECONDS. */
  sweepStaging(now: Date): Promise<number>;
}

const sha256OfStream = async (
  stream: ReadableStream<Uint8Array>,
): Promise<string> => {
  const hash = createHash("sha256");
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }

  return hash.digest("hex");
};

export const uploadIncomplete = (uploadId: string): ApiError =>
  conflict(
    "upload_incomplete",
    `Upload '${uploadId}' has not been received yet; PUT the file to its upload URL first.`,
  );

export const createUploadService = (deps: AppDependencies): UploadService => {
  const { storage, clock } = deps;

  return {
    ticket: async (key, sizeBytes, options = {}) => {
      const sha256 = key.slice(key.lastIndexOf("/") + 1);
      const presigned = await storage.presignUpload(key, {
        sha256,
        sizeBytes,
        expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
        forClient: options.forClient === true,
      });

      return {
        upload_id: sha256,
        method: "PUT",
        url: presigned.url,
        headers: presigned.headers,
        expires_at: addSeconds(
          clock.now(),
          UPLOAD_URL_TTL_SECONDS,
        ).toISOString(),
      };
    },

    commit: async (uploadId, keyFor) => {
      if (!SHA256_RE.test(uploadId)) {
        throw invalid(
          "unknown_upload",
          `Upload '${uploadId}' is not an upload id (the file's sha256).`,
        );
      }
      const key = keyFor(uploadId);
      const head = await storage.head(key);
      if (!head) throw uploadIncomplete(uploadId);
      // The store verified the signed checksum on PUT and HEAD reports it
      // back; a backend that keeps no checksum gets the bytes hashed here.
      const sha =
        head.sha256 ?? (await sha256OfStream(await storage.getStream(key)));
      if (sha !== uploadId) {
        throw invalid(
          "upload_integrity_error",
          `Upload '${uploadId}' does not match its sha256.`,
        );
      }

      return { key, sha256: uploadId, sizeBytes: head.sizeBytes };
    },

    downloadUrl: async (key, expiresInSeconds = DOWNLOAD_URL_TTL_SECONDS) =>
      storage.presignDownload(key, expiresInSeconds),

    sweepStaging: async (now) => {
      const keys = await storage.listOlder(
        STAGING_PREFIX,
        addSeconds(now, -STAGING_TTL_SECONDS),
        500,
      );
      for (const key of keys) await storage.delete(key);

      return keys.length;
    },
  };
};
