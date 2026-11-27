import { createHash } from "node:crypto";

import type { z } from "@hono/zod-openapi";

import type { AuthPrincipal } from "../adapters.js";
import { benchmarkMetadata, benchmarkSource } from "../benchmarks.js";
import {
  DatasetRecordSchema,
  type CreateImportRequestSchema,
  type DatasetRecord,
  type ImportJob,
  type TrainerJob,
} from "../contracts.js";
import type {
  CompleteJobRequestSchema,
  PostImportRecordsRequestSchema,
} from "../contracts/trainer-jobs.js";
import type { AppDependencies } from "../deps.js";
import { errorMessage, notFound } from "../errors.js";
import { createOnce, type Created } from "../idempotency.js";
import type {
  IdempotencyInput,
  ImportJobPatch,
  ImportJobRecord,
  JobRow,
  Page,
  PageRequest,
} from "../store/types.js";
import { writeRecordsPart } from "./dataset-records.js";
import {
  fenceOf,
  holdsLease,
  leaseLost,
  RELEASE,
  requeuePatch,
  type JobKindHandler,
  type JobQueue,
} from "./jobs.js";
import { isSyncPayload, type SourceService } from "./sources.js";
import { jobBlobKey, stagingKey, type UploadService } from "./uploads.js";

type CreateImportBody = z.infer<typeof CreateImportRequestSchema>;
type RecordsBody = z.infer<typeof PostImportRecordsRequestSchema>;
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
  list(workspaceId: string, page: PageRequest): Promise<Page<ImportJob>>;
  postRecords(
    principal: AuthPrincipal,
    id: string,
    body: RecordsBody,
  ): Promise<{
    accepted: number;
    rejected: number;
    errors: Array<{ index: number; error: string }>;
  }>;
  complete(
    principal: AuthPrincipal,
    id: string,
    body: CompleteBody,
  ): Promise<ImportJob>;
  /** The import kind's hooks in the job queue. */
  handler: JobKindHandler;
}

/** The id of record `index` of batch `seq`: the same on every retry of the batch. */
const batchRecordId = (
  job: { id: string; attempt: number },
  seq: number,
  index: number,
): string =>
  `rec_${createHash("sha256").update(`${job.id}:${job.attempt}:${seq}:${index}`).digest("hex").slice(0, 16)}`;

export const createImportService = (
  deps: AppDependencies,
  collaborators: {
    uploads: UploadService;
    sources: SourceService;
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
    for (const key of keys) await storage.delete(key).catch(() => undefined);
  };

  /** Closes the attempt; a terminal failure drops the staged parts. */
  const close = async (
    job: Pick<JobRow, "id" | "worker_id" | "attempt">,
    patch: ImportJobPatch,
    extra: { leaseExpiredBefore?: string } = {},
  ): Promise<ImportJobRecord> => {
    const updated = await store.imports.update(
      job.id,
      { ...RELEASE, ...patch },
      { ...fenceOf(job, ["running"]), ...extra },
    );
    if (!updated) throw leaseLost(job.id);
    if (updated.status === "failed") {
      await deleteObjects(await store.datasets.discardStaged(job.id));
    }

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
      let source: Record<string, unknown>;
      try {
        source = await claimSource(job);
      } catch (error) {
        // Unbuildable (source removed, secret gone): fail it, claim the next.
        await close(job, {
          status: "failed",
          finished_at: clock.now().toISOString(),
          error: errorMessage(error),
        });
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
      if (!job) throw notFound("import", id);

      return toPublicImport(job);
    },

    list: async (workspaceId, page) => {
      const result = await store.imports.list(workspaceId, page);

      return {
        data: result.data.map(toPublicImport),
        next_cursor: result.next_cursor,
      };
    },

    postRecords: async (principal, id, body) => {
      await collaborators
        .queue()
        .loadLeased(principal, id, body.worker_id, body.attempt);
      const job = await load(id);
      const accepted: DatasetRecord[] = [];
      const errors: Array<{ index: number; error: string }> = [];
      const scores = new Set(job.detected_scores);

      body.records.forEach((raw, index) => {
        const parsed = DatasetRecordSchema.safeParse(raw);
        if (!parsed.success) {
          if (errors.length < 20) {
            errors.push({
              index,
              error: parsed.error.issues
                .slice(0, 3)
                .map((i) => `${i.path.join(".") || "record"}: ${i.message}`)
                .join("; "),
            });
          }
          return;
        }
        // Deterministic ids keep a retried batch byte-identical.
        const record = parsed.data.id
          ? parsed.data
          : { ...parsed.data, id: batchRecordId(job, body.seq, index) };
        Object.keys(record.scores ?? {}).forEach((key) => scores.add(key));
        accepted.push(record);
      });

      const rejected = body.records.length - accepted.length;
      const part =
        accepted.length > 0
          ? await writeRecordsPart(
              storage,
              () =>
                `${jobBlobKey(job, job.attempt, "records")}/${body.seq}.jsonl.gz`,
              accepted,
            )
          : null;
      // Staged once per (job, attempt, batch): a worker retry adds nothing.
      const added = await store.datasets.stagePart({
        datasetId: job.dataset_id,
        jobId: job.id,
        attempt: job.attempt,
        batch: body.seq,
        part,
        dropped: rejected,
      });

      const updated = await store.imports.update(
        id,
        {
          // Progress only: completion recounts from the staged parts.
          ...(added
            ? {
                imported_count: job.imported_count + (part?.count ?? 0),
                dropped_count: job.dropped_count + rejected,
              }
            : {}),
          detected_scores: [...scores].sort(),
          lease_expires_at: new Date(
            clock.now().getTime() + job.lease_seconds * 1000,
          ).toISOString(),
        },
        {
          workerId: body.worker_id,
          attempt: body.attempt,
          status: ["running"],
        },
      );
      if (!updated) throw leaseLost(id);

      return { accepted: accepted.length, rejected, errors };
    },

    complete: async (principal, id, body) => {
      const row = await collaborators.queue().loadForWorker(principal, id);
      const job = await load(row.id);
      if (!holdsLease(principal, job, body.worker_id, body.attempt)) {
        // Idempotent retry of a completion that already committed.
        if (
          job.attempt === body.attempt &&
          job.worker_id === null &&
          job.status !== "queued"
        ) {
          return toPublicImport(job);
        }
        throw leaseLost(id);
      }

      const now = clock.now().toISOString();
      if (body.status !== "completed") {
        return toPublicImport(
          await close(
            job,
            body.status === "abandoned"
              ? requeuePatch(
                  job,
                  `Attempt ${job.attempt} was abandoned by its worker`,
                  now,
                )
              : {
                  status: "failed",
                  finished_at: now,
                  error:
                    body.error ??
                    `The import worker reported '${body.status}'.`,
                },
          ),
        );
      }

      const summary = body.import_summary ?? {
        dropped_count: 0,
        detected_scores: [],
        drop_reasons: [],
      };
      const staged = await store.datasets.listStaged(job.id, job.attempt);
      const { completed, orphans } = await store.transaction(async (tx) => {
        const benchmark = benchmarkMetadata(job.source);
        const { dataset, orphanKeys } = await tx.datasets.commitStaged({
          datasetId: job.dataset_id,
          jobId: job.id,
          attempt: job.attempt,
          ...(benchmark ? { metadata: benchmark } : {}),
        });
        const updated = await tx.imports.update(
          id,
          {
            ...RELEASE,
            status: "completed",
            finished_at: now,
            imported_count: staged.count,
            dropped_count: staged.dropped + summary.dropped_count,
            detected_scores: [
              ...new Set([...job.detected_scores, ...summary.detected_scores]),
            ].sort(),
            drop_reasons: [...job.drop_reasons, ...summary.drop_reasons].slice(
              0,
              MAX_DROP_REASONS,
            ),
            dataset_version: dataset.version,
            error: null,
          },
          fenceOf(job, ["running"]),
        );
        if (!updated) throw leaseLost(id);
        if (isSyncPayload(job.source)) {
          await collaborators.sources.completeSync(tx, job, summary.watermark);
        }

        return { completed: updated, orphans: orphanKeys };
      });
      // Parts staged by earlier attempts are never visible: drop them.
      await deleteObjects(orphans);

      return toPublicImport(completed);
    },
  };
};
