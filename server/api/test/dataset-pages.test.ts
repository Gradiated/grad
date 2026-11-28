import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatasetRecord } from "../src/contracts.js";
import {
  buildVersionIndex,
  createPartLinesCache,
  createVersionIndexCache,
  readVersionPage,
  storedPartLines,
} from "../src/services/dataset-pages.js";
import {
  partLines,
  writeRecordsPart,
} from "../src/services/dataset-records.js";
import { mergeRecords, scoreUpdate } from "../src/services/record-merge.js";
import type { ObjectStore } from "../src/storage/types.js";
import type { DatasetPart } from "../src/store/types.js";
import { testObjectStore } from "./fixtures/s3.js";

const rec = (id: string | undefined, text: string): DatasetRecord => ({
  ...(id ? { id } : {}),
  messages: [
    { role: "user", content: `q ${text}` },
    { role: "assistant", content: `a ${text}` },
  ],
});

describe("dataset pages (r8 P1-5)", () => {
  let s3: ReturnType<typeof testObjectStore>;
  let storage: ObjectStore;
  let fetched: string[];

  beforeEach(() => {
    s3 = testObjectStore();
    fetched = [];
    storage = {
      ...s3.storage,
      get: (key: string) => {
        fetched.push(key);
        return s3.storage.get(key);
      },
    };
  });
  afterEach(() => s3.close());

  const write = (records: DatasetRecord[]): Promise<DatasetPart> =>
    writeRecordsPart(storage, (sha) => `parts/${sha}.jsonl.gz`, records);

  it("pages exactly the whole-version merge: updates, early updates, re-sent records, resets, anonymous records", async () => {
    const parts = [
      await write([rec("a", "1"), rec("b", "1"), rec(undefined, "anon1")]),
      await write([
        scoreUpdate("c", { q: 0.1 }), // before c exists
        scoreUpdate("a", { q: 0.5 }),
        scoreUpdate("ghost", { q: 1 }), // never arrives
        rec("c", "1"),
      ]),
      await write([rec("a", "2"), rec(undefined, "anon2"), rec("d", "1")]),
      await write([
        { ...scoreUpdate("b", { r: 1 }), expected_output: { content: "e" } },
      ]),
    ];
    const all = async (ps: DatasetPart[]) => {
      const out: DatasetRecord[] = [];
      for (const p of ps) {
        out.push(
          ...(await partLines(await storage.get(p.key), p)).map(
            (l) => JSON.parse(l) as DatasetRecord,
          ),
        );
      }
      return mergeRecords(out);
    };

    for (const version of [
      parts,
      [
        ...parts,
        await write([{ metadata: { dataset_reset: true } }, rec("z", "1")]),
        await write([rec("a", "3"), scoreUpdate("z", { q: 1 })]),
      ],
    ]) {
      const expected = await all(version);
      const index = await buildVersionIndex(storedPartLines(storage), version);
      expect(index.total).toBe(expected.length);
      for (let from = 0; from <= expected.length; from += 1) {
        for (const limit of [1, 2, 3, 100]) {
          expect(
            await readVersionPage(
              storedPartLines(storage),
              version,
              index,
              from,
              limit,
            ),
          ).toEqual(expected.slice(from, from + limit));
        }
      }
    }
  });

  it("pages read each part once through the lines cache, and it stays within its bytes (r8-sources)", async () => {
    const parts = [
      await write([rec("a", "1"), rec("b", "1")]),
      await write([scoreUpdate("a", { q: 1 }), rec("c", "1")]),
    ];
    const index = await buildVersionIndex(storedPartLines(storage), parts);
    const all = await readVersionPage(
      storedPartLines(storage),
      parts,
      index,
      0,
      100,
    );
    const lines = createPartLinesCache(storedPartLines(storage));
    fetched = [];
    const pages = [];
    for (let from = 0; from < 3; from += 1) {
      pages.push(...(await readVersionPage(lines, parts, index, from, 1)));
    }
    expect(pages).toEqual(all);
    expect(fetched.sort()).toEqual(parts.map((p) => p.key).sort());
    const tiny = createPartLinesCache(storedPartLines(storage), 10);
    fetched = [];
    await readVersionPage(tiny, parts, index, 0, 1);
    await readVersionPage(tiny, parts, index, 0, 1);
    expect(fetched.length).toBe(4); // too big to keep: read again
  });

  it("pages and counts only score-filtered records whose merged scores pass (r8-sources)", async () => {
    const ruled = (
      id: string,
      text: string,
      rule: Record<string, unknown>,
    ) => ({
      ...rec(id, text),
      metadata: { score_filter: rule, model: "m" },
    });
    const parts = [
      await write([
        ruled("a", "1", { has_feedback: true }),
        ruled("b", "1", { min_score: 0.5 }),
        rec("c", "1"),
        ruled("d", "1", { min_score: { q: 0.5 } }),
      ]),
      await write([
        scoreUpdate("e", { q: 0.9 }), // before e exists
        scoreUpdate("b", { q: 0.7, r: 0.2 }),
        ruled("e", "1", { min_score: { q: 0.5 } }),
        { ...scoreUpdate("a", {}), expected_output: "fix" },
      ]),
      await write([ruled("d", "2", { min_score: { q: 0.5 } }), rec("b", "2")]),
    ];
    const lines: DatasetRecord[] = [];
    for (const p of parts)
      lines.push(
        ...(await partLines(await storage.get(p.key), p)).map(
          (l) => JSON.parse(l) as DatasetRecord,
        ),
      );
    const expected = mergeRecords(lines);
    // a: a correction; b: re-sent without a rule; c: no rule; d: no score; e: early 0.9.
    expect(expected.map((r) => r.id)).toEqual(["a", "b", "c", "e"]);
    expect(expected[0]?.metadata).toEqual({ model: "m" });
    const index = await buildVersionIndex(storedPartLines(storage), parts);
    expect(index.total).toBe(4);
    for (let from = 0; from <= expected.length; from += 1) {
      for (const limit of [1, 2, 100]) {
        expect(
          await readVersionPage(
            storedPartLines(storage),
            parts,
            index,
            from,
            limit,
          ),
        ).toEqual(expected.slice(from, from + limit));
      }
    }
  });

  it("indexes each next version from the last one's builder: only its new parts are read, same index", async () => {
    const ruled = (id: string, rule: Record<string, unknown>) => ({
      ...rec(id, id),
      metadata: { score_filter: rule },
    });
    const parts = [
      await write([rec("a", "1"), ruled("b", { min_score: 0.5 })]),
      await write([scoreUpdate("c", { q: 1 }), rec(undefined, "anon")]),
      await write([rec("c", "1"), scoreUpdate("b", { q: 0.2 })]),
      await write([{ metadata: { dataset_reset: true } }, rec("a", "2")]),
      await write([rec("d", "1"), scoreUpdate("a", { q: 1 })]),
    ];
    const cache = createVersionIndexCache(storage);
    for (let n = 1; n <= parts.length; n += 1) {
      fetched = [];
      const version = { parts: parts.slice(0, n) };
      expect(await cache.get(version)).toEqual(
        await buildVersionIndex(storedPartLines(s3.storage), version.parts),
      );
      // Version n extends version n-1: one part read, not n.
      expect(fetched).toEqual([parts[n - 1]?.key]);
    }
    // A version that extends none of the cached ones still builds whole.
    fetched = [];
    const other = { parts: [parts[0] as DatasetPart, parts[2] as DatasetPart] };
    expect(await cache.get(other)).toEqual(
      await buildVersionIndex(storedPartLines(s3.storage), other.parts),
    );
    expect(fetched).toHaveLength(2);
  });

  it("keeps memory and latency bounded on a large dataset: a page reads only its own parts", async () => {
    // 60k records (~45 MB of JSON) in 30 parts, then a dataset.score() part.
    const PARTS = 30;
    const PER_PART = 2_000;
    const parts: DatasetPart[] = [];
    const filler = "x".repeat(600);
    for (let p = 0; p < PARTS; p += 1) {
      parts.push(
        await write(
          Array.from({ length: PER_PART }, (_, i) =>
            rec(`r${p * PER_PART + i}`, `${p}-${i} ${filler}`),
          ),
        ),
      );
    }
    parts.push(
      await write(
        Array.from({ length: 50 }, (_, i) =>
          scoreUpdate(`r${i * 1000}`, { q: 1 }),
        ),
      ),
    );
    const total = PARTS * PER_PART;

    const cache = createVersionIndexCache(storage);
    const version = { parts };
    const index = await cache.get(version);
    expect(index.total).toBe(total);
    // The index is 4 bytes a line, a fraction of the data it describes.
    expect(cache.bytes()).toBeLessThan((total + 51) * 4 + 1024);
    expect(await cache.get(version)).toBe(index); // built once

    setFlagsFromString("--expose-gc");
    const gc = runInNewContext("gc") as () => void;
    let worstMs = 0;
    let worstHeap = 0;
    for (const from of [0, 31_000, 45_999, total - 1]) {
      fetched = [];
      gc();
      const heapBefore = process.memoryUsage().heapUsed;
      const t0 = performance.now();
      const page = await readVersionPage(
        storedPartLines(storage),
        parts,
        index,
        from,
        50,
      );
      worstMs = Math.max(worstMs, performance.now() - t0);
      worstHeap = Math.max(
        worstHeap,
        process.memoryUsage().heapUsed - heapBefore,
      );
      expect(page[0]?.id).toBe(`r${from}`);
      // Its own part(s), plus the score-update part when a record has a score.
      expect(fetched.length).toBeLessThanOrEqual(3);
    }
    expect(
      (
        await readVersionPage(storedPartLines(storage), parts, index, 31_000, 1)
      )[0]?.scores,
    ).toEqual({ q: 1 });
    // Loading the version would allocate several times its JSON size (~45 MB);
    // a page allocates about one part's worth.
    expect(worstHeap).toBeLessThan(32 * 1024 * 1024);
    expect(worstMs).toBeLessThan(2_000);
  }, 120_000);
});
