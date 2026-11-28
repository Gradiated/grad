import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import type { DatasetRecord } from "../contracts.js";
import { conflict } from "../errors.js";
import { ObjectExistsError, type ObjectStore } from "../storage/types.js";
import type { DatasetPart, DatasetVersion } from "../store/types.js";
import { isReset, isScoreUpdate } from "./record-merge.js";
import { metrics } from "../telemetry/metrics.js";

export const encodeRecordsJsonl = (records: readonly DatasetRecord[]): Buffer =>
  Buffer.from(records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");

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
  const bytes = gzipSync(jsonl);
  const key = keyFor(sha256);
  try {
    await storage.put(key, bytes);
    metrics.partBytes.inc({ form: "compressed" }, bytes.byteLength);
    metrics.partBytes.inc({ form: "uncompressed" }, jsonl.byteLength);
  } catch (error) {
    // A retried write of the same deterministic key: fine if the records match.
    if (!(error instanceof ObjectExistsError)) throw error;
    if (sha256Of(gunzipSync(await storage.get(key))) !== sha256) {
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

export const parsePart = (
  stored: Uint8Array,
  part: DatasetPart,
): DatasetRecord[] =>
  partLines(stored, part).map((line) => JSON.parse(line) as DatasetRecord);

/** A stored part's JSONL lines, integrity-checked (not parsed). */
export const partLines = (stored: Uint8Array, part: DatasetPart): string[] => {
  let jsonl: Buffer;
  try {
    jsonl = gunzipSync(stored);
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

/** Yields every record of a dataset version, part by part. */
async function* iterateVersionRecords(
  storage: ObjectStore,
  version: Pick<DatasetVersion, "parts">,
): AsyncGenerator<DatasetRecord> {
  for (const part of version.parts) {
    const records = parsePart(await storage.get(part.key), part);
    yield* records;
  }
}

export const readVersionRecords = async (
  storage: ObjectStore,
  version: Pick<DatasetVersion, "parts">,
): Promise<DatasetRecord[]> => {
  const out: DatasetRecord[] = [];
  for await (const record of iterateVersionRecords(storage, version)) {
    out.push(record);
  }

  return out;
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
  const bytes = gzipSync(encodeRecordsJsonl(records));

  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(bytes);
      controller.close();
    },
  });
};
