export interface StoredObject {
  key: string;
  sha256: string;
  sizeBytes: number;
}

export interface ObjectHead {
  sizeBytes: number;
  /** Lowercase hex SHA-256 when the backend stores a checksum, else null. */
  sha256: string | null;
}

export class ObjectExistsError extends Error {
  constructor(readonly key: string) {
    super(`Object '${key}' already exists and is immutable.`);
    this.name = "ObjectExistsError";
  }
}

export class ObjectNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`Object '${key}' was not found.`);
    this.name = "ObjectNotFoundError";
  }
}

export class ObjectIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectIntegrityError";
  }
}

export interface PutStreamOptions {
  /** Hard cap; exceeding it aborts the write with ObjectIntegrityError. */
  maxBytes: number;
  expectedSha256?: string | undefined;
  expectedSizeBytes?: number | undefined;
}

export interface PresignedUpload {
  url: string;
  headers: Record<string, string>;
}

/**
 * Immutable object storage. Server writes never overwrite an existing object
 * (writes to an existing key throw ObjectExistsError).
 */
export interface ObjectStore {
  readonly kind: "local" | "s3";
  put(key: string, data: Uint8Array): Promise<StoredObject>;
  putStream(
    key: string,
    body: AsyncIterable<Uint8Array>,
    options: PutStreamOptions,
  ): Promise<StoredObject>;
  /** Throws ObjectNotFoundError. */
  get(key: string): Promise<Uint8Array>;
  /** Throws ObjectNotFoundError. */
  getStream(key: string): Promise<ReadableStream<Uint8Array>>;
  head(key: string): Promise<ObjectHead | null>;
  /** Up to `limit` keys under `prefix` last modified before `before`. */
  listOlder(prefix: string, before: Date, limit: number): Promise<string[]>;
  /** Idempotent. */
  delete(key: string): Promise<void>;
  /**
   * Direct-to-storage presigned PUT whose Content-Length and
   * x-amz-checksum-sha256 are signed, so the store rejects any other body.
   * Keys are content-addressed (the sha256 is their last segment), so a
   * re-upload writes identical bytes. Null when the backend has no presigning
   * (local FS: use the server proxy, which verifies the bytes itself).
   */
  presignUpload(
    key: string,
    input: { sha256: string; sizeBytes: number; expiresInSeconds: number },
  ): Promise<PresignedUpload | null>;
  /** Presigned GET, or null when the backend has no presigning. */
  presignDownload(
    key: string,
    expiresInSeconds: number,
  ): Promise<string | null>;
}

export const validateObjectKey = (key: string): string => {
  if (
    !key ||
    key.length > 1024 ||
    key.startsWith("/") ||
    key.includes("\0") ||
    key.includes("\\")
  ) {
    throw new Error(`Invalid object storage key: '${key}'.`);
  }

  const segments = key.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Invalid object storage key: '${key}'.`);
  }

  return key;
};
