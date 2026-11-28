import type { Artifact, ArtifactPin } from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { ApiError, notFound } from "../errors.js";
import { log } from "../telemetry/log.js";
import type { ArtifactRecord } from "../store/types.js";

/**
 * The artifact registry: reading a release, deleting it and pinning it.
 * A pin (Gradiated Cloud publishing a model version, say) makes a release
 * undeletable: grad_artifact_pins references it ON DELETE RESTRICT, so no
 * path removes its row, and the orphaned-blob sweep keeps every object a row
 * references.
 */
export interface ArtifactService {
  /** A release (or checkpoint) by id or `name@version|latest`, else 404. */
  get(workspaceId: string, reference: string): Promise<ArtifactRecord>;
  /** 409 `artifact_pinned` (naming the holders) while it is pinned. */
  delete(workspaceId: string, reference: string): Promise<void>;
  pin(
    workspaceId: string,
    reference: string,
    holder: string,
    reason: string,
  ): Promise<{ pin: ArtifactPin; created: boolean }>;
  unpin(workspaceId: string, reference: string, holder: string): Promise<void>;
}

export const toPublicArtifact = ({
  storage_key: _key,
  ...artifact
}: ArtifactRecord): Artifact => artifact;

const describePins = (pins: readonly ArtifactPin[]): string =>
  pins.map((p) => `${p.holder} (${p.reason})`).join(", ");

export const artifactPinned = (
  id: string,
  pins: readonly ArtifactPin[],
): ApiError =>
  new ApiError(
    409,
    "artifact_pinned",
    "Artifact is pinned",
    `Artifact '${id}' is pinned by ${describePins(pins)}, so it can't be deleted. Unpublish it there first (that removes the pin).`,
  );

/**
 * Call inside the transaction that inserts a row referencing the blob `key`
 * (a release): holds it against deletes until that transaction ends, and
 * says whether the object is there. Checking before taking the lock could
 * pass just as a delete removes it.
 */
export const holdBlob = async (
  deps: Pick<AppDependencies, "store" | "storage">,
  key: string,
): Promise<boolean> => {
  await deps.store.artifacts.lockBlob(key, "shared");

  return (await deps.storage.head(key)) !== null;
};

/**
 * Deletes the blob `key` unless a row references it, under the blob lock (a
 * release created on it meanwhile keeps it). Returns whether it was deleted.
 */
export const deleteUnreferencedBlob = (
  deps: Pick<AppDependencies, "store" | "storage">,
  key: string,
): Promise<boolean> =>
  deps.store.transaction(async () => {
    await deps.store.artifacts.lockBlob(key, "exclusive");
    if ((await deps.store.unreferencedKeys([key])).length === 0) return false;
    await deps.storage.delete(key);

    return true;
  });

/** Postgres foreign_key_violation: the row a pin names was deleted meanwhile. */
const isForeignKeyViolation = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "23503";

export const createArtifactService = (
  deps: AppDependencies,
): ArtifactService => {
  const { store, storage } = deps;

  const get = async (
    workspaceId: string,
    reference: string,
  ): Promise<ArtifactRecord> => {
    const artifact = await store.artifacts.get(workspaceId, reference);
    if (!artifact) throw notFound("artifact", reference);

    return artifact;
  };

  return {
    get,

    delete: async (workspaceId, reference) => {
      const { id } = await get(workspaceId, reference);
      await store.transaction(async () => {
        const result = await store.artifacts.deleteRelease(workspaceId, id);
        if (!result) throw notFound("artifact", reference);
        if (result.pins.length > 0) throw artifactPinned(id, result.pins);
        // Under the blob lock, before the commit: a release created on the
        // same bundle meanwhile waits and then finds it gone (and copies or
        // uploads it again). Best effort: the orphaned-blob sweep deletes
        // what this misses.
        if (result.orphanKey) {
          await storage.delete(result.orphanKey).catch((error: unknown) => {
            log("warn", "artifact blob delete failed", {
              artifact: id,
              error,
            });
          });
        }
      });
    },

    pin: async (workspaceId, reference, holder, reason) => {
      const { id } = await get(workspaceId, reference);
      const pinned = await store.artifacts
        .pin({ workspaceId, artifactId: id, holder, reason })
        .catch((error: unknown) => {
          if (isForeignKeyViolation(error)) return null;
          throw error;
        });
      // Deleted between the read and the pin.
      if (!pinned) throw notFound("artifact", reference);

      return pinned;
    },

    unpin: async (workspaceId, reference, holder) => {
      const { id } = await get(workspaceId, reference);
      if (!(await store.artifacts.unpin(workspaceId, id, holder))) {
        throw notFound("artifact_pin", `${id} ${holder}`);
      }
    },
  };
};
