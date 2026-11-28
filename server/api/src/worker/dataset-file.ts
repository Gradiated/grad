import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DatasetRecord } from "../contracts.js";
import {
  buildVersionIndex,
  createPartLinesCache,
  readVersionPage,
  type PartLines,
} from "../services/dataset-pages.js";

/** A run of the file's lines: the "part" the merge index reads. */
interface Chunk {
  key: string;
  start: number;
  end: number;
}

/** Lines per chunk, and bytes (records can be large). */
const CHUNK_LINES = 10_000;
const CHUNK_BYTES = 16 * 1024 * 1024;
/** Merged records read at a time. */
const PAGE = 2_000;

/**
 * A downloaded dataset version on local disk, read the way grad-server reads
 * a stored version (dataset-pages.ts): the JSONL goes to a temporary file in
 * chunks, the merge index is built over them, and merged records come a page
 * at a time. Memory is the index (4 bytes a line and about 100 bytes a record
 * id) plus a page and a few chunks, not the dataset; the eval worker's pod
 * has 1 GiB.
 */
export const openDownloadedVersion = async (
  lines: AsyncIterable<string>,
  chunkLines = CHUNK_LINES,
): Promise<{
  records: () => AsyncGenerator<DatasetRecord>;
  close: () => Promise<void>;
}> => {
  const dir = await mkdtemp(join(tmpdir(), "grad-eval-"));
  const path = join(dir, "version.jsonl");
  const close = () => rm(dir, { recursive: true, force: true });

  try {
    const chunks: Chunk[] = [];
    const out = createWriteStream(path);
    let offset = 0;
    let start = 0;
    let count = 0;
    const cut = () => {
      if (count === 0) return;
      chunks.push({ key: String(chunks.length), start, end: offset });
      start = offset;
      count = 0;
    };
    try {
      for await (const line of lines) {
        const text = `${line}\n`;
        if (!out.write(text)) await once(out, "drain");
        offset += Buffer.byteLength(text);
        count += 1;
        if (count >= chunkLines || offset - start >= CHUNK_BYTES) cut();
      }
      cut();
    } finally {
      out.end();
      await once(out, "close");
    }

    const file = await open(path);
    const read: PartLines<Chunk> = async (chunk) => {
      const bytes = Buffer.alloc(chunk.end - chunk.start);
      await file.read(bytes, 0, bytes.length, chunk.start);

      return bytes.toString("utf8").split("\n").slice(0, -1);
    };
    const cached = createPartLinesCache(read, 64 * 1024 * 1024);
    const index = await buildVersionIndex(cached, chunks).catch(
      async (error: unknown) => {
        await file.close();
        throw error;
      },
    );

    return {
      records: async function* () {
        for (let from = 0; from < index.total; from += PAGE) {
          yield* await readVersionPage(cached, chunks, index, from, PAGE);
        }
      },
      close: async () => {
        await file.close();
        await close();
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
};
