import type { z } from "@hono/zod-openapi";

import type { AuthPrincipal } from "../adapters.js";
import { benchmarkMetadata, benchmarkSource } from "../benchmarks.js";
import type {
  Artifact,
  ArtifactImport,
  CreateImportRequestSchema,
  ImportJob,
  TrainerJob,
  UploadTicket,
} from "../contracts.js";
import type {
  CompleteJobRequestSchema,
  RegisterImportPartRequestSchema,
  WorkerUploadRequestSchema,
} from "../contracts/trainer-jobs.js";
import type { AppDependencies } from "../deps.js";
import { conflict, errorMessage, isTransient, notFound } from "../errors.js";
import { log } from "../telemetry/log.js";
import { addSeconds } from "../clock.js";
import { createOnce, type Created } from "../idempotency.js";
import { HF_HOST } from "../secret-hosts.js";
import type {
  IdempotencyInput,
  ImportJobPatch,
  ImportJobRecord,
  JobRow,
  Page,
  ListFilter,
  PageRequest,
} from "../store/types.js";
import {
  toPublicArtifactImport,
  type ArtifactImportService,
} from "./artifact-imports.js";
import { toPublicArtifact } from "./artifacts.js";
import type { DatasetService } from "./datasets.js";
import {
  fenceOf,
  closedBy,
  holdsLease,
  leaseLost,
  observeInterruption,
  RELEASE,
  requeuePatch,
  type JobKindHandler,
  type JobQueue,
} from "./jobs.js";
import {
  isSyncPayload,
  type SecretUse,
  type SourceService,
} from "./sources.js";
import {
  artifactKey,
  jobBlobKey,
  stagingKey,
  type UploadService,
} from "./uploads.js";
import { metricKind, metrics } from "../telemetry/metrics.js";

/** Records a worker posted (counted once per batch), and a sync's split. */
const observePart = (job: ImportJobRecord, part: PartBody): void => {
  const kind = metricKind(job);
  metrics.importRecords.inc({ kind, result: "accepted" }, part.records);
  if (kind !== "sync") return;
  const provider = String(job.source.provider ?? "unknown");
  metrics.sourceRecords.inc({ provider }, part.records - part.score_updates);
  metrics.sourceScoreUpdates.inc({ provider }, part.score_updates);
};

/** HF imports send their token to the Hugging Face Hub only. */
const HF_USE: SecretUse = { url: `https://${HF_HOST}`, use: "HF import" };

type CreateImportBody = z.infer<typeof CreateImportRequestSchema>;
type PartBody = z.infer<typeof RegisterImportPartRequestSchema>;
type UploadBody = z.infer<typeof WorkerUploadRequestSchema>;
type CompleteBody = z.infer<typeof CompleteJobRequestSchema>;

const MAX_DROP_REASONS = 101;

export const toPublicImport = (job: ImportJobRecord): ImportJob => ({
  id: job.id,
  workspace_id: job.workspace_id,
  dataset: job.dataset,
  status: job.status,
  source: job.source,
  connector: job.connector,
  attempt: job.attempt,
  imported_count: job.imported_count,
  dropped_count: job.dropped_count,
  detected_scores: job.detected_scores,
  drop_reasons: job.drop_reasons,
  dataset_version: job.dataset_version,
  error: job.error,
  created_at: job.created_at,
  updated_at: job.updated_at,
});

export interface ImportService {
  create(
    workspaceId: string,
    datasetName: string,
    body: CreateImportBody,
    idempotency?: IdempotencyInput,
  ): Promise<Created<ImportJob>>;
  get(workspaceId: string, id: string): Promise<ImportJob>;
  list(
    workspaceId: string,
    query: PageRequest & ListFilter,
  ): Promise<Page<ImportJob>>;
  /** A presigned PUT for one gzip JSONL part of the import attempt the worker holds. */
  createUpload(
    principal: AuthPrincipal,
    id: string,
    body: UploadBody,
  ): Promise<UploadTicket>;
  /**
   * Stages an uploaded part once per (job, attempt, seq): grad-server checks
   * the object (prefix, size, checksum) and never reads the records.
   */
  registerPart(
    principal: AuthPrincipal,
    id: string,
    body: PartBody,
  ): Promise<{ staged: boolean }>;
  /** A dataset import's final state, or an artifact import's and its artifact. */
  complete(
    principal: AuthPrincipal,
    id: string,
    body: CompleteBody,
  ): Promise<
    | { import: ImportJob; artifactImport: null; artifact: null }
    | {
        import: null;
        artifactImport: ArtifactImport;
        artifact: Artifact | null;
      }
  >;
  /** The import kind's hooks in the job queue. */
  handler: JobKindHandler;
}

export const createImportService = (
  deps: AppDependencies,
  collaborators: {
    uploads: UploadService;
    sources: SourceService;
    datasets: Pick<DatasetService, "settleCount">;
    artifactImports: ArtifactImportService;
    queue: () => JobQueue;
  },
): ImportService => {
  const { store, storage, clock, settings } = deps;
  const { uploads } = collaborators;

  const load = async (id: string): Promise<ImportJobRecord> => {
    const job = await store.imports.getById(id);
    if (!job) throw notFound("trainer_job", id);

    return job;
  };

  const deleteObjects = async (keys: readonly string[]): Promise<void> => {
    // Best effort: the orphaned-blob sweep deletes what this misses.
    for (const key of keys) {
      await storage.delete(key).catch((error: unknown) => {
        log("warn", "staged import part not deleted", { key, error });
      });
    }
  };

  /** Closes the attempt; a terminal failure drops the staged parts. */
  const close = async (
    job: Pick<JobRow, "id" | "worker_id" | "attempt">,
    patch: ImportJobPatch,
    extra: { leaseExpiredBefore?: string } = {},
  ): Promise<ImportJobRecord> => {
    // The status, the discarded rows and the source's failure count commit
    // together; the objects go after (the orphaned-blob sweep backs it up).
    const { updated, discarded } = await store.transaction(async () => {
      const closed = await store.imports.update(
        job.id,
        { ...RELEASE, ...patch },
        { ...fenceOf(job, ["running"]), ...extra },
      );
      if (!closed) throw leaseLost(job.id);
      if (closed.status !== "failed") return { updated: closed, discarded: [] };
      const keys = await store.datasets.discardStaged(job.id);
      if (isSyncPayload(closed.source)) {
        await collaborators.sources.failSync(closed);
      }
      return { updated: closed, discarded: keys };
    });
    await deleteObjects(discarded);

    return updated;
  };

  /**
   * The source a worker gets: uploads with a download URL; source syncs and
   * gated HF datasets with their workspace secret (only in this response).
   */
  const claimSource = async (
    job: ImportJobRecord,
  ): Promise<Record<string, unknown>> => {
    if (job.upload_key !== null) {
      return {
        ...job.source,
        download_url: await uploads.downloadUrl(job.upload_key),
      };
    }
    if (isSyncPayload(job.source))
      return collaborators.sources.claimPayload(job);
    const secret = job.source.kind === "hf" ? job.source.secret : undefined;
    if (typeof secret === "string") {
      return {
        ...job.source,
        token: await collaborators.sources.revealSecret(
          job.workspace_id,
          secret,
          HF_USE,
        ),
      };
    }

    return job.source;
  };

  const handler: JobKindHandler = {
    onClaim: async (row, renewed) => {
      // Counters describe the current attempt; its parts are staged afresh.
      const job = renewed
        ? await load(row.id)
        : await store.imports.update(
            row.id,
            {
              imported_count: 0,
              dropped_count: 0,
              detected_scores: [],
              drop_reasons: [],
            },
            fenceOf(row, ["running"]),
          );
      if (!job) return null;
      let source: Record<string, unknown> = {};
      try {
        if (job.artifact) return await collaborators.artifactImports.claim(job);
        source = await claimSource(job);
      } catch (error) {
        // A transient failure (storage, KMS, the database) requeues it,
        // spending the attempt, and answers the claim with the error so the
        // worker backs off. Unbuildable (source removed, secret gone): fail it,
        // claim the next.
        const now = clock.now().toISOString();
        const message = errorMessage(error);
        const closed = await close(
          job,
          isTransient(error)
            ? requeuePatch(
                job,
                `Attempt ${job.attempt} couldn't start (${message})`,
                now,
              )
            : { status: "failed", finished_at: now, error: message },
        );
        if (closed.status === "queued") throw error;
        return null;
      }

      return {
        id: job.id,
        kind: "import",
        attempt: job.attempt,
        lease_seconds: job.lease_seconds,
        lease_expires_at: job.lease_expires_at as string,
        run: null,
        import: {
          id: job.id,
          workspace_id: job.workspace_id,
          dataset: job.dataset,
          source,
          connector: job.connector,
        },
        eval: null,
        price_per_million_tokens: null,
        max_cost_usd: null,
        dataset: null,
        resume: null,
        base: null,
      } satisfies TrainerJob;
    },
    onLeaseLost: async (job, fence, now) => {
      await close(
        job,
        requeuePatch(
          job,
          `Attempt ${job.attempt} lost its lease`,
          now.toISOString(),
        ),
        { leaseExpiredBefore: fence.leaseExpiredBefore as string },
      );
    },
  };

  return {
    handler,

    create: async (workspaceId, datasetName, body, idempotency) =>
      createOnce(
        idempotency,
        (key) => store.jobs.findIdempotent(workspaceId, key),
        async (id) => {
          const job = await store.imports.get(workspaceId, id);
          if (!job) throw notFound("import", id);
          return toPublicImport(job);
        },
        async () => {
          const dataset = await store.datasets.getOrCreate({
            workspaceId,
            name: datasetName,
            metadata: {},
          });
          const common = {
            workspaceId,
            maxAttempts: settings.maxAttempts,
            maxQueued: settings.queue.maxQueued,
            datasetId: dataset.id,
            datasetName: dataset.name,
            connector: body.connector,
            idempotency,
          };
          if (body.source.kind === "hf" || body.source.kind === "benchmark") {
            if (body.source.kind === "hf" && body.source.secret !== undefined) {
              await collaborators.sources.requireSecret(
                workspaceId,
                body.source.secret,
                HF_USE,
              );
            }
            return toPublicImport(
              await store.imports.create({
                ...common,
                source:
                  body.source.kind === "hf"
                    ? { ...body.source }
                    : benchmarkSource(body.source.benchmark, body.source.limit),
                uploadKey: null,
              }),
            );
          }

          const blob = await uploads.commit(body.source.upload_id, (sha) =>
            stagingKey(workspaceId, sha),
          );
          // A file is imported into a dataset once: a retry gets that import.
          const imported = () =>
            store.imports.findByUpload(dataset.id, blob.sha256);
          const existing = await imported();
          if (existing) return toPublicImport(existing);

          return toPublicImport(
            await store.imports
              .create({
                ...common,
                source: {
                  kind: "upload",
                  upload_id: blob.sha256,
                  format: body.source.format,
                  size_bytes: blob.sizeBytes,
                  sha256: blob.sha256,
                },
                uploadKey: blob.key,
              })
              .catch(async (error: unknown) => {
                const raced = await imported();
                if (!raced) throw error;
                return raced;
              }),
          );
        },
      ),

    get: async (workspaceId, id) => {
      const job = await store.imports.get(workspaceId, id);
      if (!job || job.artifact) throw notFound("import", id);

      return toPublicImport(job);
    },

    list: async (workspaceId, { limit, cursor, ...filter }) => {
      const result = await store.imports.list(
        workspaceId,
        { limit, cursor },
        filter,
      );

      return {
        data: result.data.map(toPublicImport),
        next_cursor: result.next_cursor,
      };
    },

    createUpload: async (principal, id, body) => {
      await collaborators
        .queue()
        .loadLeased(principal, id, body.worker_id, body.attempt);
      const job = await load(id);
      // An artifact import uploads its bundle to the released-artifacts
      // prefix; a dataset import uploads gzip JSONL parts.
      const wants = job.artifact ? "artifact" : "records";
      if (body.kind !== wants) {
        throw conflict(
          "wrong_job_kind",
          job.artifact
            ? "Artifact imports upload their bundle (kind artifact)."
            : "Dataset imports upload records parts (kind records).",
        );
      }

      return uploads.ticket(
        job.artifact
          ? artifactKey(job.workspace_id, body.sha256)
          : jobBlobKey(job, job.attempt, body.sha256),
        body.size_bytes,
      );
    },

    registerPart: async (principal, id, body) => {
      await collaborators
        .queue()
        .loadLeased(principal, id, body.worker_id, body.attempt);
      const job = await load(id);
      if (job.artifact) {
        throw conflict("wrong_job_kind", "Artifact imports stage no parts.");
      }
      const blob = await uploads.commit(body.upload_id, (sha) =>
        jobBlobKey(job, job.attempt, sha),
      );
      // Staged once per (job, attempt, batch): a worker retry adds nothing.
      const staged = await store.datasets.stagePart({
        datasetId: job.dataset_id,
        jobId: job.id,
        attempt: job.attempt,
        batch: body.seq,
        part: {
          key: blob.key,
          count: body.count,
          resets: body.resets,
          sha256: body.sha256,
          bytes: blob.sizeBytes,
        },
        dropped: 0,
      });
      const updated = await store.imports.update(
        id,
        {
          // Progress only: completion recounts from the staged parts.
          ...(staged
            ? { imported_count: job.imported_count + body.count }
            : {}),
          detected_scores: [
            ...new Set([...job.detected_scores, ...body.detected_scores]),
          ].sort(),
          lease_expires_at: addSeconds(
            clock.now(),
            job.lease_seconds,
          ).toISOString(),
        },
        {
          workerId: body.worker_id,
          attempt: body.attempt,
          status: ["running"],
        },
      );
      if (!updated) throw leaseLost(id);
      if (staged) {
        observePart(job, body);
        metrics.partBytes.inc({ form: "compressed" }, blob.sizeBytes);
      }

      return { staged };
    },

    complete: async (principal, id, body) => {
      const row = await collaborators.queue().loadForWorker(principal, id);
      const job = await load(row.id);
      const done = async (
        final: ImportJobRecord,
        artifact?: Artifact | null,
      ) =>
        final.artifact
          ? {
              import: null,
              artifactImport: toPublicArtifactImport({
                ...final,
                artifact: final.artifact,
              }),
              artifact:
                artifact !== undefined
                  ? artifact
                  : final.artifact.artifact_id
                    ? await store.artifacts
                        .get(final.workspace_id, final.artifact.artifact_id)
                        .then((a) => (a ? toPublicArtifact(a) : null))
                    : null,
            }
          : {
              import: toPublicImport(final),
              artifactImport: null,
              artifact: null,
            };
      if (!holdsLease(principal, job, body.worker_id, body.attempt)) {
        // Idempotent retry of a completion that already committed.
        if (closedBy(principal, job, body.attempt)) {
          return done(job);
        }
        throw leaseLost(id);
      }

      const now = clock.now().toISOString();
      if (body.status === "abandoned") {
        observeInterruption(job, body.reason ?? "worker_error");
      }
      if (body.status !== "completed") {
        return done(
          await close(
            job,
            body.status === "abandoned"
              ? requeuePatch(
                  job,
                  `Attempt ${job.attempt} was abandoned by its worker`,
                  now,
                  body.reason === "compute_reclaimed"
                    ? {
                        maxPreemptions: settings.maxPreemptions,
                      }
                    : undefined,
                )
              : {
                  status: "failed",
                  finished_at: now,
                  error:
                    body.error ??
                    `The import worker reported '${body.status}'.`,
                  ...(job.artifact
                    ? {
                        artifact: {
                          ...job.artifact,
                          error_code: body.error_code ?? null,
                        },
                      }
                    : {}),
                },
          ),
        );
      }
      if (job.artifact) {
        const published = await collaborators.artifactImports.publish(
          job,
          body,
        );
        return done(published.job, published.artifact);
      }

      const summary = body.import_summary ?? {
        dropped_count: 0,
        detected_scores: [],
        drop_reasons: [],
      };
      const staged = await store.datasets.listStaged(job.id, job.attempt);
      const sync = isSyncPayload(job.source);
      const sourceId = sync ? String(job.source.source_id) : undefined;
      const { completed, orphans, dataset } = await store.transaction(
        async () => {
          const benchmark = benchmarkMetadata(job.source);
          // A scheduled sync's parts may wait for the source's next version.
          const deferred =
            sourceId !== undefined &&
            (await collaborators.sources.defersVersion(job, staged.count));
          const { dataset, orphanKeys, created } = deferred
            ? {
                ...(await store.datasets.deferStaged({
                  jobId: job.id,
                  attempt: job.attempt,
                  sourceId,
                })),
                dataset: null,
                created: false,
              }
            : await store.datasets.commitStaged({
                datasetId: job.dataset_id,
                jobId: job.id,
                attempt: job.attempt,
                ...(benchmark ? { metadata: benchmark } : {}),
                // A sync that found nothing new adds no empty version.
                keepVersionIfEmpty: sync,
                ...(sourceId !== undefined ? { sourceId } : {}),
              });
          const updated = await store.imports.update(
            id,
            {
              ...RELEASE,
              status: "completed",
              finished_at: now,
              imported_count: staged.count,
              dropped_count: staged.dropped + summary.dropped_count,
              detected_scores: [
                ...new Set([
                  ...job.detected_scores,
                  ...summary.detected_scores,
                ]),
              ].sort(),
              drop_reasons: [
                ...job.drop_reasons,
                ...summary.drop_reasons,
              ].slice(0, MAX_DROP_REASONS),
              // Null while a scheduled sync's parts wait for the next version.
              dataset_version: dataset?.version ?? null,
              error: null,
            },
            fenceOf(job, ["running"]),
          );
          if (!updated) throw leaseLost(id);
          if (sync) {
            await collaborators.sources.completeSync(job, summary, {
              records: staged.count,
              deferred,
              versioned: created,
            });
          }

          return { completed: updated, orphans: orphanKeys, dataset };
        },
      );
      // Parts staged by earlier attempts are never visible: drop them.
      await deleteObjects(orphans);
      // Synced or imported ids may already be in the dataset (an updated
      // trace, a re-import). Best effort: the next writer settles it again.
      if (
        dataset &&
        staged.count > 0 &&
        (dataset.version > 1 || staged.parts.length > 1)
      ) {
        await collaborators.datasets
          .settleCount(dataset)
          .catch((error: unknown) => {
            log("warn", "dataset record count not settled", {
              dataset_id: dataset.id,
              error,
            });
          });
      }

      return done(completed);
    },
  };
};
