import type { EvalModelSummary, EvalRun } from "@sdk/generated/models.js";

import { IconChevron } from "../components/icons.js";
import { Banner, Card, Empty, ErrorBanner, SkeletonRows, Stat, StatusBadge } from "../components/ui.js";
import { listAll, useApi } from "../lib/api.js";
import { ago, compact, dateTime, int, num, usd } from "../lib/format.js";
import { useNow, useResource } from "../lib/hooks.js";
import { Link, navigate } from "../lib/router.js";
import { recordTurns } from "./datasets.js";

const TERMINAL_EVAL = new Set(["completed", "failed", "cancelled"]);

export const EvalsPage = () => {
  const { client } = useApi();
  const now = useNow();
  const res = useResource((signal) => listAll((cursor) => client.listEvals({ limit: 200, cursor }, { signal }), 1000), [], {
    pollMs: (d) => (d?.items.some((e) => !TERMINAL_EVAL.has(e.status)) ? 4000 : 15_000),
  });
  const evals = res.data?.items ?? [];
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Evals</h1>
          <div className="page-sub">Model comparisons and dataset scoring jobs.</div>
        </div>
      </div>
      <ErrorBanner error={res.error} />
      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Eval</th>
                <th>Status</th>
                <th>Models</th>
                <th>Dataset</th>
                <th>Progress</th>
                <th className="right">Cost</th>
                <th className="right">Created</th>
              </tr>
            </thead>
            <tbody>
              {res.loading && !res.data && <SkeletonRows cols={7} />}
              {evals.map((e) => {
                const open = () => navigate(`/evals/${encodeURIComponent(e.id)}`);
                const frac = e.progress.totalOutputs > 0 ? e.progress.generated / e.progress.totalOutputs : 0;
                return (
                  <tr key={e.id} className="clickable" tabIndex={0} onClick={open} onKeyDown={(k) => k.key === "Enter" && open()}>
                    <td>
                      <div className="cell-main">
                        <span className="title">{e.name}</span>
                        <span className="sub">{e.id}</span>
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={e.status} />
                    </td>
                    <td>
                      <div className="chips">
                        {e.mode === "score" && <span className="chip">score</span>}
                        {e.models.slice(0, 3).map((m) => (
                          <span key={m} className="chip mono">
                            {m}
                          </span>
                        ))}
                        {e.models.length > 3 && <span className="chip">+{e.models.length - 3}</span>}
                      </div>
                    </td>
                    <td>
                      {e.taskSource.dataset}
                      <span className="faint"> v{e.taskSource.version}</span>
                    </td>
                    <td style={{ minWidth: 110 }}>
                      <div className="progress slim" title={`${e.progress.generated} / ${e.progress.totalOutputs}`}>
                        <span style={{ width: `${(frac * 100).toFixed(1)}%` }} />
                      </div>
                    </td>
                    <td className="right num">{usd(e.totalCostUsd)}</td>
                    <td className="right muted">{ago(e.createdAt, now)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {res.data && evals.length === 0 && (
          <Empty title="No evals yet">
            Compare models with <code>grad eval</code> or <code>client.evals.create(...)</code>.
          </Empty>
        )}
      </div>
    </div>
  );
};

export const EvalDetailPage = ({ id }: { id: string }) => {
  const { client } = useApi();
  const now = useNow();
  const res = useResource((signal) => client.getEval(id, { signal }), [id], { pollMs: (e) => (e && TERMINAL_EVAL.has(e.status) ? undefined : 3000) });
  const e = res.data;
  return (
    <div className="page">
      <div className="crumbs">
        <Link href="/evals">Evals</Link>
        <IconChevron width={12} height={12} />
        <span>{e?.name ?? id}</span>
      </div>
      <ErrorBanner error={res.error} />
      {e && (
        <>
          <div className="page-header">
            <div>
              <h1 className="page-title">
                {e.name}
                <StatusBadge status={e.status} />
              </h1>
              <div className="page-sub">
                <span className="mono">{e.id}</span>
                <span className="sep" />
                <Link className="link" href={`/datasets/${encodeURIComponent(e.taskSource.dataset)}`}>
                  {e.taskSource.dataset}
                </Link>
                <span className="faint">v{e.taskSource.version}</span>
                <span className="sep" />
                <span title={dateTime(e.createdAt)}>created {ago(e.createdAt, now)}</span>
              </div>
            </div>
          </div>
          {e.error && <Banner>{e.error}</Banner>}
          {e.status === "awaiting_scores" && <Banner tone="info">Waiting for {int(e.progress.pendingLocalScores)} local scores from the SDK ({e.localScorers.join(", ")}).</Banner>}
          <div className="stats">
            <Stat label="Outputs" value={`${int(e.progress.generated)} / ${int(e.progress.totalOutputs)}`} hint={`${e.samples} sample${e.samples === 1 ? "" : "s"} per task`} />
            <Stat label="Cost" value={usd(e.totalCostUsd)} />
            <Stat label="Pass threshold" value={num(e.passThreshold)} />
            <Stat label="Judges" value={e.judgeModels.length ? e.judgeModels.join(", ") : "none"} hint={e.localScorers.length ? `local: ${e.localScorers.join(", ")}` : undefined} />
            {e.scoredDatasetVersion !== null && <Stat label="Scored version" value={`v${e.scoredDatasetVersion}`} />}
          </div>
          <Summary run={e} />
          {e.status === "completed" && <Failures run={e} />}
        </>
      )}
    </div>
  );
};

const CiBar = ({ low, mid, high, lo = 0, hi = 1 }: { low: number; mid: number; high: number; lo?: number; hi?: number }) => {
  const span = hi - lo || 1;
  const x = (v: number) => `${(((Math.min(hi, Math.max(lo, v)) - lo) / span) * 100).toFixed(2)}%`;
  return (
    <div className="ci" title={`${num(mid)} [${num(low)}, ${num(high)}]`}>
      <div className="track" />
      <div className="range" style={{ left: x(low), width: `calc(${x(high)} - ${x(low)})` }} />
      <div className="point" style={{ left: `calc(${x(mid)} - 1px)` }} />
    </div>
  );
};

const Summary = ({ run }: { run: EvalRun }) => {
  const rows = [...run.summary].sort((a, b) => b.overall - a.overall);
  const lo = Math.min(0, ...rows.map((r) => r.ciLow));
  const hi = Math.max(1, ...rows.map((r) => r.ciHigh));
  const ks = [...new Set(rows.flatMap((r) => Object.keys(r.passAtK)))].sort((a, b) => Number(a) - Number(b));
  return (
    <Card title="Summary" tight>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Model</th>
              <th className="right">Score</th>
              <th>95% CI</th>
              {ks.map((k) => (
                <th key={k} className="right">
                  pass@{k}
                </th>
              ))}
              {run.baseline && <th className="right">vs {run.baseline}</th>}
              <th className="right">Tasks</th>
              <th className="right">Errors</th>
              <th className="right">Tokens/task</th>
              <th className="right">$/1k tasks</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <SummaryRow key={r.model} row={r} ks={ks} lo={lo} hi={hi} baseline={run.baseline} />
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <Empty title={TERMINAL_EVAL.has(run.status) ? "No results" : "Results appear when scoring finishes"} />}
    </Card>
  );
};

const SummaryRow = ({ row, ks, lo, hi, baseline }: { row: EvalModelSummary; ks: string[]; lo: number; hi: number; baseline: string | null }) => {
  const d = row.vsBaseline;
  const sig = d && (d.ciLow > 0 ? "up" : d.ciHigh < 0 ? "down" : "");
  return (
    <tr>
      <td className="mono">
        {row.model}
        {row.model === baseline && <span className="badge outline" style={{ marginLeft: 8 }}>baseline</span>}
      </td>
      <td className="right num" style={{ fontWeight: 600 }}>
        {num(row.overall, 3)}
      </td>
      <td>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <CiBar low={row.ciLow} mid={row.overall} high={row.ciHigh} lo={lo} hi={hi} />
          <span className="faint num" style={{ fontSize: 12 }}>
            {num(row.ciLow, 3)}–{num(row.ciHigh, 3)}
          </span>
        </div>
      </td>
      {ks.map((k) => (
        <td key={k} className="right num">
          {num(row.passAtK[k], 3)}
        </td>
      ))}
      {baseline && (
        <td className={`right num delta ${sig ?? ""}`}>
          {d ? (
            <span title={`95% CI ${num(d.ciLow, 3)} to ${num(d.ciHigh, 3)}`}>
              {d.delta >= 0 ? "+" : ""}
              {num(d.delta, 3)}
            </span>
          ) : (
            <span className="faint">—</span>
          )}
        </td>
      )}
      <td className="right num">{int(row.tasks)}</td>
      <td className={`right num${row.errors > 0 ? " delta down" : " muted"}`}>{int(row.errors)}</td>
      <td className="right num muted">{compact(row.tokensPerTask)}</td>
      <td className="right num">{usd(row.costPer1kTasksUsd)}</td>
    </tr>
  );
};

const Failures = ({ run }: { run: EvalRun }) => {
  const { client } = useApi();
  const res = useResource((signal) => client.listEvalFailures(run.id, { limit: 25 }, { signal }), [run.id]);
  const items = res.data?.data ?? [];
  return (
    <Card title="Failures" count={items.length ? `${items.length}${res.data?.nextCursor ? "+" : ""}` : undefined} tight>
      <ErrorBanner error={res.error} />
      {res.data && items.length === 0 && <Empty title="No failures">Every task scored at or above the pass threshold.</Empty>}
      {items.map((f) => (
        <div key={`${f.model}:${f.taskId}`} className="record">
          <div className="record-head">
            <span>
              <span className="mono">{f.taskId}</span> <span className="faint">·</span> <span className="mono muted">{f.model}</span>
            </span>
            <div className="chips">
              <span className="chip">
                score <b>{num(f.score, 3)}</b>
              </span>
              {f.judgeModel && <span className="chip">{f.judgeModel}</span>}
            </div>
          </div>
          {recordTurns(f.record)
            .slice(-3)
            .map((t, i) => (
              <div key={i} className="msg">
                <span className="role">{t.role}</span>
                <span className={`content${t.text.length < 240 ? " short" : ""}`}>{t.text}</span>
              </div>
            ))}
        </div>
      ))}
    </Card>
  );
};
