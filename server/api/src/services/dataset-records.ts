import { createHash } from "node:crypto";

import type { DatasetRecord } from "../contracts.js";
import type { ObjectStore } from "../storage/types.js";
import type { DatasetPart, DatasetVersion } from "../store/types.js";

export const encodeRecordsJsonl = (records: readonly DatasetRecord[]): Buffer =>
  Buffer.from(records.map((r) => `${JSON.stringify(r)}\n`).join(""), "utf8");

/** Writes one immutable JSONL part at a fresh key. */
export const writeRecordsPart = async (
  storage: ObjectStore,
  key: string,
  records: readonly DatasetRecord[],
): Promise<DatasetPart> => {
  const bytes = encodeRecordsJsonl(records);
  const stored = await storage.put(key, bytes);

  return {
    key: stored.key,
    count: records.length,
    sha256: stored.sha256,
    bytes: stored.sizeBytes,
  };
};

const parsePart = (bytes: Uint8Array, part: DatasetPart): DatasetRecord[] => {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== part.sha256) {
    throw new Error(`Dataset part '${part.key}' failed its integrity check.`);
  }

  return Buffer.from(bytes)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DatasetRecord);
};

/** Yields every record of a dataset version, part by part. */
export async function* iterateVersionRecords(
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

/** Reads records [offset, offset + limit) without loading earlier parts. */
export const readVersionSlice = async (
  storage: ObjectStore,
  version: Pick<DatasetVersion, "parts">,
  offset: number,
  limit: number,
): Promise<DatasetRecord[]> => {
  const out: DatasetRecord[] = [];
  let position = 0;

  for (const part of version.parts) {
    const end = position + part.count;
    if (end <= offset) {
      position = end;
      continue;
    }

    const records = parsePart(await storage.get(part.key), part);
    const start = Math.max(0, offset - position);
    for (let i = start; i < records.length && out.length < limit; i += 1) {
      out.push(records[i] as DatasetRecord);
    }
    if (out.length >= limit) break;
    position = end;
  }

  return out;
};

/** Concatenates a version's parts into one JSONL byte stream. */
export const streamVersionJsonl = (
  storage: ObjectStore,
  version: Pick<DatasetVersion, "parts">,
): ReadableStream<Uint8Array> => {
  const parts = [...version.parts];

  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      const part = parts.shift();
      if (!part) {
        controller.close();
        return;
      }

      controller.enqueue(await storage.get(part.key));
    },
  });
};
