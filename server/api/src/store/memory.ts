import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

import { hashApiKey } from "../adapters.js";
import type { Clock } from "../clock.js";
import { addSeconds } from "../clock.js";
import type {
  ApiKey,
  Dataset,
  DatasetRecord,
  Deployment,
  FeedbackRecord,
  MetricPoint,
} from "../contracts.js";
import { newId } from "../ids.js";
import { pageFromSorted, type CursorValue } from "./cursor.js";
import type {
  ArtifactRecord,
  BillingOutboxEntry,
  CheckpointRecord,
  DatasetPart,
  DatasetVersion,
  EvalOutputRow,
  EvalRecord,
  EvalResultRow,
  EvalTaskRow,
  ImportJobRecord,
  InferenceRecord,
  JobExpectation,
  Page,
  PageRequest,
  Repositories,
  RunRecord,
  Store,
  UploadRecord,
} from "./types.js";

interface MemoryState {
  apiKeys: Map<string, { key: ApiKey; hash: string }>;
  datasets: Map<string, Dataset>;
  datasetVersions: Map<string, DatasetVersion>;
  imports: Map<string, ImportJobRecord>;
  importParts: Map<string, DatasetPart[]>;
  runs: Map<string, RunRecord>;
  metrics: Map<string, MetricPoint[]>;
  metricSeq: number;
  checkpoints: Map<string, CheckpointRecord>;
  artifacts: Map<string, ArtifactRecord>;
  uploads: Map<string, UploadRecord>;
  deployments: Map<string, Deployment>;
  inferences: Map<string, InferenceRecord>;
  feedback: Map<string, FeedbackRecord>;
  evals: Map<string, EvalRecord>;
  evalTasks: Map<string, EvalTaskRow[]>;
  evalOutputs: Map<string, Map<string, EvalOutputRow>>;
  evalResults: Map<string, EvalResultRow[]>;
  billing: Map<string, BillingOutboxEntry>;
}

const emptyState = (): MemoryState => ({
  apiKeys: new Map(),
  datasets: new Map(),
  datasetVersions: new Map(),
  imports: new Map(),
  importParts: new Map(),
  runs: new Map(),
  metrics: new Map(),
  metricSeq: 0,
  checkpoints: new Map(),
  artifacts: new Map(),
  uploads: new Map(),
  deployments: new Map(),
  inferences: new Map(),
  feedback: new Map(),
  evals: new Map(),
  evalTasks: new Map(),
  evalOutputs: new Map(),
  evalResults: new Map(),
  billing: new Map(),
});

const clone = <T>(value: T): T => structuredClone(value);

/** Code-unit string order (matches Postgres `COLLATE "C"` and cursor keys). */
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const newestFirst = <T extends { created_at: string; id: string }>(
  rows: Iterable<T>,
): T[] =>
  Array.from(rows).sort((a, b) =>
    a.created_at === b.created_at
      ? cmpStr(b.id, a.id)
      : cmpStr(b.created_at, a.created_at),
  );

const createdKey = (row: { created_at: string; id: string }): CursorValue[] => [
  row.created_at,
  row.id,
];

const pageNewest = <T extends { created_at: string; id: string }>(
  rows: Iterable<T>,
  page: PageRequest,
): Page<T> => pageFromSorted(newestFirst(rows), page, createdKey, "desc");

const matches = <S extends string>(
  row: { status: S; worker_id: string | null; attempt: number },
  expect: JobExpectation<S> | undefined,
): boolean => {
  if (!expect) return true;
  if (expect.status && !expect.status.includes(row.status)) return false;
  if (expect.workerId !== undefined && row.worker_id !== expect.workerId) {
    return false;
  }
  if (expect.attempt !== undefined && row.attempt !== expect.attempt) {
    return false;
  }

  return true;
};

const oldestQueued = <
  T extends { status: string; created_at: string; id: string },
>(
  rows: Iterable<T>,
  filter: (row: T) => boolean,
): T | undefined =>
  Array.from(rows)
    .filter((row) => row.status === "queued" && filter(row))
    .sort((a, b) =>
      a.created_at === b.created_at
        ? cmpStr(a.id, b.id)
        : cmpStr(a.created_at, b.created_at),
    )[0];

const isExpired = (
  row: { worker_id: string | null; lease_expires_at: string | null },
  now: Date,
): boolean =>
  row.worker_id !== null &&
  row.lease_expires_at !== null &&
  Date.parse(row.lease_expires_at) < now.getTime();

const unexpired = (row: CheckpointRecord, now: Date): boolean =>
  row.expires_at === null || Date.parse(row.expires_at) > now.getTime();

const outputKey = (model: string, taskIndex: number, sample: number): string =>
  `${model}\u0000${taskIndex}\u0000${sample}`;

const versionParts = (version: string): [string, number] => {
  const match = /^(\d{4}-\d{2}-\d{2})-(\d+)$/.exec(version);

  return match ? [match[1] ?? "", Number(match[2])] : [version, 0];
};

const buildRepositories = (
  st: () => MemoryState,
  clock: Clock,
): Repositories => {
  const now = () => clock.now().toISOString();

  return {
    apiKeys: {
      create: async ({ workspaceId, name, scopes }) => {
        const secret = `grad_${randomBytes(24).toString("hex")}`;
        const key: ApiKey = {
          id: newId("key"),
          workspace_id: workspaceId,
          name,
          prefix: secret.slice(0, 12),
          scopes: [...scopes],
          created_at: now(),
          revoked_at: null,
        };
        st().apiKeys.set(key.id, { key, hash: hashApiKey(secret) });

        return { key: clone(key), secret };
      },
      list: async (workspaceId, page) =>
        clone(
          pageNewest(
            Array.from(st().apiKeys.values())
              .map((e) => e.key)
              .filter((k) => k.workspace_id === workspaceId),
            page,
          ),
        ),
      revoke: async (workspaceId, id) => {
        const entry = st().apiKeys.get(id);
        if (!entry || entry.key.workspace_id !== workspaceId) return null;
        entry.key.revoked_at ??= now();

        return clone(entry.key);
      },
      findActiveByHash: async (hash) => {
        for (const { key, hash: stored } of st().apiKeys.values()) {
          if (stored === hash && key.revoked_at === null) {
            return {
              id: key.id,
              workspace_id: key.workspace_id,
              name: key.name,
              scopes: [...key.scopes],
            };
          }
        }

        return null;
      },
    },

    datasets: {
      create: async ({ workspaceId, name, metadata }) => {
        const exists = Array.from(st().datasets.values()).some(
          (d) => d.workspace_id === workspaceId && d.name === name,
        );
        if (exists) return null;

        const ts = now();
        const dataset: Dataset = {
          id: newId("ds"),
          workspace_id: workspaceId,
          name,
          version: 0,
          record_count: 0,
          metadata: clone(metadata),
          created_at: ts,
          updated_at: ts,
        };
        st().datasets.set(dataset.id, dataset);
        st().datasetVersions.set(`${dataset.id}:0`, {
          dataset_id: dataset.id,
          version: 0,
          parts: [],
          record_count: 0,
          created_at: ts,
        });

        return clone(dataset);
      },
      getOrCreate: async function (input) {
        const existing = await this.get(input.workspaceId, input.name);
        if (existing) return existing;

        return (await this.create(input)) as Dataset;
      },
      get: async (workspaceId, name) => {
        for (const d of st().datasets.values()) {
          if (d.workspace_id === workspaceId && d.name === name) {
            return clone(d);
          }
        }

        return null;
      },
      getById: async (workspaceId, id) => {
        const d = st().datasets.get(id);

        return d && d.workspace_id === workspaceId ? clone(d) : null;
      },
      list: async (workspaceId, page) =>
        clone(
          pageNewest(
            Array.from(st().datasets.values()).filter(
              (d) => d.workspace_id === workspaceId,
            ),
            page,
          ),
        ),
      appendVersion: async ({ datasetId, parts, metadata }) => {
        const dataset = st().datasets.get(datasetId);
        if (!dataset) throw new Error(`Dataset '${datasetId}' not found.`);

        const previous = st().datasetVersions.get(
          `${datasetId}:${dataset.version}`,
        );
        const added = parts.reduce((sum, p) => sum + p.count, 0);
        const ts = now();
        dataset.version += 1;
        dataset.record_count += added;
        dataset.metadata = { ...dataset.metadata, ...(metadata ?? {}) };
        dataset.updated_at = ts;

        const version: DatasetVersion = {
          dataset_id: datasetId,
          version: dataset.version,
          parts: [...(previous?.parts ?? []), ...clone(parts)],
          record_count: dataset.record_count,
          created_at: ts,
        };
        st().datasetVersions.set(`${datasetId}:${version.version}`, version);

        return { dataset: clone(dataset), version: clone(version) };
      },
      getVersion: async (datasetId, version) => {
        const row = st().datasetVersions.get(`${datasetId}:${version}`);

        return row ? clone(row) : null;
      },
    },

    imports: {
      create: async (input) => {
        const ts = now();
        const job: ImportJobRecord = {
          id: newId("imp"),
          workspace_id: input.workspaceId,
          dataset_id: input.datasetId,
          dataset: input.datasetName,
          status: "queued",
          source: clone(input.source),
          connector: input.connector,
          attempt: 0,
          imported_count: 0,
          dropped_count: 0,
          detected_scores: [],
          dataset_version: null,
          error: null,
          upload_key: input.uploadKey,
          worker_id: null,
          lease_expires_at: null,
          lease_seconds: 0,
          failed_attempts: 0,
          created_at: ts,
          updated_at: ts,
        };
        st().imports.set(job.id, job);

        return clone(job);
      },
      get: async (workspaceId, id) => {
        const job = st().imports.get(id);

        return job && job.workspace_id === workspaceId ? clone(job) : null;
      },
      getById: async (id) => clone(st().imports.get(id) ?? null),
      list: async (workspaceId, page) =>
        clone(
          pageNewest(
            Array.from(st().imports.values()).filter(
              (j) => j.workspace_id === workspaceId,
            ),
            page,
          ),
        ),
      update: async (id, patch, expect) => {
        const job = st().imports.get(id);
        if (!job || !matches(job, expect)) return null;
        Object.assign(job, clone(patch), {
          updated_at: patch.updated_at ?? now(),
        });

        return clone(job);
      },
      claimNext: async ({ workerId, leaseSeconds, now: at, workspaceId }) => {
        const job = oldestQueued(
          st().imports.values(),
          (j) => !workspaceId || j.workspace_id === workspaceId,
        );
        if (!job) return null;
        job.status = "running";
        job.attempt += 1;
        job.worker_id = workerId;
        job.lease_expires_at = addSeconds(at, leaseSeconds).toISOString();
        job.lease_seconds = leaseSeconds;
        job.updated_at = at.toISOString();

        return clone(job);
      },
      listExpiredLeases: async (at, limit) =>
        clone(
          Array.from(st().imports.values())
            .filter((j) => isExpired(j, at))
            .slice(0, limit),
        ),
      addPart: async (importId, attempt, part) => {
        const key = `${importId}:${attempt}`;
        const parts = st().importParts.get(key) ?? [];
        parts.push(clone(part));
        st().importParts.set(key, parts);
      },
      listParts: async (importId, attempt) =>
        clone(st().importParts.get(`${importId}:${attempt}`) ?? []),
      countActive: async () => {
        const jobs = Array.from(st().imports.values());

        return {
          queued: jobs.filter((j) => j.status === "queued").length,
          running: jobs.filter((j) => j.worker_id !== null).length,
        };
      },
    },

    runs: {
      create: async (input) => {
        const ts = now();
        const run: RunRecord = {
          id: newId("run"),
          workspace_id: input.workspaceId,
          name: input.name,
          dataset_id: input.datasetId,
          dataset_name: input.datasetName,
          dataset_version: input.datasetVersion,
          recipe_kind: input.recipeKind,
          status: "queued",
          resolved_config: clone(input.resolvedConfig),
          max_cost_usd: input.maxCostUsd,
          price_per_million_tokens: input.pricePerMillionTokens,
          total_steps: input.totalSteps,
          current_step: 0,
          attempt: 0,
          max_attempts: input.maxAttempts,
          failed_attempts: 0,
          billed_tokens: 0,
          billed_cost_usd: 0,
          attempt_tokens: 0,
          worker_id: null,
          lease_expires_at: null,
          lease_seconds: 0,
          latest_metric: null,
          eval_report: null,
          artifact_id: null,
          error: null,
          created_at: ts,
          updated_at: ts,
          finished_at: null,
        };
        st().runs.set(run.id, run);

        return clone(run);
      },
      get: async (workspaceId, id) => {
        const run = st().runs.get(id);

        return run && run.workspace_id === workspaceId ? clone(run) : null;
      },
      getById: async (id) => clone(st().runs.get(id) ?? null),
      list: async (workspaceId, page) =>
        clone(
          pageNewest(
            Array.from(st().runs.values()).filter(
              (r) => r.workspace_id === workspaceId,
            ),
            page,
          ),
        ),
      update: async (id, patch, expect) => {
        const run = st().runs.get(id);
        if (!run || !matches(run, expect)) return null;
        Object.assign(run, clone(patch), {
          updated_at: patch.updated_at ?? now(),
        });

        return clone(run);
      },
      claimNext: async ({
        workerId,
        leaseSeconds,
        now: at,
        workspaceId,
        recipes,
      }) => {
        const run = oldestQueued(
          st().runs.values(),
          (r) =>
            (!workspaceId || r.workspace_id === workspaceId) &&
            (!recipes || recipes.includes(r.recipe_kind)),
        );
        if (!run) return null;
        run.status = "running";
        run.attempt += 1;
        run.attempt_tokens = 0;
        run.worker_id = workerId;
        run.lease_expires_at = addSeconds(at, leaseSeconds).toISOString();
        run.lease_seconds = leaseSeconds;
        run.updated_at = at.toISOString();

        return clone(run);
      },
      listExpiredLeases: async (at, limit) =>
        clone(
          Array.from(st().runs.values())
            .filter((r) => isExpired(r, at))
            .slice(0, limit),
        ),
      countActive: async () => {
        const runs = Array.from(st().runs.values());

        return {
          queued: runs.filter((r) => r.status === "queued").length,
          running: runs.filter((r) => r.worker_id !== null).length,
        };
      },
    },

    metrics: {
      append: async (runId, attempt, point) => {
        const state = st();
        state.metricSeq += 1;
        const stored = {
          ...clone(point),
          seq: state.metricSeq,
          attempt,
        } as MetricPoint;
        const list = state.metrics.get(runId) ?? [];
        list.push(stored);
        state.metrics.set(runId, list);

        return clone(stored);
      },
      list: async (runId, afterSeq, limit) =>
        clone(
          (st().metrics.get(runId) ?? [])
            .filter((m) => m.seq > afterSeq)
            .slice(0, limit),
        ),
    },

    checkpoints: {
      insert: async (input) => {
        for (const c of st().checkpoints.values()) {
          if (
            c.run_id === input.runId &&
            c.attempt === input.attempt &&
            c.step === input.step
          ) {
            return { checkpoint: clone(c), created: false };
          }
        }

        const checkpoint: CheckpointRecord = {
          id: newId("ckpt"),
          workspace_id: input.workspaceId,
          run_id: input.runId,
          attempt: input.attempt,
          step: input.step,
          eval_score: input.evalScore,
          format: input.format,
          storage_key: input.storageKey,
          sha256: input.sha256,
          size_bytes: input.sizeBytes,
          metadata: clone(input.metadata),
          best: false,
          final: false,
          expires_at: input.expiresAt,
          created_at: now(),
        };
        st().checkpoints.set(checkpoint.id, checkpoint);

        return { checkpoint: clone(checkpoint), created: true };
      },
      get: async (workspaceId, id) => {
        const c = st().checkpoints.get(id);

        return c && c.workspace_id === workspaceId ? clone(c) : null;
      },
      listByRun: async (workspaceId, runId, page, at) => {
        const rows = Array.from(st().checkpoints.values())
          .filter(
            (c) =>
              c.workspace_id === workspaceId &&
              c.run_id === runId &&
              unexpired(c, at),
          )
          .sort(
            (a, b) =>
              a.step - b.step || a.attempt - b.attempt || cmpStr(a.id, b.id),
          );

        return clone(
          pageFromSorted(rows, page, (c) => [c.step, c.attempt, c.id], "asc"),
        );
      },
      latestForRun: async (runId, at) =>
        clone(
          Array.from(st().checkpoints.values())
            .filter((c) => c.run_id === runId && unexpired(c, at))
            .sort((a, b) => b.step - a.step || b.attempt - a.attempt)[0] ??
            null,
        ),
      listAllForRun: async (runId, at) =>
        clone(
          Array.from(st().checkpoints.values())
            .filter((c) => c.run_id === runId && unexpired(c, at))
            .sort((a, b) => a.step - b.step || a.attempt - b.attempt),
        ),
      pinRetention: async (runId, { bestId, finalId }) => {
        for (const c of st().checkpoints.values()) {
          if (c.run_id !== runId) continue;
          if (c.id === bestId) {
            c.best = true;
            c.expires_at = null;
          }
          if (c.id === finalId) {
            c.final = true;
            c.expires_at = null;
          }
        }
      },
      listExpired: async (at, limit) =>
        clone(
          Array.from(st().checkpoints.values())
            .filter((c) => !unexpired(c, at))
            .slice(0, limit),
        ),
      delete: async (id) => {
        st().checkpoints.delete(id);
      },
    },

    artifacts: {
      create: async (input) => {
        const at = clock.now();
        const day = at.toISOString().slice(0, 10);
        let seq = 0;
        for (const a of st().artifacts.values()) {
          if (a.workspace_id !== input.workspaceId || a.name !== input.name) {
            continue;
          }
          const [aDay, aSeq] = versionParts(a.version);
          if (aDay === day) seq = Math.max(seq, aSeq);
        }
        const version = `${day}-${seq + 1}`;
        const artifact: ArtifactRecord = {
          id: `${input.name}@${version}`,
          workspace_id: input.workspaceId,
          name: input.name,
          version,
          run_id: input.runId,
          checkpoint_id: input.checkpointId,
          base_model: input.baseModel,
          recipe_kind: input.recipeKind,
          format: input.format,
          storage_key: input.storageKey,
          sha256: input.sha256,
          size_bytes: input.sizeBytes,
          manifest: clone(input.manifest),
          eval_report: clone(input.evalReport),
          created_at: at.toISOString(),
        };
        st().artifacts.set(`${input.workspaceId}:${artifact.id}`, artifact);

        return clone(artifact);
      },
      get: async (workspaceId, reference) => {
        if (reference.endsWith("@latest")) {
          const name = reference.slice(0, -"@latest".length);
          const latest = Array.from(st().artifacts.values())
            .filter((a) => a.workspace_id === workspaceId && a.name === name)
            .sort((a, b) => {
              const [ad, as] = versionParts(a.version);
              const [bd, bs] = versionParts(b.version);

              return ad === bd ? bs - as : cmpStr(bd, ad);
            })[0];

          return clone(latest ?? null);
        }

        return clone(st().artifacts.get(`${workspaceId}:${reference}`) ?? null);
      },
      list: async (workspaceId, filter, page) =>
        clone(
          pageNewest(
            Array.from(st().artifacts.values()).filter(
              (a) =>
                a.workspace_id === workspaceId &&
                (!filter.name || a.name === filter.name),
            ),
            page,
          ),
        ),
    },

    uploads: {
      create: async (input) => {
        const upload: UploadRecord = {
          id: input.id,
          workspace_id: input.workspaceId,
          purpose: input.purpose,
          job_id: input.jobId,
          attempt: input.attempt,
          storage_key: input.storageKey,
          sha256: input.sha256,
          size_bytes: input.sizeBytes,
          status: "pending",
          consumed_by: null,
          created_at: now(),
          expires_at: input.expiresAt,
        };
        st().uploads.set(upload.id, upload);

        return clone(upload);
      },
      get: async (id) => clone(st().uploads.get(id) ?? null),
      markUploaded: async (id) => {
        const upload = st().uploads.get(id);
        if (!upload || upload.status !== "pending") return null;
        upload.status = "uploaded";

        return clone(upload);
      },
      consume: async (id, consumedBy) => {
        const upload = st().uploads.get(id);
        if (!upload || upload.status === "consumed") return null;
        upload.status = "consumed";
        upload.consumed_by = consumedBy;

        return clone(upload);
      },
      listExpired: async (at, limit) =>
        clone(
          Array.from(st().uploads.values())
            .filter(
              (u) =>
                u.status !== "consumed" &&
                Date.parse(u.expires_at) < at.getTime(),
            )
            .slice(0, limit),
        ),
      delete: async (id) => {
        st().uploads.delete(id);
      },
    },

    deployments: {
      get: async (workspaceId, name) =>
        clone(st().deployments.get(`${workspaceId}:${name}`) ?? null),
      list: async (workspaceId, page) =>
        clone(
          pageNewest(
            Array.from(st().deployments.values()).filter(
              (d) => d.workspace_id === workspaceId,
            ),
            page,
          ),
        ),
      upsert: async (input) => {
        const key = `${input.workspaceId}:${input.name}`;
        const existing = st().deployments.get(key);
        const ts = now();
        const deployment: Deployment = {
          id: existing?.id ?? newId("dep"),
          workspace_id: input.workspaceId,
          name: input.name,
          model_id: input.modelId,
          active_artifact_id: input.activeArtifactId,
          previous_artifact_id:
            existing && existing.active_artifact_id !== input.activeArtifactId
              ? existing.active_artifact_id
              : (existing?.previous_artifact_id ?? null),
          fallback_model: input.fallbackModel,
          explore_rate: input.exploreRate,
          status: "active",
          created_at: existing?.created_at ?? ts,
          updated_at: ts,
        };
        st().deployments.set(key, deployment);

        return clone(deployment);
      },
      lock: async () => undefined,
    },

    inferences: {
      create: async (input) => {
        const record: InferenceRecord = { ...input, created_at: now() };
        st().inferences.set(record.id, record);

        return clone(record);
      },
      getMany: async (workspaceId, ids) =>
        clone(
          ids
            .map((id) => st().inferences.get(id))
            .filter(
              (r): r is InferenceRecord =>
                r !== undefined && r.workspace_id === workspaceId,
            ),
        ),
    },

    feedback: {
      insertMany: async (events) =>
        events.map((event) => {
          const key = `${event.workspaceId}:${event.idempotencyKey}`;
          const existing = st().feedback.get(key);
          if (existing) return { record: clone(existing), deduplicated: true };

          const record: FeedbackRecord = {
            id: newId("fb"),
            workspace_id: event.workspaceId,
            inference_id: event.inferenceId,
            session_id: event.sessionId,
            deployment_name: event.deploymentName,
            idempotency_key: event.idempotencyKey,
            score: event.score,
            expected_output: clone(event.expectedOutput ?? null),
            metrics: clone(event.metrics),
            created_at: now(),
          };
          st().feedback.set(key, record);

          return { record: clone(record), deduplicated: false };
        }),
      stats: async (workspaceId, deploymentName) => {
        const rows = Array.from(st().feedback.values()).filter(
          (f) =>
            f.workspace_id === workspaceId &&
            f.deployment_name === deploymentName,
        );
        const scored = rows.filter((f) => f.score !== null);
        const average =
          scored.length > 0
            ? Number(
                (
                  scored.reduce((sum, f) => sum + (f.score ?? 0), 0) /
                  scored.length
                ).toFixed(4),
              )
            : null;

        return { count: rows.length, average_score: average };
      },
    },

    evals: {
      create: async (input) => {
        const ts = now();
        const record: EvalRecord = {
          ...clone(input),
          id: newId("eval"),
          status: "queued",
          total_outputs: 0,
          generated: 0,
          summary: [],
          total_cost_usd: 0,
          error: null,
          attempt: 0,
          worker_id: null,
          lease_expires_at: null,
          lease_seconds: 0,
          created_at: ts,
          updated_at: ts,
          completed_at: null,
        };
        st().evals.set(record.id, record);

        return clone(record);
      },
      get: async (workspaceId, id) => {
        const e = st().evals.get(id);

        return e && e.workspace_id === workspaceId ? clone(e) : null;
      },
      getById: async (id) => clone(st().evals.get(id) ?? null),
      list: async (workspaceId, page) =>
        clone(
          pageNewest(
            Array.from(st().evals.values()).filter(
              (e) => e.workspace_id === workspaceId,
            ),
            page,
          ),
        ),
      update: async (id, patch, expect) => {
        const e = st().evals.get(id);
        if (!e || !matches(e, expect)) return null;
        Object.assign(e, clone(patch), {
          updated_at: patch.updated_at ?? now(),
        });

        return clone(e);
      },
      claimNext: async ({ workerId, leaseSeconds, now: at, workspaceId }) => {
        const e = oldestQueued(
          st().evals.values(),
          (row) => !workspaceId || row.workspace_id === workspaceId,
        );
        if (!e) return null;
        e.status = "running";
        e.attempt += 1;
        e.worker_id = workerId;
        e.lease_expires_at = addSeconds(at, leaseSeconds).toISOString();
        e.lease_seconds = leaseSeconds;
        e.updated_at = at.toISOString();

        return clone(e);
      },
      listExpiredLeases: async (at, limit) =>
        clone(
          Array.from(st().evals.values())
            .filter((e) => isExpired(e, at))
            .slice(0, limit),
        ),
      insertTasks: async (evalId, tasks) => {
        const list = st().evalTasks.get(evalId) ?? [];
        const known = new Set(list.map((t) => t.task_index));
        for (const task of tasks) {
          if (!known.has(task.task_index)) list.push(clone(task));
        }
        list.sort((a, b) => a.task_index - b.task_index);
        st().evalTasks.set(evalId, list);
      },
      listTasks: async (evalId, afterIndex, limit) =>
        clone(
          (st().evalTasks.get(evalId) ?? [])
            .filter((t) => t.task_index > afterIndex)
            .slice(0, limit),
        ),
      upsertOutput: async (output) => {
        const map = st().evalOutputs.get(output.eval_id) ?? new Map();
        const key = outputKey(
          output.model,
          output.task_index,
          output.sample_index,
        );
        const existing = map.get(key);
        map.set(key, { ...clone(output), id: existing?.id ?? output.id });
        st().evalOutputs.set(output.eval_id, map);
      },
      listOutputKeys: async (evalId) =>
        new Set((st().evalOutputs.get(evalId) ?? new Map()).keys()),
      listOutputs: async (evalId, filter, page) => {
        const tasks = new Map(
          (st().evalTasks.get(evalId) ?? []).map((t) => [t.task_index, t]),
        );
        const rows = Array.from(
          (
            st().evalOutputs.get(evalId) ?? new Map<string, EvalOutputRow>()
          ).values(),
        )
          .filter(
            (o) =>
              (!filter.model || o.model === filter.model) &&
              (!filter.missingScorer ||
                (o.error === null &&
                  o.scores[filter.missingScorer] === undefined)),
          )
          .sort(
            (a, b) =>
              a.task_index - b.task_index ||
              cmpStr(a.model, b.model) ||
              a.sample_index - b.sample_index,
          )
          .map((o) => ({
            ...o,
            record: (tasks.get(o.task_index)?.record ?? {}) as DatasetRecord,
          }));

        return clone(
          pageFromSorted(
            rows,
            page,
            (o) => [o.task_index, o.model, o.sample_index],
            "asc",
          ),
        );
      },
      setScores: async (evalId, entries) => {
        const map = st().evalOutputs.get(evalId);
        if (!map) return 0;
        const byId = new Map(Array.from(map.values()).map((o) => [o.id, o]));
        let accepted = 0;
        for (const entry of entries) {
          const output = byId.get(entry.output_id);
          if (!output) continue;
          output.scores[entry.scorer] = entry.score;
          accepted += 1;
        }

        return accepted;
      },
      countMissingScores: async (evalId, scorers) =>
        Array.from(st().evalOutputs.get(evalId)?.values() ?? []).filter(
          (o) =>
            o.error === null && scorers.some((s) => o.scores[s] === undefined),
        ).length,
      replaceResults: async (evalId, rows) => {
        st().evalResults.set(evalId, clone([...rows]));
      },
      listResults: async (evalId, filter, page) => {
        const tasks = new Map(
          (st().evalTasks.get(evalId) ?? []).map((t) => [t.task_index, t]),
        );
        const rows = (st().evalResults.get(evalId) ?? [])
          .filter(
            (r) =>
              (!filter.model || r.model === filter.model) &&
              (filter.maxScore === undefined || r.score < filter.maxScore),
          )
          .sort(
            (a, b) => a.task_index - b.task_index || cmpStr(a.model, b.model),
          )
          .map((r) => ({
            ...r,
            record: (tasks.get(r.task_index)?.record ?? {}) as DatasetRecord,
          }));

        return clone(
          pageFromSorted(rows, page, (r) => [r.task_index, r.model], "asc"),
        );
      },
    },

    billing: {
      enqueue: async (input) => {
        for (const entry of st().billing.values()) {
          if (entry.idempotency_key === input.idempotencyKey)
            return clone(entry);
        }
        const ts = now();
        const entry: BillingOutboxEntry = {
          id: newId("bill"),
          idempotency_key: input.idempotencyKey,
          workspace_id: input.workspaceId,
          run_id: input.runId,
          attempt: input.attempt,
          tokens: input.tokens,
          cost_usd: input.costUsd,
          status: "pending",
          attempts: 0,
          last_error: null,
          next_attempt_at: ts,
          created_at: ts,
          sent_at: null,
        };
        st().billing.set(entry.id, entry);

        return clone(entry);
      },
      claimDue: async (at, limit, lockSeconds) => {
        const due = Array.from(st().billing.values())
          .filter(
            (e) =>
              e.status === "pending" &&
              Date.parse(e.next_attempt_at) <= at.getTime(),
          )
          .sort((a, b) => cmpStr(a.created_at, b.created_at))
          .slice(0, limit);
        for (const entry of due) {
          entry.next_attempt_at = addSeconds(at, lockSeconds).toISOString();
          entry.attempts += 1;
        }

        return clone(due);
      },
      markSent: async (id) => {
        const entry = st().billing.get(id);
        if (!entry) return;
        entry.status = "sent";
        entry.sent_at = now();
        entry.last_error = null;
      },
      markFailed: async (id, error, nextAttemptAt) => {
        const entry = st().billing.get(id);
        if (!entry) return;
        entry.last_error = error.slice(0, 2000);
        entry.next_attempt_at = nextAttemptAt.toISOString();
      },
      listByRun: async (runId) =>
        clone(
          Array.from(st().billing.values())
            .filter((e) => e.run_id === runId)
            .sort((a, b) => a.attempt - b.attempt),
        ),
    },
  };
};

type AnyFn = (...args: never[]) => Promise<unknown>;

/**
 * In-memory store for development and tests. Every operation is serialized;
 * transactions snapshot the state and restore it when `fn` throws.
 */
export const createMemoryStore = (clock: Clock): Store => {
  let state = emptyState();
  let queue: Promise<unknown> = Promise.resolve();
  const inTransaction = new AsyncLocalStorage<true>();

  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    if (inTransaction.getStore()) return fn();
    const next = queue.then(() => inTransaction.run(true, fn));
    queue = next.catch(() => undefined);

    return next;
  };

  const raw = buildRepositories(() => state, clock);

  const wrapRepo = <R extends object>(repo: R): R => {
    const wrapped: Record<string, AnyFn> = {};
    for (const [name, fn] of Object.entries(repo) as Array<[string, AnyFn]>) {
      wrapped[name] = (...args: never[]) =>
        serialize(() => fn.apply(wrapped, args));
    }

    return wrapped as unknown as R;
  };

  const repos = Object.fromEntries(
    Object.entries(raw).map(([name, repo]) => [name, wrapRepo(repo as object)]),
  ) as unknown as Repositories;

  return {
    ...repos,
    transaction: (fn) =>
      serialize(async () => {
        const snapshot = clone(state);
        try {
          return await fn(repos);
        } catch (error) {
          state = snapshot;
          throw error;
        }
      }),
    migrate: async () => undefined,
    ping: async () => true,
    close: async () => undefined,
  };
};
