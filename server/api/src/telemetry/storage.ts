import {
  ObjectExistsError,
  ObjectNotFoundError,
  type ObjectStore,
} from "../storage/types.js";
import { metrics, secondsSince } from "./metrics.js";
import { SpanKind, withSpan } from "./tracing.js";

const OPS = [
  "put",
  "putStream",
  "get",
  "getStream",
  "head",
  "listOlder",
  "delete",
  "copy",
  "presignUpload",
  "presignDownload",
] as const;

/** A missing or existing object is an answer, not a storage failure. */
const isExpected = (error: unknown): boolean =>
  error instanceof ObjectNotFoundError || error instanceof ObjectExistsError;

/**
 * Wraps an object store so every call observes
 * grad_storage_operation_duration_seconds, counts unexpected failures, and
 * (with tracing on) runs in a `storage.<op>` span.
 */
export const instrumentObjectStore = (store: ObjectStore): ObjectStore => {
  const wrapped: Record<string, unknown> = {};

  for (const op of OPS) {
    wrapped[op] = async (...args: unknown[]) => {
      const start = performance.now();
      try {
        return await withSpan(
          `storage.${op}`,
          { "grad.storage.op": op },
          () =>
            (store[op] as (...a: unknown[]) => Promise<unknown>).apply(
              store,
              args,
            ),
          { kind: SpanKind.CLIENT },
        );
      } catch (error) {
        if (!isExpected(error)) metrics.storageErrors.inc({ op });
        throw error;
      } finally {
        metrics.storageDuration.observe({ op }, secondsSince(start));
      }
    };
  }

  return wrapped as unknown as ObjectStore;
};
