import type { ReactNode } from "react";

import type { ImportJob, Run } from "@sdk/generated/models.js";

import { IconCpu, IconEvals, IconImport } from "../components/icons.js";
import { Banner, Card, Empty, ErrorBanner, Stat, StatusBadge } from "../components/ui.js";
import { lifecycleOf, listAll, useApi } from "../lib/api.js";
import { PHASE_LABEL } from "../lib/events.js";
import { duration, int } from "../lib/format.js";
import { useNow, useResource } from "../lib/hooks.js";
import { Link } from "../lib/router.js";

export interface PoolView {
  kind: string;
  running: number;
  queued: number;
  /** Workers holding a lease, from a queued run's `workers_online` (null when the server doesn't say). */
  online: number | null;
  autoscaling: boolean;
  oldestQueuedMs: number | null;
}

export const trainPool = (runs: Run[], now: number): PoolView => {
  const queued = runs.filter((r) => r.status === "queued");
  const lives = queued.map(lifecycleOf);
  const online = lives.map((l) => l.workersOnline).filter((n): n is number => n !== null);
  const oldest = queued.reduce<number | null>((m, r) => Math.max(m ?? 0, now - Date.parse(r.createdAt)), null);
  return {
    kind: "train",
    running: runs.filter((r) => r.status === "running").length,
    queued: queued.length,
    online: online.length ? Math.max(...online) : null,
    autoscaling: lives.some((l) => l.autoscaling === true),
    oldestQueuedMs: oldest,
  };
};

export const importPool = (jobs: ImportJob[], now: number): PoolView => {
  const queued = jobs.filter((j) => j.status === "queued");
  return {
    kind: "import",
    running: jobs.filter((j) => j.status === "running").length,
    queued: queued.length,
    online: null,
    autoscaling: false,
    oldestQueuedMs: queued.reduce<number | null>((m, j) => Math.max(m ?? 0, now - Date.parse(j.createdAt)), null),
  };
};

export const poolState = (p: PoolView): { label: string; tone: string } => {
  if (p.queued > 0 && p.autoscaling) return { label: "scaling up", tone: "accent" };
  if (p.queued > 0 && p.running === 0 && (p.online ?? 0) === 0) return { label: "no workers", tone: "red" };
  if (p.queued > 0) return { label: "backlog", tone: "amber" };
  if (p.running > 0) return { label: "busy", tone: "blue" };
  return { label: "idle", tone: "green" };
};

const readiness = async (signal: AbortSignal): Promise<{ ok: boolean; detail: string }> => {
  try {
    const res = await fetch("/health/ready", { signal, headers: { accept: "application/json" } });
    if (res.ok) return { ok: true, detail: "ready" };
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    return { ok: false, detail: body.detail ?? `HTTP ${res.status}` };
  } catch (e) {
    if (signal.aborted) throw e;
    return { ok: false, detail: "unreachable" };
  }
};

export const HealthPage = () => {
  const { client } = useApi();
  const now = useNow(5000);
  const ready = useResource(readiness, [], { pollMs: 5000 });
  const work = useResource(
    async (signal) => {
      const [runs, imports, evals] = await Promise.all([
        listAll((cursor) => client.listRuns({ limit: 200, cursor }, { signal }), 1000),
        listAll((cursor) => client.listImports({ limit: 200, cursor }, { signal }), 600),
        listAll((cursor) => client.listEvals({ limit: 200, cursor }, { signal }), 600),
      ]);
      return { runs: runs.items, imports: imports.items, evals: evals.items };
    },
    [],
    { pollMs: 5000 },
  );
  const d = work.data;
  const train = d ? trainPool(d.runs, now) : null;
  const imp = d ? importPool(d.imports, now) : null;
  const evalsRunning = d?.evals.filter((e) => e.status === "running" || e.status === "queued").length ?? 0;
  const awaiting = d?.evals.filter((e) => e.status === "awaiting_scores").length ?? 0;
  const queuedRuns = (d?.runs ?? []).filter((r) => r.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Health</h1>
          <div className="page-sub">Server readiness, worker pools and the job queue. Refreshes every 5 seconds.</div>
        </div>
      </div>
      {ready.data && !ready.data.ok && <Banner>grad-server is not ready: {ready.data.detail}</Banner>}
      <ErrorBanner error={work.error} />
      <div className="stats">
        <Stat label="Server" value={ready.data ? <StatusBadge status={ready.data.ok ? "completed" : "failed"} /> : "—"} hint={ready.data?.ok ? "database reachable" : ready.data?.detail} />
        <Stat label="Queued runs" value={train ? int(train.queued) : "—"} hint={train?.oldestQueuedMs ? `oldest ${duration(train.oldestQueuedMs)}` : "none waiting"} />
        <Stat label="Running runs" value={train ? int(train.running) : "—"} />
        <Stat label="Imports in flight" value={imp ? int(imp.queued + imp.running) : "—"} />
        <Stat label="Evals in flight" value={d ? int(evalsRunning) : "—"} hint={awaiting ? `${awaiting} awaiting local scores` : undefined} />
      </div>
      <div className="grid-2">
        <Card title="Worker pools" tight>
          {train && <Pool icon={<IconCpu />} name="Training" sub="GPU workers (kind train)" pool={train} />}
          {imp && <Pool icon={<IconImport />} name="Import" sub="CPU workers (kind import): files, Hugging Face, source syncs" pool={imp} />}
          {d && (
            <div className="pool">
              <span className="pool-icon">
                <IconEvals />
              </span>
              <div>
                <div className="pool-name">Eval executor</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  Runs inside grad-server against the inference endpoint
                </div>
              </div>
              <div className="pool-value">
                <div className="big">{int(evalsRunning)}</div>
                <div className="faint" style={{ fontSize: 12 }}>
                  in flight
                </div>
              </div>
            </div>
          )}
          {!d && !work.error && (
            <div className="card-body">
              <div className="skeleton" />
            </div>
          )}
        </Card>
        <Card title="Queue" count={queuedRuns.length || undefined} tight>
          {d && queuedRuns.length === 0 && <Empty title="Queue is empty">Every submitted run has a worker.</Empty>}
          {queuedRuns.slice(0, 12).map((r) => {
            const life = lifecycleOf(r);
            return (
              <div key={r.id} className="pool">
                <StatusBadge status={r.status} />
                <div style={{ minWidth: 0 }}>
                  <Link className="link" href={`/runs/${encodeURIComponent(r.id)}`}>
                    {r.name}
                  </Link>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {life.phase ? PHASE_LABEL[life.phase] : "Queued"} · {r.recipeKind} · <span className="mono">{r.resolvedConfig.model}</span>
                  </div>
                </div>
                <div className="pool-value muted">{duration(now - Date.parse(r.createdAt))}</div>
              </div>
            );
          })}
        </Card>
      </div>
    </div>
  );
};

const Pool = ({ icon, name, sub, pool }: { icon: ReactNode; name: string; sub: string; pool: PoolView }) => {
  const state = poolState(pool);
  return (
    <div className="pool">
      <span className="pool-icon">{icon}</span>
      <div style={{ minWidth: 0 }}>
        <div className="pool-name" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {name}
          <span className={`badge ${state.tone}`}>
            <span className="dot" />
            {state.label}
          </span>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {sub}
        </div>
      </div>
      <div className="pool-value">
        <div className="big">
          {int(pool.online !== null ? Math.max(pool.online, pool.running) : pool.running)}
          {pool.queued > 0 && <span className="faint" style={{ fontSize: 13, fontWeight: 500 }}> +{pool.queued} queued</span>}
        </div>
        <div className="faint" style={{ fontSize: 12 }}>
          {pool.online !== null ? "workers online" : "busy workers"}
        </div>
      </div>
    </div>
  );
};
