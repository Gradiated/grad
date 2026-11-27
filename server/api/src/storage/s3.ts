import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  ObjectExistsError,
  ObjectIntegrityError,
  ObjectNotFoundError,
  validateObjectKey,
  type ObjectHead,
  type ObjectStore,
  type PresignedUpload,
  type PutStreamOptions,
  type StoredObject,
} from "./types.js";

export interface S3ObjectStoreOptions {
  bucket: string;
  region?: string | undefined;
  endpoint?: string | undefined;
  /** Defaults to true when a custom endpoint (MinIO, Ceph, R2...) is set. */
  forcePathStyle?: boolean | undefined;
  credentials?: S3ClientConfig["credentials"];
  /** Injected client (tests); other connection options are then ignored. */
  client?: S3Client;
  requestTimeoutMs?: number;
}

const hexToBase64 = (hex: string): string =>
  Buffer.from(hex, "hex").toString("base64");

const base64ToHex = (b64: string): string | null => {
  const raw = Buffer.from(b64, "base64");

  return raw.length === 32 ? raw.toString("hex") : null;
};

interface AwsLikeError {
  name?: string;
  Code?: string;
  $metadata?: { httpStatusCode?: number };
}

const awsStatus = (error: unknown): number | undefined =>
  (error as AwsLikeError)?.$metadata?.httpStatusCode;

const awsName = (error: unknown): string =>
  (error as AwsLikeError)?.name ?? (error as AwsLikeError)?.Code ?? "";

const isNotFound = (error: unknown): boolean =>
  ["NoSuchKey", "NotFound", "NoSuchObject"].includes(awsName(error)) ||
  awsStatus(error) === 404;

const isPreconditionFailed = (error: unknown): boolean =>
  ["PreconditionFailed", "ConditionalRequestConflict"].includes(
    awsName(error),
  ) ||
  awsStatus(error) === 412 ||
  awsStatus(error) === 409;

const isBadDigest = (error: unknown): boolean =>
  ["BadDigest", "XAmzContentChecksumMismatch", "InvalidDigest"].includes(
    awsName(error),
  );

/** Headers a presigned upload PUT must carry (all of them are signed). */
const uploadHeaders = (
  sha256: string,
  sizeBytes: number,
): Record<string, string> => ({
  "content-length": String(sizeBytes),
  "x-amz-checksum-sha256": hexToBase64(sha256),
});

/**
 * S3 (or S3-compatible) object store. Writes use `If-None-Match: *` so an
 * existing key is never replaced, and carry `x-amz-checksum-sha256` so the
 * service rejects corrupted bodies.
 *
 * `putStream` streams the body straight through when the caller declares both
 * size and sha256 (the trainer upload path: S3 verifies the digest
 * server-side). Without both, the body is buffered in memory up to
 * `maxBytes`, because a single PutObject needs the length and checksum up
 * front and multipart upload (`@aws-sdk/lib-storage`) is not a dependency.
 */
export class S3ObjectStore implements ObjectStore {
  readonly kind = "s3" as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly timeoutMs: number;

  constructor(options: S3ObjectStoreOptions) {
    this.bucket = options.bucket;
    this.timeoutMs = options.requestTimeoutMs ?? 120_000;
    this.client =
      options.client ??
      new S3Client({
        ...(options.region ? { region: options.region } : {}),
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
        ...(options.credentials ? { credentials: options.credentials } : {}),
        maxAttempts: 3,
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
  }

  private signal = (ms = this.timeoutMs): AbortSignal =>
    AbortSignal.timeout(ms);

  private sendPut = async (
    key: string,
    body: Uint8Array | Readable,
    sha256: string,
    sizeBytes: number,
    abort?: AbortSignal,
  ): Promise<void> => {
    const signal = abort
      ? AbortSignal.any([this.signal(), abort])
      : this.signal();
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: sizeBytes,
          ChecksumSHA256: hexToBase64(sha256),
          IfNoneMatch: "*",
        }),
        { abortSignal: signal },
      );
    } catch (error) {
      if (error instanceof ObjectIntegrityError) throw error;
      if (isPreconditionFailed(error)) throw new ObjectExistsError(key);
      if (isBadDigest(error)) {
        throw new ObjectIntegrityError(
          `Object '${key}' failed the storage checksum verification.`,
        );
      }
      throw error;
    }
  };

  put = async (key: string, data: Uint8Array): Promise<StoredObject> => {
    const clean = validateObjectKey(key);
    const sha256 = createHash("sha256").update(data).digest("hex");
    await this.sendPut(clean, data, sha256, data.byteLength);

    return { key: clean, sha256, sizeBytes: data.byteLength };
  };

  putStream = async (
    key: string,
    body: AsyncIterable<Uint8Array>,
    options: PutStreamOptions,
  ): Promise<StoredObject> => {
    const clean = validateObjectKey(key);
    const { expectedSha256, expectedSizeBytes, maxBytes } = options;
    if (expectedSizeBytes !== undefined && expectedSizeBytes > maxBytes) {
      throw new ObjectIntegrityError(
        `Upload exceeds the ${maxBytes}-byte limit.`,
      );
    }

    if (expectedSha256 !== undefined && expectedSizeBytes !== undefined) {
      const hash = createHash("sha256");
      let size = 0;
      const counted = async function* () {
        for await (const chunk of body) {
          size += chunk.byteLength;
          if (size > expectedSizeBytes) {
            throw new ObjectIntegrityError(
              `Upload exceeds the declared ${expectedSizeBytes} bytes.`,
            );
          }
          hash.update(chunk);
          yield chunk;
        }
        if (size !== expectedSizeBytes) {
          throw new ObjectIntegrityError(
            `Upload size ${size} does not match the declared ${expectedSizeBytes} bytes.`,
          );
        }
        if (hash.digest("hex") !== expectedSha256) {
          throw new ObjectIntegrityError(
            `Upload sha256 does not match the declared ${expectedSha256}.`,
          );
        }
      };

      // A body that ends short of ContentLength would leave the request (and
      // the backend's per-key lock) hanging, so a source error aborts it.
      const controller = new AbortController();
      const stream = Readable.from(counted());
      const failure = new Promise<never>((_, reject) =>
        stream.once("error", (error) => {
          controller.abort(error);
          reject(error);
        }),
      );
      const upload = this.sendPut(
        clean,
        stream,
        expectedSha256,
        expectedSizeBytes,
        controller.signal,
      );
      upload.catch(() => undefined);
      await Promise.race([upload, failure]).finally(() => stream.destroy());

      return { key: clean, sha256: expectedSha256, sizeBytes: size };
    }

    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of body) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        throw new ObjectIntegrityError(
          `Upload exceeds the ${maxBytes}-byte limit.`,
        );
      }
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    const sha256 = createHash("sha256").update(data).digest("hex");
    if (expectedSizeBytes !== undefined && size !== expectedSizeBytes) {
      throw new ObjectIntegrityError(
        `Upload size ${size} does not match the declared ${expectedSizeBytes} bytes.`,
      );
    }
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
      throw new ObjectIntegrityError(
        `Upload sha256 ${sha256} does not match the declared ${expectedSha256}.`,
      );
    }
    await this.sendPut(clean, data, sha256, size);

    return { key: clean, sha256, sizeBytes: size };
  };

  private getObject = async (key: string) => {
    const clean = validateObjectKey(key);
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: clean }),
        { abortSignal: this.signal() },
      );
      if (!response.Body) throw new ObjectNotFoundError(clean);

      return response.Body;
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError(clean);
      throw error;
    }
  };

  get = async (key: string): Promise<Uint8Array> =>
    (await this.getObject(key)).transformToByteArray();

  getStream = async (key: string): Promise<ReadableStream<Uint8Array>> =>
    (
      await this.getObject(key)
    ).transformToWebStream() as ReadableStream<Uint8Array>;

  head = async (key: string): Promise<ObjectHead | null> => {
    const clean = validateObjectKey(key);
    try {
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: clean,
          ChecksumMode: "ENABLED",
        }),
        { abortSignal: this.signal(15_000) },
      );

      return {
        sizeBytes: Number(response.ContentLength ?? 0),
        sha256: response.ChecksumSHA256
          ? base64ToHex(response.ChecksumSHA256)
          : null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };

  listOlder = async (
    prefix: string,
    before: Date,
    limit: number,
  ): Promise<string[]> => {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${validateObjectKey(prefix)}/`,
          ContinuationToken: token,
        }),
        { abortSignal: this.signal(15_000) },
      );
      for (const object of page.Contents ?? []) {
        if (keys.length >= limit) return keys;
        if (object.Key && object.LastModified && object.LastModified < before) {
          keys.push(object.Key);
        }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    return keys;
  };

  delete = async (key: string): Promise<void> => {
    const clean = validateObjectKey(key);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: clean }),
      { abortSignal: this.signal(15_000) },
    );
  };

  presignUpload = async (
    key: string,
    input: { sha256: string; sizeBytes: number; expiresInSeconds: number },
  ): Promise<PresignedUpload> => {
    const clean = validateObjectKey(key);
    const headers = uploadHeaders(input.sha256, input.sizeBytes);
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: clean,
        ContentLength: input.sizeBytes,
        ChecksumSHA256: headers["x-amz-checksum-sha256"],
      }),
      {
        expiresIn: input.expiresInSeconds,
        signableHeaders: new Set(Object.keys(headers)),
        unhoistableHeaders: new Set(["x-amz-checksum-sha256"]),
      },
    );

    return { url, headers };
  };

  presignDownload = async (
    key: string,
    expiresInSeconds: number,
  ): Promise<string> =>
    getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: validateObjectKey(key),
      }),
      { expiresIn: expiresInSeconds },
    );

  close = (): void => {
    this.client.destroy();
  };
}
