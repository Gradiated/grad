import { useMemo, useState } from "react";

import type { Run } from "@sdk/generated/models.js";

import { IconSearch } from "../components/icons.js";
import { Empty, ErrorBanner, Segmented, SkeletonRows, StatusBadge } from "../components/ui.js";
import { errorMessage, isTerminalRun, lifecycleOf, useApi } from "../lib/api.js";
import { PHASE_LABEL } from "../lib/events.js";
import { ago, usd } from "../lib/format.js";
import { useNow, useResource } from "../lib/hooks.js";
import { navigate, setQuery, useLocation } from "../lib/router.js";

export type StatusFilter = "all" | "active" | "completed" | "failed" | "stopped";

const FILTERS: Record<StatusFilter, (r: Run) => boolean> = {
  all: () => true,
  active: (r) => !isTerminalRun(r),
  completed: (r) => r.status === "completed",
  failed: (r) => r.status === "failed",
  stopped: (r) => r.status === "cancelled" || r.status === "stopped_budget",
};

export const filterRuns = (runs: Run[], status: StatusFilter, q: string): Run[] => {
  const needle = q.trim().toLowerCase();
  return runs.filter(
    (r) =>
      FILTERS[status](r) &&
      (!needle || r.name.toLowerCase().includes(needle) || r.id.toLowerCase().includes(needle) || r.datasetName.toLowerCase().includes(needle) || r.resolvedConfig.model.toLowerCase().includes(needle)),
  );
};

const PAGE = 100;

export const RunsPage = () => {
  const { client } = useApi();
  const { query } = useLocation();
  const status = (query.get("status") as StatusFilter | null) ?? "all";
  const q = query.get("q") ?? "";
  const now = useNow();
  const [older, setOlder] = useState<{ runs: Run[]; cursor: string | null }>({ runs: [], cursor: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);

  const first = useResource((signal) => client.listRuns({ limit: PAGE }, { signal }), [], {
    pollMs: (page) => (page?.data.some((r) => !isTerminalRun(r)) ? 3000 : 10_000),
  });

  const runs = useMemo(() => {
    const head = first.data?.data ?? [];
    const seen = new Set(head.map((r) => r.id));
    return [...head, ...older.runs.filter((r) => !seen.has(r.id))];
  }, [first.data, older.runs]);
  const nextCursor = older.cursor ?? (older.runs.length === 0 ? (first.data?.nextCursor ?? null) : null);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await client.listRuns({ limit: PAGE, cursor: nextCursor });
      setOlder((o) => ({ runs: [...o.runs, ...page.data], cursor: page.nextCursor }));
    } catch (e) {
      setMoreError(e);
    } finally {
      setLoadingMore(false);
    }
  };

  const shown = filterRuns(runs, status, q);
  const counts = Object.fromEntries((Object.keys(FILTERS) as StatusFilter[]).map((k) => [k, filterRuns(runs, k, q).length])) as Record<StatusFilter, number>;
  const loading = first.loading && !first.data;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Runs</h1>
          <div className="page-sub">Training runs in this workspace, newest first.</div>
        </div>
      </div>

      <div className="toolbar">
        <Segmented
          label="Status"
          value={status}
          onChange={(v) => setQuery({ status: v === "all" ? undefined : v })}
          options={[
            { value: "all", label: "All", count: counts.all },
            { value: "active", label: "Active", count: counts.active },
            { value: "completed", label: "Completed", count: counts.completed },
            { value: "failed", label: "Failed", count: counts.failed },
            { value: "stopped", label: "Stopped", count: counts.stopped },
          ]}
        />
        <div className="grow" />
        <label className="search">
          <IconSearch />
          <input className="input" type="search" placeholder="Filter by name, model, dataset" aria-label="Filter runs" value={q} onChange={(e) => setQuery({ q: e.target.value })} />
        </label>
      </div>

      <ErrorBanner error={first.error && !first.data ? first.error : null} />

      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Status</th>
                <th>Phase</th>
                <th>Recipe</th>
                <th>Model</th>
                <th>Dataset</th>
                <th className="right">Cost</th>
                <th className="right">Created</th>
              </tr>
            </thead>
            <tbody>
              {loading && <SkeletonRows cols={8} />}
              {shown.map((r) => (
                <RunRow key={r.id} run={r} now={now} />
              ))}
            </tbody>
          </table>
        </div>
        {!loading && shown.length === 0 && (
          <Empty title={runs.length === 0 ? "No runs yet" : "No runs match"}>
            {runs.length === 0 ? (
              <>
                Start one with <code>grad train</code> or <code>client.runs.create(...)</code>.
              </>
            ) : (
              "Try another status or filter."
            )}
          </Empty>
        )}
        {nextCursor && (
          <div className="table-foot">
            <button type="button" className="btn sm" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore && <span className="spinner" />}
              Load older runs
            </button>
            {moreError ? <span className="muted">{errorMessage(moreError)}</span> : null}
          </div>
        )}
      </div>
    </div>
  );
};

const RunRow = ({ run, now }: { run: Run; now: number }) => {
  const life = lifecycleOf(run);
  const active = !isTerminalRun(run);
  const progress = run.totalSteps > 0 ? run.currentStep / run.totalSteps : 0;
  const phase = life.phase ? (PHASE_LABEL[life.phase] ?? life.phase) : active ? (run.status === "queued" ? "Queued" : run.currentStep > 0 ? "Training" : "Starting") : null;
  const open = () => navigate(`/runs/${encodeURIComponent(run.id)}`);
  return (
    <tr className="clickable" onClick={open} onKeyDown={(e) => e.key === "Enter" && open()} tabIndex={0}>
      <td>
        <div className="cell-main">
          <span className="title">{run.name}</span>
          <span className="sub">{run.id}</span>
        </div>
      </td>
      <td>
        <StatusBadge status={run.status} />
      </td>
      <td>
        {active ? (
          <div style={{ display: "grid", gap: 4, minWidth: 120 }}>
            <span>{phase}</span>
            {run.status === "running" && run.totalSteps > 0 && (
              <div className="progress slim" title={`${run.currentStep} / ${run.totalSteps} steps`}>
                <span style={{ width: `${(progress * 100).toFixed(1)}%` }} />
              </div>
            )}
          </div>
        ) : (
          <span className="faint">{phase ?? "—"}</span>
        )}
      </td>
      <td>
        <span className="chip">{run.recipeKind}</span>
      </td>
      <td className="mono" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }} title={run.resolvedConfig.model}>
        {run.resolvedConfig.model}
      </td>
      <td>
        {run.datasetName}
        <span className="faint"> v{run.datasetVersion}</span>
      </td>
      <td className="right num">
        {usd(run.costUsd)}
        {run.maxCostUsd !== null && <span className="faint"> / {usd(run.maxCostUsd)}</span>}
      </td>
      <td className="right muted" title={run.createdAt}>
        {ago(run.createdAt, now)}
      </td>
    </tr>
  );
};
