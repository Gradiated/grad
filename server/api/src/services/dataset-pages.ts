import type { DatasetRecord } from "../contracts.js";
import type { ObjectStore } from "../storage/types.js";
import type { DatasetPart, DatasetVersion } from "../store/types.js";
import { parsePart } from "./dataset-records.js";
import { isReset, isScoreUpdate, mergeRecords } from "./record-merge.js";

/**
 * Pages of a dataset version's merged records (the `mergeRecords` view)
 * without loading the version: memory is one part plus the page, and a page
 * reads only the parts that hold its records or later facts about them.
 *
 * A version's parts never change, so its merge is planned once into a
 * `VersionIndex`: for every stored line, the merged record ("slot") it
 * contributes to, or -1 (dropped by a reset, or an update for an id that
 * never arrives). Slots are numbered in first-seen order, which is the merged
 * order. A page of slots [from, to) collects their lines from the parts that
 * hold them, in stored order, and merges just those: the same result as
 * merging the whole version, since a record's merge only reads its own lines.
 *
 * Building an index streams the version once, holding one part and one map
 * entry per record id; the index itself is 4 bytes per line. Indexes are
 * cached per version in a byte-bounded LRU.
 */
export interface VersionIndex {
  /** Merged records in the version. */
  total: number;
  /** Line → slot, or -1. Lines are numbered across parts in order. */
  slots: Int32Array;
  /** First line of each part, plus the total line count at the end. */
  partStarts: Int32Array;
}

const indexBytes = (index: VersionIndex): number =>
  index.slots.byteLength + index.partStarts.byteLength;

/** Streams `parts` once and plans their merge. */
export const buildVersionIndex = async (
  storage: ObjectStore,
  parts: readonly DatasetPart[],
): Promise<VersionIndex> => {
  const lineSlots: number[] = [];
  const partStarts = new Int32Array(parts.length + 1);
  let slotOf = new Map<string, number>();
  // Lines of updates that arrived before their id's first record.
  let early = new Map<string, number[]>();
  let next = 0;
  let line = 0;

  for (const [p, part] of parts.entries()) {
    partStarts[p] = line;
    for (const record of parsePart(await storage.get(part.key), part)) {
      const at = line;
      line += 1;
      lineSlots.push(-1);
      if (isReset(record)) {
        // Everything before a reset marker drops out of the merge.
        lineSlots.fill(-1);
        slotOf = new Map();
        early = new Map();
        next = 0;
        continue;
      }
      const id = record.id;
      if (!id) {
        lineSlots[at] = next;
        next += 1;
        continue;
      }
      const known = slotOf.get(id);
      if (known !== undefined) {
        lineSlots[at] = known;
      } else if (isScoreUpdate(record)) {
        const waiting = early.get(id);
        if (waiting) waiting.push(at);
        else early.set(id, [at]);
      } else {
        slotOf.set(id, next);
        lineSlots[at] = next;
        for (const earlier of early.get(id) ?? []) lineSlots[earlier] = next;
        early.delete(id);
        next += 1;
      }
    }
  }
  partStarts[parts.length] = line;

  return { total: next, slots: Int32Array.from(lineSlots), partStarts };
};

/** Merged records [from, from + limit) of the version `index` describes. */
export const readVersionPage = async (
  storage: ObjectStore,
  parts: readonly DatasetPart[],
  index: VersionIndex,
  from: number,
  limit: number,
): Promise<DatasetRecord[]> => {
  const to = Math.min(index.total, from + limit);
  if (from >= to) return [];

  const lines: DatasetRecord[] = [];
  for (const [p, part] of parts.entries()) {
    const start = index.partStarts[p] as number;
    const end = index.partStarts[p + 1] as number;
    let wanted = false;
    for (let i = start; i < end && !wanted; i += 1) {
      const slot = index.slots[i] as number;
      wanted = slot >= from && slot < to;
    }
    if (!wanted) continue;

    const records = parsePart(await storage.get(part.key), part);
    for (const [offset, record] of records.entries()) {
      const slot = index.slots[start + offset] as number;
      if (slot >= from && slot < to) lines.push(record);
    }
  }

  return mergeRecords(lines);
};

/** A byte-bounded LRU of version indexes, with one build per version at a time. */
export const createVersionIndexCache = (
  storage: ObjectStore,
  maxBytes = 64 * 1024 * 1024,
) => {
  const cached = new Map<string, VersionIndex>();
  const building = new Map<string, Promise<VersionIndex>>();
  let bytes = 0;

  const keyOf = (version: Pick<DatasetVersion, "parts">): string =>
    version.parts.map((part) => part.sha256).join(",");

  const remember = (key: string, index: VersionIndex): void => {
    const size = indexBytes(index);
    if (size > maxBytes) return;
    cached.set(key, index);
    bytes += size;
    for (const [oldest, old] of cached) {
      if (bytes <= maxBytes) break;
      cached.delete(oldest);
      bytes -= indexBytes(old);
    }
  };

  return {
    get: async (
      version: Pick<DatasetVersion, "parts">,
    ): Promise<VersionIndex> => {
      const key = keyOf(version);
      const hit = cached.get(key);
      if (hit) {
        // Most recently used last.
        cached.delete(key);
        cached.set(key, hit);
        return hit;
      }
      const inFlight = building.get(key);
      if (inFlight) return inFlight;

      const build = buildVersionIndex(storage, version.parts)
        .then((index) => {
          remember(key, index);
          return index;
        })
        .finally(() => building.delete(key));
      building.set(key, build);

      return build;
    },
    /** Bytes held by cached indexes (tests). */
    bytes: () => bytes,
  };
};
