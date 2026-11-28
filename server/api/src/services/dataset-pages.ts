import type { DatasetRecord } from "../contracts.js";
import type { ObjectStore } from "../storage/types.js";
import type { DatasetPart, DatasetVersion } from "../store/types.js";
import { parsePart, partLines } from "./dataset-records.js";
import {
  applyFacts,
  isReset,
  isScoreUpdate,
  mergeRecords,
  passesScoreFilter,
  SCORE_FILTER,
} from "./record-merge.js";

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
 *
 * A record with a source's score filter (`metadata.score_filter`) also keeps
 * its merged scores while the index is built; slots whose scores fail the
 * filter are dropped at the end and the rest renumbered, so `total` and pages
 * count only admitted records.
 */
interface VersionIndex {
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
  // Score-filtered slots: their rule and merged scores, and (once the version
  // has a rule) the facts of early updates.
  let ruled = new Map<number, DatasetRecord>();
  let earlyFacts = new Map<string, DatasetRecord>();
  let next = 0;
  let line = 0;

  const rule = (
    record: DatasetRecord,
    slot: number,
    before?: DatasetRecord,
  ) => {
    const filter = record.metadata?.[SCORE_FILTER];
    if (filter === undefined) {
      ruled.delete(slot); // the latest content decides
      return;
    }
    ruled.set(
      slot,
      applyFacts(
        {
          ...applyFacts({}, before ?? {}),
          metadata: { [SCORE_FILTER]: filter },
        },
        record,
      ),
    );
  };

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
        ruled = new Map();
        earlyFacts = new Map();
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
        const state = ruled.get(known);
        if (!isScoreUpdate(record)) rule(record, known, state);
        else if (state) ruled.set(known, applyFacts(state, record));
      } else if (isScoreUpdate(record)) {
        const waiting = early.get(id);
        if (waiting) waiting.push(at);
        else early.set(id, [at]);
        if (ruled.size > 0) {
          earlyFacts.set(id, applyFacts(earlyFacts.get(id) ?? {}, record));
        }
      } else {
        slotOf.set(id, next);
        lineSlots[at] = next;
        for (const earlier of early.get(id) ?? []) lineSlots[earlier] = next;
        early.delete(id);
        rule(record, next);
        const facts = earlyFacts.get(id);
        const state = ruled.get(next);
        if (facts && state) ruled.set(next, applyFacts(state, facts));
        earlyFacts.delete(id);
        next += 1;
      }
    }
  }
  partStarts[parts.length] = line;

  // Drop the slots whose scores fail their filter, and renumber the rest.
  let total = next;
  if ([...ruled.values()].some((facts) => !passesScoreFilter(facts))) {
    const renumber = new Int32Array(next);
    total = 0;
    for (let slot = 0; slot < next; slot += 1) {
      const facts = ruled.get(slot);
      renumber[slot] = facts && !passesScoreFilter(facts) ? -1 : total++;
    }
    for (let i = 0; i < lineSlots.length; i += 1) {
      const slot = lineSlots[i] as number;
      if (slot >= 0) lineSlots[i] = renumber[slot] as number;
    }
  }

  return { total, slots: Int32Array.from(lineSlots), partStarts };
};

/** A part's JSONL lines (`createPartLinesCache`, or a fresh read). */
type PartLines = (part: DatasetPart) => Promise<string[]>;

/**
 * A byte-bounded LRU of parts' JSONL lines. A page parses only its own
 * lines, and a source's late scores sit in the parts after their records, so
 * consecutive pages read the same few parts: caching their text saves a
 * download, a gunzip and a sha256 per page.
 */
export const createPartLinesCache = (
  storage: ObjectStore,
  maxBytes = 128 * 1024 * 1024,
): PartLines => {
  const cached = new Map<string, { lines: string[]; bytes: number }>();
  let bytes = 0;

  return async (part) => {
    const hit = cached.get(part.key);
    if (hit) {
      cached.delete(part.key);
      cached.set(part.key, hit);
      return hit.lines;
    }
    const lines = partLines(await storage.get(part.key), part);
    const size = lines.reduce((sum, line) => sum + line.length, 0);
    if (size <= maxBytes) {
      cached.set(part.key, { lines, bytes: size });
      bytes += size;
      for (const [key, old] of cached) {
        if (bytes <= maxBytes) break;
        cached.delete(key);
        bytes -= old.bytes;
      }
    }

    return lines;
  };
};

/** Merged records [from, from + limit) of the version `index` describes. */
export const readVersionPage = async (
  storage: ObjectStore,
  parts: readonly DatasetPart[],
  index: VersionIndex,
  from: number,
  limit: number,
  lines: PartLines = async (part) =>
    partLines(await storage.get(part.key), part),
): Promise<DatasetRecord[]> => {
  const to = Math.min(index.total, from + limit);
  if (from >= to) return [];

  const picked: DatasetRecord[] = [];
  for (const [p, part] of parts.entries()) {
    const start = index.partStarts[p] as number;
    const end = index.partStarts[p + 1] as number;
    let wanted = false;
    for (let i = start; i < end && !wanted; i += 1) {
      const slot = index.slots[i] as number;
      wanted = slot >= from && slot < to;
    }
    if (!wanted) continue;

    for (const [offset, line] of (await lines(part)).entries()) {
      const slot = index.slots[start + offset] as number;
      if (slot >= from && slot < to) {
        picked.push(JSON.parse(line) as DatasetRecord);
      }
    }
  }

  return mergeRecords(picked);
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
