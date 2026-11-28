import type { Clock } from "../../clock.js";
import { queueLimit, workspaceInactive } from "../../errors.js";
import { newJobId } from "../../ids.js";
import {
  metricKind,
  metrics,
  PREEMPTION_LIMIT_MARK,
} from "../../telemetry/metrics.js";
import { currentTraceparent } from "../../telemetry/tracing.js";
import type {
  IdempotencyInput,
  JobExpectation,
  JobFields,
  JobKind,
  JobPatch,
  JobRepository,
  JobStatus,
  Page,
  PageRequest,
  QueueCaps,
} from "../types.js";
import {
  expectClause,
  Params,
  setClause,
  type ColumnTypes,
  type Db,
  type Row,
} from "./db.js";
import { toEvent, toJob } from "./mappers.js";
import { addSecondsIso, first, listNewest, nowIso } from "./shared.js";

/** Record fields stored on grad_jobs (`error` is the last_error column). */
const JOB_FIELDS: Readonly<Record<string, string>> = {
  status: "status",
  attempt: "attempt",
  failed_attempts: "failed_attempts",
  preemptions: "preemptions",
  max_attempts: "max_attempts",
  worker_id: "worker_id",
  worker_key: "worker_key",
  lease_expires_at: "lease_expires_at",
  lease_seconds: "lease_seconds",
  waiting_on: "waiting_on",
  error: "last_error",
  updated_at: "updated_at",
  finished_at: "finished_at",
};

const JOB_TYPES: ColumnTypes = {
  json: new Set(),
  timestamps: new Set(["lease_expires_at", "updated_at", "finished_at"]),
};

/** Splits a record patch into grad_jobs columns and the rest. */
const splitPatch = (
  patch: Readonly<Record<string, unknown>>,
): { job: Record<string, unknown>; rest: Record<string, unknown> } => {
  const job: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const column = JOB_FIELDS[field];
    if (column) job[column] = value;
    else rest[field] = value;
  }

  return { job, rest };
};

const updateJobRow = async (
  db: Db,
  clock: Clock,
  id: string,
  columns: Record<string, unknown>,
  expect: JobExpectation | undefined,
  payload?: Record<string, unknown>,
): Promise<Row | null> => {
  const params = new Params();
  const sets = setClause(
    { ...columns, updated_at: columns.updated_at ?? nowIso(clock) },
    JOB_TYPES,
    params,
  );
  if (payload && Object.keys(payload).length > 0) {
    sets.push(
      `payload = payload || ${params.add(JSON.stringify(payload))}::jsonb`,
    );
  }
  const where = `id = ${params.add(id)}${expectClause(expect, params)}`;
  const finishing = typeof columns.finished_at === "string";
  const row = first(
    await db.query(
      `UPDATE grad_jobs SET ${sets.join(", ")} WHERE ${where} RETURNING *${
        finishing
          ? ", (SELECT recipe_kind FROM grad_runs r WHERE r.id = grad_jobs.id) AS recipe_kind"
          : ""
      }`,
      params.values,
    ),
  );
  if (row && finishing) observeJobFinished(row);

  return row;
};

/**
 * A failed job's grad_job_failures_total error_code, from its row: the
 * artifact import's code, else whether it ran out of attempts or
 * preemptions, else `job_error` (the worker reported the failure, or the job
 * could not be built).
 */
export const failureCode = (
  job: { failed_attempts: number; max_attempts: number; error: string | null },
  payload: unknown,
): string => {
  const artifact = (payload as { artifact?: { error_code?: unknown } } | null)
    ?.artifact;
  if (
    typeof artifact?.error_code === "string" &&
    FAILURE_CODES.has(artifact.error_code)
  ) {
    return artifact.error_code;
  }
  if (job.failed_attempts >= job.max_attempts) return "attempts_exhausted";
  if (job.error?.includes(PREEMPTION_LIMIT_MARK)) {
    return "preemptions_exhausted";
  }

  return "job_error";
};

const FAILURE_CODES = new Set(["invalid_artifact", "source_unavailable"]);

/** grad_job_duration_seconds for a job that just reached a terminal status. */
const observeJobFinished = (row: Row): void => {
  const job = toJob(row);
  if (!job.finished_at) return;
  const kind = metricKind(job);
  if (kind === "sync") {
    const source = (row.payload as { source?: { provider?: unknown } } | null)
      ?.source;
    metrics.sourceSyncs.inc({
      provider:
        typeof source?.provider === "string" ? source.provider : "unknown",
      status: job.status,
    });
  }
  const recipeKind =
    typeof row.recipe_kind === "string" ? row.recipe_kind : "none";
  if (job.status === "failed") {
    metrics.jobFailures.inc({
      kind,
      recipe_kind: recipeKind,
      error_code: failureCode(job, row.payload),
    });
  }
  metrics.jobDuration.observe(
    {
      kind,
      recipe_kind: recipeKind,
      status: job.status,
    },
    Math.max(
      0,
      (Date.parse(job.finished_at) - Date.parse(job.created_at)) / 1000,
    ),
  );
};

export const insertJob = async (
  db: Db,
  clock: Clock,
  input: {
    kind: JobKind;
    workspaceId: string;
    maxAttempts: number;
    waitingOn?: string | null | undefined;
    payload?: Record<string, unknown>;
    idempotency?: IdempotencyInput | undefined;
    maxQueued?: number | undefined;
    minGpuMemoryGb?: number | null | undefined;
  },
): Promise<string> => {
  await assertWorkspaceActive(db, input.workspaceId);
  if (input.maxQueued !== undefined) {
    await assertQueueRoom(db, input.workspaceId, input.kind, input.maxQueued);
  }
  const ts = nowIso(clock);
  const id = newJobId(input.kind);
  // A worker's requests for this job join the creating request's trace.
  const traceparent = currentTraceparent();
  await db.query(
    `INSERT INTO grad_jobs
       (id, workspace_id, kind, status, max_attempts, waiting_on, payload,
        idempotency_key, request_hash, created_at, updated_at, min_gpu_memory_gb)
     VALUES ($1, $2, $3, 'queued', $4, $5, $6::jsonb, $7, $8, $9::timestamptz, $9::timestamptz, $10)`,
    [
      id,
      input.workspaceId,
      input.kind,
      input.maxAttempts,
      input.waitingOn ?? null,
      JSON.stringify({
        ...(input.payload ?? {}),
        ...(traceparent ? { traceparent } : {}),
      }),
      input.idempotency?.key ?? null,
      input.idempotency?.hash ?? null,
      ts,
      input.minGpuMemoryGb ?? null,
    ],
  );

  return id;
};

/** 403 for a suspended or deleted workspace (Cloud's lifecycle hooks): no new jobs. */
const assertWorkspaceActive = async (
  db: Db,
  workspaceId: string,
): Promise<void> => {
  const row = (
    await db.query(
      `SELECT state FROM grad_workspace_states
        WHERE workspace_id = $1 AND state <> 'active'`,
      [workspaceId],
    )
  )[0];
  if (row) throw workspaceInactive(String(row.state));
};

/** Advisory lock classes (two-key form): serializing per workspace or kind. */
const QUEUED_LOCK = 72_419_031;
const CLAIM_LOCK = 72_419_032;

/**
 * 429 queue_limit once `workspaceId` has `limit` queued jobs. Runs in the
 * insert's transaction under a per-workspace advisory lock, so concurrent
 * creates on several replicas cannot all slip under the cap.
 */
const assertQueueRoom = async (
  db: Db,
  workspaceId: string,
  kind: JobKind,
  limit: number,
): Promise<void> => {
  await db.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
    QUEUED_LOCK,
    workspaceId,
  ]);
  const queued = Number(
    first(
      await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM grad_jobs
         WHERE kind IN ('train', 'import', 'eval') AND status = 'queued' AND workspace_id = $1`,
        [workspaceId],
      ),
    )?.n ?? 0,
  );
  if (queued >= limit) {
    metrics.queueLimitRejections.inc({ kind });
    throw queueLimit(limit);
  }
};

/** No cap: a claim without maxRunning (store tests, tools). */
const UNCAPPED: QueueCaps = { train: 1e9, import: 1e9, eval: 1e9 };

/** A worker may run train job `j` (alias): its recipe and GPU memory fit. */
const fitsWorker = (j: string, recipes: string, gpuMemory: string): string =>
  `(${recipes}::text[] IS NULL OR ${j}.kind <> 'train'
     OR EXISTS (SELECT 1 FROM grad_runs r WHERE r.id = ${j}.id AND r.recipe_kind = ANY(${recipes}::text[])))
   AND (${gpuMemory}::float8 IS NULL OR ${j}.kind <> 'train' OR ${j}.min_gpu_memory_gb IS NULL
     OR ${j}.min_gpu_memory_gb <= ${gpuMemory}::float8)`;

/** A worker counts as online this long after its last claim poll (or while it holds a lease). */
const WORKER_ONLINE_SECONDS = 60;

/** `grad_workers w` rows of online workers of job kind `kind` at `now` (SQL expressions). */
export const onlineWorkers = (kind: string, now: string): string =>
  `grad_workers w WHERE ${kind} = ANY(w.kinds)
     AND (w.last_seen_at > ${now}::timestamptz - make_interval(secs => ${WORKER_ONLINE_SECONDS})
          OR EXISTS (SELECT 1 FROM grad_jobs l
                     WHERE l.worker_id = w.id AND l.lease_expires_at > ${now}::timestamptz))`;

export const createJobRepository = (db: Db, clock: Clock): JobRepository => ({
  getById: async (id) => {
    const row = first(
      await db.query("SELECT * FROM grad_jobs WHERE id = $1", [id]),
    );

    return row ? toJob(row) : null;
  },
  update: async (id, patch, expect) => {
    const row = await updateJobRow(
      db,
      clock,
      id,
      splitPatch(patch).job,
      expect,
    );

    return row ? toJob(row) : null;
  },
  claimNext: async ({
    workerId,
    workerKey,
    leaseSeconds,
    now,
    kinds,
    recipes,
    workspaceId,
    gpuMemoryGb,
    maxRunning,
  }) => {
    const params = [
      [...kinds],
      workspaceId ?? null,
      recipes ? [...recipes] : null,
      gpuMemoryGb ?? null,
    ];
    const claimable = `j.status = 'queued' AND j.waiting_on IS NULL AND j.kind = ANY($1::text[])
      AND ($2::text IS NULL OR j.workspace_id = $2)
      AND ${fitsWorker("j", "$3", "$4")}`;
    // An idle poll of an empty queue takes no lock.
    const any = await db.query(
      `SELECT 1 FROM grad_jobs j WHERE ${claimable} LIMIT 1`,
      params,
    );
    if (any.length === 0) return null;

    // Fair share: among workspaces below their running cap for the kind,
    // the one with the fewest running jobs (ties: its oldest job this worker
    // can run), then that job. A GPU worker first takes runs no smaller
    // online GPU fits (fair share among those), so a big run is never
    // starved by small runs that any worker could take. Claims of a kind take
    // one advisory lock (in kind order, so multi-kind claims cannot
    // deadlock), which makes the running counts and caps exact across
    // replicas; SKIP LOCKED leaves rows another writer (a cancel) holds.
    return db.atomic(async () => {
      for (const kind of [...kinds].sort()) {
        await db.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
          CLAIM_LOCK,
          kind,
        ]);
      }
      const row = first(
        await db.query(
          `WITH RECURSIVE running AS (
             SELECT workspace_id, kind, count(*)::int AS n FROM grad_jobs
             WHERE status = 'running' AND kind = ANY($1::text[])
               AND ($2::text IS NULL OR workspace_id = $2)
             GROUP BY workspace_id, kind
           ), spaces AS (
             -- Each kind's workspaces with queued jobs: a loose index scan,
             -- one probe per workspace however long its queue is.
             -- ('' sorts before every workspace id and names none.)
             SELECT k AS kind, ''::text AS workspace_id FROM unnest($1::text[]) k
             UNION ALL
             SELECT s.kind, (
               SELECT min(workspace_id) FROM grad_jobs
               WHERE kind = s.kind AND status = 'queued' AND workspace_id > s.workspace_id
                 AND ($2::text IS NULL OR workspace_id = $2)
             )
             FROM spaces s WHERE s.workspace_id IS NOT NULL
           ), smallest AS (
             -- The smallest GPU an online train worker has.
             SELECT min(w.gpu_memory_gb) AS gb FROM ${onlineWorkers("'train'", "$10")}
               AND w.gpu_memory_gb IS NOT NULL
           ), heads AS (
             -- Each workspace's oldest job this worker can run.
             SELECT h.* FROM spaces s CROSS JOIN LATERAL (
               SELECT j.id, j.kind, j.workspace_id, j.created_at, j.min_gpu_memory_gb FROM grad_jobs j
               WHERE j.kind = s.kind AND j.workspace_id = s.workspace_id AND ${claimable}
               ORDER BY j.created_at, j.id COLLATE "C" LIMIT 1
             ) h
             WHERE s.workspace_id IS NOT NULL AND s.workspace_id <> ''
           ), pick AS (
             SELECT h.id FROM heads h
             LEFT JOIN running r ON r.workspace_id = h.workspace_id AND r.kind = h.kind
             WHERE coalesce(r.n, 0) < coalesce(($5::jsonb ->> h.kind)::int, 1000000000)
             ORDER BY ($4::float8 IS NOT NULL
                       AND coalesce(h.min_gpu_memory_gb > (SELECT gb FROM smallest), false)) DESC,
                      coalesce(r.n, 0), h.created_at, h.id COLLATE "C"
             LIMIT 1
           ), locked AS (
             SELECT id FROM grad_jobs
             WHERE id = (SELECT id FROM pick) AND status = 'queued'
             FOR UPDATE SKIP LOCKED
           )
           UPDATE grad_jobs
           SET status = 'running', attempt = attempt + 1, worker_id = $6, worker_key = $7,
               lease_expires_at = $8::timestamptz, lease_seconds = $9, updated_at = $10::timestamptz,
               billed_through = 0, billed_cost = 0, billed_at = $10::timestamptz,
               payload = payload - 'worker_stats'
           WHERE id = (SELECT id FROM locked)
           RETURNING *`,
          [
            ...params,
            JSON.stringify(maxRunning ?? UNCAPPED),
            workerId,
            workerKey,
            addSecondsIso(now, leaseSeconds),
            leaseSeconds,
            now.toISOString(),
          ],
        ),
      );

      return row ? toJob(row) : null;
    });
  },
  heldBy: async ({ workerId, workerKey, kinds, workspaceId }) => {
    const row = first(
      await db.query(
        `SELECT * FROM grad_jobs
         WHERE worker_id = $1 AND worker_key = $2
           AND status IN ('running', 'cancelled') AND kind = ANY($3::text[])
           AND ($4::text IS NULL OR workspace_id = $4)
         ORDER BY updated_at DESC LIMIT 1`,
        [workerId, workerKey, [...kinds], workspaceId ?? null],
      ),
    );

    return row ? toJob(row) : null;
  },
  listExpiredLeases: async (now, limit) =>
    (
      await db.query(
        `SELECT * FROM grad_jobs
         WHERE worker_id IS NOT NULL
           AND lease_expires_at + make_interval(secs => lease_seconds / 3.0) < $1::timestamptz
         ORDER BY lease_expires_at LIMIT $2`,
        [now.toISOString(), limit],
      )
    ).map((r) => toJob(r)),
  advanceBilling: async ({ id, attempt, from, through, cost, at }) =>
    (
      await db.query(
        `UPDATE grad_jobs SET billed_through = $4, billed_cost = $5, billed_at = $6::timestamptz
         WHERE id = $1 AND attempt = $2 AND billed_through = $3 RETURNING id`,
        [id, attempt, from, through, cost, at.toISOString()],
      )
    ).length > 0,
  recordWorkerStats: async (id, attempt, stats) => {
    await db.query(
      `UPDATE grad_jobs SET payload = payload || jsonb_build_object('worker_stats', $3::jsonb)
       WHERE id = $1 AND attempt = $2`,
      [id, attempt, JSON.stringify(stats)],
    );
  },
  listWaitingOn: async (jobId) =>
    (
      await db.query(
        `SELECT * FROM grad_jobs WHERE waiting_on = $1 AND status = 'queued'
         ORDER BY created_at, id COLLATE "C"`,
        [jobId],
      )
    ).map((r) => toJob(r)),
  findIdempotent: async (workspaceId, key) =>
    first(
      await db.query<{ id: string; request_hash: string }>(
        "SELECT id, request_hash FROM grad_jobs WHERE workspace_id = $1 AND idempotency_key = $2",
        [workspaceId, key],
      ),
    ),
  appendEvent: async ({ jobId, attempt, type, step, key, payload }) => {
    const natural = key ?? String(step);
    // A job's events commit in seq order: the insert takes the job row's lock
    // (held to the end of the caller's transaction) before it draws a seq. A
    // reader follows a job by `seq > cursor`, so an event that drew a lower
    // seq but committed later (a metric still billing while a checkpoint
    // event commits) would otherwise be skipped by every live stream.
    const inserted = first(
      await db.query(
        `WITH job AS (SELECT id FROM grad_jobs WHERE id = $1 FOR NO KEY UPDATE)
         INSERT INTO grad_job_events (job_id, attempt, type, step, key, payload, created_at)
         SELECT $1::text, $2::int, $3::text, $4::int, $5::text, $6::jsonb, $7::timestamptz
           FROM (SELECT 1) AS one LEFT JOIN job ON true
         ON CONFLICT (job_id, attempt, type, key) DO NOTHING RETURNING *`,
        [
          jobId,
          attempt,
          type,
          step,
          natural,
          JSON.stringify(payload),
          nowIso(clock),
        ],
      ),
    );
    if (inserted) return toEvent(inserted);
    const existing = first(
      await db.query(
        `SELECT * FROM grad_job_events
         WHERE job_id = $1 AND attempt = $2 AND type = $3 AND key = $4`,
        [jobId, attempt, type, natural],
      ),
    );

    return toEvent(
      existing ?? {
        seq: 0,
        attempt,
        type,
        step,
        payload,
        created_at: nowIso(clock),
      },
    );
  },
  listEvents: async (jobId, types, afterSeq, limit) =>
    (
      await db.query(
        `SELECT * FROM grad_job_events WHERE job_id = $1 AND type = ANY($2::text[]) AND seq > $3
         ORDER BY seq LIMIT $4`,
        [
          jobId,
          typeof types === "string" ? [types] : [...types],
          afterSeq,
          limit,
        ],
      )
    ).map(toEvent),
  listEventsSince: async (cursors, limitPerJob) =>
    cursors.length === 0
      ? []
      : (
          await db.query(
            `SELECT e.* FROM unnest($1::text[], $2::bigint[]) AS c(job_id, after_seq)
             CROSS JOIN LATERAL (
               SELECT * FROM grad_job_events
               WHERE job_id = c.job_id AND seq > c.after_seq ORDER BY seq LIMIT $3
             ) e
             ORDER BY e.seq`,
            [
              cursors.map((c) => c.jobId),
              cursors.map((c) => c.afterSeq),
              limitPerJob,
            ],
          )
        ).map((r) => ({ ...toEvent(r), job_id: String(r.job_id) })),
  jobStates: async (ids) =>
    ids.length === 0
      ? []
      : (
          await db.query<{
            id: string;
            status: JobStatus;
            worker_id: string | null;
          }>(
            "SELECT id, status, worker_id FROM grad_jobs WHERE id = ANY($1::text[])",
            [[...ids]],
          )
        ).map((r) => ({ id: r.id, status: r.status, worker_id: r.worker_id })),
  countLeasedWorkers: async (kind, now) =>
    Number(
      first(
        await db.query<{ n: string }>(
          `SELECT count(DISTINCT worker_id) AS n FROM grad_jobs
           WHERE kind = $1 AND worker_id IS NOT NULL AND lease_expires_at > $2::timestamptz`,
          [kind, now.toISOString()],
        ),
      )?.n ?? 0,
    ),
  listUnclaimedSince: async (kind, before, limit, maxRunning) =>
    (
      await db.query(
        `SELECT j.* FROM grad_jobs j
         JOIN LATERAL (
           SELECT e.payload->>'phase' AS phase, e.created_at AS phase_at FROM grad_job_events e
           WHERE e.job_id = j.id AND e.type = 'phase' ORDER BY e.seq DESC LIMIT 1
         ) p ON true
         WHERE j.status = 'queued' AND j.waiting_on IS NULL AND j.kind = $1
           AND p.phase = 'queued' AND p.phase_at < $2::timestamptz
           AND ($4::int IS NULL OR (
             SELECT count(*) FROM grad_jobs r
             WHERE r.kind = j.kind AND r.status = 'running' AND r.workspace_id = j.workspace_id
           ) < $4::int)
         ORDER BY j.created_at, j.id COLLATE "C" LIMIT $3`,
        [kind, before.toISOString(), limit, maxRunning ?? null],
      )
    ).map((r) => toJob(r)),
  seeWorker: async ({ id, kinds, device, gpuMemoryGb, now }) => {
    await db.query(
      `INSERT INTO grad_workers (id, kinds, device, gpu_memory_gb, last_seen_at)
       VALUES ($1, $2::text[], $3, $4, $5::timestamptz)
       ON CONFLICT (id) DO UPDATE
       SET kinds = EXCLUDED.kinds, device = EXCLUDED.device,
           gpu_memory_gb = EXCLUDED.gpu_memory_gb, last_seen_at = EXCLUDED.last_seen_at
       WHERE grad_workers.last_seen_at < EXCLUDED.last_seen_at - interval '10 seconds'
          OR grad_workers.kinds IS DISTINCT FROM EXCLUDED.kinds
          OR grad_workers.device IS DISTINCT FROM EXCLUDED.device
          OR grad_workers.gpu_memory_gb IS DISTINCT FROM EXCLUDED.gpu_memory_gb`,
      [id, [...kinds].sort(), device, gpuMemoryGb, now.toISOString()],
    );
  },
  pruneWorkers: async (before) =>
    (
      await db.query(
        `DELETE FROM grad_workers w WHERE w.last_seen_at < $1::timestamptz
           AND NOT EXISTS (SELECT 1 FROM grad_jobs j WHERE j.worker_id = w.id)
         RETURNING id`,
        [before.toISOString()],
      )
    ).length,
  queueSnapshot: async (kind, ids, now) => {
    const shares = await db.query(
      `SELECT workspace_id,
              count(*) FILTER (WHERE status = 'queued' AND waiting_on IS NULL)::int AS queued,
              count(*) FILTER (WHERE status = 'running')::int AS running,
              min(created_at) FILTER (WHERE status = 'queued' AND waiting_on IS NULL) AS oldest
       FROM grad_jobs WHERE kind = $1 AND status IN ('queued', 'running')
       GROUP BY workspace_id`,
      [kind],
    );
    const ranks =
      ids.length === 0
        ? []
        : await db.query(
            `SELECT j.id, (
               SELECT count(*)::int FROM grad_jobs o
               WHERE o.kind = j.kind AND o.status = 'queued' AND o.waiting_on IS NULL
                 AND o.workspace_id = j.workspace_id
                 AND (o.created_at, o.id COLLATE "C") < (j.created_at, j.id COLLATE "C")
             ) AS rank
             FROM grad_jobs j WHERE j.id = ANY($1::text[])`,
            [[...ids]],
          );
    const workers = await db.query(
      `SELECT w.gpu_memory_gb, w.device FROM ${onlineWorkers("$1", "$2")}`,
      [kind, now.toISOString()],
    );

    return {
      shares: shares.map((r) => ({
        workspace_id: String(r.workspace_id),
        queued: Number(r.queued),
        running: Number(r.running),
        oldest:
          r.oldest === null || r.oldest === undefined
            ? null
            : new Date(r.oldest as string).toISOString(),
      })),
      ranks: Object.fromEntries(
        ranks.map((r) => [String(r.id), Number(r.rank)]),
      ),
      workerGpus: workers.map((r) =>
        r.gpu_memory_gb === null || r.gpu_memory_gb === undefined
          ? null
          : Number(r.gpu_memory_gb),
      ),
      cpuWorkers: workers.filter((r) => r.device === "cpu").length,
    };
  },
  deleteEventsBefore: async (before, limit) =>
    (
      await db.query(
        `DELETE FROM grad_job_events WHERE seq IN (
           SELECT seq FROM grad_job_events WHERE created_at < $1::timestamptz
           ORDER BY seq LIMIT $2)
         RETURNING seq`,
        [before.toISOString(), limit],
      )
    ).length,
});

/**
 * Repository for one job kind whose record is the job row joined with its
 * domain table (runs, evals) or its payload (imports). Updates split the
 * patch: queue fields and the expectation go to grad_jobs, the rest to the
 * domain table or payload, in one transaction.
 */
export const createJobBackedRepository = <R extends JobFields<string>>(
  db: Db,
  clock: Clock,
  spec: {
    kind: JobKind;
    /** null: domain fields live in grad_jobs.payload. */
    table: string | null;
    /** The FROM clause reads use (default: grad_jobs joined with `table`). */
    from?: string;
    types: ColumnTypes;
    map: (row: Row) => R;
  },
) => {
  const from =
    spec.from ??
    (spec.table ? `grad_jobs JOIN ${spec.table} USING (id)` : "grad_jobs");
  const byId = async (where: string, params: unknown[]): Promise<R | null> => {
    const row = first(
      await db.query(
        `SELECT * FROM ${from} WHERE kind = '${spec.kind}' AND ${where}`,
        params,
      ),
    );

    return row ? spec.map(row) : null;
  };

  return {
    get: (workspaceId: string, id: string) =>
      byId("workspace_id = $1 AND id = $2", [workspaceId, id]),
    getById: (id: string) => byId("id = $1", [id]),
    /** `where` over grad_jobs (and the domain table), first match. */
    find: (where: string, params: unknown[]) => byId(where, params),
    /** Every match of `where`, newest first (at most `limit`). */
    findAll: async (
      where: string,
      params: unknown[],
      limit: number,
    ): Promise<R[]> =>
      (
        await db.query(
          `SELECT * FROM ${from} WHERE kind = '${spec.kind}' AND ${where}
           ORDER BY created_at DESC, id COLLATE "C" DESC LIMIT ${Math.trunc(limit)}`,
          params,
        )
      ).map(spec.map),
    /** `where`: an extra condition (constant SQL) on the listed rows. */
    list: (
      workspaceId: string,
      page: PageRequest,
      where?: string,
    ): Promise<Page<R>> => {
      const params = new Params();

      return listNewest(db, {
        table: from,
        where: `kind = '${spec.kind}' AND workspace_id = ${params.add(workspaceId)}${where ? ` AND ${where}` : ""}`,
        params,
        page,
        map: spec.map,
      });
    },
    update: (
      id: string,
      patch: JobPatch<string> & Record<string, unknown>,
      expect?: JobExpectation<string>,
    ): Promise<R | null> =>
      db.atomic(async () => {
        const { job, rest } = splitPatch(patch);
        const updated = await updateJobRow(
          db,
          clock,
          id,
          job,
          expect as JobExpectation | undefined,
          spec.table ? undefined : rest,
        );
        if (!updated) return null;
        if (spec.table && Object.keys(rest).length > 0) {
          const params = new Params();
          const sets = setClause(rest, spec.types, params);
          await db.query(
            `UPDATE ${spec.table} SET ${sets.join(", ")} WHERE id = ${params.add(id)}`,
            params.values,
          );
        }

        return byId("id = $1", [id]);
      }),
    /** Inserts the job row and, with a table, its domain row. */
    insert: (
      job: Parameters<typeof insertJob>[2],
      domain: Record<string, unknown> | null,
    ): Promise<R> =>
      db.atomic(async () => {
        const id = await insertJob(db, clock, job);
        if (spec.table && domain) {
          const params = new Params();
          const columns = ["id", ...Object.keys(domain)];
          const values = [
            params.add(id),
            ...Object.entries(domain).map(([column, value]) =>
              spec.types.json.has(column)
                ? `${params.add(value === null ? null : JSON.stringify(value))}::jsonb`
                : params.add(value),
            ),
          ];
          await db.query(
            `INSERT INTO ${spec.table} (${columns.map((c) => `"${c}"`).join(", ")})
             VALUES (${values.join(", ")})`,
            params.values,
          );
        }
        const created = await byId("id = $1", [id]);
        if (!created) throw new Error(`Job '${id}' vanished.`);

        return created;
      }),
  };
};
