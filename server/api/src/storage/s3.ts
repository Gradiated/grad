import { createHash } from "node:crypto";
import {
  CopyObjectCommand,
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
  attachmentDisposition,
  ObjectExistsError,
  ObjectIntegrityError,
  ObjectNotFoundError,
  StorageUnavailableError,
  validateObjectKey,
  type ObjectHead,
  type ObjectStore,
  type PresignUploadInput,
  type PresignedUpload,
  type StoredObject,
} from "./types.js";

interface S3ObjectStoreOptions {
  bucket: string;
  region?: string | undefined;
  endpoint?: string | undefined;
  /**
   * The endpoint SDK clients reach, when it differs from `endpoint` (compose:
   * workers use http://seaweedfs:8333, the host uses 127.0.0.1). Only client
   * upload tickets are signed for it.
   */
  publicEndpoint?: string | undefined;
  /** Defaults to true when a custom endpoint (SeaweedFS, MinIO, R2...) is set. */
  forcePathStyle?: boolean | undefined;
  credentials?: S3ClientConfig["credentials"];
  /** Injected client (tests); other connection options are then ignored. */
  client?: S3Client;
  /**
   * A request's bound (default 120 s). A streamed read is bound by it until
   * the response starts, then by the same time between two chunks, so a
   * long download on a slow link finishes and a stalled one still ends.
   */
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

/** A 5xx, a timeout or a failed connection after the SDK's own retries. */
const isTransient = (error: unknown): boolean => {
  const status = awsStatus(error);
  if (status !== undefined) return status >= 500 || status === 429;
  const name = awsName(error);

  return (
    ["TimeoutError", "AbortError", "RequestTimeout", "SlowDown"].includes(
      name,
    ) ||
    typeof (error as { code?: unknown })?.code === "string" ||
    (error as { $retryable?: unknown })?.$retryable !== undefined
  );
};

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
 * service rejects corrupted bodies. Clients and workers upload large bodies
 * straight to storage through presigned PUTs.
 */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  /** Signs client upload tickets (S3_PUBLIC_ENDPOINT); `client` otherwise. */
  private readonly publicClient: S3Client;
  private readonly bucket: string;
  private readonly timeoutMs: number;

  constructor(options: S3ObjectStoreOptions) {
    this.bucket = options.bucket;
    this.timeoutMs = options.requestTimeoutMs ?? 120_000;
    const connect = (endpoint: string | undefined): S3Client =>
      new S3Client({
        ...(options.region ? { region: options.region } : {}),
        ...(endpoint ? { endpoint } : {}),
        forcePathStyle: options.forcePathStyle ?? Boolean(endpoint),
        ...(options.credentials ? { credentials: options.credentials } : {}),
        maxAttempts: 3,
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
    this.client = options.client ?? connect(options.endpoint);
    this.publicClient =
      options.publicEndpoint && options.publicEndpoint !== options.endpoint
        ? connect(options.publicEndpoint)
        : this.client;
  }

  private signal = (ms = this.timeoutMs): AbortSignal =>
    AbortSignal.timeout(ms);

  /** `client.send`, with transient failures as StorageUnavailableError. */
  private send = (async (command: never, options?: never) => {
    try {
      return await this.client.send(command, options);
    } catch (error) {
      throw isTransient(error) ? new StorageUnavailableError(error) : error;
    }
  }) as unknown as S3Client["send"];

  private sendPut = async (
    key: string,
    body: Uint8Array,
    sha256: string,
    sizeBytes: number,
  ): Promise<void> => {
    try {
      await this.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: sizeBytes,
          ChecksumSHA256: hexToBase64(sha256),
          IfNoneMatch: "*",
        }),
        { abortSignal: this.signal() },
      );
    } catch (error) {
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

  private getObject = async (key: string, abortSignal: AbortSignal) => {
    const clean = validateObjectKey(key);
    try {
      const response = await this.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: clean }),
        { abortSignal },
      );
      if (!response.Body) throw new ObjectNotFoundError(clean);

      return response.Body;
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError(clean);
      throw error;
    }
  };

  get = async (key: string): Promise<Uint8Array> =>
    (await this.getObject(key, this.signal())).transformToByteArray();

  getStream = async (key: string): Promise<ReadableStream<Uint8Array>> => {
    // An idle timer, not a deadline: it restarts with every chunk.
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => controller.abort(new Error("S3 read timed out")),
        this.timeoutMs,
      );
      timer.unref();
    };
    arm();
    try {
      const body = (
        await this.getObject(key, controller.signal)
      ).transformToWebStream() as ReadableStream<Uint8Array>;

      return body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform: (chunk, out) => {
            arm();
            out.enqueue(chunk);
          },
          flush: () => clearTimeout(timer),
        }),
      );
    } catch (error) {
      clearTimeout(timer);
      throw error;
    }
  };

  head = async (key: string): Promise<ObjectHead | null> => {
    const clean = validateObjectKey(key);
    try {
      const response = await this.send(
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
    after?: string,
  ): Promise<string[]> => {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${validateObjectKey(prefix)}/`,
          ContinuationToken: token,
          StartAfter: token ? undefined : after,
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
    await this.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: clean }),
      { abortSignal: this.signal(15_000) },
    );
  };

  copy = async (from: string, to: string): Promise<void> => {
    const source = validateObjectKey(from);
    const target = validateObjectKey(to);
    if (await this.head(target)) return;
    try {
      await this.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: target,
          CopySource: `${this.bucket}/${source.split("/").map(encodeURIComponent).join("/")}`,
          ChecksumAlgorithm: "SHA256",
        }),
        { abortSignal: this.signal(15 * 60_000) },
      );
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError(from);
      throw error;
    }
  };

  presignUpload = async (
    key: string,
    input: PresignUploadInput,
  ): Promise<PresignedUpload> => {
    const clean = validateObjectKey(key);
    const headers = uploadHeaders(input.sha256, input.sizeBytes);
    const url = await getSignedUrl(
      input.forClient ? this.publicClient : this.client,
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
    options: { forClient?: boolean; filename?: string } = {},
  ): Promise<string> =>
    getSignedUrl(
      options.forClient ? this.publicClient : this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: validateObjectKey(key),
        ...(options.filename
          ? {
              ResponseContentDisposition: attachmentDisposition(
                options.filename,
              ),
            }
          : {}),
      }),
      { expiresIn: expiresInSeconds },
    );

  close = (): void => {
    this.client.destroy();
    this.publicClient.destroy();
  };
}
