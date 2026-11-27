import { useMemo } from "react";

import type { UsageRecord } from "@sdk/generated/models.js";

import { Banner, Empty, ErrorBanner, SkeletonRows, Stat } from "../components/ui.js";
import { listAll, useApi } from "../lib/api.js";
import { compact, dateTime, int, usd } from "../lib/format.js";
import { useResource } from "../lib/hooks.js";
import { Link } from "../lib/router.js";

export interface UsageTotals {
  cost: number;
  tokens: number;
  rows: number;
  byKind: Record<string, { cost: number; tokens: number; refs: number }>;
}

export const usageTotals = (rows: UsageRecord[]): UsageTotals => {
  const byKind: UsageTotals["byKind"] = {};
  const refs = new Map<string, Set<string>>();
  let cost = 0;
  let tokens = 0;
  for (const r of rows) {
    cost += r.costUsd;
    tokens += r.tokens;
    const k = (byKind[r.kind] ??= { cost: 0, tokens: 0, refs: 0 });
    k.cost += r.costUsd;
    k.tokens += r.tokens;
    const set = refs.get(r.kind) ?? new Set<string>();
    set.add(r.refId);
    refs.set(r.kind, set);
  }
  for (const [k, set] of refs) (byKind[k] as { refs: number }).refs = set.size;
  return { cost, tokens, rows: rows.length, byKind };
};

const MAX_ROWS = 10_000;

export const UsagePage = () => {
  const { client } = useApi();
  const res = useResource((signal) => listAll((cursor) => client.listUsage({ limit: 500, cursor }, { signal }), MAX_ROWS), [], { pollMs: 30_000 });
  const rows = res.data?.items ?? [];
  const totals = useMemo(() => usageTotals(rows), [rows]);
  const shown = rows.slice(0, 300);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Usage</h1>
          <div className="page-sub">The billing ledger: one row per billed slice of a run attempt or an eval.</div>
        </div>
      </div>
      <ErrorBanner error={res.error} />
      {res.data?.truncated && <Banner tone="info">Totals cover the newest {int(rows.length)} rows.</Banner>}
      <div className="stats">
        <Stat label="Total cost" value={res.data ? usd(totals.cost) : "—"} hint={`${int(totals.rows)} ledger rows`} />
        <Stat label="Tokens billed" value={res.data ? compact(totals.tokens) : "—"} />
        <Stat label="Training" value={usd(totals.byKind.run?.cost ?? 0)} hint={`${int(totals.byKind.run?.refs ?? 0)} runs · ${compact(totals.byKind.run?.tokens ?? 0)} tokens`} />
        <Stat label="Evals" value={usd(totals.byKind.eval?.cost ?? 0)} hint={`${int(totals.byKind.eval?.refs ?? 0)} evals`} />
      </div>
      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Kind</th>
                <th>Reference</th>
                <th className="right">Attempt</th>
                <th className="right">Token range</th>
                <th className="right">Tokens</th>
                <th className="right">Cost</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              {res.loading && !res.data && <SkeletonRows cols={8} />}
              {shown.map((r) => (
                <tr key={r.id}>
                  <td className="muted">{dateTime(r.createdAt)}</td>
                  <td>
                    <span className="chip">{r.kind}</span>
                  </td>
                  <td>
                    <Link className="link mono" href={`/${r.kind === "run" ? "runs" : "evals"}/${encodeURIComponent(r.refId)}`}>
                      {r.refId}
                    </Link>
                  </td>
                  <td className="right num muted">{r.kind === "run" ? r.attempt : "—"}</td>
                  <td className="right num faint">{r.kind === "run" ? `${compact(r.tokensFrom)}–${compact(r.tokensThrough)}` : "—"}</td>
                  <td className="right num">{int(r.tokens)}</td>
                  <td className="right num">{usd(r.costUsd)}</td>
                  <td className="mono faint">{r.priceVersion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {res.data && rows.length === 0 && <Empty title="Nothing billed yet" />}
        {rows.length > shown.length && <div className="table-foot muted">Showing the newest {shown.length} of {int(rows.length)} rows (totals include all).</div>}
      </div>
    </div>
  );
};
