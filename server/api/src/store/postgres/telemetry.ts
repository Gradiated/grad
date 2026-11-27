import type { TelemetryRepository, TelemetrySnapshot } from "../types.js";
import type { Db } from "./db.js";
import { onlineWorkers } from "./jobs.js";

const num = (v: unknown): number =>
  v === null || v === undefined ? 0 : Number(v);

/**
 * The few aggregate reads behind grad-server's gauges, run once per
 * maintenance tick (a handful of GROUP BYs over open jobs and sources).
 */
export const createTelemetryRepository = (db: Db): TelemetryRepository => ({
  snapshot: async (now, options): Promise<TelemetrySnapshot> => {
    const at = now.toISOString();
    // Open jobs. A queued job whose latest phase event is waiting_for_compute
    // reports that state; a job waiting on another job is blocked. Source
    // syncs (imports whose source names a source_id) are kind `sync`.
    const jobs = await db.query(
      `SELECT CASE WHEN j.kind = 'import' AND j.payload->'source' ? 'source_id' THEN 'sync' ELSE j.kind END AS kind,
              CASE WHEN j.status = 'queued' AND j.waiting_on IS NOT NULL THEN 'blocked'
                   WHEN j.status = 'queued' AND p.phase = 'waiting_for_compute' THEN 'waiting_for_compute'
                   ELSE j.status END AS state,
              ${options.byWorkspace ? "j.workspace_id" : "NULL"} AS workspace_id,
              count(*) AS n,
              count(*) FILTER (WHERE (j.status = 'queued' AND j.waiting_on IS NULL) OR j.worker_id IS NOT NULL) AS open,
              max(EXTRACT(EPOCH FROM ($1::timestamptz - j.updated_at)))
                FILTER (WHERE j.status = 'queued' AND j.waiting_on IS NULL) AS oldest
       FROM grad_jobs j
       LEFT JOIN LATERAL (
         SELECT e.payload->>'phase' AS phase FROM grad_job_events e
         WHERE e.job_id = j.id AND e.type = 'phase' ORDER BY e.seq DESC LIMIT 1
       ) p ON j.status = 'queued'
       WHERE j.status IN ('queued', 'running', 'awaiting_scores') OR j.worker_id IS NOT NULL
       GROUP BY 1, 2, 3`,
      [at],
    );
    // Leased workers and the stats their last heartbeat carried.
    const workers = await db.query(
      `SELECT kind,
              count(DISTINCT worker_id) AS online,
              coalesce(sum((payload->'worker_stats'->>'tokens_per_second')::float8), 0) AS tokens_per_second,
              coalesce(sum((payload->'worker_stats'->>'gpu_memory_used_bytes')::float8), 0) AS gpu_memory,
              avg((payload->'worker_stats'->>'gpu_utilization')::float8) AS gpu_utilization,
              max(EXTRACT(EPOCH FROM ($1::timestamptz - coalesce(billed_at, updated_at))))
                FILTER (WHERE status = 'running') AS flush_lag
       FROM grad_jobs
       WHERE worker_id IS NOT NULL AND lease_expires_at > $1::timestamptz
       GROUP BY kind`,
      [at],
    );
    const phases = await db.query(
      `SELECT kind, payload->'worker_stats'->>'phase' AS phase, count(*) AS n
       FROM grad_jobs
       WHERE worker_id IS NOT NULL AND lease_expires_at > $1::timestamptz
         AND payload->'worker_stats' ? 'phase'
       GROUP BY 1, 2`,
      [at],
    );

    // Fair share: per kind and workspace, the queued jobs its running cap
    // holds back, and how long the next job of each uncapped workspace waits.
    const caps = JSON.stringify(
      options.maxRunning ?? { train: 1e9, import: 1e9, eval: 1e9 },
    );
    const queue = await db.query(
      `WITH s AS (
         SELECT kind, workspace_id,
                count(*) FILTER (WHERE status = 'queued' AND waiting_on IS NULL) AS q,
                count(*) FILTER (WHERE status = 'running') AS r,
                min(updated_at) FILTER (WHERE status = 'queued' AND waiting_on IS NULL) AS oldest,
                coalesce(($2::jsonb ->> kind)::int, 1000000000) AS cap
         FROM grad_jobs WHERE status IN ('queued', 'running')
         GROUP BY kind, workspace_id
       )
       SELECT kind,
              sum(greatest(0, q - greatest(0, cap - r))) AS over_limit,
              max(EXTRACT(EPOCH FROM ($1::timestamptz - oldest))) FILTER (WHERE q > 0 AND r < cap) AS wait
       FROM s GROUP BY kind`,
      [at, caps],
    );
    const unfit = await db.query(
      `WITH online AS (SELECT w.gpu_memory_gb FROM ${onlineWorkers("'train'", "$1")})
       SELECT count(*) AS n FROM grad_jobs j
       WHERE j.kind = 'train' AND j.status = 'queued' AND j.waiting_on IS NULL
         AND j.min_gpu_memory_gb IS NOT NULL
         AND EXISTS (SELECT 1 FROM online)
         AND NOT EXISTS (SELECT 1 FROM online o
                         WHERE o.gpu_memory_gb IS NULL OR o.gpu_memory_gb >= j.min_gpu_memory_gb)`,
      [at],
    );

    // Sync lag: how long an active scheduled source has gone without a
    // successful sync (since its creation when it never synced).
    const sources = await db.query(
      `SELECT provider, count(*) AS n,
              count(*) FILTER (WHERE status = 'paused') AS paused,
              max(consecutive_failures) AS failures,
              max(EXTRACT(EPOCH FROM ($1::timestamptz - coalesce(last_synced_at, created_at))))
                FILTER (WHERE status = 'active' AND schedule IS NOT NULL) AS lag
       FROM grad_sources GROUP BY provider`,
      [at],
    );

    return {
      sources: sources.map((r) => ({
        provider: String(r.provider),
        count: num(r.n),
        paused: num(r.paused),
        max_consecutive_failures: num(r.failures),
        sync_lag_seconds: num(r.lag),
      })),
      jobs: jobs.map((r) => ({
        kind: String(r.kind),
        state: String(r.state),
        workspace_id: r.workspace_id === null ? null : String(r.workspace_id),
        count: num(r.n),
        open: num(r.open),
        oldest_queued_seconds: r.oldest === null ? null : num(r.oldest),
      })),
      workers: workers.map((r) => ({
        kind: String(r.kind),
        online: num(r.online),
        tokens_per_second: num(r.tokens_per_second),
        gpu_memory_used_bytes: num(r.gpu_memory),
        gpu_utilization:
          r.gpu_utilization === null ? null : num(r.gpu_utilization),
        flush_lag_seconds: r.flush_lag === null ? null : num(r.flush_lag),
      })),
      phases: phases.map((r) => ({
        kind: String(r.kind),
        phase: String(r.phase),
        count: num(r.n),
      })),
      queue: queue.map((r) => ({
        kind: String(r.kind),
        over_limit: num(r.over_limit),
        fair_share_wait_seconds: r.wait === null ? null : num(r.wait),
      })),
      unfit: num(unfit[0]?.n),
    };
  },
});
