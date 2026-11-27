import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * HMAC-signed, expiring URLs for the server-proxied blob endpoints used when
 * the object store cannot presign (local filesystem). URLs are relative to
 * the API base URL. Replicas sharing a filesystem must share the secret.
 */
export interface BlobSigner {
  uploadPath(uploadId: string, expiresAt: Date): string;
  verifyUpload(uploadId: string, exp: string, sig: string, now: Date): boolean;
  downloadPath(key: string, expiresAt: Date): string;
  verifyDownload(key: string, exp: string, sig: string, now: Date): boolean;
}

export const BLOB_UPLOAD_PREFIX = "/blobs/uploads/";
export const BLOB_DOWNLOAD_PATH = "/blobs/objects";

export const createBlobSigner = (secret?: string): BlobSigner => {
  const key = secret ? Buffer.from(secret, "utf8") : randomBytes(32);

  const sign = (purpose: string, subject: string, exp: string): string =>
    createHmac("sha256", key)
      .update(`${purpose}\n${subject}\n${exp}`)
      .digest("base64url");

  const verify = (
    purpose: string,
    subject: string,
    exp: string,
    sig: string,
    now: Date,
  ): boolean => {
    if (!/^\d{1,13}$/.test(exp) || Number(exp) < now.getTime()) return false;
    const expected = Buffer.from(sign(purpose, subject, exp));
    const given = Buffer.from(sig);

    return expected.length === given.length && timingSafeEqual(expected, given);
  };

  return {
    uploadPath: (uploadId, expiresAt) => {
      const exp = String(expiresAt.getTime());

      return `${BLOB_UPLOAD_PREFIX}${encodeURIComponent(uploadId)}?exp=${exp}&sig=${sign("put", uploadId, exp)}`;
    },
    verifyUpload: (uploadId, exp, sig, now) =>
      verify("put", uploadId, exp, sig, now),
    downloadPath: (objectKey, expiresAt) => {
      const exp = String(expiresAt.getTime());

      return `${BLOB_DOWNLOAD_PATH}?key=${encodeURIComponent(objectKey)}&exp=${exp}&sig=${sign("get", objectKey, exp)}`;
    },
    verifyDownload: (objectKey, exp, sig, now) =>
      verify("get", objectKey, exp, sig, now),
  };
};
