import type { z } from "@hono/zod-openapi";

import type { AuthPrincipal, TracesPage } from "../adapters.js";
import {
  SOURCE_PROVIDERS,
  type CreateSourceRequestSchema,
  type UpdateSourceRequestSchema,
  type ImportJob,
  type Source,
  type SourceProviderKind,
} from "../contracts.js";
import { CronError, parseCron } from "../cron.js";
import type { AppDependencies } from "../deps.js";
import {
  conflict,
  errorMessage,
  invalid,
  isTransient,
  notFound,
  unavailable,
} from "../errors.js";
import { createOnce, type Created } from "../idempotency.js";
import { PROVIDER_DEFAULT_HOSTS } from "../secret-hosts.js";
import type {
  IdempotencyInput,
  ImportJobRecord,
  Page,
  PageRequest,
  SourcePatch,
  SourceRecord,
  Store,
} from "../store/types.js";
import { log } from "../telemetry/log.js";
import {
  isSyncPayload,
  syncPayloadOf,
  toPublicImport,
  type SyncPayload,
} from "./imports.js";
import type { SecretService } from "./secrets.js";
import { cloudFilters, effectiveFilters } from "./source-filters.js";
import { leased } from "./jobs.js";

type CreateSourceBody = z.infer<typeof CreateSourceRequestSchema>;
type UpdateSourceBody = z.infer<typeof UpdateSourceRequestSchema>;

/** What a completed sync reports back (the import summary's source fields). */
interface SyncSummary {
  watermark?: Record<string, unknown> | null | undefined;
  /** New traces taken: what the record caps count. */
  traces?: number | undefined;
}

/** What the sync's completion did with its parts. */
interface SyncOutcome {
  /** Records the parts added (staged.count). */
  records: number;
  /** The parts wait for the next version (version_interval). */
  deferred: boolean;
  /** A new dataset version was committed. */
  versioned: boolean;
}

/** The UTC day `records_today` counts. */
const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

const recordsToday = (source: SourceRecord, now: Date): number =>
  source.records_day === utcDay(now) ? source.records_today : 0;

/**
 * New traces the next sync may take: the smaller of the per-sync cap and
 * what is left of today's. Null without a cap.
 */
const syncBudget = (source: SourceRecord, now: Date): number | null => {
  const caps = [
    source.max_records_per_sync,
    source.max_records_per_day === null
      ? null
      : Math.max(0, source.max_records_per_day - recordsToday(source, now)),
  ].filter((cap): cap is number => cap !== null);

  return caps.length > 0 ? Math.min(...caps) : null;
};

/** Sources due per transaction; a tick takes up to TICK_BATCHES of them. */
const TICK_BATCH = 50;
/**
 * Batches per tick and replica (1,000 sources per 15 s tick), so a cron
 * minute that many sources share starts them all within a tick or two.
 */
const TICK_BATCHES = 20;

const ACTIVE = new Set(["queued", "running"]);

/** A source starts at most one sync per minute (manual or scheduled). */
const MIN_SYNC_INTERVAL_SECONDS = 60;
/** A failing schedule backs off to at most this. */
export const MAX_BACKOFF_SECONDS = 3600;
/** Consecutive failed syncs that pause a source. */
export const PAUSE_AFTER_FAILURES = 10;
const MAX_ERROR_LENGTH = 2000;

/**
 * When a schedule fires next after `failures` consecutive failed syncs: the
 * cron's next time, pushed out to twice its interval per failure (at most an
 * hour, at least a minute). Null without a schedule.
 */
export const nextScheduledSync = (
  schedule: string | null,
  now: Date,
  failures: number,
): string | null => {
  if (!schedule) return null;
  let cron;
  try {
    cron = parseCron(schedule);
  } catch {
    return null; // validated at create; an unparseable one stops firing
  }
  const next = cron.next(now);
  if (failures <= 0) return next.toISOString();
  const interval = cron.next(next).getTime() - next.getTime();
  const delay = Math.min(
    Math.max(interval * 2 ** failures, MIN_SYNC_INTERVAL_SECONDS * 1000),
    MAX_BACKOFF_SECONDS * 1000,
  );

  return new Date(
    Math.max(next.getTime(), now.getTime() + delay),
  ).toISOString();
};

/** A sync request's job, and how long to wait before asking again. */
interface SyncRequest {
  job: ImportJob;
  /** Seconds until a new sync may start; null when this one is new or active. */
  retryAfter: number | null;
}

/** A paused source active again, with a fresh failure count and schedule (call holding its row lock). */
export const resumeSource = async (
  store: Pick<Store, "sources">,
  now: Date,
  source: SourceRecord,
): Promise<SourceRecord> => {
  if (source.status !== "paused") return source;
  const resumed = await store.sources.update(source.id, {
    status: "active",
    paused_reason: null,
    consecutive_failures: 0,
    next_sync_at: nextScheduledSync(source.schedule, now, 0),
  });

  return resumed ?? source;
};

export interface SourceService {
  create(
    workspaceId: string,
    datasetName: string,
    body: CreateSourceBody,
    idempotency: IdempotencyInput | undefined,
  ): Promise<Created<Source>>;
  get(workspaceId: string, id: string): Promise<Source>;
  list(
    workspaceId: string,
    filter: { dataset?: string | undefined },
    page: PageRequest,
  ): Promise<Page<Source>>;
  /** Changes filters, sampling, caps or the schedule; applies from the next sync. */
  update(
    workspaceId: string,
    id: string,
    body: UpdateSourceBody,
  ): Promise<Source>;
  remove(workspaceId: string, id: string): Promise<void>;
  /**
   * Enqueues a sync (resuming a paused source), or returns the one already
   * queued or running (a full request then runs right after it), or, within
   * a minute of the last sync's start, that sync with `retryAfter`.
   */
  sync(workspaceId: string, id: string, full: boolean): Promise<SyncRequest>;
  /** Enqueues due scheduled syncs (SKIP LOCKED: safe on every replica). */
  tick(now: Date): Promise<number>;

  /** The claim-time source of a sync job: provider config, secret, watermark. */
  claimPayload(job: ImportJobRecord): Promise<Record<string, unknown>>;
  /**
   * In the import's completion transaction: advance the watermark, clear the
   * failure state, queue a pending full sync.
   */
  completeSync(
    job: ImportJobRecord,
    summary: SyncSummary,
    outcome: SyncOutcome,
  ): Promise<void>;
  /**
   * In the completion transaction: whether a sync's parts wait for the next
   * version. Only scheduled incremental syncs wait, until version_interval
   * has passed since the last version or enough records are waiting.
   */
  defersVersion(job: ImportJobRecord, records: number): Promise<boolean>;
  /**
   * A sync ended failed: record the error, back the schedule off, pause the
   * source after PAUSE_AFTER_FAILURES in a row, else queue a pending full sync.
   */
  failSync(job: ImportJobRecord): Promise<void>;
  /** The gradiated provider's next page for the job this worker holds (Cloud only). */
  pullTracesFor(
    principal: AuthPrincipal,
    jobId: string,
    input: { worker_id: string; attempt: number; cursor: string | null },
  ): Promise<TracesPage>;
}

const sourceUnavailable = () =>
  unavailable(
    "source_unavailable",
    "The 'gradiated' source isn't available on this server: it reads traces recorded by the Gradiated Cloud gateway, and is coming soon on Gradiated Cloud. Meanwhile, connect your observability tool instead (langfuse, langsmith, braintrust, posthog or phoenix).",
  );

export const createSourceService = (
  deps: AppDependencies,
  collaborators: { secrets: SecretService },
): SourceService => {
  const { store, clock, settings } = deps;
  const { secrets } = collaborators;

  /** The host a source's requests go to: its own, else the provider's public one. */
  const sourceUrl = (kind: SourceProviderKind, host: string | null) =>
    host ?? PROVIDER_DEFAULT_HOSTS[kind] ?? "";

  const lastSync = async (
    source: SourceRecord,
  ): Promise<ImportJobRecord | null> =>
    source.sync_job_id
      ? store.imports.get(source.workspace_id, source.sync_job_id)
      : null;

  const toPublic = async (source: SourceRecord): Promise<Source> => {
    const job = await lastSync(source);

    return {
      id: source.id,
      workspace_id: source.workspace_id,
      dataset: source.dataset,
      provider: {
        kind: source.provider,
        host: source.host,
        secret: source.secret_name,
        project: source.project,
        filters: source.filters,
      },
      schedule: source.schedule,
      sample_rate: source.sample_rate,
      max_records_per_sync: source.max_records_per_sync,
      max_records_per_day: source.max_records_per_day,
      records_today: recordsToday(source, clock.now()),
      version_interval: source.version_interval,
      pending_records: source.pending_records,
      next_sync_at: source.next_sync_at,
      status: source.status,
      paused_reason: source.paused_reason,
      last_error: source.last_error,
      last_error_at: source.last_error_at,
      consecutive_failures: source.consecutive_failures,
      pending_full: source.pending_full,
      last_synced_at: source.last_synced_at,
      last_sync: job
        ? {
            import_id: job.id,
            status: job.status,
            full: job.source.full === true,
            dataset_version: job.dataset_version,
            error: job.error,
            created_at: job.created_at,
            finished_at: job.finished_at,
          }
        : null,
      created_at: source.created_at,
      updated_at: source.updated_at,
    };
  };

  const load = async (workspaceId: string, id: string) => {
    const source = await store.sources.get(workspaceId, id);
    if (!source) throw notFound("source", id);

    return source;
  };

  /** One transaction's worth of due sources: each enqueued (or skipped) and rescheduled. */
  const tickBatch = (now: Date): Promise<number> =>
    store.transaction(async () => {
      const due = await store.sources.lockDue(now.toISOString(), TICK_BATCH);
      for (const source of due) {
        // One source that can't enqueue (its workspace suspended under it,
        // say) rolls back only its own savepoint, never the whole batch.
        await store
          .transaction(async () => {
            // Queued, running or started under a minute ago: this firing is skipped.
            await enqueue(source, false, false, true);
          })
          .catch((error: unknown) => {
            log("warn", "scheduled source sync not started", {
              source_id: source.id,
              workspace_id: source.workspace_id,
              error,
            });
          });
        await store.sources.update(source.id, {
          next_sync_at: nextScheduledSync(
            source.schedule,
            now,
            source.consecutive_failures,
          ),
        });
      }

      return due.length;
    });

  /**
   * Inside a transaction holding the source's row lock. At most one sync is
   * queued or running: asking for a full one meanwhile marks it pending. A new
   * one starts at most a minute after the last one did, unless `force` (a
   * pending full sync, queued when the one before it ends).
   */
  const enqueue = async (
    source: SourceRecord,
    full: boolean,
    force = false,
    scheduled = false,
  ): Promise<{ job: ImportJobRecord; retryAfter: number | null }> => {
    const current = await lastSync(source);
    if (current && ACTIVE.has(current.status)) {
      if (full && current.source.full !== true && !source.pending_full) {
        await store.sources.update(source.id, { pending_full: true });
      }
      return { job: current, retryAfter: null };
    }
    if (current && !force) {
      const interval = settings.sourceSyncIntervalSeconds;
      const wait =
        Date.parse(current.created_at) +
        interval * 1000 -
        clock.now().getTime();
      if (wait > 0) return { job: current, retryAfter: Math.ceil(wait / 1000) };
    }

    const payload: SyncPayload = {
      kind: "provider",
      source_id: source.id,
      provider: source.provider,
      full: full || source.pending_full,
      ...(scheduled ? { scheduled: true } : {}),
    };
    const job = await store.imports.create({
      workspaceId: source.workspace_id,
      maxAttempts: settings.maxAttempts,
      datasetId: source.dataset_id,
      datasetName: source.dataset,
      source: { ...payload },
      connector: "auto",
      uploadKey: null,
    });
    await store.sources.update(source.id, {
      sync_job_id: job.id,
      pending_full: false,
    });

    return { job, retryAfter: null };
  };

  /**
   * The full sync asked for while `source`'s last one ran, queued as that one
   * closes (inside its transaction). Best effort, under a savepoint: a source
   * paused meanwhile (its workspace suspended, say) keeps pending_full, so
   * its next sync is the full one, and the closing sync commits regardless.
   */
  const enqueuePendingFull = async (source: SourceRecord | null) => {
    if (!source?.pending_full || source.status !== "active") return;
    await store
      .transaction(() => enqueue(source, true, true))
      .catch((error: unknown) => {
        log("warn", "pending full sync not queued", {
          source_id: source.id,
          workspace_id: source.workspace_id,
          error,
        });
      });
  };

  const resume = (source: SourceRecord) =>
    resumeSource(store, clock.now(), source);

  const validateProvider = async (
    workspaceId: string,
    provider: CreateSourceBody["provider"],
  ) => {
    const kind = provider.kind.trim().toLowerCase();
    if (!(SOURCE_PROVIDERS as readonly string[]).includes(kind)) {
      throw invalid(
        "source_provider_unsupported",
        `grad can't sync from '${provider.kind}'. Supported providers: ${SOURCE_PROVIDERS.join(", ")}. For other tools, export traces to a file and import it, or push records with dataset.push().`,
      );
    }

    const filters = effectiveFilters(
      kind as SourceProviderKind,
      provider.filters,
    );
    if (kind === "gradiated") {
      if (!deps.traces) throw sourceUnavailable();

      return {
        kind: kind as SourceProviderKind,
        host: null,
        secret: null,
        filters,
      };
    }

    const host = provider.host ?? null;
    if (host !== null && !/^https?:\/\//i.test(host)) {
      throw invalid(
        "source_host_invalid",
        `The source host must be an http(s) URL, got '${host}'.`,
      );
    }
    if (kind === "phoenix" && host === null) {
      throw invalid(
        "source_host_required",
        "The phoenix source needs a host: your Phoenix Cloud space URL or your self-hosted Phoenix URL.",
      );
    }

    if ((kind === "braintrust" || kind === "posthog") && !provider.project) {
      throw invalid(
        "source_project_required",
        kind === "braintrust"
          ? "The braintrust source needs project: the Braintrust project id or name whose logs to sync."
          : "The posthog source needs project: the numeric PostHog project id (Project settings > Project ID).",
      );
    }

    const secret = provider.secret ?? null;
    if (secret === null && kind !== "phoenix") {
      throw invalid(
        "source_secret_required",
        `The ${kind} source needs a secret holding its API key: store it with 'grad secrets set NAME' and pass secret=NAME.`,
      );
    }
    if (secret !== null) {
      await secrets.require(workspaceId, secret, {
        url: sourceUrl(kind as SourceProviderKind, host),
        use: `${kind} source`,
      });
    }

    return { kind: kind as SourceProviderKind, host, secret, filters };
  };

  const firstRun = (schedule: string | null | undefined) => {
    if (!schedule) return { schedule: null, nextSyncAt: null };
    try {
      const cron = parseCron(schedule);

      return {
        schedule: cron.expression,
        nextSyncAt: cron.next(clock.now()).toISOString(),
      };
    } catch (error) {
      if (error instanceof CronError) {
        throw invalid(
          "invalid_schedule",
          `Invalid schedule '${schedule}': ${error.message}`,
        );
      }
      throw error;
    }
  };

  return {
    create: async (workspaceId, datasetName, body, idempotency) => {
      const created = await createOnce(
        idempotency,
        (key) => store.sources.findIdempotent(workspaceId, key),
        (id) => load(workspaceId, id),
        async () => {
          const provider = await validateProvider(workspaceId, body.provider);
          const { schedule, nextSyncAt } = firstRun(body.schedule);
          const dataset = await store.datasets.getOrCreate({
            workspaceId,
            name: datasetName,
            metadata: {},
          });

          return store.sources.create({
            workspaceId,
            datasetId: dataset.id,
            provider: provider.kind,
            host: provider.host,
            secretName: provider.secret,
            project: body.provider.project ?? null,
            filters: provider.filters,
            sampleRate: body.sample_rate ?? 1,
            maxRecordsPerSync: body.max_records_per_sync ?? null,
            maxRecordsPerDay: body.max_records_per_day ?? null,
            versionInterval:
              body.version_interval ?? settings.sourceVersionIntervalSeconds,
            schedule,
            nextSyncAt,
            idempotency,
          });
        },
      );

      return {
        value: await toPublic(created.value),
        replayed: created.replayed,
      };
    },

    get: async (workspaceId, id) => toPublic(await load(workspaceId, id)),

    list: async (workspaceId, filter, page) => {
      let datasetId: string | undefined;
      if (filter.dataset) {
        const dataset = await store.datasets.get(workspaceId, filter.dataset);
        if (!dataset) return { data: [], next_cursor: null };
        datasetId = dataset.id;
      }
      const result = await store.sources.list(workspaceId, { datasetId }, page);

      return {
        data: await Promise.all(result.data.map(toPublic)),
        next_cursor: result.next_cursor,
      };
    },

    update: async (workspaceId, id, body) => {
      const updated = await store.transaction(async () => {
        const source = await store.sources.lock(workspaceId, id);
        if (!source) throw notFound("source", id);
        const schedule =
          body.schedule === undefined ? undefined : firstRun(body.schedule);

        const patch: SourcePatch = {};
        if (body.filters !== undefined) {
          patch.filters = effectiveFilters(source.provider, body.filters);
        }
        if (body.sample_rate !== undefined)
          patch.sample_rate = body.sample_rate;
        if (body.max_records_per_sync !== undefined) {
          patch.max_records_per_sync = body.max_records_per_sync;
        }
        if (body.max_records_per_day !== undefined) {
          patch.max_records_per_day = body.max_records_per_day;
        }
        if (body.version_interval !== undefined) {
          patch.version_interval = body.version_interval;
        }

        return store.sources.update(source.id, {
          ...patch,
          ...(schedule
            ? {
                schedule: schedule.schedule,
                // A paused source stays paused until it is resumed.
                next_sync_at:
                  source.status === "paused" ? null : schedule.nextSyncAt,
              }
            : {}),
        });
      });
      if (!updated) throw notFound("source", id);

      return toPublic(updated);
    },

    remove: async (workspaceId, id) => {
      const removed = await store.transaction(async () => {
        const source = await store.sources.lock(workspaceId, id);
        if (!source) return false;
        // What scheduled syncs fetched stays: it becomes a last version.
        if (source.pending_records > 0 || source.last_version_at !== null) {
          await store.datasets.commitSettled({
            datasetId: source.dataset_id,
            sourceId: source.id,
          });
        }

        return store.sources.delete(workspaceId, id);
      });
      if (!removed) throw notFound("source", id);
    },

    sync: async (workspaceId, id, full) => {
      const source = await load(workspaceId, id);
      if (source.provider === "gradiated" && !deps.traces)
        throw sourceUnavailable();

      const { job, retryAfter } = await store.transaction(async () => {
        const locked = await store.sources.lock(workspaceId, id);
        if (!locked) throw notFound("source", id);

        return enqueue(await resume(locked), full);
      });

      return { job: toPublicImport(job), retryAfter };
    },

    tick: async (now) => {
      let started = 0;
      for (let i = 0; i < TICK_BATCHES; i += 1) {
        const due = await tickBatch(now);
        started += due;
        if (due < TICK_BATCH) break;
      }

      return started;
    },

    claimPayload: async (job) => {
      const payload = syncPayloadOf(job);
      const source = await store.sources.getById(payload.source_id);
      if (!source || source.workspace_id !== job.workspace_id) {
        throw conflict(
          "source_removed",
          `Source ${payload.source_id} was removed; nothing to sync.`,
        );
      }

      const secret = source.secret_name
        ? await secrets
            .reveal(source.workspace_id, source.secret_name, {
              url: sourceUrl(source.provider, source.host),
              use: `${source.provider} source`,
            })
            .catch((error: unknown) => {
              if (isTransient(error)) throw error;
              throw conflict(
                "secret_unreadable",
                `The source's secret '${source.secret_name}' can't be read: ${errorMessage(error)}`,
              );
            })
        : null;

      return {
        kind: "provider",
        source_id: source.id,
        provider: source.provider,
        host: source.host,
        secret,
        project: source.project,
        filters: source.filters,
        sample_rate: source.sample_rate,
        max_records: syncBudget(source, clock.now()),
        watermark: payload.full ? null : source.watermark,
        full: payload.full,
      };
    },

    defersVersion: async (job, records) => {
      const payload = syncPayloadOf(job);
      if (payload.scheduled !== true || payload.full) return false;
      const source = await store.sources.lock(
        job.workspace_id,
        payload.source_id,
      );
      if (!source || source.version_interval <= 0) return false;
      // The first version, and enough waiting records, commit at once.
      if (source.last_version_at === null) return false;
      const max = settings.sourceVersionMaxRecords;
      if (source.pending_records + records >= max) return false;

      return (
        clock.now().getTime() - Date.parse(source.last_version_at) <
        source.version_interval * 1000
      );
    },

    completeSync: async (job, { watermark, traces }, outcome) => {
      const payload = syncPayloadOf(job);
      const source = await store.sources.lock(
        job.workspace_id,
        payload.source_id,
      );
      if (!source || source.sync_job_id !== job.id) return;
      const now = clock.now();
      const updated = await store.sources.update(source.id, {
        last_synced_at: now.toISOString(),
        ...(watermark !== undefined && watermark !== null ? { watermark } : {}),
        records_today: recordsToday(source, now) + (traces ?? 0),
        records_day: utcDay(now),
        ...(outcome.deferred
          ? { pending_records: source.pending_records + outcome.records }
          : outcome.versioned
            ? { pending_records: 0, last_version_at: now.toISOString() }
            : {}),
        last_error: null,
        last_error_at: null,
        consecutive_failures: 0,
        // A backed-off schedule returns to its own pace.
        ...(source.consecutive_failures > 0 && source.status === "active"
          ? { next_sync_at: nextScheduledSync(source.schedule, now, 0) }
          : {}),
      });
      await enqueuePendingFull(updated);
    },

    failSync: async (job) => {
      const payload = syncPayloadOf(job);
      await store.transaction(async () => {
        const source = await store.sources.lock(
          job.workspace_id,
          payload.source_id,
        );
        if (!source || source.sync_job_id !== job.id) return;
        const now = clock.now();
        const failures = source.consecutive_failures + 1;
        const paused = failures >= PAUSE_AFTER_FAILURES;
        const updated = await store.sources.update(source.id, {
          consecutive_failures: failures,
          // Worker errors are redacted (provider keys never reach them).
          last_error: (job.error ?? "The sync failed.").slice(
            0,
            MAX_ERROR_LENGTH,
          ),
          last_error_at: now.toISOString(),
          ...(paused
            ? {
                status: "paused" as const,
                paused_reason: `${failures} syncs in a row failed. Fix the cause (often the provider key: 'grad secrets set NAME' resumes the source), or run 'grad sources sync ${source.id}' to resume it.`,
                next_sync_at: null,
                pending_full: false,
              }
            : {
                next_sync_at: nextScheduledSync(source.schedule, now, failures),
              }),
        });
        await enqueuePendingFull(updated);
      });
    },

    pullTracesFor: async (principal, jobId, { worker_id, attempt, cursor }) => {
      if (!deps.traces) throw sourceUnavailable();
      const job = leased(principal, jobId, await store.imports.getById(jobId), {
        worker_id,
        attempt,
      });
      const payload = isSyncPayload(job.source) ? job.source : null;
      if (payload?.provider !== "gradiated") {
        throw invalid(
          "source_page_unavailable",
          `Job '${job.id}' is not a gradiated source sync.`,
        );
      }
      const source = await store.sources.getById(payload.source_id);
      if (!source) throw notFound("source", payload.source_id);

      return deps.traces.pull({
        // Always the job's workspace: never anything the worker sends.
        workspaceId: job.workspace_id,
        filter: cloudFilters(source.filters),
        cursor,
        limit: 500,
      });
    },
  };
};
