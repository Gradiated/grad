import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LocalObjectStore } from "../src/storage/local.js";
import { S3ObjectStore } from "../src/storage/s3.js";
import {
  ObjectExistsError,
  ObjectIntegrityError,
  ObjectNotFoundError,
  validateObjectKey,
  type ObjectStore,
} from "../src/storage/types.js";
import { s3Target } from "./fixtures/minio.js";

const sha = (data: Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

const chunksOf = async function* (
  data: Uint8Array,
  size = 7,
): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.byteLength; i += size) {
    yield data.subarray(i, i + size);
  }
};

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Buffer> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
};

const uniqueKey = (name: string): string =>
  `contract/${randomBytes(6).toString("hex")}/${name}`;

interface StoreHarness {
  store: ObjectStore;
  cleanup: () => Promise<void>;
}

const describeObjectStoreContract = (
  name: string,
  factory: () => Promise<StoreHarness | null>,
): void => {
  describe(`ObjectStore contract: ${name}`, () => {
    let harness: StoreHarness | null = null;
    let store: ObjectStore;

    beforeAll(async () => {
      harness = await factory();
      if (harness) store = harness.store;
    });

    afterAll(async () => {
      await harness?.cleanup();
    });

    const live = () => {
      if (!harness) {
        console.warn(
          `[storage-contract] ${name}: backend unavailable, skipped`,
        );
        return false;
      }
      return true;
    };

    it("round-trips bytes and reports sha256/size", async () => {
      if (!live()) return;
      const key = uniqueKey("roundtrip.bin");
      const data = Buffer.from("hello gradiated");
      const stored = await store.put(key, data);

      expect(stored).toEqual({
        key,
        sha256: sha(data),
        sizeBytes: data.byteLength,
      });
      expect(Buffer.from(await store.get(key)).toString()).toBe(
        "hello gradiated",
      );
      expect((await readAll(await store.getStream(key))).toString()).toBe(
        "hello gradiated",
      );
    });

    it("never overwrites an existing key", async () => {
      if (!live()) return;
      const key = uniqueKey("immutable.bin");
      await store.put(key, Buffer.from("AAAA"));

      await expect(store.put(key, Buffer.from("BBBB"))).rejects.toBeInstanceOf(
        ObjectExistsError,
      );
      await expect(
        store.putStream(key, chunksOf(Buffer.from("CCCC")), {
          maxBytes: 100,
          expectedSha256: sha(Buffer.from("CCCC")),
          expectedSizeBytes: 4,
        }),
      ).rejects.toBeInstanceOf(ObjectExistsError);
      expect(Buffer.from(await store.get(key)).toString()).toBe("AAAA");
    });

    it("lets exactly one of several concurrent puts to a key win", async () => {
      if (!live()) return;
      const key = uniqueKey("race.bin");
      const bodies = ["one", "two", "three", "four", "five"].map((v) =>
        Buffer.from(v),
      );
      const results = await Promise.allSettled(
        bodies.map((b) => store.put(key, b)),
      );
      const wins = results.filter((r) => r.status === "fulfilled");
      const losses = results.filter((r) => r.status === "rejected");

      expect(wins).toHaveLength(1);
      for (const loss of losses) {
        expect((loss as PromiseRejectedResult).reason).toBeInstanceOf(
          ObjectExistsError,
        );
      }
      const winner = (wins[0] as PromiseFulfilledResult<{ sha256: string }>)
        .value;
      expect(sha(await store.get(key))).toBe(winner.sha256);
    });

    it("streams uploads with declared size and sha256", async () => {
      if (!live()) return;
      const key = uniqueKey("stream.bin");
      const data = randomBytes(64 * 1024 + 3);
      const stored = await store.putStream(key, chunksOf(data, 4096), {
        maxBytes: 1024 * 1024,
        expectedSha256: sha(data),
        expectedSizeBytes: data.byteLength,
      });

      expect(stored.sha256).toBe(sha(data));
      expect(stored.sizeBytes).toBe(data.byteLength);
      expect(Buffer.compare(Buffer.from(await store.get(key)), data)).toBe(0);
    });

    it("streams uploads without declared digests", async () => {
      if (!live()) return;
      const key = uniqueKey("undeclared.bin");
      const data = Buffer.from("no declared digest");
      const stored = await store.putStream(key, chunksOf(data), {
        maxBytes: 1000,
      });

      expect(stored.sha256).toBe(sha(data));
      expect(stored.sizeBytes).toBe(data.byteLength);
    });

    it.each([
      [
        "sha256 mismatch",
        { expectedSha256: "0".repeat(64), expectedSizeBytes: 11 },
      ],
      ["size too small", { expectedSha256: undefined, expectedSizeBytes: 5 }],
      ["size too large", { expectedSha256: undefined, expectedSizeBytes: 50 }],
      ["declared size mismatch with sha", { sizeDelta: 1 }],
      ["maxBytes exceeded", { maxBytes: 4 }],
    ] as const)("rejects %s and leaves no object", async (_label, opts) => {
      if (!live()) return;
      const key = uniqueKey("bad.bin");
      const data = Buffer.from("hello world");
      const options =
        "sizeDelta" in opts
          ? {
              maxBytes: 1000,
              expectedSha256: sha(data),
              expectedSizeBytes: data.byteLength + opts.sizeDelta,
            }
          : "maxBytes" in opts
            ? { maxBytes: opts.maxBytes }
            : { maxBytes: 1000, ...opts };

      await expect(
        store.putStream(key, chunksOf(data), options),
      ).rejects.toBeInstanceOf(ObjectIntegrityError);
      expect(await store.head(key)).toBeNull();
      await expect(store.get(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    it("reports head size (and sha for checksummed backends)", async () => {
      if (!live()) return;
      const key = uniqueKey("head.bin");
      const data = Buffer.from("head me");
      await store.put(key, data);
      const head = await store.head(key);

      expect(head?.sizeBytes).toBe(data.byteLength);
      if (store.kind === "s3") expect(head?.sha256).toBe(sha(data));
      expect(await store.head(uniqueKey("missing.bin"))).toBeNull();
    });

    it("lists keys under a prefix older than a cutoff", async () => {
      if (!live()) return;
      const prefix = uniqueKey("sweep");
      await store.put(`${prefix}/a/one.bin`, Buffer.from("1"));
      await store.put(`${prefix}/two.bin`, Buffer.from("2"));
      await store.put(uniqueKey("elsewhere.bin"), Buffer.from("3"));
      const future = new Date(Date.now() + 60_000);

      expect((await store.listOlder(prefix, future, 10)).sort()).toEqual([
        `${prefix}/a/one.bin`,
        `${prefix}/two.bin`,
      ]);
      expect(await store.listOlder(prefix, future, 1)).toHaveLength(1);
      expect(await store.listOlder(prefix, new Date(0), 10)).toEqual([]);
      expect(await store.listOlder(uniqueKey("empty"), future, 10)).toEqual([]);
    });

    it("deletes idempotently", async () => {
      if (!live()) return;
      const key = uniqueKey("delete.bin");
      await store.put(key, Buffer.from("bye"));
      await store.delete(key);
      await store.delete(key);

      await expect(store.get(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
      await expect(store.getStream(key)).rejects.toBeInstanceOf(
        ObjectNotFoundError,
      );
    });

    it("rejects invalid keys", async () => {
      if (!live()) return;
      for (const key of [
        "",
        "/etc/passwd",
        "../escape",
        "a/../b",
        "a//b",
        "a/./b",
        "a\\b",
        "a\0b",
      ]) {
        await expect(store.put(key, Buffer.from("x"))).rejects.toThrow(
          /Invalid object storage key/,
        );
        await expect(store.get(key)).rejects.toThrow(
          /Invalid object storage key/,
        );
      }
    });
  });
};

describe("validateObjectKey", () => {
  it("accepts clean relative keys and rejects overlong ones", () => {
    expect(validateObjectKey("datasets/ws1/support/records.jsonl")).toBe(
      "datasets/ws1/support/records.jsonl",
    );
    expect(() => validateObjectKey("a".repeat(1025))).toThrow();
  });
});

const tmpRoot = () =>
  mkdtemp(
    path.join(process.env.TMPDIR ?? os.tmpdir(), "grad-storage-contract-"),
  );

describeObjectStoreContract("local filesystem", async () => {
  const root = await tmpRoot();

  return {
    store: new LocalObjectStore(root),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
});

describeObjectStoreContract("S3 (MinIO)", async () => {
  const target = s3Target();
  if (!target) return null;
  const store = new S3ObjectStore({
    bucket: target.bucket,
    region: target.region,
    endpoint: target.endpoint,
    credentials: {
      accessKeyId: target.accessKeyId,
      secretAccessKey: target.secretAccessKey,
    },
  });

  return { store, cleanup: async () => store.close() };
});

describe("LocalObjectStore specifics", () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    root = await tmpRoot();
    outside = await tmpRoot();
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("rejects a symlinked subdirectory that points outside the root", async () => {
    const store = new LocalObjectStore(root);
    await writeFile(path.join(outside, "secret.txt"), "top secret");
    await symlink(outside, path.join(root, "escape"));

    await expect(store.get("escape/secret.txt")).rejects.toThrow(/symlink/);
    await expect(store.put("escape/new.txt", Buffer.from("x"))).rejects.toThrow(
      /symlink/,
    );
    await expect(
      store.put("escape/deeper/new.txt", Buffer.from("x")),
    ).rejects.toThrow(/symlink/);
    expect(await readdir(outside)).toEqual(["secret.txt"]);
  });

  it("rejects a symlinked file that points outside the root", async () => {
    const store = new LocalObjectStore(root);
    await mkdir(path.join(root, "links"), { recursive: true });
    await symlink(
      path.join(outside, "secret.txt"),
      path.join(root, "links", "leak.txt"),
    );

    await expect(store.get("links/leak.txt")).rejects.toThrow(/symlink/);
    await expect(store.head("links/leak.txt")).rejects.toThrow(/symlink/);
  });

  it("cleans up temp files when a write fails", async () => {
    const store = new LocalObjectStore(root);
    await mkdir(path.join(root, "tmpcheck"), { recursive: true });

    await expect(
      store.putStream("tmpcheck/a.bin", chunksOf(Buffer.from("abcdef")), {
        maxBytes: 1000,
        expectedSha256: "f".repeat(64),
      }),
    ).rejects.toBeInstanceOf(ObjectIntegrityError);
    await store.put("tmpcheck/b.bin", Buffer.from("b"));
    await expect(
      store.put("tmpcheck/b.bin", Buffer.from("c")),
    ).rejects.toBeInstanceOf(ObjectExistsError);

    expect(await readdir(path.join(root, "tmpcheck"))).toEqual(["b.bin"]);
  });

  it("cleans up when the source iterable throws mid-stream", async () => {
    const store = new LocalObjectStore(root);
    const failing = async function* () {
      yield Buffer.from("partial");
      throw new Error("client disconnected");
    };

    await expect(
      store.putStream("aborted/x.bin", failing(), { maxBytes: 1000 }),
    ).rejects.toThrow(/client disconnected/);
    expect(await readdir(path.join(root, "aborted"))).toEqual([]);
  });

  it("has no presigning (the server proxies uploads instead)", async () => {
    const store = new LocalObjectStore(root);

    expect(
      await store.presignUpload("a/b", {
        sha256: "0".repeat(64),
        sizeBytes: 1,
        expiresInSeconds: 60,
      }),
    ).toBeNull();
    expect(await store.presignDownload("a/b", 60)).toBeNull();
  });
});

describe("S3ObjectStore presigned URLs (MinIO)", () => {
  const target = s3Target();
  const store = target
    ? new S3ObjectStore({
        bucket: target.bucket,
        region: target.region,
        endpoint: target.endpoint,
        credentials: {
          accessKeyId: target.accessKeyId,
          secretAccessKey: target.secretAccessKey,
        },
      })
    : null;

  afterAll(() => store?.close());

  const put = (url: string, headers: Record<string, string>, body: Buffer) =>
    fetch(url, { method: "PUT", headers, body: new Uint8Array(body) });

  it("binds Content-Length and x-amz-checksum-sha256: only the declared bytes are accepted", async () => {
    if (!store) {
      console.warn("[storage-contract] S3 presign: MinIO unavailable, skipped");
      return;
    }
    const key = uniqueKey("presigned.bin");
    const data = randomBytes(2048);
    const ticket = await store.presignUpload(key, {
      sha256: sha(data),
      sizeBytes: data.byteLength,
      expiresInSeconds: 300,
    });

    expect(ticket.headers).toEqual({
      "content-length": String(data.byteLength),
      "x-amz-checksum-sha256": Buffer.from(sha(data), "hex").toString("base64"),
    });

    const tampered = Buffer.from(data);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const bad = await put(ticket.url, ticket.headers, tampered);
    expect(bad.ok).toBe(false);
    expect(await store.head(key)).toBeNull();

    const withoutChecksum = { ...ticket.headers };
    delete withoutChecksum["x-amz-checksum-sha256"];
    expect((await put(ticket.url, withoutChecksum, data)).ok).toBe(false);

    // Another length (with the length header the client computes) is refused.
    const { "content-length": _length, ...noLength } = ticket.headers;
    expect((await put(ticket.url, noLength, data.subarray(1))).ok).toBe(false);
    expect(await store.head(key)).toBeNull();

    const good = await put(ticket.url, ticket.headers, data);
    expect(good.status).toBe(200);
    expect((await store.head(key))?.sha256).toBe(sha(data));

    // Keys are content-addressed: a retried upload rewrites identical bytes.
    const retry = await put(ticket.url, ticket.headers, data);
    expect(retry.status).toBe(200);
    expect((await store.head(key))?.sha256).toBe(sha(data));

    const download = await store.presignDownload(key, 300);
    const res = await fetch(download);
    expect(res.status).toBe(200);
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), data)).toBe(0);
  });
});
