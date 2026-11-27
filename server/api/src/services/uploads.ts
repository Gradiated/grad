import { createHash } from "node:crypto";

import { addSeconds } from "../clock.js";
import type { UploadTicket } from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { ApiError, conflict, invalid } from "../errors.js";
import { ObjectExistsError, ObjectIntegrityError } from "../storage/types.js";

/**
 * Uploads keep no rows. Keys are content-addressed and scoped:
 * - worker blobs: `ws/<ws>/jobs/<job>/<attempt>/<sha256>`;
 * - user files for imports: `uploads/<ws>/<sha256>` (the staging prefix).
 * A presigned PUT binds Content-Length and x-amz-checksum-sha256, so S3
 * rejects any other body; local-FS mode streams through the server, which
 * verifies the bytes. Committing an upload derives the key from the caller's
 * own scope (so it can only name its own prefix) and HEADs the object.
 * Staged user files are swept after STAGING_TTL_SECONDS.
 */

export const UPLOAD_URL_TTL_SECONDS = 6 * 3600;
export const DOWNLOAD_URL_TTL_SECONDS = 3600;
/** User uploads expire this long after upload (the import must be claimed by then). */
export const STAGING_TTL_SECONDS = 7 * 86_400;
export const STAGING_PREFIX = "uploads";

const SHA256_RE = /^[0-9a-f]{64}$/;

const ws = (workspaceId: string): string => encodeURIComponent(workspaceId);

export const jobBlobKey = (
  job: { workspace_id: string; id: string },
  attempt: number,
  sha256: string,
): string => `ws/${ws(job.workspace_id)}/jobs/${job.id}/${attempt}/${sha256}`;

export const stagingKey = (workspaceId: string, sha256: string): string =>
  `${STAGING_PREFIX}/${ws(workspaceId)}/${sha256}`;

export interface VerifiedBlob {
  key: string;
  sha256: string;
  sizeBytes: number;
}

export interface UploadService {
  /** A PUT ticket for `key`, whose last segment is the sha256. */
  ticket(key: string, sizeBytes: number): Promise<UploadTicket>;
  /** Server-proxied PUT for stores without presigning (local FS). */
  receive(
    query: { key: string; size: string; exp: string; sig: string },
    body: AsyncIterable<Uint8Array>,
  ): Promise<VerifiedBlob>;
  /**
   * The uploaded object at `key` (an `upload_id` resolved in the caller's
   * scope): it must exist, and on S3 its stored checksum must match.
   */
  commit(
    uploadId: string,
    keyFor: (sha256: string) => string,
  ): Promise<VerifiedBlob>;
  /** Presigned URL (S3) or a signed server path (local FS). */
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

const notReceived = (uploadId: string): ApiError =>
  conflict(
    "upload_incomplete",
    `Upload '${uploadId}' has not been received yet; PUT the file to its upload URL first.`,
  );

export const createUploadService = (deps: AppDependencies): UploadService => {
  const { storage, signer, clock } = deps;

  return {
    ticket: async (key, sizeBytes) => {
      const sha256 = key.slice(key.lastIndexOf("/") + 1);
      const expiresAt = addSeconds(clock.now(), UPLOAD_URL_TTL_SECONDS);
      const presigned = await storage.presignUpload(key, {
        sha256,
        sizeBytes,
        expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
      });

      return {
        upload_id: sha256,
        method: "PUT",
        url: presigned?.url ?? signer.uploadPath(key, sizeBytes, expiresAt),
        headers: presigned?.headers ?? {
          "Content-Type": "application/octet-stream",
        },
        expires_at: expiresAt.toISOString(),
      };
    },

    receive: async ({ key, size, exp, sig }, body) => {
      if (!signer.verifyUpload(key, size, exp, sig, clock.now())) {
        throw new ApiError(
          403,
          "invalid_upload_signature",
          "Invalid upload URL",
          "The upload URL signature is invalid or expired; request a new upload ticket.",
        );
      }
      const sha256 = key.slice(key.lastIndexOf("/") + 1);
      const sizeBytes = Number(size);
      const blob = { key, sha256, sizeBytes };
      try {
        await storage.putStream(key, body, {
          maxBytes: sizeBytes,
          expectedSha256: sha256,
          expectedSizeBytes: sizeBytes,
        });
      } catch (error) {
        if (error instanceof ObjectIntegrityError) {
          throw invalid("upload_integrity_error", error.message);
        }
        // Content-addressed: the same bytes were already received.
        if (error instanceof ObjectExistsError) return blob;
        throw error;
      }

      return blob;
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
      if (!head) throw notReceived(uploadId);
      // Local FS verified the bytes on receive; S3 verified the signed
      // checksum on PUT, which HEAD reports back (else hash it here).
      if (storage.kind === "s3") {
        const sha =
          head.sha256 ?? (await sha256OfStream(await storage.getStream(key)));
        if (sha !== uploadId) {
          throw invalid(
            "upload_integrity_error",
            `Upload '${uploadId}' does not match its sha256.`,
          );
        }
      }

      return { key, sha256: uploadId, sizeBytes: head.sizeBytes };
    },

    downloadUrl: async (key, expiresInSeconds = DOWNLOAD_URL_TTL_SECONDS) =>
      (await storage.presignDownload(key, expiresInSeconds)) ??
      signer.downloadPath(key, addSeconds(clock.now(), expiresInSeconds)),

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
