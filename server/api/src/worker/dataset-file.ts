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

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/**
 * The version doesn't fit on the worker's disk: past `maxBytes`, or the disk
 * filled first (ENOSPC). The attempt fails with this message.
 */
export class DatasetTooLarge extends Error {}

/**
 * A downloaded dataset version on local disk, read the way grad-server reads
 * a stored version (dataset-pages.ts): the JSONL goes to a temporary file in
 * chunks, the merge index is built over them, and merged records come a page
 * at a time. Memory is the index (4 bytes a line and about 100 bytes a record
 * id) plus a page and a few chunks, not the dataset; the eval worker's pod
 * has 1 GiB. The file is unlinked as soon as it is open, so however the
 * worker ends (an OOM kill, SIGKILL) its disk is freed, never left in the
 * pod's /tmp for the restarted container to fill up on.
 */
export const openDownloadedVersion = async (
  lines: AsyncIterable<string>,
  options: { chunkLines?: number; maxBytes?: number | undefined } = {},
): Promise<{
  records: () => AsyncGenerator<DatasetRecord>;
  close: () => Promise<void>;
}> => {
  const dir = await mkdtemp(join(tmpdir(), "grad-eval-"));
  const path = join(dir, "version.jsonl");
  const file = await open(path, "w+").catch(async (error: unknown) => {
    await rm(dir, { recursive: true, force: true });
    throw error;
  });

  const chunkLines = options.chunkLines ?? CHUNK_LINES;
  const maxBytes = options.maxBytes ?? Infinity;
  try {
    const chunks: Chunk[] = [];
    const out = createWriteStream(path, { flags: "r+" });
    // A write error (ENOSPC) surfaces here, never as an unhandled 'error' event.
    let failed: NodeJS.ErrnoException | null = null;
    out.on("error", (error) => (failed ??= error));
    // Both descriptors are open: drop the name (the disk is freed with them).
    await once(out, "open").catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
    const tooLarge = (written: number) =>
      new DatasetTooLarge(
        failed?.code === "ENOSPC"
          ? `The eval worker's disk filled up after ${gb(written)} of the dataset version (uncompressed JSONL in ${tmpdir()}). Give the eval worker more temporary disk (evals.tmpSizeGb in the Helm chart), or eval a smaller version or a \`limit\`.`
          : `The dataset version is over the eval worker's ${gb(maxBytes)} of temporary disk (uncompressed JSONL; GRAD_EVAL_TMP_MAX_GB, evals.tmpSizeGb in the Helm chart). Raise it, or eval a smaller version or a \`limit\`.`,
      );
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
        offset += Buffer.byteLength(text);
        if (offset > maxBytes) throw tooLarge(offset);
        if (!out.write(text)) await once(out, "drain").catch(() => undefined);
        if (failed) break;
        count += 1;
        if (count >= chunkLines || offset - start >= CHUNK_BYTES) cut();
      }
      cut();
    } finally {
      out.end();
      if (!out.closed) await once(out, "close").catch(() => undefined);
    }
    if (failed !== null) {
      throw (failed as NodeJS.ErrnoException).code === "ENOSPC"
        ? tooLarge(offset)
        : failed;
    }

    const read: PartLines<Chunk> = async (chunk) => {
      const bytes = Buffer.alloc(chunk.end - chunk.start);
      await file.read(bytes, 0, bytes.length, chunk.start);

      return bytes.toString("utf8").split("\n").slice(0, -1);
    };
    const cached = createPartLinesCache(read, 64 * 1024 * 1024);
    const index = await buildVersionIndex(cached, chunks);

    return {
      records: async function* () {
        for (let from = 0; from < index.total; from += PAGE) {
          yield* await readVersionPage(cached, chunks, index, from, PAGE);
        }
      },
      close: () => file.close(),
    };
  } catch (error) {
    await file.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
};
