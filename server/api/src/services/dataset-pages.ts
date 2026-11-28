import { createHash } from "node:crypto";

import type { DatasetRecord } from "../contracts.js";
import type { ObjectStore } from "../storage/types.js";
import type { DatasetPart, DatasetVersion } from "../store/types.js";
import { partLines, readPart } from "./dataset-records.js";
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
 * its merged scores while the index is built (a record that gets a rule
 * after unfiltered lines has their scores folded in by one more read of the
 * parts holding them); slots whose scores fail the filter are dropped at the
 * end and the rest renumbered, so `total` and pages count only admitted
 * records. server/api/test/trainer-parity.test.ts holds it to the trainer's
 * merge.
 */
export interface VersionIndex {
  /** Merged records in the version. */
  total: number;
  /** Line → slot, or -1. Lines are numbered across parts in order. */
  slots: Int32Array;
  /** First line of each part, plus the total line count at the end. */
  partStarts: Int32Array;
}

/** Lines parsed between yields to the event loop while an index builds. */
const YIELD_LINES = 2000;
const yieldToEventLoop = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

const indexBytes = (index: VersionIndex): number =>
  index.slots.byteLength + index.partStarts.byteLength;

/**
 * A merge plan in progress: everything a later part's lines need to know
 * about the earlier ones. Extending it with a version's new parts gives the
 * new version's index without re-reading the old parts (a push or a sync
 * reads only what it added, not the dataset).
 */
/**
 * A part's JSONL lines. Parts are a version's stored parts on the server
 * (`storedPartLines`) and runs of a downloaded version's lines in the eval
 * worker: anything with a key whose lines don't change.
 */
export type PartLines<P> = (part: P) => Promise<string[]>;

/** The lines of a version's stored parts. */
export const storedPartLines =
  (storage: ObjectStore): PartLines<DatasetPart> =>
  async (part) =>
    partLines(await readPart(storage, part), part);

export interface IndexBuilder<P> {
  /** Parts folded in so far (a prefix of every version built from it). */
  parts: P[];
  lineSlots: number[];
  partStarts: number[];
  slotOf: Map<string, number>;
  /** Lines of updates that arrived before their id's first record. */
  early: Map<string, number[]>;
  /** Score-filtered slots: their rule and merged scores. */
  ruled: Map<number, DatasetRecord>;
  /** The merged facts of the updates in `early`. */
  earlyFacts: Map<string, DatasetRecord>;
  next: number;
}

export const newIndexBuilder = <P>(): IndexBuilder<P> => ({
  parts: [],
  lineSlots: [],
  partStarts: [],
  slotOf: new Map(),
  early: new Map(),
  ruled: new Map(),
  earlyFacts: new Map(),
  next: 0,
});

/** About what a builder holds (ids dominate: a map entry and its key). */
const builderBytes = <P>(b: IndexBuilder<P>): number =>
  b.lineSlots.length * 8 +
  b.slotOf.size * 96 +
  (b.early.size + b.ruled.size + b.earlyFacts.size) * 256;

/** Folds `parts` (the version's parts after `b.parts`) into `b`, in place. */
export const extendIndex = async <P>(
  lines: PartLines<P>,
  b: IndexBuilder<P>,
  parts: readonly P[],
): Promise<IndexBuilder<P>> => {
  /**
   * Slots that got a rule while unruled after earlier lines (the line it
   * came at): their earlier facts are folded in by `foldHistory` once the
   * parts are read, since only ruled slots carry their facts along.
   */
  const history = new Map<number, number>();

  /** `at`: the line, for a slot that has earlier lines. */
  const rule = (
    record: DatasetRecord,
    slot: number,
    before?: DatasetRecord,
    at?: number,
  ) => {
    const filter = record.metadata?.[SCORE_FILTER];
    if (filter === undefined) {
      b.ruled.delete(slot); // the latest content decides
      history.delete(slot);
      return;
    }
    if (!before && at !== undefined) history.set(slot, at);
    b.ruled.set(
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

  for (const part of parts) {
    b.partStarts.push(b.lineSlots.length);
    for (const text of await lines(part)) {
      const at = b.lineSlots.length;
      // Parsing a part is ~100 ms of CPU per 25k records: let requests in.
      if (at % YIELD_LINES === 0) await yieldToEventLoop();
      const record = JSON.parse(text) as DatasetRecord;
      b.lineSlots.push(-1);
      if (isReset(record)) {
        // Everything before a reset marker drops out of the merge.
        b.lineSlots.fill(-1);
        b.slotOf = new Map();
        b.early = new Map();
        b.ruled = new Map();
        b.earlyFacts = new Map();
        b.next = 0;
        history.clear();
        continue;
      }
      const id = record.id;
      if (!id) {
        b.lineSlots[at] = b.next;
        b.next += 1;
        continue;
      }
      const known = b.slotOf.get(id);
      if (known !== undefined) {
        b.lineSlots[at] = known;
        const state = b.ruled.get(known);
        if (!isScoreUpdate(record)) rule(record, known, state, at);
        else if (state) b.ruled.set(known, applyFacts(state, record));
      } else if (isScoreUpdate(record)) {
        const waiting = b.early.get(id);
        if (waiting) waiting.push(at);
        else b.early.set(id, [at]);
        b.earlyFacts.set(id, applyFacts(b.earlyFacts.get(id) ?? {}, record));
      } else {
        const slot = b.next;
        b.slotOf.set(id, slot);
        b.lineSlots[at] = slot;
        for (const earlier of b.early.get(id) ?? [])
          b.lineSlots[earlier] = slot;
        b.early.delete(id);
        rule(record, slot);
        const facts = b.earlyFacts.get(id);
        const state = b.ruled.get(slot);
        if (facts && state) b.ruled.set(slot, applyFacts(state, facts));
        b.earlyFacts.delete(id);
        b.next += 1;
      }
    }
    b.parts.push(part);
  }
  await foldHistory(lines, b, history);

  return b;
};

/**
 * Folds into each slot of `history` the facts of its lines before the line
 * its current rule came at, in merge order (its first content, then the
 * updates that arrived before it, then the rest): one more read of the
 * parts that hold such lines.
 */
const foldHistory = async <P>(
  lines: PartLines<P>,
  b: IndexBuilder<P>,
  history: ReadonlyMap<number, number>,
): Promise<void> => {
  if (history.size === 0) return;

  const facts = new Map<
    number,
    { early: DatasetRecord; merged?: DatasetRecord }
  >();
  const starts = [...b.partStarts, b.lineSlots.length];
  for (const [p, part] of b.parts.entries()) {
    const start = starts[p] as number;
    const end = starts[p + 1] as number;
    const wanted = (i: number): boolean => {
      const until = history.get(b.lineSlots[i] as number);
      return until !== undefined && i < until;
    };
    let any = false;
    for (let i = start; i < end && !any; i += 1) any = wanted(i);
    if (!any) continue;

    for (const [offset, text] of (await lines(part)).entries()) {
      const i = start + offset;
      if (!wanted(i)) continue;
      const slot = b.lineSlots[i] as number;
      const record = JSON.parse(text) as DatasetRecord;
      const seen = facts.get(slot) ?? { early: {} };
      if (seen.merged) seen.merged = applyFacts(seen.merged, record);
      else if (isScoreUpdate(record))
        seen.early = applyFacts(seen.early, record);
      else seen.merged = applyFacts(applyFacts({}, record), seen.early);
      facts.set(slot, seen);
    }
  }

  for (const [slot, seen] of facts) {
    const state = b.ruled.get(slot);
    const before = seen.merged ?? seen.early;
    if (state)
      b.ruled.set(slot, {
        ...applyFacts(before, state),
        metadata: state.metadata,
      });
  }
};

/** The index of the version `b` has folded in (`b` stays extendable). */
export const finishIndex = <P>(b: IndexBuilder<P>): VersionIndex => {
  const slots = Int32Array.from(b.lineSlots);
  const partStarts = Int32Array.from([...b.partStarts, slots.length]);

  // Drop the slots whose scores fail their filter, and renumber the rest.
  let total = b.next;
  if ([...b.ruled.values()].some((facts) => !passesScoreFilter(facts))) {
    const renumber = new Int32Array(b.next);
    total = 0;
    for (let slot = 0; slot < b.next; slot += 1) {
      const facts = b.ruled.get(slot);
      renumber[slot] = facts && !passesScoreFilter(facts) ? -1 : total++;
    }
    for (let i = 0; i < slots.length; i += 1) {
      const slot = slots[i] as number;
      if (slot >= 0) slots[i] = renumber[slot] as number;
    }
  }

  return { total, slots, partStarts };
};

/** Streams `parts` once and plans their merge. */
export const buildVersionIndex = async <P>(
  lines: PartLines<P>,
  parts: readonly P[],
): Promise<VersionIndex> =>
  finishIndex(await extendIndex(lines, newIndexBuilder<P>(), parts));

/**
 * A byte-bounded LRU of parts' JSONL lines. A page parses only its own
 * lines, and a source's late scores sit in the parts after their records, so
 * consecutive pages read the same few parts: caching their text saves a
 * download, a gunzip and a sha256 per page.
 */
export const createPartLinesCache = <P extends { key: string }>(
  read: PartLines<P>,
  maxBytes = 128 * 1024 * 1024,
): PartLines<P> => {
  const cached = new Map<string, { lines: string[]; bytes: number }>();
  let bytes = 0;

  return async (part) => {
    const hit = cached.get(part.key);
    if (hit) {
      cached.delete(part.key);
      cached.set(part.key, hit);
      return hit.lines;
    }
    const lines = await read(part);
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
export const readVersionPage = async <P>(
  lines: PartLines<P>,
  parts: readonly P[],
  index: VersionIndex,
  from: number,
  limit: number,
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

/**
 * Each prefix of `parts` as one key (a rolling hash of the part hashes): a
 * version's key, and those of the versions it extends.
 */
const prefixKeys = (parts: readonly DatasetPart[]): string[] => {
  const keys = [""];
  for (const part of parts) {
    keys.push(
      createHash("sha256")
        .update(`${keys.at(-1) as string},${part.sha256}`)
        .digest("hex"),
    );
  }

  return keys;
};

/**
 * A byte-bounded LRU of version indexes, with one build per version at a
 * time. It also keeps the builders of the versions it built (byte-bounded
 * too): the next version of a dataset (a push, a sync) extends its
 * predecessor's builder with the new parts instead of re-reading the whole
 * dataset (p1-scale: a push to a 300k-record dataset took 7 s, nearly all
 * of it rebuilding the index).
 */
export const createVersionIndexCache = (
  storage: ObjectStore,
  maxBytes = 64 * 1024 * 1024,
  maxBuilderBytes = 128 * 1024 * 1024,
) => {
  const cached = new Map<string, VersionIndex>();
  const lines = storedPartLines(storage);
  const builders = new Map<string, IndexBuilder<DatasetPart>>();
  const building = new Map<string, Promise<VersionIndex>>();
  let bytes = 0;

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

  const keepBuilder = (
    key: string,
    builder: IndexBuilder<DatasetPart>,
  ): void => {
    if (builderBytes(builder) > maxBuilderBytes) return;
    builders.set(key, builder);
    let total = 0;
    for (const b of builders.values()) total += builderBytes(b);
    for (const [oldest, old] of builders) {
      if (total <= maxBuilderBytes) break;
      builders.delete(oldest);
      total -= builderBytes(old);
    }
  };

  /** The longest cached prefix's builder (taken: it is extended in place), or a new one. */
  const takeBuilder = (keys: readonly string[]): IndexBuilder<DatasetPart> => {
    for (let k = keys.length - 2; k > 0; k -= 1) {
      const key = keys[k] as string;
      const builder = builders.get(key);
      if (builder) {
        builders.delete(key);
        return builder;
      }
    }

    return newIndexBuilder<DatasetPart>();
  };

  return {
    get: async (
      version: Pick<DatasetVersion, "parts">,
    ): Promise<VersionIndex> => {
      const keys = prefixKeys(version.parts);
      const key = keys.at(-1) as string;
      const hit = cached.get(key);
      if (hit) {
        // Most recently used last.
        cached.delete(key);
        cached.set(key, hit);
        return hit;
      }
      const inFlight = building.get(key);
      if (inFlight) return inFlight;

      const build = (async () => {
        const builder = takeBuilder(keys);
        await extendIndex(
          lines,
          builder,
          version.parts.slice(builder.parts.length),
        );
        const index = finishIndex(builder);
        remember(key, index);
        keepBuilder(key, builder);

        return index;
      })().finally(() => building.delete(key));
      building.set(key, build);

      return build;
    },
    /** Bytes held by cached indexes (tests). */
    bytes: () => bytes,
  };
};
