import type { Artifact, ArtifactPin } from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { ApiError, notFound } from "../errors.js";
import { log } from "../telemetry/log.js";
import type { ArtifactRecord } from "../store/types.js";

/**
 * The artifact registry's write side: deleting a release and pinning it.
 * A pin (Gradiated Cloud publishing a model version, say) makes a release
 * undeletable: grad_artifact_pins references it ON DELETE RESTRICT, so no
 * path removes its row, and the orphaned-blob sweep keeps every object a row
 * references.
 */
export interface ArtifactService {
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

export const createArtifactService = (
  deps: AppDependencies,
): ArtifactService => {
  const { store, storage } = deps;

  const load = async (
    workspaceId: string,
    reference: string,
  ): Promise<ArtifactRecord> => {
    const artifact = await store.artifacts.get(workspaceId, reference);
    if (!artifact) throw notFound("artifact", reference);

    return artifact;
  };

  return {
    delete: async (workspaceId, reference) => {
      const { id } = await load(workspaceId, reference);
      const result = await store.artifacts.deleteRelease(workspaceId, id);
      if (!result) throw notFound("artifact", reference);
      if (result.pins.length > 0) throw artifactPinned(id, result.pins);
      // Best effort: the orphaned-blob sweep deletes what this misses.
      if (result.orphanKey) {
        await storage.delete(result.orphanKey).catch((error: unknown) => {
          log("warn", "artifact blob delete failed", {
            artifact: id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    },

    pin: async (workspaceId, reference, holder, reason) => {
      const { id } = await load(workspaceId, reference);
      const pinned = await store.artifacts.pin({
        workspaceId,
        artifactId: id,
        holder,
        reason,
      });
      // Deleted between the read and the pin.
      if (!pinned) throw notFound("artifact", reference);

      return pinned;
    },

    unpin: async (workspaceId, reference, holder) => {
      const { id } = await load(workspaceId, reference);
      if (!(await store.artifacts.unpin(workspaceId, id, holder))) {
        throw notFound("artifact_pin", `${id} ${holder}`);
      }
    },
  };
};
