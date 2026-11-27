import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DatasetRecord } from "../src/contracts.js";
import {
  buildVersionIndex,
  createVersionIndexCache,
  readVersionPage,
} from "../src/services/dataset-pages.js";
import {
  parsePart,
  writeRecordsPart,
} from "../src/services/dataset-records.js";
import { mergeRecords, scoreUpdate } from "../src/services/record-merge.js";
import { LocalObjectStore } from "../src/storage/local.js";
import type { DatasetPart } from "../src/store/types.js";

const rec = (id: string | undefined, text: string): DatasetRecord => ({
  ...(id ? { id } : {}),
  messages: [
    { role: "user", content: `q ${text}` },
    { role: "assistant", content: `a ${text}` },
  ],
});

describe("dataset pages (r8 P1-5)", () => {
  let dir: string;
  let storage: LocalObjectStore;
  let fetched: string[];

  beforeEach(async () => {
    dir = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "pages-"));
    const local = new LocalObjectStore(dir);
    fetched = [];
    storage = Object.assign(Object.create(local) as LocalObjectStore, {
      get: (key: string) => {
        fetched.push(key);
        return local.get(key);
      },
    });
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));

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
        out.push(...parsePart(await storage.get(p.key), p));
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
      const index = await buildVersionIndex(storage, version);
      expect(index.total).toBe(expected.length);
      for (let from = 0; from <= expected.length; from += 1) {
        for (const limit of [1, 2, 3, 100]) {
          expect(
            await readVersionPage(storage, version, index, from, limit),
          ).toEqual(expected.slice(from, from + limit));
        }
      }
    }
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
      const page = await readVersionPage(storage, parts, index, from, 50);
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
      (await readVersionPage(storage, parts, index, 31_000, 1))[0]?.scores,
    ).toEqual({ q: 1 });
    // Loading the version would allocate several times its JSON size (~45 MB);
    // a page allocates about one part's worth.
    expect(worstHeap).toBeLessThan(32 * 1024 * 1024);
    expect(worstMs).toBeLessThan(2_000);
  }, 120_000);
});
