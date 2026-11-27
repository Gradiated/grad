/* Node-only file helpers. Loaded with dynamic import so the browser build never touches node:fs. */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, openAsBlob } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { ChecksumMismatchError, GradUsageError } from "../errors.js";
import type { RawResponse } from "../generated/transport.js";

export interface LocalFile {
  path: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  blob: Blob;
}

export const sha256File = async (file: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
};

export const describeFile = async (file: string): Promise<LocalFile> => {
  const info = await stat(file).catch(() => {
    throw new GradUsageError(`File not found: ${file}`, "file_not_found");
  });
  if (!info.isFile()) throw new GradUsageError(`${file} is not a regular file.`, "file_not_found");
  return {
    path: file,
    filename: path.basename(file),
    sizeBytes: info.size,
    sha256: await sha256File(file),
    blob: await openAsBlob(file),
  };
};

export const readTextFile = async (file: string): Promise<string> => {
  const { readFile } = await import("node:fs/promises");
  return readFile(file, "utf8");
};

/** Streams JSON Lines records from disk (blank lines skipped, line numbers in errors). */
export async function* readJsonl(file: string): AsyncGenerator<Record<string, unknown>> {
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of lines) {
    lineNo += 1;
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new GradUsageError(`${file}:${lineNo} is not valid JSON: ${(error as Error).message}`, "invalid_jsonl");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new GradUsageError(`${file}:${lineNo} must be a JSON object.`, "invalid_jsonl");
    }
    yield value as Record<string, unknown>;
  }
}

const SAFE_NAME = /[^A-Za-z0-9._@-]+/g;

export const filenameFromDisposition = (header: string | null): string | undefined => {
  if (!header) return undefined;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  const plain = /filename="?([^";]+)"?/i.exec(header);
  let name = star?.[1] ?? plain?.[1];
  if (!name) return undefined;
  try {
    name = decodeURIComponent(name.trim());
  } catch {
    // keep as-is
  }
  const base = path.basename(name.replace(/\\/g, "/")).replace(SAFE_NAME, "_");
  return base && base !== "." && base !== ".." ? base : undefined;
};

export interface DownloadResult {
  path: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * Streams `raw.body` to `dest` through a temp file in the same directory,
 * hashing as it goes; verifies `expectedSha256` before the atomic rename.
 * `dest` that is an existing directory (or ends with a separator) receives
 * the server's file name.
 */
export const streamToFile = async (
  raw: RawResponse,
  dest: string,
  reference: string,
  expectedSha256: string | undefined,
): Promise<DownloadResult> => {
  let target = dest;
  const isDirHint = dest.endsWith("/") || dest.endsWith(path.sep);
  const existing = await stat(dest).catch(() => undefined);
  if (isDirHint || existing?.isDirectory()) {
    await mkdir(dest, { recursive: true });
    const name =
      filenameFromDisposition(raw.headers.get("content-disposition")) ??
      `${reference.replace(SAFE_NAME, "_")}.grad.tar.gz`;
    target = path.join(dest, name);
  } else {
    await mkdir(path.dirname(path.resolve(dest)), { recursive: true });
  }
  const dir = path.dirname(path.resolve(target));
  const tmp = path.join(dir, `.${path.basename(target)}.grad-dl-${randomBytes(6).toString("hex")}`);
  const handle = await open(tmp, "wx", 0o644);
  const hash = createHash("sha256");
  let size = 0;
  let ok = false;
  try {
    const reader = raw.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      size += value.byteLength;
      let offset = 0;
      while (offset < value.byteLength) {
        const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
        offset += bytesWritten;
      }
    }
    await handle.sync();
    await handle.close();
    const actual = hash.digest("hex");
    if (expectedSha256 !== undefined && actual !== expectedSha256) {
      throw new ChecksumMismatchError(reference, expectedSha256, actual);
    }
    await rename(tmp, target);
    ok = true;
    const dirHandle = await open(dir, "r").catch(() => undefined);
    await dirHandle?.sync().catch(() => undefined);
    await dirHandle?.close();
    return { path: target, sha256: actual, sizeBytes: size };
  } finally {
    if (!ok) {
      await handle.close().catch(() => undefined);
      await rm(tmp, { force: true });
      await raw.cancel().catch(() => undefined);
    }
  }
};
