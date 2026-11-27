import type { Repositories, RunPatch, RunRecord } from "../store/types.js";

/**
 * Queued runs can wait on a gate (`waiting_on`): a dependency run (chained
 * runs) or a labeling eval (router rubrics). These helpers open a gate or
 * cancel everything behind it, transitively.
 */

/** Starts the runs waiting on `gateId`, applying `patch` to each. */
export const releaseWaiting = async (
  repos: Pick<Repositories, "runs">,
  gateId: string,
  now: string,
  patch: (run: RunRecord) => RunPatch = () => ({}),
): Promise<void> => {
  for (const run of await repos.runs.listWaitingOn(gateId)) {
    await repos.runs.update(
      run.id,
      { ...patch(run), waiting_on: null, updated_at: now },
      { status: ["queued"] },
    );
  }
};

/** Cancels the runs waiting on `gateId`, and the runs waiting on those. */
export const cancelWaiting = async (
  repos: Pick<Repositories, "runs">,
  gateId: string,
  now: string,
  reason: string,
): Promise<void> => {
  for (const run of await repos.runs.listWaitingOn(gateId)) {
    const cancelled = await repos.runs.update(
      run.id,
      {
        status: "cancelled",
        waiting_on: null,
        finished_at: now,
        updated_at: now,
        error: reason,
      },
      { status: ["queued"] },
    );
    if (cancelled) {
      await cancelWaiting(
        repos,
        cancelled.id,
        now,
        `Cancelled because dependency run '${cancelled.id}' ended cancelled.`,
      );
    }
  }
};
