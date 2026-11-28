import type { Artifact, Checkpoint } from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { conflict, notFound } from "../errors.js";
import { ObjectNotFoundError } from "../storage/types.js";
import type {
  CheckpointRecord,
  Page,
  PageRequest,
  RunRecord,
} from "../store/types.js";
import { holdBlob, toPublicArtifact } from "./artifacts.js";
import { artifactKey } from "./uploads.js";

/**
 * A run's checkpoints: retention while it trains, the best and final ones
 * pinned when it ends, listing, promotion to a release, and the sweep of
 * expired ones. Registering one is part of the worker protocol (runs.ts).
 */
export interface CheckpointService {
  list(
    workspaceId: string,
    runId: string,
    page: PageRequest,
  ): Promise<Page<Checkpoint>>;
  /** A copy of the checkpoint as a release named `name` (default: the run's). */
  promote(
    workspaceId: string,
    checkpointId: string,
    name?: string,
  ): Promise<Artifact>;
  /**
   * As each checkpoint registers: the run keeps its last CHECKPOINTS_KEPT
   * plus the best by eval so far; the others expire now (kept ones expire
   * after checkpoint_ttl_days unless pinned at the end).
   */
  applyRetention(run: RunRecord, now: Date): Promise<void>;
  /** At a run's end: its best checkpoint (by eval) and its final one never expire. */
  pinBestAndFinal(run: RunRecord, now: Date): Promise<void>;
  /** Deletes expired checkpoints and their blobs (100 a pass). */
  collectExpired(now: Date): Promise<number>;
}

/** Retention: the last N checkpoints of a run stay, plus the best and final ones. */
const CHECKPOINTS_KEPT = 3;

/**
 * The best checkpoint by eval score, in the direction of the run's metric
 * (`metadata.metric_mode`: eval_loss is "min", accuracy-style metrics "max").
 * Ties go to the later checkpoint, like the trainer's select="best".
 */
const bestCheckpoint = (
  checkpoints: readonly CheckpointRecord[],
): CheckpointRecord | null =>
  checkpoints.reduce<CheckpointRecord | null>((acc, c) => {
    if (c.eval_score === null) return acc;
    if (acc === null || acc.eval_score === null) return c;
    // The trainer stores the selection metric's direction with it: minimised
    // (eval_loss, eval_kl) or maximised (accuracy, recall@10).
    const lower = metricMode(c.metadata) === "min";

    return (
      lower ? c.eval_score <= acc.eval_score : c.eval_score >= acc.eval_score
    )
      ? c
      : acc;
  }, null);

export const toPublicCheckpoint = ({
  storage_key: _key,
  ...checkpoint
}: CheckpointRecord): Checkpoint => checkpoint;

/** Losses are minimised; a checkpoint without metric_mode falls back on its metric name. */
const MINIMISED_METRICS = new Set(["eval_loss", "eval_kl", "loss"]);

const metricMode = (metadata: Record<string, unknown>): "min" | "max" => {
  const mode = metadata["metric_mode"];
  if (mode === "min" || mode === "max") return mode;
  const name = metadata["metric_name"];

  return typeof name === "string" && MINIMISED_METRICS.has(name)
    ? "min"
    : "max";
};

export const createCheckpointService = (
  deps: AppDependencies,
): CheckpointService => {
  const { store, storage, clock } = deps;

  const loadRun = async (
    workspaceId: string,
    id: string,
  ): Promise<RunRecord> => {
    const run = await store.runs.get(workspaceId, id);
    if (!run) throw notFound("run", id);

    return run;
  };

  const applyRetention = async (run: RunRecord, now: Date): Promise<void> => {
    const all = await store.artifacts.allCheckpoints(run.id, now);
    const keep = new Set(all.slice(-CHECKPOINTS_KEPT).map((c) => c.id));
    const best = bestCheckpoint(all);
    if (best) keep.add(best.id);
    await store.artifacts.expireCheckpoints(
      run.id,
      all.filter((c) => !keep.has(c.id)).map((c) => c.id),
      now,
    );
  };

  const pinBestAndFinal = async (run: RunRecord, now: Date): Promise<void> => {
    const all = await store.artifacts.allCheckpoints(run.id, now);
    if (all.length === 0) return;

    // Ordered by (step, attempt): the final one is last.
    const final = all.at(-1) as CheckpointRecord;
    await store.artifacts.pinCheckpoints(run.id, {
      bestId: bestCheckpoint(all)?.id ?? null,
      finalId: final.id,
    });
  };

  return {
    applyRetention,
    pinBestAndFinal,

    list: async (workspaceId, runId, page) => {
      await loadRun(workspaceId, runId);
      const result = await store.artifacts.listCheckpoints(
        workspaceId,
        runId,
        page,
        clock.now(),
      );

      return {
        data: result.data.map(toPublicCheckpoint),
        next_cursor: result.next_cursor,
      };
    },

    promote: async (workspaceId, checkpointId, name) => {
      const checkpoint = await store.artifacts.getCheckpoint(
        workspaceId,
        checkpointId,
      );
      const now = clock.now();
      if (
        !checkpoint ||
        (checkpoint.expires_at !== null &&
          Date.parse(checkpoint.expires_at) <= now.getTime())
      ) {
        throw notFound("checkpoint", checkpointId);
      }
      const { format } = checkpoint;
      if (format === null) {
        throw conflict(
          "checkpoint_not_exportable",
          `Checkpoint '${checkpointId}' holds training state only (the recipe did not export it as an artifact); promote the run's final artifact or a checkpoint with a format.`,
        );
      }

      const run = await loadRun(workspaceId, checkpoint.run_id);
      const releaseName = name ?? run.name;
      // Checkpoints are never servable: the release gets its own copy under
      // the content-addressed artifacts/ prefix. Natural key (checkpoint,
      // name): promoting twice returns the first release.
      const storageKey = artifactKey(workspaceId, checkpoint.sha256);
      // Its blob expired (retention) between the read and the copy: gone.
      const copy = () =>
        storage
          .copy(checkpoint.storage_key, storageKey)
          .catch((error: unknown) => {
            if (error instanceof ObjectNotFoundError) {
              throw notFound("checkpoint", checkpointId);
            }
            throw error;
          });
      await copy();
      const artifact = await store.transaction(async () => {
        // A delete of another release on this bundle removed it since the copy.
        if (!(await holdBlob(deps, storageKey))) await copy();

        return store.artifacts.createRelease({
          workspaceId,
          name: releaseName,
          runId: run.id,
          sourceId: checkpoint.id,
          baseModel: run.resolved_config.model,
          recipeKind: run.recipe_kind,
          format,
          storageKey,
          sha256: checkpoint.sha256,
          sizeBytes: checkpoint.size_bytes,
          manifest: {
            ...checkpoint.metadata,
            schema: "grad.artifact/1",
            run_id: run.id,
            provenance: { source: "run", run_id: run.id },
            promoted_from_checkpoint: checkpoint.id,
            step: checkpoint.step,
            attempt: checkpoint.attempt,
            resolved_config: run.resolved_config,
          },
          evalReport: null,
        });
      });

      return toPublicArtifact(artifact);
    },

    collectExpired: async (now) => {
      const keys = await store.artifacts.deleteExpiredCheckpoints(now, 100);
      for (const key of keys) await storage.delete(key);

      return keys.length;
    },
  };
};
