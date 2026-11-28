import { addSeconds } from "../clock.js";
import type { AppDependencies } from "../deps.js";
import { errorMessage } from "../errors.js";
import { log } from "../telemetry/log.js";
import type {
  WorkspaceStateName,
  WorkspaceStateRecord,
} from "../store/types.js";
import type { EvalService } from "./evals/service.js";
import type { RunLifecycle } from "./runs.js";

/**
 * Workspace lifecycle, driven by Gradiated Cloud's hooks (the internal
 * listener). Self-hosted servers never call it; a workspace without a state
 * row is active.
 *
 * - suspended: new jobs are refused (403 workspace_suspended); queued and
 *   running runs stop resumable (stopped_balance: queued ones now, running
 *   ones at their next heartbeat, after a checkpoint); open evals are
 *   cancelled; sources pause.
 * - active: jobs are accepted again; the sources the suspension paused resume
 *   (stopped runs stay stopped until resumed).
 * - deleted: like suspended, but runs are cancelled, and after
 *   GRAD_WORKSPACE_PURGE_DELAY_SECONDS the maintenance tick purges the
 *   workspace in bounded passes: sources, secrets, jobs (runs, evals,
 *   imports), datasets, every artifact no holder pins, and the workspace's
 *   `ws/<ws>/` and `artifacts/<ws>/` objects (pinned artifacts' bundles stay).
 *   The usage ledger is kept: it is the billing record.
 */
export interface WorkspaceLifecycle {
  get(workspaceId: string): Promise<WorkspaceStateRecord>;
  set(
    workspaceId: string,
    state: WorkspaceStateName,
  ): Promise<WorkspaceStateRecord>;
  /** One purge pass for a deleted workspace whose purge is due; returns 1 when one ran. */
  purgeDue(now: Date): Promise<number>;
}

/** Rows (per table) and objects (per prefix) one purge pass deletes. */
const PURGE_PAGE = 500;
/** A pass leases its workspace this long (another replica skips it). */
const PURGE_LEASE_SECONDS = 300;
/** Pinned artifacts or running jobs left: look again this much later. */
const PURGE_RETRY_SECONDS = 3600;

const activeRecord = (workspaceId: string): WorkspaceStateRecord => ({
  workspace_id: workspaceId,
  state: "active",
  purge_after: null,
  purged_at: null,
  last_error: null,
  updated_at: new Date(0).toISOString(),
});

export const createWorkspaceLifecycle = (
  deps: AppDependencies,
  services: { runs: RunLifecycle; evals: EvalService },
): WorkspaceLifecycle => {
  const { store, storage, clock } = deps;

  /** Stops the workspace's open work; `cancelRuns` for a delete. */
  const stopWork = async (workspaceId: string, cancelRuns: boolean) => {
    await store.workspaces.pauseSources(workspaceId);
    for (const job of await store.workspaces.openJobs(workspaceId, [
      "train",
      "eval",
    ])) {
      try {
        if (job.kind === "eval") {
          await services.evals.cancel(workspaceId, job.id);
        } else if (cancelRuns) {
          await services.runs.cancel(workspaceId, job.id);
        } else if (job.status === "queued") {
          await services.runs.stopForSuspension(job.id);
        }
        // A running run stops at its next heartbeat (stopped_balance).
      } catch (error) {
        log("warn", "could not stop a job of a suspended workspace", {
          workspace_id: workspaceId,
          job_id: job.id,
          error,
        });
      }
    }
  };

  /** One page of `prefix`'s objects deleted, except `keep`; returns how many were left to look at. */
  const sweepPrefix = async (
    prefix: string,
    keep: ReadonlySet<string>,
  ): Promise<number> => {
    // Listed without the trailing slash (object keys have no empty
    // segment), so keep only this workspace's keys, not `ws/<ws>x/`.
    // Kept (pinned) objects count against the page, so list past them: else
    // a workspace whose first PURGE_PAGE keys are all pinned never purges.
    const keys = await storage.listOlder(
      prefix.slice(0, -1),
      addSeconds(clock.now(), 86_400),
      PURGE_PAGE + keep.size,
    );
    const doomed = keys.filter((k) => k.startsWith(prefix) && !keep.has(k));
    for (const key of doomed) await storage.delete(key);

    return doomed.length;
  };

  return {
    get: async (workspaceId) =>
      (await store.workspaces.get(workspaceId)) ?? activeRecord(workspaceId),

    set: async (workspaceId, state) => {
      const delay = deps.settings.workspacePurgeDelaySeconds;
      const record = await store.workspaces.set(
        workspaceId,
        state,
        state === "deleted" ? addSeconds(clock.now(), delay) : null,
      );
      if (record.state === "active") {
        await store.workspaces.resumeSources(workspaceId);
      } else {
        await stopWork(workspaceId, record.state === "deleted");
      }
      log("info", "workspace state changed", {
        workspace_id: workspaceId,
        state: record.state,
      });

      return record;
    },

    purgeDue: async (now) => {
      const workspaceId = await store.workspaces.claimPurge(
        now,
        PURGE_LEASE_SECONDS,
      );
      if (!workspaceId) return 0;
      try {
        await stopWork(workspaceId, true);
        const pass = await store.workspaces.purgeRows(workspaceId, PURGE_PAGE);
        const keep = new Set(pass.keepKeys);
        const objects =
          (await sweepPrefix(`ws/${workspaceId}/`, keep)) +
          (await sweepPrefix(`artifacts/${workspaceId}/`, keep));
        const more = pass.remainingRows > 0 || objects > 0;
        const blocked = pass.runningJobs > 0 || pass.pinnedArtifacts > 0;
        await store.workspaces.finishPurge(workspaceId, {
          done: !more && !blocked,
          // More to delete: next tick. Only pinned or running left: hourly.
          nextAt: more ? now : addSeconds(now, PURGE_RETRY_SECONDS),
          error: blocked
            ? `waiting for ${pass.runningJobs} running jobs and ${pass.pinnedArtifacts} pinned artifacts`
            : null,
          now,
        });
        log("info", "workspace purge pass", {
          workspace_id: workspaceId,
          rows: pass.deletedRows,
          objects,
          running_jobs: pass.runningJobs,
          pinned_artifacts: pass.pinnedArtifacts,
          done: !more && !blocked,
        });
      } catch (error) {
        await store.workspaces.finishPurge(workspaceId, {
          done: false,
          nextAt: addSeconds(now, 60),
          error: errorMessage(error),
          now,
        });
        throw error;
      }

      return 1;
    },
  };
};
