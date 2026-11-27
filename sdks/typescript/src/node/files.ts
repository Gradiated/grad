/* Node-only file helpers. Loaded with dynamic import so the browser build never touches node:fs. */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, openAsBlob } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { ChecksumMismatchError, GradUsageError } from "../errors.js";
import type { RawResponse } from "../transport.js";

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

const ARCHIVE = /\.(tar\.gz|tgz|tar)$/;
const BLOCK = 512;

/** A ustar header for a regular file (`name` up to 255 bytes, split into prefix/name). */
const tarHeader = (name: string, size: number): Buffer => {
  const header = Buffer.alloc(BLOCK);
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(base) > 100) {
    const cut = name.lastIndexOf("/", 155);
    prefix = cut > 0 ? name.slice(0, cut) : "";
    base = cut > 0 ? name.slice(cut + 1) : name;
    if (!prefix || Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) {
      throw new GradUsageError(`Path ${name} is too long to upload (255 bytes at most).`, "path_too_long");
    }
  }
  const field = (value: string, offset: number, width: number) => header.write(value, offset, width, "utf8");
  field(base, 0, 100);
  field("0000644\0", 100, 8);
  field("0000000\0", 108, 8);
  field("0000000\0", 116, 8);
  field(`${size.toString(8).padStart(11, "0")}\0`, 124, 12);
  field("00000000000\0", 136, 12);
  field("        ", 148, 8);
  field("0", 156, 1);
  field("ustar\0", 257, 6);
  field("00", 263, 2);
  field(prefix, 345, 155);
  let sum = 0;
  for (const byte of header) sum += byte;
  field(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
};

const listFiles = async (root: string, dir = root): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new GradUsageError(`Refusing to upload symlink ${full}; copy the file instead.`, "symlink");
    if (entry.isDirectory()) out.push(...(await listFiles(root, full)));
    else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join("/"));
  }
  return out;
};

async function* tarStream(root: string, names: string[]): AsyncGenerator<Buffer> {
  for (const name of names) {
    const file = path.join(root, ...name.split("/"));
    const { size } = await stat(file);
    yield tarHeader(name, size);
    for await (const chunk of createReadStream(file)) yield chunk as Buffer;
    if (size % BLOCK) yield Buffer.alloc(BLOCK - (size % BLOCK));
  }
  yield Buffer.alloc(BLOCK * 2);
}

/**
 * The file `artifacts.upload` sends for `target`: a `.tar`/`.tar.gz` as is, else a gzip tar
 * of the directory's regular files (sorted, relative paths) or of the single file.
 */
export const packArtifact = async (target: string): Promise<{ path: string; cleanup: () => Promise<void> }> => {
  const info = await lstat(target).catch(() => {
    throw new GradUsageError(`No such file or directory: ${target}`, "file_not_found");
  });
  if (info.isFile() && ARCHIVE.test(target)) return { path: target, cleanup: async () => undefined };
  let root: string;
  let names: string[];
  if (info.isDirectory()) {
    root = target;
    names = await listFiles(target);
    if (names.length === 0) throw new GradUsageError(`${target} has no files to upload.`, "empty_upload");
  } else if (info.isFile()) {
    root = path.dirname(target);
    names = [path.basename(target)];
  } else {
    throw new GradUsageError(`${target} is not a file or directory.`, "file_not_found");
  }
  const dir = await mkdtemp(path.join(tmpdir(), "grad-upload-"));
  const out = path.join(dir, "upload.tar.gz");
  await pipeline(Readable.from(tarStream(root, names)), createGzip(), createWriteStream(out));
  return { path: out, cleanup: () => rm(dir, { recursive: true, force: true }) };
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
