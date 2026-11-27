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

/** The object store is unreachable, timed out or answered 5xx: retry shortly (API: 503). */
export class StorageUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `Object storage unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "StorageUnavailableError";
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

export interface PresignUploadInput {
  sha256: string;
  sizeBytes: number;
  expiresInSeconds: number;
  /** Sign for the endpoint SDK clients reach (S3_PUBLIC_ENDPOINT), not the workers' one. */
  forClient?: boolean;
}

/**
 * Immutable S3-compatible object storage. Server writes never overwrite an
 * existing object (writes to an existing key throw ObjectExistsError).
 */
export interface ObjectStore {
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
  /**
   * Up to `limit` keys under `prefix` last modified before `before`, in key
   * order, after the key `after` when given (to page through a prefix).
   */
  listOlder(
    prefix: string,
    before: Date,
    limit: number,
    after?: string,
  ): Promise<string[]>;
  /** Idempotent. */
  delete(key: string): Promise<void>;
  /**
   * Server-side copy of `from` to `to` (both under 5 GB, the upload cap).
   * Keys are content-addressed, so an existing `to` is left as it is.
   * Throws ObjectNotFoundError when `from` is missing.
   */
  copy(from: string, to: string): Promise<void>;
  /**
   * Direct-to-storage presigned PUT whose Content-Length and
   * x-amz-checksum-sha256 are signed, so the store rejects any other body.
   * Keys are content-addressed (the sha256 is their last segment), so a
   * re-upload writes identical bytes.
   */
  presignUpload(
    key: string,
    input: PresignUploadInput,
  ): Promise<PresignedUpload>;
  /**
   * Presigned GET (for workers; `forClient`: signed for S3_PUBLIC_ENDPOINT).
   * `filename`: the store answers `Content-Disposition: attachment` with it, so a
   * browser saves the object under that name instead of its storage key.
   */
  presignDownload(
    key: string,
    expiresInSeconds: number,
    options?: { forClient?: boolean; filename?: string },
  ): Promise<string>;
}

/**
 * `attachment; filename="…"; filename*=UTF-8''…` (RFC 6266): an ASCII fallback with
 * quotes, backslashes and controls replaced, plus the exact name percent-encoded.
 */
export const attachmentDisposition = (filename: string): string => {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const exact = encodeURIComponent(filename).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename="${fallback}"; filename*=UTF-8''${exact}`;
};

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
