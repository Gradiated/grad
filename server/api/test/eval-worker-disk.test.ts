import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import {
  DatasetTooLarge,
  openDownloadedVersion,
} from "../src/worker/dataset-file.js";

// /dev/full answers every write with ENOSPC: a disk that is already full.
const disk = vi.hoisted(() => ({ full: false }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    createWriteStream: ((path: string, options?: unknown) =>
      fs.createWriteStream(
        disk.full ? "/dev/full" : path,
        options as never,
      )) as typeof fs.createWriteStream,
  };
});

const lines = async function* (n: number) {
  for (let i = 0; i < n; i += 1) {
    yield JSON.stringify({
      id: `r${i}`,
      messages: [{ role: "user", content: "x".repeat(100) }],
    });
  }
};
const leftovers = async () =>
  (await readdir(tmpdir())).filter((f) => f.startsWith("grad-eval-"));

describe("an eval worker's dataset version on disk", () => {
  it("fails with a clear error past its temporary disk limit, and leaves no file behind", async () => {
    const before = await leftovers();
    const error = await openDownloadedVersion(lines(1_000), {
      maxBytes: 20_000,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatasetTooLarge);
    expect(String(error)).toMatch(
      /over the eval worker's 0\.0 GB of temporary disk.*evals\.tmpSizeGb/,
    );
    expect(await leftovers()).toEqual(before);
  });

  it("fails with a clear error when the disk fills up (ENOSPC), never an unhandled stream error", async () => {
    const before = await leftovers();
    disk.full = true;
    try {
      const error = await openDownloadedVersion(lines(1_000)).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DatasetTooLarge);
      expect(String(error)).toMatch(
        /disk filled up after .* GB of the dataset version/,
      );
    } finally {
      disk.full = false;
    }
    expect(await leftovers()).toEqual(before);
  });

  it("keeps no named file on disk while open, so a killed worker leaves nothing behind", async () => {
    const before = await leftovers();
    const version = await openDownloadedVersion(lines(10));
    expect(await leftovers()).toEqual(before);
    let n = 0;
    for await (const _ of version.records()) n += 1;
    expect(n).toBe(10);
    await version.close();
  });

  it("reads a version under the limit", async () => {
    const version = await openDownloadedVersion(lines(10), {
      maxBytes: 1e6,
    });
    let n = 0;
    for await (const _ of version.records()) n += 1;
    await version.close();
    expect(n).toBe(10);
  });
});
