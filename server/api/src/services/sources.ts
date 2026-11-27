import type { z } from "@hono/zod-openapi";

import type { AuthPrincipal, TracesPage } from "../adapters.js";
import {
  SOURCE_PROVIDERS,
  type CreateSourceRequestSchema,
  type ImportJob,
  type Secret,
  type Source,
  type SourceProviderKind,
} from "../contracts.js";
import { CronError, parseCron } from "../cron.js";
import type { AppDependencies } from "../deps.js";
import { conflict, invalid, notFound, unavailable } from "../errors.js";
import { createOnce, type Created } from "../idempotency.js";
import { secretsUnavailable, type SecretsCipher } from "../secrets.js";
import type {
  IdempotencyInput,
  ImportJobRecord,
  Page,
  PageRequest,
  Repositories,
  SourceRecord,
} from "../store/types.js";
import { toPublicImport } from "./imports.js";
import type { JobQueue } from "./jobs.js";

type CreateSourceBody = z.infer<typeof CreateSourceRequestSchema>;

/** The `source` payload of a sync's import job (no secret: that is added at claim). */
export interface SyncPayload {
  kind: "provider";
  source_id: string;
  provider: SourceProviderKind;
  full: boolean;
}

export const isSyncPayload = (source: Record<string, unknown>): boolean =>
  source.kind === "provider" && typeof source.source_id === "string";

/** Sources due per tick and replica; the rest wait for the next tick. */
const TICK_BATCH = 50;

const ACTIVE = new Set(["queued", "running"]);

/** A source starts at most one sync per minute (manual or scheduled). */
export const MIN_SYNC_INTERVAL_SECONDS = 60;
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
export interface SyncRequest {
  job: ImportJob;
  /** Seconds until a new sync may start; null when this one is new or active. */
  retryAfter: number | null;
}

export interface SourceService {
  setSecret(workspaceId: string, name: string, value: string): Promise<Secret>;
  getSecret(workspaceId: string, name: string): Promise<Secret>;
  listSecrets(workspaceId: string, page: PageRequest): Promise<Page<Secret>>;
  deleteSecret(workspaceId: string, name: string): Promise<void>;
  /** 422 secret_not_found unless `name` exists (and secrets are configured). */
  requireSecret(workspaceId: string, name: string): Promise<void>;
  /** Plaintext for a worker claim (HF tokens, provider keys). Never log it. */
  revealSecret(workspaceId: string, name: string): Promise<string>;

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
    tx: Repositories,
    job: ImportJobRecord,
    watermark: Record<string, unknown> | null | undefined,
  ): Promise<void>;
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
    "The 'gradiated' source reads traces recorded by the Gradiated Cloud gateway, so it is only available on Gradiated Cloud. On a self-hosted server, connect your observability tool instead (langfuse, langsmith, braintrust, posthog or phoenix).",
  );

export const createSourceService = (
  deps: AppDependencies,
  collaborators: { queue: () => JobQueue },
): SourceService => {
  const { store, clock, settings } = deps;

  const cipher = (): SecretsCipher => {
    if (!deps.secrets) throw secretsUnavailable();

    return deps.secrets;
  };

  const revealSecret = async (workspaceId: string, name: string) => {
    const sealed = await store.secrets.getSealed(workspaceId, name);
    if (!sealed) throw notFound("secret", name);

    return cipher().open(workspaceId, name, sealed);
  };

  const requireSecret = async (workspaceId: string, name: string) => {
    cipher();
    if (!(await store.secrets.get(workspaceId, name))) {
      throw invalid(
        "secret_not_found",
        `No secret named '${name}' in this workspace. Store it first with 'grad secrets set ${name}' (the value is read from stdin).`,
      );
    }
  };

  const lastSync = async (
    repos: Repositories,
    source: SourceRecord,
  ): Promise<ImportJobRecord | null> =>
    source.sync_job_id
      ? repos.imports.get(source.workspace_id, source.sync_job_id)
      : null;

  const toPublic = async (source: SourceRecord): Promise<Source> => {
    const job = await lastSync(store, source);

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

  /**
   * Inside a transaction holding the source's row lock. At most one sync is
   * queued or running: asking for a full one meanwhile marks it pending. A new
   * one starts at most a minute after the last one did, unless `force` (a
   * pending full sync, queued when the one before it ends).
   */
  const enqueue = async (
    repos: Repositories,
    source: SourceRecord,
    full: boolean,
    force = false,
  ): Promise<{ job: ImportJobRecord; retryAfter: number | null }> => {
    const current = await lastSync(repos, source);
    if (current && ACTIVE.has(current.status)) {
      if (full && current.source.full !== true && !source.pending_full) {
        await repos.sources.update(source.id, { pending_full: true });
      }
      return { job: current, retryAfter: null };
    }
    if (current && !force) {
      const wait =
        Date.parse(current.created_at) +
        MIN_SYNC_INTERVAL_SECONDS * 1000 -
        clock.now().getTime();
      if (wait > 0) return { job: current, retryAfter: Math.ceil(wait / 1000) };
    }

    const payload: SyncPayload = {
      kind: "provider",
      source_id: source.id,
      provider: source.provider,
      full: full || source.pending_full,
    };
    const job = await repos.imports.create({
      workspaceId: source.workspace_id,
      maxAttempts: settings.maxAttempts,
      datasetId: source.dataset_id,
      datasetName: source.dataset,
      source: { ...payload },
      connector: "auto",
      uploadKey: null,
    });
    await repos.sources.update(source.id, {
      sync_job_id: job.id,
      pending_full: false,
    });

    return { job, retryAfter: null };
  };

  /** Active again, with a fresh failure count and schedule. */
  const resume = async (repos: Repositories, source: SourceRecord) => {
    if (source.status !== "paused") return source;
    const resumed = await repos.sources.update(source.id, {
      status: "active",
      paused_reason: null,
      consecutive_failures: 0,
      next_sync_at: nextScheduledSync(source.schedule, clock.now(), 0),
    });

    return resumed ?? source;
  };

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

    if (kind === "gradiated") {
      if (!deps.traces) throw sourceUnavailable();

      return { kind: kind as SourceProviderKind, host: null, secret: null };
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
    if (secret !== null) await requireSecret(workspaceId, secret);

    return { kind: kind as SourceProviderKind, host, secret };
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
    setSecret: async (workspaceId, name, value) => {
      const secret = await store.secrets.put({
        workspaceId,
        name,
        sealed: cipher().seal(workspaceId, name, value),
      });
      // A new key is the usual fix for a paused source: resume its users.
      for (const id of await store.sources.usingSecret(workspaceId, name)) {
        await store.transaction(async (tx) => {
          const locked = await tx.sources.lock(workspaceId, id);
          if (locked) await resume(tx, locked);
        });
      }

      return secret;
    },

    getSecret: async (workspaceId, name) => {
      const secret = await store.secrets.get(workspaceId, name);
      if (!secret) throw notFound("secret", name);

      return secret;
    },

    listSecrets: (workspaceId, page) => store.secrets.list(workspaceId, page),

    deleteSecret: async (workspaceId, name) => {
      const users = await store.sources.usingSecret(workspaceId, name);
      if (users.length > 0) {
        throw conflict(
          "secret_in_use",
          `Secret '${name}' is used by ${users.length === 1 ? "source" : "sources"} ${users.join(", ")}; remove ${users.length === 1 ? "it" : "them"} first.`,
        );
      }
      if (!(await store.secrets.delete(workspaceId, name))) {
        throw notFound("secret", name);
      }
    },

    requireSecret,
    revealSecret,

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
            filters: body.provider.filters ?? {},
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

    remove: async (workspaceId, id) => {
      if (!(await store.sources.delete(workspaceId, id))) {
        throw notFound("source", id);
      }
    },

    sync: async (workspaceId, id, full) => {
      const source = await load(workspaceId, id);
      if (source.provider === "gradiated" && !deps.traces)
        throw sourceUnavailable();

      const { job, retryAfter } = await store.transaction(async (tx) => {
        const locked = await tx.sources.lock(workspaceId, id);
        if (!locked) throw notFound("source", id);

        return enqueue(tx, await resume(tx, locked), full);
      });

      return { job: toPublicImport(job), retryAfter };
    },

    tick: async (now) =>
      store.transaction(async (tx) => {
        const due = await tx.sources.lockDue(now.toISOString(), TICK_BATCH);
        for (const source of due) {
          // Queued, running or started under a minute ago: this firing is skipped.
          await enqueue(tx, source, false);
          await tx.sources.update(source.id, {
            next_sync_at: nextScheduledSync(
              source.schedule,
              now,
              source.consecutive_failures,
            ),
          });
        }

        return due.length;
      }),

    claimPayload: async (job) => {
      const payload = job.source as unknown as SyncPayload;
      const source = await store.sources.getById(payload.source_id);
      if (!source || source.workspace_id !== job.workspace_id) {
        throw new Error(
          `Source ${payload.source_id} was removed; nothing to sync.`,
        );
      }

      const secret = source.secret_name
        ? await revealSecret(source.workspace_id, source.secret_name).catch(
            (error: unknown) => {
              throw new Error(
                `The source's secret '${source.secret_name}' can't be read: ${error instanceof Error ? error.message : String(error)}`,
              );
            },
          )
        : null;

      return {
        kind: "provider",
        source_id: source.id,
        provider: source.provider,
        host: source.host,
        secret,
        project: source.project,
        filters: source.filters,
        watermark: payload.full ? null : source.watermark,
        full: payload.full,
      };
    },

    completeSync: async (tx, job, watermark) => {
      const payload = job.source as unknown as SyncPayload;
      const source = await tx.sources.lock(job.workspace_id, payload.source_id);
      if (!source || source.sync_job_id !== job.id) return;
      const now = clock.now();
      const updated = await tx.sources.update(source.id, {
        last_synced_at: now.toISOString(),
        ...(watermark !== undefined && watermark !== null ? { watermark } : {}),
        last_error: null,
        last_error_at: null,
        consecutive_failures: 0,
        // A backed-off schedule returns to its own pace.
        ...(source.consecutive_failures > 0 && source.status === "active"
          ? { next_sync_at: nextScheduledSync(source.schedule, now, 0) }
          : {}),
      });
      if (updated?.pending_full) await enqueue(tx, updated, true, true);
    },

    failSync: async (job) => {
      const payload = job.source as unknown as SyncPayload;
      await store.transaction(async (tx) => {
        const source = await tx.sources.lock(
          job.workspace_id,
          payload.source_id,
        );
        if (!source || source.sync_job_id !== job.id) return;
        const now = clock.now();
        const failures = source.consecutive_failures + 1;
        const paused = failures >= PAUSE_AFTER_FAILURES;
        const updated = await tx.sources.update(source.id, {
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
        if (updated?.pending_full) await enqueue(tx, updated, true, true);
      });
    },

    pullTracesFor: async (principal, jobId, { worker_id, attempt, cursor }) => {
      if (!deps.traces) throw sourceUnavailable();
      await collaborators
        .queue()
        .loadLeased(principal, jobId, worker_id, attempt);
      const job = await store.imports.getById(jobId);
      if (!job) throw notFound("trainer_job", jobId);
      const payload = job.source as unknown as SyncPayload;
      if (!isSyncPayload(job.source) || payload.provider !== "gradiated") {
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
        filter: source.filters,
        cursor,
        limit: 500,
      });
    },
  };
};
