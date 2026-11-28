import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip as gunzipCb, gzip as gzipCb } from "node:zlib";

import type { DatasetRecord } from "../contracts.js";
import { ApiError, conflict } from "../errors.js";
import {
  ObjectExistsError,
  ObjectNotFoundError,
  type ObjectStore,
} from "../storage/types.js";
import type { DatasetPart, DatasetVersion } from "../store/types.js";
import { isReset, isScoreUpdate } from "./record-merge.js";
import { metrics } from "../telemetry/metrics.js";

export const encodeRecordsJsonl = (records: readonly DatasetRecord[]): Buffer =>
  Buffer.from(records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");

// (De)compression runs on libuv's thread pool: a sync gunzip of a 64 MB part
// stalls every request on the replica (p1-scale: /health/live p99 1.2 s).
const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

const sha256Of = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * What a part does to its dataset's merged record count: the distinct records
 * it adds after its last reset marker. Score updates and reset markers add
 * none, and `resets` says the count restarts at this part (a full sync).
 */
export const countRecords = (
  records: readonly DatasetRecord[],
): Pick<DatasetPart, "count" | "resets"> => {
  let resets = false;
  let ids = new Set<string>();
  let anonymous = 0;
  for (const record of records) {
    if (isReset(record)) {
      resets = true;
      ids = new Set();
      anonymous = 0;
    } else if (!isScoreUpdate(record)) {
      if (record.id) ids.add(record.id);
      else anonymous += 1;
    }
  }

  return { count: ids.size + anonymous, resets };
};

/**
 * Writes one immutable gzip-compressed JSONL part at `keyFor(sha256)`, where
 * `sha256` is of the uncompressed JSONL (so identical records dedupe whatever
 * the compressor does). Rewriting an existing key with the same records is a
 * no-op, so a deterministic key makes a retried write safe. The part's
 * `bytes` are the stored (compressed) size.
 */
export const writeRecordsPart = async (
  storage: ObjectStore,
  keyFor: (sha256: string) => string,
  records: readonly DatasetRecord[],
): Promise<DatasetPart> => {
  const jsonl = encodeRecordsJsonl(records);
  const sha256 = sha256Of(jsonl);
  const bytes = await gzip(jsonl);
  const key = keyFor(sha256);
  try {
    await storage.put(key, bytes);
    metrics.partBytes.inc({ form: "compressed" }, bytes.byteLength);
    metrics.partBytes.inc({ form: "uncompressed" }, jsonl.byteLength);
  } catch (error) {
    // A retried write of the same deterministic key: fine if the records match.
    if (!(error instanceof ObjectExistsError)) throw error;
    if (sha256Of(await gunzip(await storage.get(key))) !== sha256) {
      throw conflict(
        "records_batch_conflict",
        `Records part '${key}' already exists with different contents; a batch number was reused for different records.`,
      );
    }
  }

  return {
    key,
    ...countRecords(records),
    sha256,
    bytes: bytes.byteLength,
  };
};

/**
 * A stored part's bytes. A part whose object is gone (a bucket lost or
 * restored without the database) answers 410 dataset_part_missing: the
 * version's records can't be read again, so a retry would not help.
 */
export const readPart = async (
  storage: ObjectStore,
  part: DatasetPart,
): Promise<Uint8Array> => {
  try {
    return await storage.get(part.key);
  } catch (error) {
    if (!(error instanceof ObjectNotFoundError)) throw error;
    throw new ApiError(
      410,
      "dataset_part_missing",
      "Dataset records missing",
      `A part of this dataset version is missing from object storage (${part.key}), so its records can't be read. Push or import them again as a new version.`,
    );
  }
};

/** A stored part's JSONL lines, integrity-checked (not parsed). */
export const partLines = async (
  stored: Uint8Array,
  part: DatasetPart,
): Promise<string[]> => {
  let jsonl: Buffer;
  try {
    jsonl = await gunzip(stored);
  } catch {
    throw new Error(`Dataset part '${part.key}' is not valid gzip.`);
  }
  if (sha256Of(jsonl) !== part.sha256) {
    throw new Error(`Dataset part '${part.key}' failed its integrity check.`);
  }

  return jsonl
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0);
};

/**
 * A version as one gzip stream: the stored parts back to back, streamed from
 * storage without decompressing (concatenated gzip members are one valid gzip
 * file, so `gunzip` yields the parts' JSONL in order).
 */
export const streamVersionGzip = (
  storage: ObjectStore,
  version: Pick<DatasetVersion, "parts">,
): ReadableStream<Uint8Array> => {
  const parts = [...version.parts];
  let current: ReadableStreamDefaultReader<Uint8Array> | null = null;

  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      for (;;) {
        if (!current) {
          const part = parts.shift();
          if (!part) {
            controller.close();
            return;
          }
          current = (await storage.getStream(part.key)).getReader();
        }
        const chunk = await current.read();
        if (!chunk.done) {
          controller.enqueue(chunk.value);
          return;
        }
        current = null;
      }
    },
    cancel: async (reason) => {
      await current?.cancel(reason);
    },
  });
};

/** Records as one gzip-compressed JSONL stream (in-memory training records). */
export const gzipJsonlStream = (
  records: readonly DatasetRecord[],
): ReadableStream<Uint8Array> => {
  return new ReadableStream<Uint8Array>({
    start: async (controller) => {
      controller.enqueue(await gzip(encodeRecordsJsonl(records)));
      controller.close();
    },
  });
};
