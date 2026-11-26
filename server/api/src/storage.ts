import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StoredObject {
  key: string;
  sha256: string;
  sizeBytes: number;
}

export interface ObjectStore {
  put(key: string, data: Uint8Array): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  signDownload?(key: string, expiresInSeconds: number): Promise<string>;
}

const sha256Hex = (data: Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

export const validateObjectKey = (key: string): string => {
  if (!key || key.startsWith("/") || key.includes("\0") || key.includes("\\")) {
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

export class LocalObjectStore implements ObjectStore {
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  private resolveSafe = (key: string): string => {
    const clean = validateObjectKey(key);
    const full = path.resolve(this.root, clean);
    if (full !== this.root && !full.startsWith(`${this.root}${path.sep}`)) {
      throw new Error(`Object key escapes storage root: '${key}'.`);
    }

    return full;
  };

  put = async (key: string, data: Uint8Array): Promise<StoredObject> => {
    const full = this.resolveSafe(key);
    const tmp = `${full}.${randomUUID()}.tmp`;

    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(tmp, data);
    await rename(tmp, full);

    return {
      key,
      sha256: sha256Hex(data),
      sizeBytes: data.byteLength,
    };
  };

  get = async (key: string): Promise<Uint8Array> => {
    const full = this.resolveSafe(key);

    return readFile(full);
  };

  delete = async (key: string): Promise<void> => {
    const full = this.resolveSafe(key);

    await rm(full, { force: true });
  };
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    region?: string,
    endpoint?: string,
  ) {
    this.client = new S3Client({
      ...(region ? { region } : {}),
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      maxAttempts: 3,
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
  }

  put = async (key: string, data: Uint8Array): Promise<StoredObject> => {
    const clean = validateObjectKey(key);
    const sha256 = sha256Hex(data);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: clean,
        Body: data,
        ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
      }),
      { abortSignal: AbortSignal.timeout(120_000) },
    );

    return { key: clean, sha256, sizeBytes: data.byteLength };
  };

  get = async (key: string): Promise<Uint8Array> => {
    const clean = validateObjectKey(key);
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: clean }),
      { abortSignal: AbortSignal.timeout(120_000) },
    );
    if (!response.Body) throw new Error(`Missing object body for '${clean}'.`);

    return response.Body.transformToByteArray();
  };

  delete = async (key: string): Promise<void> => {
    const clean = validateObjectKey(key);

    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: clean }),
      { abortSignal: AbortSignal.timeout(15_000) },
    );
  };

  signDownload = async (
    key: string,
    expiresInSeconds: number,
  ): Promise<string> => {
    const clean = validateObjectKey(key);

    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: clean }),
      { expiresIn: expiresInSeconds },
    );
  };
}
