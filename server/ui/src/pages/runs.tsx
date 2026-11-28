import type { Run } from "@sdk/generated/models.js";

import { IconRuns, IconSearch } from "../components/icons.js";
import { Empty, ErrorBanner, LoadMore, RowTitle, rowLink, SearchBox, Segmented, SkeletonRows, StatusBadge } from "../components/ui.js";
import { isTerminalRun, lifecycleOf, useApi } from "../lib/api.js";
import { PHASE_LABEL } from "../lib/events.js";
import { ago, duration, usd } from "../lib/format.js";
import { useDebounced, useNow, usePagedList } from "../lib/hooks.js";
import { setQuery, useLocation } from "../lib/router.js";

export type StatusFilter = "all" | "active" | "completed" | "failed" | "stopped";

/** Each tab's statuses, filtered by the server so a tab is right past the first page. */
export const STATUS_QUERY: Record<StatusFilter, string | undefined> = {
  all: undefined,
  active: "queued,running",
  completed: "completed",
  failed: "failed",
  stopped: "cancelled,stopped_budget,stopped_balance",
};

const isFilter = (v: string | null): v is StatusFilter => v !== null && v in STATUS_QUERY;

const PAGE = 50;

export const RunsPage = () => {
  const { client } = useApi();
  const { query } = useLocation();
  const raw = query.get("status");
  const status: StatusFilter = isFilter(raw) ? raw : "all";
  const q = query.get("q") ?? "";
  const search = useDebounced(q.trim());
  const now = useNow();

  const list = usePagedList((cursor, signal) => client.listRuns({ limit: PAGE, cursor, status: STATUS_QUERY[status], q: search || undefined }, { signal }), [status, search], {
    pollMs: (page) => (page?.data.some((r) => !isTerminalRun(r)) ? 3000 : 10_000),
  });
  const filtered = status !== "all" || search !== "";

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
            { value: "all", label: "All" },
            { value: "active", label: "Active" },
            { value: "completed", label: "Completed" },
            { value: "failed", label: "Failed" },
            { value: "stopped", label: "Stopped" },
          ]}
        />
        <div className="grow" />
        <SearchBox value={q} onChange={(v) => setQuery({ q: v })} placeholder="Filter by name or id" label="Filter runs" />
      </div>

      <ErrorBanner error={list.error} onRetry={list.reload} stale={list.items.length > 0} />

      <div className="card">
        <div className="table-wrap" tabIndex={0}>
          <table className="table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Status</th>
                <th>Model and data</th>
                <th className="right">Cost</th>
                <th className="right">Created</th>
              </tr>
            </thead>
            <tbody aria-busy={list.loading}>
              {list.loading && <SkeletonRows cols={5} />}
              {list.items.map((r) => (
                <RunRow key={r.id} run={r} now={now} />
              ))}
            </tbody>
          </table>
        </div>
        {!list.loading && !list.error && list.items.length === 0 && (
          <Empty title={filtered ? "No runs match" : "No runs yet"} icon={filtered ? <IconSearch /> : <IconRuns />}>
            {filtered ? (
              "Try another status or filter."
            ) : (
              <>
                Start one with <code>grad train</code> or <code>client.runs.create(...)</code>.
              </>
            )}
          </Empty>
        )}
        <LoadMore list={list} label="Load older runs" />
      </div>
    </div>
  );
};

const RunRow = ({ run, now }: { run: Run; now: number }) => {
  const life = lifecycleOf(run);
  const active = !isTerminalRun(run);
  const progress = run.totalSteps > 0 ? run.currentStep / run.totalSteps : 0;
  const phase = life.phase ? (PHASE_LABEL[life.phase] ?? life.phase) : run.status === "queued" ? "Queued" : run.currentStep > 0 ? "Training" : "Starting";
  const href = `/runs/${encodeURIComponent(run.id)}`;
  return (
    <tr {...rowLink(href)}>
      <td>
        <div className="cell-main">
          <RowTitle href={href}>{run.name}</RowTitle>
          <span className="sub">{run.id}</span>
        </div>
      </td>
      <td className="cell-status">
        <div className="cell-stack">
          <StatusBadge status={run.status} />
          {run.status === "running" && run.totalSteps > 0 ? (
            <span className="bar-line small muted" title={`${run.currentStep} / ${run.totalSteps} steps`}>
              <span className="progress slim">
                <span style={{ width: `${(progress * 100).toFixed(1)}%` }} />
              </span>
              {phase} · {Math.floor(progress * 100)}%
            </span>
          ) : (
            <span className={`small ${active ? "muted" : "faint"}`}>{active ? phase : run.finishedAt ? `took ${duration(Date.parse(run.finishedAt) - Date.parse(run.createdAt))}` : "—"}</span>
          )}
        </div>
      </td>
      <td className="clip" title={`${run.recipeKind} on ${run.resolvedConfig.model} with ${run.datasetName} v${run.datasetVersion}`}>
        <div className="cell-main">
          <span className="title mono">{run.resolvedConfig.model}</span>
          <span className="sub">
            {run.recipeKind} · {run.datasetName} v{run.datasetVersion}
          </span>
        </div>
      </td>
      <td className="right num">
        <div className="cell-main">
          <span>{usd(run.costUsd)}</span>
          <span className="faint small">{run.maxCostUsd !== null ? `of ${usd(run.maxCostUsd)}` : "no cap"}</span>
        </div>
      </td>
      <td className="right muted" title={run.createdAt}>
        {ago(run.createdAt, now)}
      </td>
    </tr>
  );
};
