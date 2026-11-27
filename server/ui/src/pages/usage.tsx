import { useState } from "react";

import type { UsageGroupBy, UsageKind, UsageRecord, UsageRefTotal } from "@sdk/generated/models.js";

import { IconUsage } from "../components/icons.js";
import { Card, Empty, ErrorBanner, Segmented, SkeletonRows, Stat } from "../components/ui.js";
import { errorMessage, useApi } from "../lib/api.js";
import { compact, dateTime, int, usd } from "../lib/format.js";
import { useResource } from "../lib/hooks.js";
import { Link, setQuery, useLocation } from "../lib/router.js";

export const KIND_LABEL: Record<UsageKind, string> = {
  training: "Training",
  eval: "Evals",
  scoring: "Dataset scoring",
  labeling: "Labeling",
  teacher: "Teacher answers",
};

const DAY_MS = 86_400_000;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The current UTC month as inclusive dates, the summary endpoint's default period. */
export const defaultPeriod = (now = Date.now()): { from: string; to: string } => {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { from: isoDay(start), to: isoDay(next - DAY_MS) };
};

/** Quick ranges as inclusive UTC dates. */
export const presets = (now = Date.now()): Record<"month" | "last-month" | "7d" | "30d", { from: string; to: string }> => {
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const lastStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
  const thisStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return {
    month: defaultPeriod(now),
    "last-month": { from: isoDay(lastStart), to: isoDay(thisStart - DAY_MS) },
    "7d": { from: isoDay(today - 6 * DAY_MS), to: isoDay(today) },
    "30d": { from: isoDay(today - 29 * DAY_MS), to: isoDay(today) },
  };
};

const GROUPS: { value: UsageGroupBy; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "model", label: "Model" },
  { value: "recipe", label: "Recipe" },
  { value: "kind", label: "Kind" },
];

const isGroup = (v: string | null): v is UsageGroupBy => GROUPS.some((g) => g.value === v);

const refHref = (kind: UsageKind, id: string): string => `/${kind === "training" ? "runs" : "evals"}/${encodeURIComponent(id)}`;

const RefLink = ({ kind, id, name }: { kind: UsageKind; id: string; name: string | null }) => (
  <Link className="link" href={refHref(kind, id)}>
    {name ?? <span className="mono">{id}</span>}
  </Link>
);

const TopTable = ({ title, refs }: { title: string; refs: UsageRefTotal[] }) => (
  <Card title={title} tight>
    {refs.length === 0 ? (
      <Empty title="None in this period" />
    ) : (
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Kind</th>
              <th className="right">Tokens</th>
              <th className="right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {refs.map((r) => (
              <tr key={r.id}>
                <td>
                  <RefLink kind={r.kind} id={r.id} name={r.name} />
                  <div className="mono faint">{r.id}</div>
                </td>
                <td>
                  <span className="chip">{r.kind}</span>
                </td>
                <td className="right num">{compact(r.tokens)}</td>
                <td className="right num">{usd(r.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </Card>
);

const ROWS = 25;

export const UsagePage = () => {
  const { client } = useApi();
  const { query } = useLocation();
  const fallback = defaultPeriod();
  const from = query.get("from") ?? fallback.from;
  const to = query.get("to") ?? fallback.to;
  const rawBy = query.get("by");
  const by: UsageGroupBy = isGroup(rawBy) ? rawBy : "day";
  const summary = useResource((signal) => client.getUsageSummary({ from, to, groupBy: by }, { signal }), [from, to, by], { pollMs: 30_000 });
  const rows = useResource((signal) => client.listUsage({ from, to, limit: ROWS }, { signal }), [from, to], { pollMs: 30_000 });
  const s = summary.data;
  const ranges = presets();
  const active = (Object.keys(ranges) as (keyof typeof ranges)[]).find((k) => ranges[k].from === from && ranges[k].to === to) ?? "custom";
  const maxGroup = Math.max(0, ...(s?.groups ?? []).map((g) => g.costUsd));
  const [older, setOlder] = useState<{ key: string; rows: UsageRecord[]; cursor: string | null } | null>(null);
  const [more, setMore] = useState<{ busy: boolean; error: unknown }>({ busy: false, error: null });
  const period = `${from}:${to}`;
  const extra = older?.key === period ? older : null;
  const billed: UsageRecord[] = [...(rows.data?.data ?? []), ...(extra?.rows ?? [])];
  const cursor = extra ? extra.cursor : (rows.data?.nextCursor ?? null);
  const loadMore = async () => {
    if (!cursor) return;
    setMore({ busy: true, error: null });
    try {
      const page = await client.listUsage({ from, to, limit: ROWS, cursor });
      setOlder({ key: period, rows: [...(extra?.rows ?? []), ...page.data], cursor: page.nextCursor });
      setMore({ busy: false, error: null });
    } catch (e) {
      setMore({ busy: false, error: e });
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Usage</h1>
          <div className="page-sub">What this workspace was billed for, in UTC: training, evals, dataset scoring, labeling and teacher answers.</div>
        </div>
      </div>

      <div className="toolbar">
        <Segmented
          label="Period"
          value={active}
          onChange={(v) => v !== "custom" && setQuery(ranges[v])}
          options={[
            { value: "month", label: "This month" },
            { value: "last-month", label: "Last month" },
            { value: "7d", label: "7 days" },
            { value: "30d", label: "30 days" },
            ...(active === "custom" ? [{ value: "custom" as const, label: "Custom" }] : []),
          ]}
        />
        <div className="grow" />
        <div className="field-inline">
          <label htmlFor="usage-from">From</label>
          <input id="usage-from" className="input" type="date" value={from} max={to} onChange={(e) => setQuery({ from: e.target.value })} />
          <label htmlFor="usage-to">to</label>
          <input id="usage-to" className="input" type="date" value={to} min={from} onChange={(e) => setQuery({ to: e.target.value })} />
        </div>
      </div>

      <ErrorBanner error={summary.error} onRetry={summary.reload} />
      <div className="stats">
        <Stat label="Total cost" value={s ? usd(s.costUsd) : "—"} hint={s ? `${int(s.records)} billed rows` : undefined} />
        <Stat label="Tokens billed" value={s ? compact(s.tokens) : "—"} />
        {(s?.byKind ?? []).map((k) => (
          <Stat key={k.kind} label={KIND_LABEL[k.kind] ?? k.kind} value={usd(k.costUsd)} hint={`${compact(k.tokens)} tokens`} />
        ))}
      </div>

      <Card
        title="Breakdown"
        actions={<Segmented label="Group by" value={by} onChange={(v) => setQuery({ by: v === "day" ? undefined : v })} options={GROUPS} />}
        tight
      >
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{GROUPS.find((g) => g.value === by)?.label}</th>
                <th>Share</th>
                <th className="right">Rows</th>
                <th className="right">Tokens</th>
                <th className="right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {summary.loading && !s && <SkeletonRows cols={5} />}
              {(s?.groups ?? []).map((g) => (
                <tr key={g.key ?? "none"}>
                  <td className={g.key ? "mono" : "faint"}>{g.key ?? "(none)"}</td>
                  <td className="share">
                    <div className="progress slim">
                      <span style={{ width: `${maxGroup > 0 ? ((g.costUsd / maxGroup) * 100).toFixed(1) : 0}%` }} />
                    </div>
                  </td>
                  <td className="right num muted">{int(g.records)}</td>
                  <td className="right num">{compact(g.tokens)}</td>
                  <td className="right num">{usd(g.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {s && s.records === 0 && (
          <Empty title="Nothing billed in this period" icon={<IconUsage />}>
            Pick another range, or start a run or an eval.
          </Empty>
        )}
      </Card>

      <div className="grid-2">
        <TopTable title="Top runs" refs={s?.topRuns ?? []} />
        <TopTable title="Top evals" refs={s?.topEvals ?? []} />
      </div>

      <Card title="Billed rows" count={rows.data ? int(billed.length) : undefined} tight>
        <ErrorBanner error={rows.error} />
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Kind</th>
                <th>Run / eval</th>
                <th className="right">Attempt</th>
                <th className="right">Tokens</th>
                <th className="right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.loading && !rows.data && <SkeletonRows cols={6} />}
              {billed.map((r) => (
                <tr key={r.id}>
                  <td className="muted">{dateTime(r.createdAt)}</td>
                  <td>
                    <span className="chip">{r.kind}</span>
                  </td>
                  <td>
                    <RefLink kind={r.kind} id={r.refId} name={r.refName} />
                  </td>
                  <td className="right num muted">{r.attempt}</td>
                  <td className="right num">{int(r.tokens)}</td>
                  <td className="right num">{usd(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {cursor && (
          <div className="table-foot">
            <button type="button" className="btn sm" onClick={() => void loadMore()} disabled={more.busy}>
              {more.busy && <span className="spinner" />}
              Show older rows
            </button>
            {more.error ? <span>{errorMessage(more.error)}</span> : <span>The totals above cover the whole period.</span>}
          </div>
        )}
      </Card>
    </div>
  );
};
