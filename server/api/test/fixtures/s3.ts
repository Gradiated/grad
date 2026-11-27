import { randomBytes } from "node:crypto";
import { inject } from "vitest";

import { S3ObjectStore } from "../../src/storage/s3.js";
import type { ObjectStore } from "../../src/storage/types.js";
import type { S3TestTarget } from "./docker-seaweedfs.js";

export type { S3TestTarget };

/** The run's SeaweedFS (fixtures/s3-global.ts). */
export const s3Target = (): S3TestTarget => inject("s3Target");

export const s3Store = (target = s3Target()): S3ObjectStore =>
  new S3ObjectStore({
    bucket: target.bucket,
    region: target.region,
    endpoint: target.endpoint,
    credentials: {
      accessKeyId: target.accessKeyId,
      secretAccessKey: target.secretAccessKey,
    },
  });

/**
 * `store` with every key under `prefix/`, so test apps sharing the run's
 * bucket never see each other's objects (staging sweeps count only their own).
 */
export const prefixedStore = (
  store: ObjectStore,
  prefix: string,
): ObjectStore => {
  const k = (key: string): string => `${prefix}/${key}`;

  return {
    put: async (key, data) => ({ ...(await store.put(k(key), data)), key }),
    putStream: async (key, body, options) => ({
      ...(await store.putStream(k(key), body, options)),
      key,
    }),
    get: (key) => store.get(k(key)),
    getStream: (key) => store.getStream(k(key)),
    head: (key) => store.head(k(key)),
    listOlder: async (key, before, limit, after) =>
      (
        await store.listOlder(
          k(key),
          before,
          limit,
          after === undefined ? undefined : k(after),
        )
      ).map((full) => full.slice(prefix.length + 1)),
    delete: (key) => store.delete(k(key)),
    copy: (from, to) => store.copy(k(from), k(to)),
    presignUpload: (key, input) => store.presignUpload(k(key), input),
    presignDownload: (key, seconds) => store.presignDownload(k(key), seconds),
  };
};

/** A fresh, isolated S3 store for one test app (and its close). */
export const testObjectStore = (): {
  storage: ObjectStore;
  close: () => void;
} => {
  const store = s3Store();

  return {
    storage: prefixedStore(store, `t-${randomBytes(6).toString("hex")}`),
    close: () => store.close(),
  };
};
