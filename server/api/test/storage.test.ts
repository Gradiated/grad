import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { LocalObjectStore, validateObjectKey } from "../src/storage.js";

describe("validateObjectKey", () => {
  it("accepts clean relative keys", () => {
    expect(validateObjectKey("datasets/ws1/support/records.jsonl")).toBe(
      "datasets/ws1/support/records.jsonl",
    );
  });

  it("rejects traversal, absolute, backslash, and empty keys", () => {
    const bad = [
      "",
      "/etc/passwd",
      "../escape.txt",
      "datasets/../secret",
      "datasets//double",
      "datasets/./dot",
      "datasets\\win\\path",
      "datasets/null\0byte",
    ];
    for (const key of bad) {
      expect(() => validateObjectKey(key)).toThrow(
        /Invalid object storage key/,
      );
    }
  });
});

describe("LocalObjectStore", () => {
  it("stores, verifies SHA-256, retrieves, and deletes bytes safely", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grad-store-test-"));
    try {
      const store = new LocalObjectStore(root);
      const payload = Buffer.from("hello gradiated", "utf8");
      const saved = await store.put("artifacts/ws1/test.bin", payload);

      expect(saved.sizeBytes).toBe(payload.byteLength);
      expect(saved.sha256).toHaveLength(64);

      const readBack = await store.get("artifacts/ws1/test.bin");
      expect(Buffer.from(readBack).toString("utf8")).toBe("hello gradiated");

      await store.delete("artifacts/ws1/test.bin");
      await expect(store.get("artifacts/ws1/test.bin")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
