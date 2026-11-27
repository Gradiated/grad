import type { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { S3ObjectStore } from "../src/storage/s3.js";
import {
  ObjectExistsError,
  ObjectIntegrityError,
  ObjectNotFoundError,
} from "../src/storage/types.js";

const awsError = (name: string, status?: number): Error =>
  Object.assign(new Error(name), {
    name,
    ...(status ? { $metadata: { httpStatusCode: status } } : {}),
  });

/** S3ObjectStore over a scripted client: error mapping without a live backend. */
const storeWith = (
  send: (command: { constructor: { name: string }; input: unknown }) => unknown,
): S3ObjectStore =>
  new S3ObjectStore({
    bucket: "b",
    client: {
      send: async (command: never) => send(command),
      destroy: () => undefined,
    } as unknown as S3Client,
  });

const body = async function* () {
  yield Buffer.from("abc");
};

describe("S3ObjectStore error mapping", () => {
  it("maps conditional-write conflicts to ObjectExistsError", async () => {
    for (const error of [
      awsError("PreconditionFailed"),
      awsError("Whatever", 412),
      awsError("ConditionalRequestConflict", 409),
    ]) {
      const store = storeWith(() => {
        throw error;
      });
      await expect(store.put("k", Buffer.from("x"))).rejects.toBeInstanceOf(
        ObjectExistsError,
      );
    }
  });

  it("maps checksum rejections to ObjectIntegrityError and rethrows others", async () => {
    const bad = storeWith(() => {
      throw awsError("BadDigest", 400);
    });
    await expect(bad.put("k", Buffer.from("x"))).rejects.toBeInstanceOf(
      ObjectIntegrityError,
    );

    const down = storeWith(() => {
      throw awsError("ServiceUnavailable", 503);
    });
    await expect(down.put("k", Buffer.from("x"))).rejects.toThrow(
      "ServiceUnavailable",
    );
    await expect(down.get("k")).rejects.toThrow("ServiceUnavailable");
    await expect(down.head("k")).rejects.toThrow("ServiceUnavailable");
  });

  it("maps missing objects and empty bodies to ObjectNotFoundError", async () => {
    const missing = storeWith(() => {
      throw awsError("NoSuchKey", 404);
    });
    await expect(missing.get("k")).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(missing.getStream("k")).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
    expect(await missing.head("k")).toBeNull();

    const empty = storeWith(() => ({}));
    await expect(empty.get("k")).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("returns a null sha when the backend stores no checksum", async () => {
    const store = storeWith(() => ({ ContentLength: 3 }));

    expect(await store.head("k")).toEqual({ sizeBytes: 3, sha256: null });
  });

  it("refuses to copy over an existing destination", async () => {
    const commands: string[] = [];
    const store = storeWith((command) => {
      commands.push(command.constructor.name);
      return { ContentLength: 1 };
    });

    await expect(store.copy("a", "b")).rejects.toBeInstanceOf(
      ObjectExistsError,
    );
    expect(commands).toEqual(["HeadObjectCommand"]);
  });

  it("maps copy failures", async () => {
    const run = (error: Error) =>
      storeWith((command) => {
        if (command.constructor.name === "HeadObjectCommand") {
          throw awsError("NotFound", 404);
        }
        throw error;
      });

    await expect(
      run(awsError("NoSuchKey", 404)).copy("a", "b"),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(
      run(awsError("PreconditionFailed", 412)).copy("a", "b"),
    ).rejects.toBeInstanceOf(ObjectExistsError);
    await expect(
      run(awsError("AccessDenied", 403)).copy("a", "b"),
    ).rejects.toThrow("AccessDenied");
  });

  it("rejects a declared size above maxBytes before sending anything", async () => {
    const store = storeWith(() => {
      throw new Error("must not be called");
    });

    await expect(
      store.putStream("k", body(), {
        maxBytes: 2,
        expectedSizeBytes: 3,
        expectedSha256: "0".repeat(64),
      }),
    ).rejects.toBeInstanceOf(ObjectIntegrityError);
  });

  it("sends deletes for valid keys", async () => {
    const sent: unknown[] = [];
    const store = storeWith((command) => {
      sent.push(command.input);
      return {};
    });
    await store.delete("a/b");

    expect(sent).toEqual([{ Bucket: "b", Key: "a/b" }]);
  });
});
