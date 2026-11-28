import { useMemo, useState } from "react";

import type { Artifact } from "@sdk/generated/models.js";

import { IconArtifacts, IconChevron, IconDownload, IconSearch } from "../components/icons.js";
import { Badge, Card, Command, Confirm, Empty, ErrorBanner, Kv, SkeletonRows, useToast } from "../components/ui.js";
import { listAll, useApi } from "../lib/api.js";
import { ago, bytes, dateTime } from "../lib/format.js";
import { useNow, useResource } from "../lib/hooks.js";
import { Link, navigate, setQuery, useLocation } from "../lib/router.js";

const hrefOf = (a: Pick<Artifact, "id">) => `/artifacts/${encodeURIComponent(a.id)}`;

export const filterArtifacts = (artifacts: Artifact[], q: string): Artifact[] => {
  const needle = q.trim().toLowerCase();
  if (!needle) return artifacts;
  return artifacts.filter((a) => [a.id, a.baseModel, a.format ?? "", a.provenance.source].some((v) => v.toLowerCase().includes(needle)));
};

/** Where an artifact came from: the run that trained it, its uploader, or its pinned Hub revision. */
const ProvenanceValue = ({ artifact }: { artifact: Artifact }) => {
  const p = artifact.provenance;
  const runId = p.runId ?? artifact.runId;
  if (p.source === "run" && runId)
    return (
      <Link className="link mono" href={`/runs/${encodeURIComponent(runId)}`} onClick={(e) => e.stopPropagation()}>
        {runId}
      </Link>
    );
  const detail = p.source === "upload" ? p.uploader : p.uri;
  return <span className="mono faint">{detail ?? "—"}</span>;
};

const Pinned = ({ artifact }: { artifact: Artifact }) =>
  artifact.pins.length > 0 ? (
    <span title={artifact.pins.map((p) => p.holder).join(", ")}>
      <Badge tone="accent">pinned{artifact.pins.length > 1 ? ` ×${artifact.pins.length}` : ""}</Badge>
    </span>
  ) : (
    <span className="faint">—</span>
  );

export const ArtifactsPage = () => {
  const { client } = useApi();
  const { query } = useLocation();
  const q = query.get("q") ?? "";
  const now = useNow();
  const res = useResource((signal) => listAll((cursor) => client.listArtifacts({ limit: 200, cursor }, { signal }), 2000), []);
  const items = useMemo(() => res.data?.items ?? [], [res.data]);
  const shown = filterArtifacts(items, q);
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Artifacts</h1>
          <div className="page-sub">Immutable weights, trained by runs, uploaded or imported from Hugging Face. A pinned artifact can't be deleted.</div>
        </div>
      </div>
      <div className="toolbar">
        <div className="grow" />
        <label className="search">
          <IconSearch />
          <input className="input" type="search" placeholder="Filter by name, model, format" aria-label="Filter artifacts" value={q} onChange={(e) => setQuery({ q: e.target.value })} />
        </label>
      </div>
      <ErrorBanner error={res.error} onRetry={res.reload} />
      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Artifact</th>
                <th>Format</th>
                <th>Base model</th>
                <th>Provenance</th>
                <th className="right">Size</th>
                <th className="right">Created</th>
                <th className="right">Pinned</th>
              </tr>
            </thead>
            <tbody>
              {res.loading && !res.data && <SkeletonRows cols={7} />}
              {shown.map((a) => {
                const open = () => navigate(hrefOf(a));
                return (
                  <tr key={a.id} className="clickable" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === "Enter" && open()}>
                    <td>
                      <div className="cell-main">
                        <span className="title mono">{`${a.name}@${a.version}`}</span>
                        <span className="sub">{a.recipeKind}</span>
                      </div>
                    </td>
                    <td>{a.format ? <span className="chip">{a.format}</span> : <span className="faint">—</span>}</td>
                    <td className="mono">{a.baseModel}</td>
                    <td>
                      <div className="cell-main">
                        <span>{a.provenance.source}</span>
                        <span className="sub">
                          <ProvenanceValue artifact={a} />
                        </span>
                      </div>
                    </td>
                    <td className="right num">{bytes(a.sizeBytes)}</td>
                    <td className="right muted" title={dateTime(a.createdAt)}>
                      {ago(a.createdAt, now)}
                    </td>
                    <td className="right">
                      <Pinned artifact={a} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {res.data && items.length === 0 && (
          <Empty title="No artifacts yet" icon={<IconArtifacts />}>
            A completed run releases one. Bring your own with <code>grad artifacts upload</code> or <code>grad artifacts import</code>.
          </Empty>
        )}
        {res.data && items.length > 0 && shown.length === 0 && <Empty title="No artifacts match" />}
      </div>
    </div>
  );
};

/** Opens a presigned URL; storage answers with the bundle as an attachment. */
export const openUrl = (url: string): void => {
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener";
  link.click();
};

export const ArtifactDetailPage = ({ id }: { id: string }) => {
  const { client } = useApi();
  const toast = useToast();
  const now = useNow();
  const res = useResource((signal) => client.getArtifact(id, { signal }), [id]);
  const [busy, setBusy] = useState(false);
  const [downloadError, setDownloadError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState(false);
  const a = res.data;

  const download = async () => {
    setBusy(true);
    setDownloadError(null);
    try {
      openUrl((await client.getArtifactDownloadUrl(id)).url);
    } catch (e) {
      setDownloadError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="crumbs">
        <Link href="/artifacts">Artifacts</Link>
        <IconChevron width={12} height={12} />
        <span>{id}</span>
      </div>
      <div className="page-header">
        <div>
          <h1 className="page-title mono">{a ? `${a.name}@${a.version}` : id}</h1>
          {a && (
            <div className="page-sub">
              <span>{a.format ?? "training state"}</span>
              <span className="sep" />
              <span className="mono">{a.baseModel}</span>
              <span className="sep" />
              <span>created {ago(a.createdAt, now)}</span>
            </div>
          )}
        </div>
        {a && (
          <div className="actions">
            <button type="button" className="btn" onClick={() => void download()} disabled={busy}>
              {busy ? <span className="spinner" /> : <IconDownload />}
              Download {bytes(a.sizeBytes)}
            </button>
            <button type="button" className="btn danger" onClick={() => setConfirm(true)}>
              Delete
            </button>
          </div>
        )}
      </div>
      <ErrorBanner error={res.error ?? downloadError} {...(res.error ? { onRetry: res.reload } : {})} />
      {a && (
        <div className="split">
          <div className="stack">
            <Card title="Details">
              <div className="stack">
                <dl className="kv">
                  <Kv label="Format" value={a.format ?? "—"} />
                  <Kv label="Recipe" value={a.recipeKind} />
                  <Kv label="Base model" value={<span className="mono">{a.baseModel}</span>} />
                  <Kv label="Size" value={bytes(a.sizeBytes)} />
                  <Kv label="SHA-256" value={<span className="mono faint">{a.sha256}</span>} />
                  {a.checkpointId && <Kv label="Checkpoint" value={<span className="mono">{a.checkpointId}</span>} />}
                  <Kv label="Created" value={dateTime(a.createdAt)} />
                </dl>
                <Command cmd={`grad artifacts download ${a.name}@${a.version} --output ./${a.name}`} />
              </div>
            </Card>
            <details className="card disclosure" open>
              <summary className="card-header">
                <h2 className="card-title">
                  <IconChevron className="chev" />
                  Manifest
                </h2>
              </summary>
              <pre className="code">{JSON.stringify(a.manifest, null, 2)}</pre>
            </details>
          </div>
          <div className="stack">
            <Card title="Provenance">
              <dl className="kv">
                <Kv label="Source" value={a.provenance.source} />
                {a.provenance.source === "run" && <Kv label="Run" value={<ProvenanceValue artifact={a} />} />}
                {a.provenance.source === "upload" && <Kv label="Uploader" value={<ProvenanceValue artifact={a} />} />}
                {a.provenance.source === "import" && <Kv label="From" value={<ProvenanceValue artifact={a} />} />}
              </dl>
            </Card>
            <Card title="Pins" count={a.pins.length || undefined} tight>
              {a.pins.length === 0 ? (
                <Empty title="Not pinned">Nothing published depends on it, so it can be deleted.</Empty>
              ) : (
                a.pins.map((p) => (
                  <div key={p.holder} className="item">
                    <div className="truncate">
                      <div className="item-name mono">{p.holder}</div>
                      <div className="item-sub">
                        {p.reason} · {ago(p.createdAt, now)}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </Card>
          </div>
        </div>
      )}
      {!a && !res.error && <div className="skeleton" aria-label="Loading artifact" />}
      {a && confirm && (
        <Confirm
          title={`Delete ${a.name}@${a.version}?`}
          confirm="Delete"
          danger
          body={
            a.pins.length > 0 ? (
              <p>It is pinned by {a.pins.map((p) => p.holder).join(", ")}: the server keeps a pinned artifact until it is unpublished.</p>
            ) : (
              <p>Deletes the artifact and its bundle. Runs and evals that used it keep their results. This can't be undone.</p>
            )
          }
          onConfirm={async () => {
            await client.deleteArtifact(a.id);
            toast(`Deleted ${a.name}@${a.version}`);
            navigate("/artifacts");
          }}
          onClose={() => setConfirm(false)}
        />
      )}
    </div>
  );
};
