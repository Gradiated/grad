import { createHash, randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import { S3ObjectStore } from "../src/storage/s3.js";
import {
  attachmentDisposition,
  ObjectExistsError,
  ObjectIntegrityError,
  ObjectNotFoundError,
  validateObjectKey,
  type ObjectStore,
} from "../src/storage/types.js";
import { s3Store, s3Target } from "./fixtures/s3.js";

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

/**
 * The ObjectStore contract against the run's SeaweedFS, the store `grad local
 * up`, the harness and CI use. It also passed on MinIO (its CI backend until
 * 0.2.0-alpha.3); AWS S3 documents the same checks.
 */
describe("ObjectStore contract: S3 (SeaweedFS)", () => {
  const store = s3Store();
  afterAll(() => store.close());

  it("round-trips bytes and reports sha256/size", async () => {
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

  it("reports head size and sha256", async () => {
    const key = uniqueKey("head.bin");
    const data = Buffer.from("head me");
    await store.put(key, data);
    const head = await store.head(key);

    expect(head?.sizeBytes).toBe(data.byteLength);
    expect(head?.sha256).toBe(sha(data));
    expect(await store.head(uniqueKey("missing.bin"))).toBeNull();
  });

  it("copies server-side with a full-object SHA-256 checksum, leaving an existing target alone", async () => {
    const from = uniqueKey("copy-src.bin");
    const to = uniqueKey("copy-dst.bin");
    const data = randomBytes(4096);
    await store.put(from, data);
    await store.copy(from, to);

    expect(await store.head(to)).toEqual({
      sizeBytes: data.byteLength,
      sha256: sha(data),
    });
    expect(Buffer.compare(Buffer.from(await store.get(to)), data)).toBe(0);
    await store.copy(from, to); // content-addressed: a repeat is a no-op
    await expect(
      store.copy(uniqueKey("missing.bin"), uniqueKey("x.bin")),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("lists keys under a prefix older than a cutoff", async () => {
    const prefix = uniqueKey("sweep");
    await store.put(`${prefix}/a/one.bin`, Buffer.from("1"));
    await store.put(`${prefix}/two.bin`, Buffer.from("2"));
    await store.put(uniqueKey("elsewhere.bin"), Buffer.from("3"));
    const future = new Date(Date.now() + 60_000);

    expect((await store.listOlder(prefix, future, 10)).sort()).toEqual([
      `${prefix}/a/one.bin`,
      `${prefix}/two.bin`,
    ]);
    // Pages in key order after a cursor. The cursor is always a key a page
    // returned: SeaweedFS skips a whole "directory" when StartAfter names
    // one (`${prefix}/a`), which AWS S3 does not.
    const first = await store.listOlder(prefix, future, 1);
    expect(first).toEqual([`${prefix}/a/one.bin`]);
    expect(await store.listOlder(prefix, future, 5, first[0])).toEqual([
      `${prefix}/two.bin`,
    ]);
    expect(await store.listOlder(prefix, new Date(0), 10)).toEqual([]);
    expect(await store.listOlder(uniqueKey("empty"), future, 10)).toEqual([]);
  });

  it("deletes idempotently", async () => {
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

describe("validateObjectKey", () => {
  it("accepts clean relative keys and rejects overlong ones", () => {
    expect(validateObjectKey("datasets/ws1/support/records.jsonl")).toBe(
      "datasets/ws1/support/records.jsonl",
    );
    expect(() => validateObjectKey("a".repeat(1025))).toThrow();
  });
});

describe("S3ObjectStore presigned URLs (SeaweedFS)", () => {
  const store = s3Store();
  afterAll(() => store.close());

  const put = (url: string, headers: Record<string, string>, body: Buffer) =>
    fetch(url, { method: "PUT", headers, body: new Uint8Array(body) });

  it("binds Content-Length and x-amz-checksum-sha256: only the declared bytes are accepted", async () => {
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
    expect(res.headers.get("content-disposition")).toBeNull();

    // A browser download is saved under the bundle's name, not the storage key.
    const named = await fetch(
      await store.presignDownload(key, 300, {
        filename: "support-router-2026-11-27-1.grad.tar.gz",
      }),
    );
    expect(named.status).toBe(200);
    expect(named.headers.get("content-disposition")).toBe(
      "attachment; filename=\"support-router-2026-11-27-1.grad.tar.gz\"; filename*=UTF-8''support-router-2026-11-27-1.grad.tar.gz",
    );
    await named.arrayBuffer();
  });

  it("quotes a download filename safely", () => {
    expect(attachmentDisposition('a"b\\c\nd é.tgz')).toBe(
      "attachment; filename=\"a_b_c_d _.tgz\"; filename*=UTF-8''a%22b%5Cc%0Ad%20%C3%A9.tgz",
    );
  });

  it("expires presigned downloads", async () => {
    const key = uniqueKey("expiring.bin");
    await store.put(key, Buffer.from("soon gone"));
    const url = await store.presignDownload(key, 1);
    expect((await fetch(url)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 2_100));
    expect((await fetch(url)).status).toBe(403);
  });

  it("signs client upload tickets for the public endpoint only", async () => {
    const target = s3Target();
    const split = new S3ObjectStore({
      bucket: target.bucket,
      region: target.region,
      endpoint: target.endpoint,
      publicEndpoint: "http://s3.example.test:9999",
      credentials: {
        accessKeyId: target.accessKeyId,
        secretAccessKey: target.secretAccessKey,
      },
    });
    const input = {
      sha256: "0".repeat(64),
      sizeBytes: 1,
      expiresInSeconds: 60,
    };
    try {
      expect(
        (await split.presignUpload("a/b", { ...input, forClient: true })).url,
      ).toMatch(/^http:\/\/s3\.example\.test:9999\/grad-test\/a\/b\?/);
      expect((await split.presignUpload("a/b", input)).url).toMatch(
        new RegExp(`^${target.endpoint}/`),
      );
      expect(await split.presignDownload("a/b", 60)).toMatch(
        new RegExp(`^${target.endpoint}/`),
      );
    } finally {
      split.close();
    }
  });
});
