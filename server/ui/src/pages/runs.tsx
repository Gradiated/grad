import { useState } from "react";

import type { Run, RunCounts } from "@sdk/generated/models.js";

import { IconRuns, IconSearch } from "../components/icons.js";
import { Empty, ErrorBanner, LoadMore, RowTitle, rowLink, SearchBox, Segmented, SkeletonRows, StatusBadge } from "../components/ui.js";
import { isTerminalRun, useApi } from "../lib/api.js";
import { PHASE_LABEL } from "../lib/events.js";
import { ago, duration, usd } from "../lib/format.js";
import { compareHref, MAX_COMPARE } from "../lib/compare.js";
import { useDebounced, useNow, usePagedList, useResource } from "../lib/hooks.js";
import { Link, setQuery, useLocation } from "../lib/router.js";

export type StatusFilter = "all" | "active" | "completed" | "failed" | "stopped";

/** Each tab's statuses, filtered by the server so a tab is right past the first page. */
export const STATUS_QUERY: Record<StatusFilter, string | undefined> = {
  all: undefined,
  active: "queued,running",
  completed: "completed",
  failed: "failed",
  stopped: "cancelled,stopped_budget,stopped_balance",
};

/** A tab's count: the sum of its statuses (GET /v1/runs/counts). */
export const countOf = (counts: RunCounts | undefined, filter: StatusFilter): number | undefined => {
  if (!counts) return undefined;
  const statuses = STATUS_QUERY[filter];
  if (statuses === undefined) return counts.total;
  const by = counts.byStatus as unknown as Record<string, number>;
  return statuses.split(",").reduce((n, s) => n + (by[s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] ?? 0), 0);
};

const TABS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "stopped", label: "Stopped" },
];

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
  const counts = useResource((signal) => client.countRuns({ q: search || undefined }, { signal }), [search], {
    pollMs: (c) => (c && c.byStatus.queued + c.byStatus.running > 0 ? 5000 : 15_000),
  });
  const filtered = status !== "all" || search !== "";
  // Runs ticked for comparison, in the order ticked; kept across tabs and searches.
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < MAX_COMPARE ? [...p, id] : p));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Runs</h1>
          <div className="page-sub">Training runs in this workspace, newest first.</div>
        </div>
      </div>

      <div className="toolbar">
        <Segmented label="Status" value={status} onChange={(v) => setQuery({ status: v === "all" ? undefined : v })} options={TABS.map((t) => ({ ...t, count: countOf(counts.data, t.value) }))} />
        <div className="grow" />
        <SearchBox value={q} onChange={(v) => setQuery({ q: v }, { replace: true })} placeholder="Filter by name or id" label="Filter runs" />
        <div className="actions">
          {picked.length > 0 && (
            <button type="button" className="btn sm ghost" onClick={() => setPicked([])}>
              Clear
            </button>
          )}
          {picked.length >= 2 ? (
            <Link className="btn sm primary" href={compareHref(picked)}>
              Compare {picked.length}
            </Link>
          ) : (
            <button type="button" className="btn sm" disabled title="Tick two or more runs to compare them">
              Compare{picked.length === 1 ? " 1" : ""}
            </button>
          )}
        </div>
      </div>

      <ErrorBanner error={list.error} onRetry={list.reload} stale={list.items.length > 0} />

      <div className="card">
        <div className="table-wrap" tabIndex={0}>
          <table className="table">
            <thead>
              <tr>
                <th className="cell-check">
                  <span className="sr-only">Compare</span>
                </th>
                <th>Run</th>
                <th>Status</th>
                <th>Model and data</th>
                <th className="right">Cost</th>
                <th className="right">Created</th>
              </tr>
            </thead>
            <tbody aria-busy={list.loading}>
              {list.loading && <SkeletonRows cols={6} />}
              {list.items.map((r) => (
                <RunRow key={r.id} run={r} now={now} picked={picked.includes(r.id)} full={picked.length >= MAX_COMPARE} onPick={() => toggle(r.id)} />
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

const RunRow = ({ run, now, picked, full, onPick }: { run: Run; now: number; picked: boolean; full: boolean; onPick: () => void }) => {
  const active = !isTerminalRun(run);
  const progress = run.totalSteps > 0 ? run.currentStep / run.totalSteps : 0;
  const phase = run.phase ? PHASE_LABEL[run.phase] : run.status === "queued" ? "Queued" : run.currentStep > 0 ? "Training" : "Starting";
  const href = `/runs/${encodeURIComponent(run.id)}`;
  return (
    <tr {...rowLink(href)} className={`clickable${picked ? " picked" : ""}`}>
      <td className="cell-check">
        <label title={!picked && full ? `Compare up to ${MAX_COMPARE} runs` : undefined}>
          <input type="checkbox" checked={picked} disabled={!picked && full} onChange={onPick} aria-label={`Compare ${run.name}`} />
        </label>
      </td>
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
