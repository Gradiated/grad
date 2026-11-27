import type { z } from "@hono/zod-openapi";

import type { AuthPrincipal } from "../adapters.js";
import { addSeconds } from "../clock.js";
import {
  DatasetRecordSchema,
  type CreateImportRequestSchema,
  type DatasetRecord,
  type ImportJob,
  type TrainerJob,
} from "../contracts.js";
import type {
  CompleteJobRequestSchema,
  HeartbeatRequestSchema,
  PostImportRecordsRequestSchema,
} from "../contracts/trainer-jobs.js";
import type { AppDependencies } from "../deps.js";
import { ApiError, conflict, notFound } from "../errors.js";
import { newId } from "../ids.js";
import type {
  ImportJobPatch,
  ImportJobRecord,
  Page,
  PageRequest,
} from "../store/types.js";
import { writeRecordsPart } from "./dataset-records.js";
import type { DatasetService } from "./datasets.js";
import { assertWorkerScope } from "./runs.js";
import type { UploadService } from "./uploads.js";

type CreateImportBody = z.infer<typeof CreateImportRequestSchema>;
type HeartbeatBody = z.infer<typeof HeartbeatRequestSchema>;
type RecordsBody = z.infer<typeof PostImportRecordsRequestSchema>;
type CompleteBody = z.infer<typeof CompleteJobRequestSchema>;

const MAX_DROP_REASONS = 101;

export const toPublicImport = ({
  dataset_id: _d,
  upload_key: _u,
  worker_id: _w,
  lease_expires_at: _l,
  lease_seconds: _s,
  failed_attempts: _f,
  ...job
}: ImportJobRecord): ImportJob => job;

export interface ImportService {
  create(
    workspaceId: string,
    datasetName: string,
    body: CreateImportBody,
  ): Promise<ImportJob>;
  get(workspaceId: string, id: string): Promise<ImportJob>;
  list(workspaceId: string, page: PageRequest): Promise<Page<ImportJob>>;

  claim(
    principal: AuthPrincipal,
    input: { workerId: string; leaseSeconds: number },
  ): Promise<TrainerJob | null>;
  heartbeat(
    principal: AuthPrincipal,
    id: string,
    body: HeartbeatBody,
  ): Promise<{
    status: string;
    should_stop: boolean;
    stop_reason: null;
    lease_expires_at: string;
  }>;
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
  expireLeases(now: Date): Promise<number>;
}

const leaseLost = (id: string): ApiError =>
  conflict(
    "lease_lost",
    `This worker no longer holds the lease on job '${id}' (expired, reclaimed, or finished). Stop work on it.`,
  );

export const createImportService = (
  deps: AppDependencies,
  collaborators: { datasets: DatasetService; uploads: UploadService },
): ImportService => {
  const { store, storage, clock, settings } = deps;
  const { uploads } = collaborators;

  const loadLeased = async (
    principal: AuthPrincipal,
    id: string,
    workerId: string,
    attempt: number,
  ): Promise<ImportJobRecord> => {
    const job = await store.imports.getById(id);
    if (!job) throw notFound("trainer_job", id);
    assertWorkerScope(principal, job.workspace_id, id);
    if (job.worker_id !== workerId || job.attempt !== attempt)
      throw leaseLost(id);

    return job;
  };

  const release = (patch: ImportJobPatch): ImportJobPatch => ({
    ...patch,
    worker_id: null,
    lease_expires_at: null,
    updated_at: clock.now().toISOString(),
  });

  return {
    create: async (workspaceId, datasetName, body) => {
      const dataset = await store.datasets.getOrCreate({
        workspaceId,
        name: datasetName,
        metadata: {},
      });

      if (body.source.kind === "hf") {
        const job = await store.imports.create({
          workspaceId,
          datasetId: dataset.id,
          datasetName: dataset.name,
          source: { ...body.source },
          connector: body.connector,
          uploadKey: null,
        });

        return toPublicImport(job);
      }

      const upload = await uploads.load({
        uploadId: body.source.upload_id,
        workspaceId,
        purpose: "dataset_import",
        jobId: null,
        attempt: null,
      });
      await uploads.verify(upload);
      const format = body.source.format;
      const job = await store.transaction(async (tx) => {
        await uploads.consume(tx, upload, `import:${dataset.id}`);

        return tx.imports.create({
          workspaceId,
          datasetId: dataset.id,
          datasetName: dataset.name,
          source: {
            kind: "upload",
            upload_id: upload.id,
            format,
            size_bytes: upload.size_bytes,
            sha256: upload.sha256,
          },
          connector: body.connector,
          uploadKey: upload.storage_key,
        });
      });

      return toPublicImport(job);
    },

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

    claim: async (principal, input) => {
      const job = await store.imports.claimNext({
        workerId: input.workerId,
        leaseSeconds: input.leaseSeconds,
        now: clock.now(),
        workspaceId: principal.workerWorkspaceId ?? undefined,
      });
      if (!job) return null;

      const reset = await store.imports.update(
        job.id,
        {
          imported_count: 0,
          dropped_count: 0,
          detected_scores: [],
          drop_reasons: [],
        },
        { workerId: job.worker_id, attempt: job.attempt },
      );
      const claimed = reset ?? job;
      const source =
        claimed.upload_key !== null
          ? {
              ...claimed.source,
              download_url: await uploads.downloadUrl(claimed.upload_key),
            }
          : claimed.source;

      return {
        id: claimed.id,
        kind: "import",
        attempt: claimed.attempt,
        lease_seconds: claimed.lease_seconds,
        lease_expires_at: claimed.lease_expires_at as string,
        run: null,
        import: {
          id: claimed.id,
          workspace_id: claimed.workspace_id,
          dataset: claimed.dataset,
          source,
          connector: claimed.connector,
        },
        price_per_million_tokens: null,
        max_cost_usd: null,
        dataset: null,
        resume: null,
      };
    },

    heartbeat: async (principal, id, body) => {
      const job = await loadLeased(principal, id, body.worker_id, body.attempt);
      const leaseSeconds = body.lease_seconds ?? job.lease_seconds;
      const leaseExpiresAt = addSeconds(
        clock.now(),
        leaseSeconds,
      ).toISOString();
      const updated = await store.imports.update(
        id,
        { lease_expires_at: leaseExpiresAt, lease_seconds: leaseSeconds },
        {
          workerId: body.worker_id,
          attempt: body.attempt,
          status: ["running"],
        },
      );
      if (!updated) throw leaseLost(id);

      return {
        status: updated.status,
        should_stop: false,
        stop_reason: null,
        lease_expires_at: leaseExpiresAt,
      };
    },

    postRecords: async (principal, id, body) => {
      const job = await loadLeased(principal, id, body.worker_id, body.attempt);
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
        const record = parsed.data.id
          ? parsed.data
          : { ...parsed.data, id: newId("rec").slice(0, 20) };
        Object.keys(record.scores ?? {}).forEach((key) => scores.add(key));
        accepted.push(record);
      });

      const rejected = body.records.length - accepted.length;
      if (accepted.length > 0) {
        const part = await writeRecordsPart(
          storage,
          `imports/${encodeURIComponent(job.workspace_id)}/${job.id}/${job.attempt}/${newId("part")}.jsonl`,
          accepted,
        );
        await store.imports.addPart(job.id, job.attempt, part);
      }

      const updated = await store.imports.update(
        id,
        {
          imported_count: job.imported_count + accepted.length,
          dropped_count: job.dropped_count + rejected,
          detected_scores: [...scores].sort(),
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

      return { accepted: accepted.length, rejected, errors };
    },

    complete: async (principal, id, body) => {
      const job = await store.imports.getById(id);
      if (!job) throw notFound("trainer_job", id);
      assertWorkerScope(principal, job.workspace_id, id);
      if (job.worker_id !== body.worker_id || job.attempt !== body.attempt) {
        if (
          job.attempt === body.attempt &&
          job.worker_id === null &&
          job.status !== "queued"
        ) {
          return toPublicImport(job);
        }
        throw leaseLost(id);
      }

      const summary = body.import_summary ?? {
        dropped_count: 0,
        detected_scores: [],
        drop_reasons: [],
      };
      const expect = {
        workerId: body.worker_id,
        attempt: body.attempt,
        status: ["running" as const],
      };

      if (body.status !== "completed") {
        const patch: ImportJobPatch =
          body.status === "abandoned"
            ? { status: "queued" }
            : {
                status: "failed",
                error:
                  body.error ?? `The import worker reported '${body.status}'.`,
              };
        const updated = await store.imports.update(id, release(patch), expect);
        if (!updated) throw leaseLost(id);

        return toPublicImport(updated);
      }

      const parts = await store.imports.listParts(job.id, job.attempt);
      const completed = await store.transaction(async (tx) => {
        const { version } = await tx.datasets.appendVersion({
          datasetId: job.dataset_id,
          parts,
        });
        const updated = await tx.imports.update(
          id,
          release({
            status: "completed",
            imported_count: parts.reduce((sum, p) => sum + p.count, 0),
            dropped_count: job.dropped_count + summary.dropped_count,
            detected_scores: [
              ...new Set([...job.detected_scores, ...summary.detected_scores]),
            ].sort(),
            drop_reasons: [...job.drop_reasons, ...summary.drop_reasons].slice(
              0,
              MAX_DROP_REASONS,
            ),
            dataset_version: version.version,
            error: null,
          }),
          expect,
        );
        if (!updated) throw leaseLost(id);

        return updated;
      });

      return toPublicImport(completed);
    },

    expireLeases: async (now) => {
      const expired = await store.imports.listExpiredLeases(now, 100);
      let closed = 0;
      for (const job of expired) {
        const failedAttempts = job.failed_attempts + 1;
        const patch: ImportJobPatch =
          failedAttempts >= settings.maxAttempts
            ? {
                status: "failed",
                failed_attempts: failedAttempts,
                error: `The import worker stopped heartbeating ${failedAttempts} time(s) (max_attempts=${settings.maxAttempts}).`,
              }
            : { status: "queued", failed_attempts: failedAttempts };
        const updated = await store.imports.update(job.id, release(patch), {
          workerId: job.worker_id,
          attempt: job.attempt,
        });
        if (updated) closed += 1;
      }

      return closed;
    },
  };
};
