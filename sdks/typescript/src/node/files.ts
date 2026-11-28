/* Node-only file helpers. Loaded with dynamic import so the browser build never touches node:fs. */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import { ChecksumMismatchError, GradUsageError } from "../errors.js";
import { FileBody, GradError, type RawResponse } from "../transport.js";

export interface LocalFile {
  path: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * fetch for uploads: a {@link FileBody} streams from disk through node:http(s) with its exact
 * Content-Length (bounded memory however large the file; fetch would buffer it whole). Anything
 * else goes to the global fetch. A fresh read stream per call, so retries replay the file.
 */
export const nodeFetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
  const body = init.body as unknown;
  if (!(body instanceof FileBody)) return fetch(input, init);
  const url = new URL(String(input));
  const { request } = url.protocol === "https:" ? await import("node:https") : await import("node:http");
  const headers: Record<string, string> = Object.fromEntries(new Headers(init.headers));
  headers["content-length"] = String(body.size);
  return new Promise<Response>((resolve, reject) => {
    const req = request(url, { method: init.method ?? "PUT", headers, ...(init.signal ? { signal: init.signal } : {}) }, (res) => {
      const out = new Headers();
      for (const [name, value] of Object.entries(res.headers)) {
        if (value !== undefined) out.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const status = res.statusCode ?? 502;
      if (status === 204 || status === 304) {
        res.resume();
        resolve(new Response(null, { status, headers: out }));
      } else {
        resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers: out }));
      }
    });
    req.on("error", reject);
    pipeline(createReadStream(body.path), req).catch(reject);
  });
};

/**
 * The fetch uploads go through: {@link nodeFetch}, or the caller's own `fetch` (a proxy, a
 * custom agent) with each {@link FileBody} turned into a stream of the file and its
 * Content-Length. Node's fetch holds such a body in memory as it sends it (measured: a
 * 2 GiB upload peaks at 2.1 GiB RSS), so only a custom `fetch` takes this path.
 */
export const uploadFetch = (custom: typeof fetch | undefined): typeof fetch => {
  if (custom === undefined) return nodeFetch as typeof fetch;
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const body = init.body as unknown;
    if (!(body instanceof FileBody)) return custom(input, init);
    const headers = new Headers(init.headers);
    headers.set("content-length", String(body.size));
    const stream = Readable.toWeb(createReadStream(body.path)) as ReadableStream<Uint8Array>;
    return custom(input, { ...init, headers, body: stream, duplex: "half" } as RequestInit);
  }) as typeof fetch;
};

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

// Limits on what extraction writes (the same as the Python and Go SDKs).
const MAX_MEMBERS = 10_000;
const MAX_EXTRACT_BYTES = 512 * 1024 ** 3;
const RESERVED = new Set(["manifest.json", "eval_report.json"]);

const unsafe = (message: string): GradError => new GradError(message, { code: "unsafe_archive" });

const memberName = (raw: string): string => {
  if (raw === "" || /[\0\\]/.test(raw) || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw unsafe(`Refusing to extract unsafe archive entry ${JSON.stringify(raw)}.`);
  }
  const parts = raw.replace(/\/$/, "").split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    throw unsafe(`Refusing to extract unsafe archive entry ${JSON.stringify(raw)} (path traversal).`);
  }
  return parts.join("/");
};

const field = (block: Buffer, offset: number, width: number): string => {
  const raw = block.subarray(offset, offset + width);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? width : end).toString("utf8");
};

/** Pax records (`len key=value\n`): only `path` and `size` matter for a bundle. */
const paxRecords = (data: Buffer): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of data.toString("utf8").split("\n")) {
    const m = /^\d+ ([^=]+)=(.*)$/s.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2];
  }
  return out;
};

/**
 * Writes a `.grad.tar.gz` into the empty directory `dest`, streaming: only regular files with
 * safe relative paths, each checked against the SHA-256 that `manifest.json` lists.
 */
export const extractBundle = async (archive: string, dest: string): Promise<void> => {
  const chunks = createReadStream(archive).pipe(createGunzip())[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let buf: Buffer = Buffer.alloc(0);
  let ended = false;
  const fill = async (n: number): Promise<boolean> => {
    while (buf.length < n && !ended) {
      const next = await chunks.next().catch((error: unknown) => {
        throw unsafe(`The download is not a valid .grad.tar.gz bundle: ${(error as Error).message}`);
      });
      if (next.done) ended = true;
      else buf = buf.length === 0 ? next.value : Buffer.concat([buf, next.value]);
    }
    return buf.length >= n;
  };
  const read = async (n: number): Promise<Buffer> => {
    if (!(await fill(n))) throw unsafe("The bundle is truncated.");
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return out;
  };
  const seen = new Map<string, string>();
  let total = 0;
  let pax: Record<string, string> = {};
  for (let count = 1; ; count += 1) {
    if (!(await fill(BLOCK))) break;
    const header = await read(BLOCK);
    if (header.every((b) => b === 0)) break;
    if (count > MAX_MEMBERS) throw unsafe(`The bundle has more than ${MAX_MEMBERS} entries.`);
    const type = String.fromCharCode(header[156] ?? 0);
    const ustarPrefix = field(header, 257, 6) === "ustar" ? field(header, 345, 155) : "";
    const size = pax.size !== undefined ? Number(pax.size) : parseInt(field(header, 124, 12).trim() || "0", 8);
    const rawName = pax.path ?? (ustarPrefix ? `${ustarPrefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    pax = {};
    if (!Number.isSafeInteger(size) || size < 0) throw unsafe(`Archive entry ${JSON.stringify(rawName)} has an invalid size.`);
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (type === "x" || type === "g") {
      const data = await read(size + padding);
      if (type === "x") pax = paxRecords(data.subarray(0, size));
      continue;
    }
    const name = memberName(rawName);
    if (type === "5") {
      await read(size + padding);
      continue;
    }
    if (type !== "0" && type !== "\0") throw unsafe(`Refusing to extract ${JSON.stringify(name)}: only regular files are allowed (no links or devices).`);
    if (seen.has(name)) throw unsafe(`Duplicate archive entry ${JSON.stringify(name)}.`);
    total += size;
    if (total > MAX_EXTRACT_BYTES) throw unsafe(`The bundle expands beyond ${MAX_EXTRACT_BYTES} bytes.`);
    const out = path.join(dest, ...name.split("/"));
    await mkdir(path.dirname(out), { recursive: true });
    const handle = await open(out, "wx", 0o644);
    const hash = createHash("sha256");
    try {
      for (let left = size; left > 0; ) {
        if (buf.length === 0 && !(await fill(1))) throw unsafe(`The bundle is truncated inside ${JSON.stringify(name)}.`);
        const part = buf.subarray(0, Math.min(left, buf.length));
        buf = buf.subarray(part.length);
        hash.update(part);
        await handle.write(part);
        left -= part.length;
      }
    } finally {
      await handle.close();
    }
    await read(padding);
    seen.set(name, hash.digest("hex"));
  }
  const manifest = await readFile(path.join(dest, "manifest.json"), "utf8").then(
    (text) => JSON.parse(text) as { files?: Record<string, string> },
    () => {
      throw unsafe("The bundle has no valid manifest.json.");
    },
  );
  const listed = manifest.files;
  if (typeof listed !== "object" || listed === null) throw unsafe("manifest.json has no 'files' checksum map.");
  const unlisted = [...seen.keys()].filter((name) => !RESERVED.has(name) && !Object.hasOwn(listed, name)).sort();
  if (unlisted.length > 0) throw unsafe(`The bundle has files manifest.json does not list: ${unlisted.join(", ")}.`);
  for (const [name, want] of Object.entries(listed)) {
    const got = seen.get(name);
    if (got === undefined) throw unsafe(`manifest.json lists ${JSON.stringify(name)}, which is missing from the bundle.`);
    if (got !== String(want).toLowerCase()) throw new ChecksumMismatchError(`file ${name} of the bundle`, String(want), got);
  }
};

/** Throws unless `dest` is missing or an empty directory (checked before a download starts). */
export const checkExtractDest = async (dest: string): Promise<void> => {
  const existing = await readdir(dest).catch(() => undefined);
  if (existing !== undefined && existing.length > 0) {
    throw new GradUsageError(`${dest} is not empty; pick a new directory.`, "destination_not_empty");
  }
};

/** Extracts the verified bundle at `archive` into `dest` through a staging directory beside it. */
export const extractInto = async (archive: string, dest: string): Promise<void> => {
  await checkExtractDest(dest);
  const parent = path.dirname(path.resolve(dest));
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, ".grad-extract-"));
  try {
    await extractBundle(archive, staging);
    await rm(dest, { recursive: true, force: true });
    await rename(staging, dest);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
};
