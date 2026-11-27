import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import {
  link,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import {
  ObjectExistsError,
  ObjectIntegrityError,
  ObjectNotFoundError,
  validateObjectKey,
  type ObjectHead,
  type ObjectStore,
  type PutStreamOptions,
  type StoredObject,
} from "./types.js";

const isErrno = (error: unknown, code: string): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === code;

const closeQuietly = async (out: WriteStream): Promise<void> => {
  if (out.closed) return;
  await new Promise<void>((resolve) => {
    out.once("close", () => resolve());
    out.destroy();
  });
};

/**
 * Filesystem object store. Objects are written to a temp file and hard-linked
 * into place, so an existing key is never replaced (EEXIST → ObjectExistsError)
 * and readers never observe a partial object. Paths are confined to the root,
 * including through symlinked directories or files.
 */
export class LocalObjectStore implements ObjectStore {
  readonly kind = "local" as const;
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  private within = (realRoot: string, candidate: string): boolean =>
    candidate === realRoot || candidate.startsWith(`${realRoot}${path.sep}`);

  private escape = (key: string): Error =>
    new Error(`Object key escapes storage root via a symlink: '${key}'.`);

  /** Realpath of `target`, or of its deepest existing ancestor. */
  private realExisting = async (target: string): Promise<string> => {
    let current = target;
    for (;;) {
      try {
        return await realpath(current);
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
        const parent = path.dirname(current);
        if (parent === current) return current;
        current = parent;
      }
    }
  };

  private resolveSafe = async (
    key: string,
    create: boolean,
  ): Promise<string> => {
    const clean = validateObjectKey(key);
    const full = path.resolve(this.root, clean);
    if (!full.startsWith(`${this.root}${path.sep}`)) {
      throw new Error(`Object key escapes storage root: '${key}'.`);
    }

    if (create) await mkdir(this.root, { recursive: true });
    const realRoot = await this.realExisting(this.root);
    const dir = path.dirname(full);

    // Check before mkdir so a symlinked ancestor can't make us create
    // directories outside the root, then again after creating them.
    if (!this.within(realRoot, await this.realExisting(dir))) {
      throw this.escape(key);
    }
    if (create) {
      await mkdir(dir, { recursive: true });
      if (!this.within(realRoot, await realpath(dir))) throw this.escape(key);
    }

    try {
      if (!this.within(realRoot, await realpath(full))) throw this.escape(key);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }

    return full;
  };

  private commit = async (
    tmp: string,
    full: string,
    key: string,
  ): Promise<void> => {
    try {
      await link(tmp, full);
    } catch (error) {
      if (isErrno(error, "EEXIST")) throw new ObjectExistsError(key);
      throw error;
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  };

  private tempPath = (full: string): string =>
    `${full}.${randomUUID()}.partial`;

  put = async (key: string, data: Uint8Array): Promise<StoredObject> =>
    this.putStream(
      key,
      (async function* () {
        yield data;
      })(),
      { maxBytes: data.byteLength },
    );

  putStream = async (
    key: string,
    body: AsyncIterable<Uint8Array>,
    options: PutStreamOptions,
  ): Promise<StoredObject> => {
    const full = await this.resolveSafe(key, true);
    const tmp = this.tempPath(full);
    const hash = createHash("sha256");
    let size = 0;

    const out = createWriteStream(tmp, { flags: "wx" });
    const failed = new Promise<never>((_, reject) => out.once("error", reject));
    failed.catch(() => undefined);
    try {
      for await (const chunk of body) {
        size += chunk.byteLength;
        if (size > options.maxBytes) {
          throw new ObjectIntegrityError(
            `Upload exceeds the ${options.maxBytes}-byte limit.`,
          );
        }
        hash.update(chunk);
        if (!out.write(chunk)) {
          await Promise.race([
            new Promise<void>((resolve) => out.once("drain", resolve)),
            failed,
          ]);
        }
      }
      await Promise.race([
        new Promise<void>((resolve, reject) =>
          out.end((error?: Error | null) =>
            error ? reject(error) : resolve(),
          ),
        ),
        failed,
      ]);

      const sha256 = hash.digest("hex");
      if (
        options.expectedSizeBytes !== undefined &&
        size !== options.expectedSizeBytes
      ) {
        throw new ObjectIntegrityError(
          `Upload size ${size} does not match the declared ${options.expectedSizeBytes} bytes.`,
        );
      }
      if (
        options.expectedSha256 !== undefined &&
        sha256 !== options.expectedSha256
      ) {
        throw new ObjectIntegrityError(
          `Upload sha256 ${sha256} does not match the declared ${options.expectedSha256}.`,
        );
      }

      await this.commit(tmp, full, key);

      return { key, sha256, sizeBytes: size };
    } catch (error) {
      await closeQuietly(out);
      await rm(tmp, { force: true });
      throw error;
    }
  };

  get = async (key: string): Promise<Uint8Array> => {
    const full = await this.resolveSafe(key, false);
    try {
      return await readFile(full);
    } catch (error) {
      if (isErrno(error, "ENOENT")) throw new ObjectNotFoundError(key);
      throw error;
    }
  };

  getStream = async (key: string): Promise<ReadableStream<Uint8Array>> => {
    const full = await this.resolveSafe(key, false);
    try {
      await stat(full);
    } catch (error) {
      if (isErrno(error, "ENOENT")) throw new ObjectNotFoundError(key);
      throw error;
    }

    return Readable.toWeb(createReadStream(full)) as ReadableStream<Uint8Array>;
  };

  head = async (key: string): Promise<ObjectHead | null> => {
    const full = await this.resolveSafe(key, false);
    try {
      const info = await stat(full);
      return { sizeBytes: info.size, sha256: null };
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
  };

  listOlder = async (
    prefix: string,
    before: Date,
    limit: number,
  ): Promise<string[]> => {
    const base = path.resolve(this.root, validateObjectKey(prefix));
    const keys: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (isErrno(error, "ENOENT")) return;
        throw error;
      }
      for (const entry of entries) {
        if (keys.length >= limit) return;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (
          entry.isFile() &&
          !entry.name.endsWith(".partial") &&
          (await stat(full)).mtime < before
        ) {
          keys.push(path.relative(this.root, full).split(path.sep).join("/"));
        }
      }
    };
    await walk(base);

    return keys;
  };

  delete = async (key: string): Promise<void> => {
    const full = await this.resolveSafe(key, false);
    await rm(full, { force: true });
  };

  presignUpload = async (
    _key: string,
    _input: { sha256: string; sizeBytes: number; expiresInSeconds: number },
  ): Promise<null> => null;

  presignDownload = async (
    _key: string,
    _expiresInSeconds: number,
  ): Promise<null> => null;
}
