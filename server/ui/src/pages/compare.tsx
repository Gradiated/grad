import { useMemo, useRef } from "react";

import type { MetricPoint, Run } from "@sdk/generated/models.js";

import { ChartCard, LineChart } from "../components/chart.js";
import { IconRuns } from "../components/icons.js";
import { Banner, Card, Empty, ErrorBanner, StatusBadge } from "../components/ui.js";
import { errorMessage, isTerminalRun, useApi } from "../lib/api.js";
import { compareHref, configRows, CURVE_POINTS, labelsOf, lastOf, MAX_COMPARE, metricByKey, metricsOf, overlay, parseIds, runStyle, type MetricDef } from "../lib/compare.js";
import { compact, duration, int, num, usd } from "../lib/format.js";
import { useResource, useTitle } from "../lib/hooks.js";
import { Link, navigate, setQuery, useLocation } from "../lib/router.js";

interface Loaded {
  id: string;
  run: Run | null;
  points: MetricPoint[];
  error: unknown;
}

const fmt = (def: MetricDef) => (v: number | null) => (def.kind === "usd" ? usd(v) : def.kind === "rate" ? compact(v) : num(v, 4));

/** Loads every run and its thinned curve; a finished run is read once, an active one again on each poll. */
const useCompared = (ids: string[]) => {
  const { client } = useApi();
  const done = useRef(new Map<string, Loaded>());
  return useResource(
    (signal) =>
      Promise.all(
        ids.map(async (id): Promise<Loaded> => {
          const cached = done.current.get(id);
          if (cached) return cached;
          try {
            const [run, page] = await Promise.all([client.getRun(id, { signal }), client.listRunMetrics(id, { maxPoints: CURVE_POINTS }, { signal })]);
            const loaded = { id, run, points: page.data, error: null };
            if (isTerminalRun(run)) done.current.set(id, loaded);
            return loaded;
          } catch (error) {
            if (signal.aborted) throw error;
            return { id, run: null, points: [], error };
          }
        }),
      ),
    [ids],
    { pollMs: (data) => (data?.some((r) => r.run && !isTerminalRun(r.run)) ? 15_000 : undefined) },
  );
};

export const ComparePage = () => {
  const { query } = useLocation();
  const ids = parseIds(query.get("ids"));
  const res = useCompared(ids);
  useTitle(ids.length > 1 ? `Compare ${ids.length} runs` : "Compare runs");

  const loaded = res.data ?? [];
  const runs = loaded.filter((l): l is Loaded & { run: Run } => l.run !== null);
  const failed = loaded.filter((l) => l.run === null);
  const labels = labelsOf(runs.map((l) => l.run));

  const metrics = useMemo(() => metricsOf(runs.map((r) => r.points)), [res.data]);
  const requested = query.get("metric") ?? "loss";
  const metric = metrics.find((m) => m.key === requested) ?? metrics[0] ?? metricByKey("loss");
  const smoothing = Math.min(0.99, Math.max(0, Number(query.get("smooth") ?? "0.6") || 0));
  const chart = useMemo(
    () =>
      overlay(
        runs.map((r, i) => ({ label: labels[i] ?? r.id, points: r.points })),
        metric,
        smoothing,
      ),
    [res.data, metric.key, smoothing],
  );

  const remove = (id: string) => {
    const rest = ids.filter((i) => i !== id);
    navigate(rest.length > 0 ? compareHref(rest) : "/runs");
  };

  if (ids.length < 2) {
    return (
      <div className="page">
        <h1 className="page-title">Compare runs</h1>
        <div className="card">
          <Empty title="Pick two or more runs" icon={<IconRuns />}>
            Tick runs on the{" "}
            <Link className="link" href="/runs">
              Runs
            </Link>{" "}
            page, then choose Compare.
          </Empty>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Compare {ids.length} runs</h1>
          <div className="page-sub">
            Curves thinned to {int(CURVE_POINTS)} points per run. The link keeps this selection; up to {MAX_COMPARE} runs.
          </div>
        </div>
      </div>

      <ErrorBanner error={res.error} onRetry={res.reload} stale={loaded.length > 0} />
      {failed.length > 0 && (
        <Banner tone="warn">
          {failed.map((f) => (
            <div key={f.id}>
              Couldn't load <span className="mono">{f.id}</span>: {errorMessage(f.error)}{" "}
              <button type="button" className="btn sm" onClick={() => remove(f.id)}>
                Remove
              </button>
            </div>
          ))}
        </Banner>
      )}

      <ul className="compare-runs" aria-label="Runs compared">
        {runs.map((r, i) => {
          const style = runStyle(i);
          return (
            <li key={r.id} className="chip">
              <span className={`swatch${style.dashed ? " dashed" : ""}`} style={{ borderColor: `var(${style.color})` }} aria-hidden="true" />
              <Link className="link" href={`/runs/${encodeURIComponent(r.id)}`}>
                {labels[i]}
              </Link>
              <StatusBadge status={r.run.status} />
              <button type="button" className="btn ghost icon sm" aria-label={`Remove ${labels[i]} from the comparison`} title="Remove" onClick={() => remove(r.id)}>
                ×
              </button>
            </li>
          );
        })}
      </ul>

      <div className="toolbar">
        <div className="field-inline">
          <label htmlFor="compare-metric">Metric</label>
          <select id="compare-metric" className="input" value={metric.key} onChange={(e) => setQuery({ metric: e.target.value === "loss" ? undefined : e.target.value })}>
            {(metrics.length > 0 ? metrics : [metric]).map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field-inline">
          <label htmlFor="compare-smooth">Smoothing</label>
          <input
            id="compare-smooth"
            type="range"
            min={0}
            max={0.99}
            step={0.01}
            value={smoothing}
            onChange={(e) => setQuery({ smooth: e.target.value === "0.6" ? undefined : e.target.value }, { replace: true })}
          />
          <output htmlFor="compare-smooth" className="mono">
            {smoothing.toFixed(2)}
          </output>
        </div>
      </div>

      <ChartCard title={metric.label}>
        <LineChart x={chart.x} series={chart.series} format={fmt(metric)} nearest height={300} empty={res.loading && !res.data ? "Loading…" : `No ${metric.label.toLowerCase()} logged yet`} />
      </ChartCard>

      {runs.length > 0 && <Summary runs={runs} labels={labels} metrics={metrics} />}
      {runs.length > 0 && <ConfigDiff runs={runs.map((r) => r.run)} labels={labels} />}
    </div>
  );
};

const Head = ({ first, labels }: { first: string; labels: string[] }) => (
  <thead>
    <tr>
      <th scope="col">{first}</th>
      {labels.map((l, i) => (
        <th key={`${l}-${i}`} scope="col" className="clip" title={l}>
          <span className="compare-head">
            <span className={`swatch${runStyle(i).dashed ? " dashed" : ""}`} style={{ borderColor: `var(${runStyle(i).color})` }} aria-hidden="true" />
            {l}
          </span>
        </th>
      ))}
    </tr>
  </thead>
);

const Summary = ({ runs, labels, metrics }: { runs: (Loaded & { run: Run })[]; labels: string[]; metrics: MetricDef[] }) => {
  const finals = metrics.filter((m) => m.key !== "lr" && m.key !== "cost_usd" && m.key !== "grad_norm");
  return (
    <Card title="Results" tight>
      <div className="table-wrap" tabIndex={0}>
        <table className="table compare-table">
          <Head first="Result" labels={labels} />
          <tbody>
            <tr>
              <th scope="row">Status</th>
              {runs.map((r) => (
                <td key={r.id}>
                  <StatusBadge status={r.run.status} />
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Steps</th>
              {runs.map((r) => (
                <td key={r.id} className="num">
                  {int(r.run.currentStep)} / {int(r.run.totalSteps)}
                </td>
              ))}
            </tr>
            {finals.map((m) => (
              <tr key={m.key}>
                <th scope="row">Final {m.label.charAt(0).toLowerCase() + m.label.slice(1)}</th>
                {runs.map((r) => (
                  <td key={r.id} className="num">
                    {fmt(m)(lastOf(r.points, m))}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <th scope="row">Tokens</th>
              {runs.map((r) => (
                <td key={r.id} className="num">
                  {compact(r.run.tokensProcessed)}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Cost</th>
              {runs.map((r) => (
                <td key={r.id} className="num">
                  {usd(r.run.costUsd)}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Took</th>
              {runs.map((r) => (
                <td key={r.id} className="num">
                  {r.run.finishedAt ? duration(Date.parse(r.run.finishedAt) - Date.parse(r.run.createdAt)) : "—"}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
};

const ConfigDiff = ({ runs, labels }: { runs: Run[]; labels: string[] }) => {
  const { query } = useLocation();
  const all = query.get("config") === "all";
  const rows = useMemo(() => configRows(runs), [runs]);
  const differing = rows.filter((r) => r.differs).length;
  const shown = all ? rows : rows.filter((r) => r.differs);
  return (
    <Card
      title="Settings"
      count={`${differing} of ${rows.length} differ`}
      tight
      actions={
        <label className="field-inline">
          <input type="checkbox" checked={all} onChange={(e) => setQuery({ config: e.target.checked ? "all" : undefined })} />
          Show identical
        </label>
      }
    >
      <div className="table-wrap" tabIndex={0}>
        <table className="table compare-table">
          <Head first="Setting" labels={labels} />
          <tbody>
            {shown.map((r) => (
              <tr key={r.key} className={r.differs ? "differs" : undefined}>
                <th scope="row" className="mono">
                  {r.key}
                </th>
                {r.values.map((v, i) => (
                  <td key={i} className={`mono${i > 0 && v !== r.values[0] ? " changed" : ""}`}>
                    {v}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length === 0 && <Empty title="Same settings">Every resolved setting of these runs is identical.</Empty>}
    </Card>
  );
};
