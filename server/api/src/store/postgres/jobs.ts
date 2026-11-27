import type { Clock } from "../../clock.js";
import { newId } from "../../ids.js";
import { metricKind, metrics } from "../../telemetry/metrics.js";
import { currentTraceparent } from "../../telemetry/tracing.js";
import type {
  IdempotencyInput,
  JobExpectation,
  JobFields,
  JobKind,
  JobPatch,
  JobRepository,
  Page,
  PageRequest,
} from "../types.js";
import {
  expectClause,
  Params,
  setClause,
  type ColumnTypes,
  type Db,
  type Row,
} from "./db.js";
import { toJob } from "./mappers.js";
import { addSecondsIso, first, listNewest, nowIso } from "./shared.js";

/** Record fields stored on grad_jobs (`error` is the last_error column). */
const JOB_FIELDS: Readonly<Record<string, string>> = {
  status: "status",
  attempt: "attempt",
  failed_attempts: "failed_attempts",
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
  metrics.jobDuration.observe(
    {
      kind,
      recipe_kind:
        typeof row.recipe_kind === "string" ? row.recipe_kind : "none",
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
    prefix: string;
    kind: JobKind;
    workspaceId: string;
    maxAttempts: number;
    waitingOn?: string | null | undefined;
    payload?: Record<string, unknown>;
    idempotency?: IdempotencyInput | undefined;
  },
): Promise<string> => {
  const ts = nowIso(clock);
  const id = newId(input.prefix);
  // A worker's requests for this job join the creating request's trace.
  const traceparent = currentTraceparent();
  await db.query(
    `INSERT INTO grad_jobs
       (id, workspace_id, kind, status, max_attempts, waiting_on, payload,
        idempotency_key, request_hash, created_at, updated_at)
     VALUES ($1, $2, $3, 'queued', $4, $5, $6::jsonb, $7, $8, $9::timestamptz, $9::timestamptz)`,
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
    ],
  );

  return id;
};

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
  }) => {
    const row = first(
      await db.query(
        `UPDATE grad_jobs
         SET status = 'running', attempt = attempt + 1, worker_id = $1, worker_key = $8,
             lease_expires_at = $2::timestamptz, lease_seconds = $3, updated_at = $4::timestamptz,
             billed_through = 0, billed_cost = 0, billed_at = $4::timestamptz
         WHERE id = (
           SELECT j.id FROM grad_jobs j
           WHERE j.status = 'queued' AND j.waiting_on IS NULL AND j.kind = ANY($5::text[])
             AND ($6::text IS NULL OR j.workspace_id = $6)
             AND ($7::text[] IS NULL OR j.kind <> 'train'
                  OR EXISTS (SELECT 1 FROM grad_runs r WHERE r.id = j.id AND r.recipe_kind = ANY($7::text[])))
           ORDER BY j.created_at, j.id COLLATE "C"
           LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [
          workerId,
          addSecondsIso(now, leaseSeconds),
          leaseSeconds,
          now.toISOString(),
          [...kinds],
          workspaceId ?? null,
          recipes ? [...recipes] : null,
          workerKey,
        ],
      ),
    );

    return row ? toJob(row) : null;
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
  appendEvent: async ({ jobId, attempt, type, step, payload }) => {
    const toEvent = (r: Row) => ({
      seq: Number(r.seq),
      attempt: Number(r.attempt),
      step: Number(r.step),
      payload: r.payload as Record<string, unknown>,
    });
    const inserted = first(
      await db.query(
        `INSERT INTO grad_job_events (job_id, attempt, type, step, payload, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
         ON CONFLICT (job_id, attempt, type, step) DO NOTHING RETURNING *`,
        [jobId, attempt, type, step, JSON.stringify(payload), nowIso(clock)],
      ),
    );
    if (inserted) return toEvent(inserted);
    const existing = first(
      await db.query(
        `SELECT * FROM grad_job_events
         WHERE job_id = $1 AND attempt = $2 AND type = $3 AND step = $4`,
        [jobId, attempt, type, step],
      ),
    );

    return toEvent(existing ?? { seq: 0, attempt, step, payload });
  },
  listEvents: async (jobId, type, afterSeq, limit) =>
    (
      await db.query(
        `SELECT * FROM grad_job_events WHERE job_id = $1 AND type = $2 AND seq > $3
         ORDER BY seq LIMIT $4`,
        [jobId, type, afterSeq, limit],
      )
    ).map((r) => ({
      seq: Number(r.seq),
      attempt: Number(r.attempt),
      step: Number(r.step),
      payload: r.payload as Record<string, unknown>,
    })),
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
    types: ColumnTypes;
    map: (row: Row) => R;
  },
) => {
  const from = spec.table
    ? `grad_jobs JOIN ${spec.table} USING (id)`
    : "grad_jobs";
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
    list: (workspaceId: string, page: PageRequest): Promise<Page<R>> => {
      const params = new Params();

      return listNewest(db, {
        table: from,
        where: `kind = '${spec.kind}' AND workspace_id = ${params.add(workspaceId)}`,
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
