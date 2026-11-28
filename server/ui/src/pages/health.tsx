import type { ReactNode } from "react";

import type { ImportJob, Run } from "@sdk/generated/models.js";

import { IconCpu, IconEvals, IconImport, IconRuns } from "../components/icons.js";
import { Badge, Banner, Card, Empty, ErrorBanner, Stat, StatusBadge, type Tone } from "../components/ui.js";
import { APIError, useApi } from "../lib/api.js";
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
  const online = queued.map((r) => r.workersOnline).filter((n): n is number => n !== null);
  const oldest = queued.reduce<number | null>((m, r) => Math.max(m ?? 0, now - Date.parse(r.createdAt)), null);
  return {
    kind: "train",
    running: runs.filter((r) => r.status === "running").length,
    queued: queued.length,
    online: online.length ? Math.max(...online) : null,
    autoscaling: queued.some((r) => r.autoscaling === true),
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

export const poolState = (p: PoolView): { label: string; tone: Tone } => {
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

/** A list the key may not read (403): null, so only its section is empty. */
const allowed = <T,>(page: Promise<T>): Promise<T | null> =>
  page.catch((e: unknown) => {
    if (e instanceof APIError && e.status === 403) return null;
    throw e;
  });

/** In-flight jobs per kind and status this page reads; more show as "100+". */
const CAP = 100;

export const HealthPage = () => {
  const { client } = useApi();
  const now = useNow(5000);
  const ready = useResource(readiness, [], { pollMs: 5000 });
  // Only what is in flight, filtered by the server: four small pages every 5 s however many jobs a workspace has finished.
  const work = useResource(
    async (signal) => {
      const [queued, running, imports, evals] = await Promise.all([
        allowed(client.listRuns({ status: "queued", limit: CAP }, { signal })),
        allowed(client.listRuns({ status: "running", limit: CAP }, { signal })),
        allowed(client.listImports({ status: "queued,running", limit: CAP }, { signal })),
        allowed(client.listEvals({ status: "queued,running,awaiting_scores", limit: CAP }, { signal })),
      ]);
      return { queued, running, runs: queued && running ? [...queued.data, ...running.data] : null, imports: imports?.data ?? null, evals };
    },
    [],
    { pollMs: 5000 },
  );
  const d = work.data;
  const train = d?.runs ? trainPool(d.runs, now) : null;
  const imp = d?.imports ? importPool(d.imports, now) : null;
  const evalsRunning = d?.evals?.data.filter((e) => e.status !== "awaiting_scores").length ?? 0;
  const awaiting = d?.evals?.data.filter((e) => e.status === "awaiting_scores").length ?? 0;
  const queuedRuns = [...(d?.queued?.data ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // A key without one of the read scopes still sees the other sections.
  const lacking = d ? [...new Set([!d.runs && "runs:read", !d.imports && "datasets:read", !d.evals && "runs:read"])].filter((x): x is string => Boolean(x)) : [];
  const more = (page: { nextCursor: string | null } | null | undefined) => (page?.nextCursor ? "+" : "");

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Health</h1>
          <div className="page-sub">Server readiness, worker pools and the job queue. Refreshes every 5 seconds.</div>
        </div>
      </div>
      {ready.data && !ready.data.ok && <Banner>grad-server is not ready: {ready.data.detail}</Banner>}
      <ErrorBanner error={work.error} onRetry={work.reload} />
      {lacking.length > 0 && (
        <Banner tone="info">
          This key lacks {lacking.join(", ")}, so the sections that need {lacking.length === 1 ? "it" : "them"} are empty.
        </Banner>
      )}
      <div className="stats">
        <Stat label="Server" value={ready.data ? <Badge tone={ready.data.ok ? "green" : "red"}>{ready.data.ok ? "ready" : "not ready"}</Badge> : "—"} hint={ready.data?.ok ? "database reachable" : ready.data?.detail} />
        <Stat label="Queued runs" value={train ? `${int(train.queued)}${more(d?.queued)}` : "—"} hint={train?.oldestQueuedMs ? `oldest ${duration(train.oldestQueuedMs)}` : "none waiting"} />
        <Stat label="Running runs" value={train ? `${int(train.running)}${more(d?.running)}` : "—"} />
        <Stat label="Imports in flight" value={imp ? int(imp.queued + imp.running) : "—"} />
        <Stat label="Evals in flight" value={d?.evals ? `${int(evalsRunning)}${more(d.evals)}` : "—"} hint={awaiting ? `${awaiting} awaiting local scores` : undefined} />
      </div>
      <div className="grid-2">
        <Card title="Worker pools" tight>
          {train && <Pool icon={<IconCpu />} name="Training" sub="Training workers (kind train)" pool={train} />}
          {imp && <Pool icon={<IconImport />} name="Import" sub="CPU workers (kind import): files, Hugging Face, source syncs" pool={imp} />}
          {d?.evals && (
            <div className="item">
              <span className="item-icon">
                <IconEvals />
              </span>
              <div>
                <div className="item-name">Eval executor</div>
                <div className="item-sub">Eval workers (kind eval) call the inference endpoint</div>
              </div>
              <div className="item-side">
                <div className="big">{int(evalsRunning)}</div>
                <div className="faint small">in flight</div>
              </div>
            </div>
          )}
          {!d && !work.error && (
            <div className="skeleton-block" aria-label="Loading worker pools">
              <div className="skeleton" />
              <div className="skeleton" />
            </div>
          )}
        </Card>
        <Card title="Queue" count={queuedRuns.length ? `${queuedRuns.length}${more(d?.queued)}` : undefined} tight>
          {d?.runs && queuedRuns.length === 0 && (
            <Empty title="Queue is empty" icon={<IconRuns />}>
              Every submitted run has a worker.
            </Empty>
          )}
          {queuedRuns.slice(0, 12).map((r) => {
            return (
              <div key={r.id} className="item">
                <StatusBadge status={r.status} />
                <div className="truncate">
                  <Link className="link" href={`/runs/${encodeURIComponent(r.id)}`}>
                    {r.name}
                  </Link>
                  <div className="item-sub truncate">
                    {r.queueMessage ?? (r.phase ? PHASE_LABEL[r.phase] : "Queued")} · {r.recipeKind} · <span className="mono">{r.resolvedConfig.model}</span>
                  </div>
                </div>
                <div className="item-side muted">{duration(now - Date.parse(r.createdAt))}</div>
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
    <div className="item">
      <span className="item-icon">{icon}</span>
      <div>
        <div className="item-name">
          {name}
          <Badge tone={state.tone} live={state.tone === "blue"}>
            {state.label}
          </Badge>
        </div>
        <div className="item-sub">{sub}</div>
      </div>
      <div className="item-side">
        <div className="big">
          {int(pool.online !== null ? Math.max(pool.online, pool.running) : pool.running)}
          {pool.queued > 0 && <span className="faint small"> +{pool.queued} queued</span>}
        </div>
        <div className="faint small">{pool.online !== null ? "workers online" : "busy workers"}</div>
      </div>
    </div>
  );
};
