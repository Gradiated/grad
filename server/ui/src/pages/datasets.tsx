import { useState, type ReactNode } from "react";

import type { DatasetRecord, ImportJob, Source } from "@sdk/generated/models.js";

import { IconChevron, IconDatasets, IconImport, IconRefresh, IconSearch } from "../components/icons.js";
import { Banner, Card, Confirm, Empty, ErrorBanner, LoadMore, RowTitle, rowLink, SearchBox, SkeletonRows, Stat, StatusBadge, useToast } from "../components/ui.js";
import { errorMessage, useApi } from "../lib/api.js";
import { ago, dateTime, int, num } from "../lib/format.js";
import { Message, recordTurns } from "../components/record.js";
import { useDebounced, useNow, usePagedList, useResource } from "../lib/hooks.js";
import { Link, setQuery, useLocation } from "../lib/router.js";

export const DatasetsPage = () => {
  const { client } = useApi();
  const { query } = useLocation();
  const q = query.get("q") ?? "";
  const search = useDebounced(q.trim());
  const now = useNow();
  const list = usePagedList((cursor, signal) => client.listDatasets({ limit: 50, cursor, q: search || undefined }, { signal }), [search]);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Datasets</h1>
          <div className="page-sub">Versioned record sets. Every push, import or sync adds a version.</div>
        </div>
      </div>
      <div className="toolbar">
        <div className="grow" />
        <SearchBox value={q} onChange={(v) => setQuery({ q: v }, { replace: true })} placeholder="Filter by name" label="Filter datasets" />
      </div>
      <ErrorBanner error={list.error} onRetry={list.reload} stale={list.items.length > 0} />
      <div className="card">
        <div className="table-wrap" tabIndex={0}>
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
            <tbody aria-busy={list.loading}>
              {list.loading && <SkeletonRows cols={5} />}
              {list.items.map((d) => {
                const href = `/datasets/${encodeURIComponent(d.name)}`;
                return (
                  <tr key={d.id} {...rowLink(href)}>
                    <td>
                      <div className="cell-main">
                        <RowTitle href={href}>{d.name}</RowTitle>
                        <span className="sub">{d.id}</span>
                      </div>
                    </td>
                    <td className="right num">v{d.version}</td>
                    <td className="right num">{int(d.recordCount)}</td>
                    <td className="right muted" title={dateTime(d.updatedAt)}>
                      {ago(d.updatedAt, now)}
                    </td>
                    <td className="right muted" title={dateTime(d.createdAt)}>
                      {ago(d.createdAt, now)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!list.loading && !list.error && list.items.length === 0 &&
          (search ? (
            <Empty title="No datasets match" icon={<IconSearch />} />
          ) : (
            <Empty title="No datasets yet" icon={<IconDatasets />}>
              Import a trace export with <code>grad import FILE --dataset NAME</code>, or push records with <code>grad datasets push</code>.
            </Empty>
          ))}
        <LoadMore list={list} />
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
  const list = usePagedList((cursor, signal) => client.listDatasetRecords(name, { version: version || undefined, limit: PREVIEW, cursor }, { signal }), [name, version]);
  return (
    <Card title="Records" count={version ? `v${version}` : undefined} tight>
      <ErrorBanner error={list.error} onRetry={list.reload} />
      {list.loading && (
        <div className="skeleton-block" aria-label="Loading records">
          <div className="skeleton" />
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      )}
      {!list.loading && !list.error && list.items.length === 0 && <Empty title="No records in this version" />}
      {list.items.map((r, i) => (
        <RecordView key={`${r.id ?? i}:${i}`} record={r} />
      ))}
      <LoadMore list={list} label="Show more" />
    </Card>
  );
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
        <Message key={i} role={t.role} text={t.text} />
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
  const list = usePagedList((cursor, signal) => client.listImports({ dataset: name, limit: 10, cursor }, { signal }), [name], {
    pollMs: (page) => (page?.data.some((j) => j.status === "queued" || j.status === "running") ? 3000 : 30_000),
  });
  return (
    <Card title="Imports" tight>
      <ErrorBanner error={list.error} onRetry={list.reload} />
      {!list.loading && !list.error && list.items.length === 0 && (
        <Empty title="No imports" icon={<IconImport />}>
          <code>grad import</code> loads files; <code>grad datasets import hf</code> loads Hugging Face datasets.
        </Empty>
      )}
      {list.items.map((j) => (
        <ImportRow key={j.id} job={j} now={now} />
      ))}
      <LoadMore list={list} label="Older imports" />
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
