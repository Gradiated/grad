import { createHash } from "node:crypto";

import { addSeconds } from "../clock.js";
import type { UploadTicket } from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { ApiError, conflict, invalid, notFound } from "../errors.js";
import { newId } from "../ids.js";
import { ObjectExistsError, ObjectIntegrityError } from "../storage/types.js";
import type {
  Repositories,
  UploadPurpose,
  UploadRecord,
} from "../store/types.js";

export const UPLOAD_TTL_SECONDS = 6 * 3600;
export const DOWNLOAD_URL_TTL_SECONDS = 3600;

export interface UploadService {
  createTicket(input: {
    workspaceId: string;
    purpose: UploadPurpose;
    jobId: string | null;
    attempt: number | null;
    sha256: string;
    sizeBytes: number;
  }): Promise<{ upload: UploadRecord; ticket: UploadTicket }>;
  /** Server-proxied PUT for stores without presigning (local FS). */
  receive(
    uploadId: string,
    exp: string,
    sig: string,
    body: AsyncIterable<Uint8Array>,
  ): Promise<UploadRecord>;
  /**
   * Checks that the object behind an upload exists with the declared size and
   * sha256. Call before `consume` (outside any DB transaction).
   */
  verify(upload: UploadRecord): Promise<void>;
  /** Loads an upload owned by (workspace, purpose, job, attempt) or throws. */
  load(input: {
    uploadId: string;
    workspaceId: string;
    purpose: UploadPurpose;
    jobId: string | null;
    attempt: number | null;
  }): Promise<UploadRecord>;
  /** Marks the upload consumed (single use) inside `tx`; throws 409 if already used. */
  consume(
    tx: Repositories,
    upload: UploadRecord,
    consumedBy: string,
  ): Promise<UploadRecord>;
  /** Presigned URL (S3) or a signed server path (local FS). */
  downloadUrl(key: string, expiresInSeconds?: number): Promise<string>;
  /** Deletes unconsumed uploads past their expiry. */
  collectExpired(now: Date): Promise<number>;
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

export const createUploadService = (deps: AppDependencies): UploadService => {
  const { store, storage, signer, clock } = deps;

  const verify = async (upload: UploadRecord): Promise<void> => {
    if (storage.kind === "local") {
      if (upload.status === "pending") {
        throw conflict(
          "upload_incomplete",
          `Upload '${upload.id}' has not been received yet; PUT the file to its upload URL first.`,
        );
      }
      return;
    }

    const head = await storage.head(upload.storage_key);
    if (!head) {
      throw conflict(
        "upload_incomplete",
        `Upload '${upload.id}' has not been received yet; PUT the file to its upload URL first.`,
      );
    }
    if (head.sizeBytes !== upload.size_bytes) {
      throw invalid(
        "upload_integrity_error",
        `Upload '${upload.id}' is ${head.sizeBytes} bytes but ${upload.size_bytes} were declared.`,
      );
    }

    const sha =
      head.sha256 ??
      (await sha256OfStream(await storage.getStream(upload.storage_key)));
    if (sha !== upload.sha256) {
      throw invalid(
        "upload_integrity_error",
        `Upload '${upload.id}' sha256 does not match the declared digest.`,
      );
    }
  };

  return {
    createTicket: async (input) => {
      const id = newId("upl");
      const expiresAt = addSeconds(clock.now(), UPLOAD_TTL_SECONDS);
      const storageKey = `uploads/${encodeURIComponent(input.workspaceId)}/${id}`;
      const upload = await store.uploads.create({
        id,
        workspaceId: input.workspaceId,
        purpose: input.purpose,
        jobId: input.jobId,
        attempt: input.attempt,
        storageKey,
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        expiresAt: expiresAt.toISOString(),
      });

      const presigned = await storage.presignUpload(storageKey, {
        sha256: input.sha256,
        sizeBytes: input.sizeBytes,
        expiresInSeconds: UPLOAD_TTL_SECONDS,
      });

      return {
        upload,
        ticket: {
          upload_id: id,
          method: "PUT",
          url: presigned?.url ?? signer.uploadPath(id, expiresAt),
          headers: presigned?.headers ?? {
            "Content-Type": "application/octet-stream",
          },
          expires_at: expiresAt.toISOString(),
        },
      };
    },

    receive: async (uploadId, exp, sig, body) => {
      if (!signer.verifyUpload(uploadId, exp, sig, clock.now())) {
        throw new ApiError(
          403,
          "invalid_upload_signature",
          "Invalid upload URL",
          "The upload URL signature is invalid or expired; request a new upload ticket.",
        );
      }

      const upload = await store.uploads.get(uploadId);
      if (!upload) throw notFound("upload", uploadId);
      if (upload.status !== "pending") {
        throw conflict(
          "upload_already_received",
          `Upload '${uploadId}' was already received.`,
        );
      }

      try {
        await storage.putStream(upload.storage_key, body, {
          maxBytes: upload.size_bytes,
          expectedSha256: upload.sha256,
          expectedSizeBytes: upload.size_bytes,
        });
      } catch (error) {
        if (error instanceof ObjectIntegrityError) {
          throw invalid("upload_integrity_error", error.message);
        }
        if (error instanceof ObjectExistsError) {
          throw conflict(
            "upload_already_received",
            `Upload '${uploadId}' was already received.`,
          );
        }
        throw error;
      }

      return (await store.uploads.markUploaded(uploadId)) ?? upload;
    },

    verify,

    load: async ({ uploadId, workspaceId, purpose, jobId, attempt }) => {
      const upload = await store.uploads.get(uploadId);
      if (
        !upload ||
        upload.workspace_id !== workspaceId ||
        upload.purpose !== purpose ||
        upload.job_id !== jobId ||
        upload.attempt !== attempt
      ) {
        throw invalid(
          "unknown_upload",
          `Upload '${uploadId}' does not exist or was not issued for this ${purpose}.`,
        );
      }
      if (
        Date.parse(upload.expires_at) < clock.now().getTime() &&
        upload.status !== "consumed"
      ) {
        throw new ApiError(
          410,
          "upload_expired",
          "Upload expired",
          `Upload '${uploadId}' expired.`,
        );
      }

      return upload;
    },

    consume: async (tx, upload, consumedBy) => {
      const consumed = await tx.uploads.consume(upload.id, consumedBy);
      if (!consumed) {
        throw conflict(
          "upload_already_used",
          `Upload '${upload.id}' was already used.`,
        );
      }

      return consumed;
    },

    downloadUrl: async (key, expiresInSeconds = DOWNLOAD_URL_TTL_SECONDS) =>
      (await storage.presignDownload(key, expiresInSeconds)) ??
      signer.downloadPath(key, addSeconds(clock.now(), expiresInSeconds)),

    collectExpired: async (now) => {
      const expired = await store.uploads.listExpired(now, 100);
      for (const upload of expired) {
        await storage.delete(upload.storage_key);
        await store.uploads.delete(upload.id);
      }

      return expired.length;
    },
  };
};
