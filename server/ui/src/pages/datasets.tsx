import { useState, type ReactNode } from "react";

import type { ChatMessage, DatasetRecord, ImportJob, Source } from "@sdk/generated/models.js";

import { IconChevron, IconDatasets, IconImport, IconRefresh } from "../components/icons.js";
import { Banner, Card, Confirm, Empty, ErrorBanner, SkeletonRows, Stat, StatusBadge, useToast } from "../components/ui.js";
import { errorMessage, listAll, useApi } from "../lib/api.js";
import { ago, dateTime, int, num } from "../lib/format.js";
import { useNow, useResource } from "../lib/hooks.js";
import { Link, navigate, setQuery, useLocation } from "../lib/router.js";

export const DatasetsPage = () => {
  const { client } = useApi();
  const now = useNow();
  const res = useResource((signal) => listAll((cursor) => client.listDatasets({ limit: 200, cursor }, { signal }), 2000), []);
  const items = res.data?.items ?? [];
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Datasets</h1>
          <div className="page-sub">Versioned record sets. Every push, import or sync adds a version.</div>
        </div>
      </div>
      <ErrorBanner error={res.error} onRetry={res.reload} />
      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th className="right">Version</th>
                <th className="right">Records</th>
                <th className="right">Updated</th>
                <th className="right">Created</th>
              </tr>
            </thead>
            <tbody>
              {res.loading && !res.data && <SkeletonRows cols={5} />}
              {items.map((d) => {
                const open = () => navigate(`/datasets/${encodeURIComponent(d.name)}`);
                return (
                  <tr key={d.id} className="clickable" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === "Enter" && open()}>
                    <td>
                      <div className="cell-main">
                        <span className="title">{d.name}</span>
                        <span className="sub">{d.id}</span>
                      </div>
                    </td>
                    <td className="right num">v{d.version}</td>
                    <td className="right num">{int(d.recordCount)}</td>
                    <td className="right muted">{ago(d.updatedAt, now)}</td>
                    <td className="right muted">{ago(d.createdAt, now)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {res.data && items.length === 0 && (
          <Empty title="No datasets yet" icon={<IconDatasets />}>
            Push records with <code>grad datasets push</code> or import a file with <code>grad datasets import</code>.
          </Empty>
        )}
      </div>
    </div>
  );
};

export const DatasetDetailPage = ({ name }: { name: string }) => {
  const { client } = useApi();
  const { query } = useLocation();
  const now = useNow();
  const ds = useResource((signal) => client.getDataset(name, { signal }), [name], { pollMs: 10_000 });
  const d = ds.data;
  const version = Number(query.get("version")) || d?.version || 0;
  return (
    <div className="page">
      <div className="crumbs">
        <Link href="/datasets">Datasets</Link>
        <IconChevron width={12} height={12} />
        <span>{name}</span>
      </div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{name}</h1>
          {d && (
            <div className="page-sub">
              <span className="mono">{d.id}</span>
              <span className="sep" />
              <span>updated {ago(d.updatedAt, now)}</span>
            </div>
          )}
        </div>
        {d && d.version > 0 && (
          <div className="actions field-inline">
            <label htmlFor="version">Version</label>
            <select id="version" className="input" value={version} onChange={(e) => setQuery({ version: e.target.value === String(d.version) ? undefined : e.target.value })}>
              {Array.from({ length: d.version }, (_, i) => d.version - i).map((v) => (
                <option key={v} value={v}>
                  v{v}
                  {v === d.version ? " (latest)" : ""}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <ErrorBanner error={ds.error} onRetry={ds.reload} />
      {d && (
        <>
          <div className="stats">
            <Stat label="Latest version" value={`v${d.version}`} />
            <Stat label="Records" value={int(d.recordCount)} hint="merged, latest version" />
            <Stat label="Created" value={ago(d.createdAt, now)} hint={dateTime(d.createdAt)} />
            {typeof (d.metadata as Record<string, unknown>).view === "object" && <Stat label="View of" value={String(((d.metadata as Record<string, unknown>).view as Record<string, unknown>).source ?? "—")} hint="filtered dataset" />}
          </div>
          <div className="split">
            <Records name={name} version={version} />
            <div className="stack">
              <Sources name={name} onSynced={ds.reload} />
              <Imports name={name} />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

// ------------------------------------------------------------ records

const PREVIEW = 25;

const Records = ({ name, version }: { name: string; version: number }) => {
  const { client } = useApi();
  const [pages, setPages] = useState<{ version: number; records: DatasetRecord[]; cursor: string | null } | null>(null);
  const first = useResource((signal) => client.listDatasetRecords(name, { version: version || undefined, limit: PREVIEW }, { signal }), [name, version]);
  const [busy, setBusy] = useState(false);
  const extra = pages?.version === version ? pages : null;
  const records = [...(first.data?.data ?? []), ...(extra?.records ?? [])];
  const cursor = extra ? extra.cursor : (first.data?.nextCursor ?? null);
  const more = async () => {
    if (!cursor) return;
    setBusy(true);
    try {
      const page = await client.listDatasetRecords(name, { version: version || undefined, limit: PREVIEW, cursor });
      setPages({ version, records: [...(extra?.records ?? []), ...page.data], cursor: page.nextCursor });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Records" count={version ? `v${version}` : undefined} tight>
      <ErrorBanner error={first.error} />
      {first.loading && !first.data && (
        <div className="skeleton-block" aria-label="Loading records">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      )}
      {first.data && records.length === 0 && <Empty title="No records in this version" />}
      {records.map((r, i) => (
        <RecordView key={`${r.id ?? i}:${i}`} record={r} />
      ))}
      {cursor && (
        <div className="table-foot">
          <button type="button" className="btn sm" disabled={busy} onClick={() => void more()}>
            {busy && <span className="spinner" />}
            Show more
          </button>
        </div>
      )}
    </Card>
  );
};

const text = (c: unknown): string => {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === "object" && p && "text" in p ? String((p as { text: unknown }).text) : typeof p === "string" ? p : JSON.stringify(p))).join("");
  if (c === null || c === undefined) return "";
  return JSON.stringify(c);
};

/** The conversation-ish parts of any record shape, as (role, text) pairs. */
export const recordTurns = (r: DatasetRecord): { role: string; text: string }[] => {
  const msgs = (m: ChatMessage[] | undefined) => (m ?? []).map((x) => ({ role: x.role, text: text(x.content) || (x.toolCalls ? JSON.stringify(x.toolCalls) : "") }));
  const asTurns = (role: string, v: string | ChatMessage[] | undefined) => (v === undefined ? [] : typeof v === "string" ? [{ role, text: v }] : msgs(v));
  if (r.messages?.length) return msgs(r.messages);
  if (r.input?.messages) return [...msgs(r.input.messages), ...msgs(r.output?.turns)];
  if (r.prompt !== undefined) return [...asTurns("prompt", r.prompt), ...asTurns("completion", r.completion), ...asTurns("chosen", r.chosen), ...asTurns("rejected", r.rejected)];
  if (r.query !== undefined) return [{ role: "query", text: r.query }, ...(r.positive ? [{ role: "positive", text: r.positive }] : []), ...(r.negatives ?? []).slice(0, 2).map((n) => ({ role: "negative", text: n }))];
  return [{ role: "record", text: JSON.stringify(r) }];
};

const RecordView = ({ record }: { record: DatasetRecord }) => {
  const turns = recordTurns(record).slice(0, 6);
  const scores = Object.entries(record.scores ?? {});
  return (
    <div className="record">
      <div className="record-head">
        <span className="mono faint">{record.id ?? "—"}</span>
        <div className="chips">
          {record.source && <span className="chip">{record.source}</span>}
          {scores.map(([k, v]) => (
            <span key={k} className="chip">
              {k} <b>{num(v, 3)}</b>
            </span>
          ))}
        </div>
      </div>
      {turns.map((t, i) => (
        <div key={i} className="msg">
          <span className="role">{t.role}</span>
          <span className={`content${t.text.length < 240 ? " short" : ""}`}>{t.text}</span>
        </div>
      ))}
    </div>
  );
};

// ------------------------------------------------------------ sources + imports

const Sources = ({ name, onSynced }: { name: string; onSynced: () => void }) => {
  const { client } = useApi();
  const toast = useToast();
  const now = useNow();
  const res = useResource((signal) => client.listSources({ dataset: name, limit: 100 }, { signal }), [name], {
    pollMs: (p) => (p?.data.some((s) => s.lastSync && (s.lastSync.status === "queued" || s.lastSync.status === "running")) ? 3000 : 20_000),
  });
  const [sync, setSync] = useState<Source | null>(null);
  const sources = res.data?.data ?? [];
  if (res.data && sources.length === 0) return null;
  return (
    <Card title="Sources" count={sources.length || undefined} tight>
      <ErrorBanner error={res.error} />
      {sources.map((s) => (
        <div key={s.id} className="item">
          <span className="chip">{s.provider.kind}</span>
          <div className="truncate">
            <div className="item-name">{s.provider.project ?? s.provider.host ?? s.id}</div>
            <div className="item-sub">
              {s.schedule ? <span className="mono">{s.schedule}</span> : "manual"} · {s.lastSyncedAt ? `synced ${ago(s.lastSyncedAt, now)}` : "never synced"}
              {s.nextSyncAt && ` · next ${ago(s.nextSyncAt, now)}`}
            </div>
          </div>
          <div className="item-side">
            {s.lastSync && <StatusBadge status={s.lastSync.status} />}
            <button type="button" className="btn sm" onClick={() => setSync(s)}>
              <IconRefresh /> Sync
            </button>
          </div>
          {s.lastSync?.error && <div className="item-error">{s.lastSync.error}</div>}
        </div>
      ))}
      {sync && (
        <Confirm
          title="Sync now?"
          confirm="Sync"
          body={<p>Pulls new traces from {sync.provider.kind} into a new version of {name}. At most one sync runs per source.</p>}
          onConfirm={async () => {
            const job = await client.syncSource(sync.id, {});
            toast(`Sync ${job.status}: ${job.id}`);
            res.reload();
            onSynced();
          }}
          onClose={() => setSync(null)}
        />
      )}
    </Card>
  );
};

const Imports = ({ name }: { name: string }) => {
  const { client } = useApi();
  const now = useNow();
  const res = useResource(
    async (signal) => (await listAll((cursor) => client.listImports({ limit: 200, cursor }, { signal }), 600)).items.filter((j) => j.dataset === name).slice(0, 20),
    [name],
    { pollMs: (jobs) => (jobs?.some((j) => j.status === "queued" || j.status === "running") ? 3000 : 30_000) },
  );
  const jobs = res.data ?? [];
  return (
    <Card title="Imports" count={jobs.length || undefined} tight>
      <ErrorBanner error={res.error} />
      {res.data && jobs.length === 0 && (
        <Empty title="No imports" icon={<IconImport />}>
          <code>grad datasets import</code> loads files and Hugging Face datasets.
        </Empty>
      )}
      {jobs.map((j) => (
        <ImportRow key={j.id} job={j} now={now} />
      ))}
    </Card>
  );
};

const ImportRow = ({ job, now }: { job: ImportJob; now: number }): ReactNode => (
  <div className="record">
    <div className="record-head">
      <span>
        <span className="chip">{job.connector}</span> <span className="mono faint">{job.id}</span>
      </span>
      <StatusBadge status={job.status} />
    </div>
    <div className="muted num small">
      {int(job.importedCount)} imported
      {job.droppedCount > 0 && ` · ${int(job.droppedCount)} dropped`}
      {job.datasetVersion !== null && ` · v${job.datasetVersion}`} · {ago(job.createdAt, now)}
    </div>
    {job.error && <Banner>{errorMessage(job.error)}</Banner>}
    {job.dropReasons.length > 0 && <div className="t-detail">{job.dropReasons.slice(0, 3).join("; ")}</div>}
  </div>
);
