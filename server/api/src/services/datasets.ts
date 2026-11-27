import { createHash } from "node:crypto";

import type {
  Dataset,
  DatasetRecord,
  FilterDatasetRequest,
} from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { conflict, invalid, notFound } from "../errors.js";
import { createOnce, type Created } from "../idempotency.js";
import { decodeCursor, encodeCursor } from "../store/cursor.js";
import type {
  DatasetPart,
  DatasetVersion,
  IdempotencyInput,
  Page,
  PageRequest,
} from "../store/types.js";
import { canonicalJson, compileFilter, viewName } from "./dataset-filter.js";
import { createVersionIndexCache, readVersionPage } from "./dataset-pages.js";
import { readVersionRecords, writeRecordsPart } from "./dataset-records.js";
import { mergeRecords } from "./record-merge.js";

export interface ResolvedDatasetVersion {
  dataset: Dataset;
  version: DatasetVersion;
}

export interface DatasetService {
  create(
    workspaceId: string,
    name: string,
    metadata: Record<string, unknown>,
    idempotency?: IdempotencyInput,
  ): Promise<Created<Dataset>>;
  get(workspaceId: string, name: string): Promise<Dataset>;
  list(workspaceId: string, page: PageRequest): Promise<Page<Dataset>>;
  /**
   * Creates the dataset if needed and appends records as a new version; a
   * retry with the same Idempotency-Key returns the dataset, appending nothing.
   */
  push(
    workspaceId: string,
    name: string,
    records: readonly DatasetRecord[],
    metadata?: Record<string, unknown>,
    idempotency?: IdempotencyInput,
  ): Promise<Created<Dataset>>;
  /** Pins `version` (default: current) of a dataset; throws 404 / 422. */
  resolve(
    workspaceId: string,
    name: string,
    version?: number,
  ): Promise<ResolvedDatasetVersion>;
  /** A version's records with later parts (score updates) merged in by id. */
  readRecords(version: DatasetVersion): Promise<DatasetRecord[]>;
  /**
   * A filtered view: a dataset holding the source version's matching records.
   * Its default name hashes the filter, so the same filter returns the same
   * view (`created: false`) without writing anything.
   */
  filter(
    workspaceId: string,
    name: string,
    request: FilterDatasetRequest,
  ): Promise<{ dataset: Dataset; created: boolean }>;
  listRecords(
    workspaceId: string,
    name: string,
    input: {
      version?: number | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ): Promise<{
    dataset: string;
    version: number;
    total: number;
    data: DatasetRecord[];
    next_cursor: string | null;
  }>;
  /** Writes records as a content-addressed part of `datasetId`. */
  writePart(
    workspaceId: string,
    datasetId: string,
    records: readonly DatasetRecord[],
  ): Promise<DatasetPart>;
}

/**
 * Parts are gzip-compressed and content-addressed by their uncompressed
 * JSONL: `ws/<ws>/datasets/<dataset>/<sha256>.jsonl.gz`.
 */
export const datasetPartKey = (
  workspaceId: string,
  datasetId: string,
  sha256: string,
): string =>
  `ws/${encodeURIComponent(workspaceId)}/datasets/${datasetId}/${sha256}.jsonl.gz`;

/**
 * Ids for the records of one push that have none: a hash of the whole batch
 * and the record's position in it. The same batch pushed again gets the same
 * ids, so its part is byte-identical and the push is a no-op; identical
 * records within a batch, or in different batches, stay distinct records.
 */
export const pushRecordIds = (
  records: readonly DatasetRecord[],
): DatasetRecord[] => {
  const batch = createHash("sha256")
    .update(canonicalJson(records))
    .digest("hex");

  return records.map((record, i) =>
    record.id
      ? record
      : {
          ...record,
          id: `rec_${createHash("sha256").update(`${batch}:${i}`).digest("hex").slice(0, 16)}`,
        },
  );
};

export const createDatasetService = (deps: AppDependencies): DatasetService => {
  const { store, storage } = deps;
  const indexes = createVersionIndexCache(storage);

  const get = async (workspaceId: string, name: string): Promise<Dataset> => {
    const dataset = await store.datasets.get(workspaceId, name);
    if (!dataset) throw notFound("dataset", name);

    return dataset;
  };

  const writePart = (
    workspaceId: string,
    datasetId: string,
    records: readonly DatasetRecord[],
  ) =>
    writeRecordsPart(
      storage,
      (sha) => datasetPartKey(workspaceId, datasetId, sha),
      records,
    );

  const readRecords = async (
    version: DatasetVersion,
  ): Promise<DatasetRecord[]> =>
    mergeRecords(await readVersionRecords(storage, version));

  const resolve = async (
    workspaceId: string,
    name: string,
    version?: number,
  ): Promise<ResolvedDatasetVersion> => {
    const dataset = await get(workspaceId, name);
    const wanted = version ?? dataset.version;
    const row = await store.datasets.getVersion(dataset.id, wanted);
    if (!row) {
      throw invalid(
        "dataset_version_not_found",
        `Dataset '${name}' has no version ${wanted} (current version is ${dataset.version}).`,
      );
    }

    return { dataset, version: row };
  };

  return {
    create: (workspaceId, name, metadata, idempotency) =>
      createOnce(
        idempotency,
        (key) => store.datasets.findIdempotent(workspaceId, key),
        async (id) => {
          const dataset = await store.datasets.getById(workspaceId, id);
          if (!dataset) throw notFound("dataset", id);
          return dataset;
        },
        async () => {
          const created = await store.datasets.create({
            workspaceId,
            name,
            metadata,
            idempotency,
          });
          if (!created) {
            throw conflict(
              "dataset_exists",
              `Dataset '${name}' already exists.`,
            );
          }
          return created;
        },
      ),
    get,
    list: (workspaceId, page) => store.datasets.list(workspaceId, page),
    push: async (workspaceId, name, records, metadata, idempotency) => {
      const dataset = await store.datasets.getOrCreate({
        workspaceId,
        name,
        metadata: {},
      });

      return createOnce(
        idempotency,
        (key) => store.datasets.findIdempotentPush(dataset.id, key),
        () => get(workspaceId, name),
        async () => {
          const part = await writePart(
            workspaceId,
            dataset.id,
            pushRecordIds(records),
          );
          // Re-pushing records the dataset already holds is a no-op: the
          // current version is returned and no new one is created.
          const current = await store.datasets.getVersion(
            dataset.id,
            dataset.version,
          );
          if (current?.parts.some((p) => p.sha256 === part.sha256)) {
            return get(workspaceId, name);
          }
          return store.datasets.appendVersion({
            datasetId: dataset.id,
            parts: [part],
            ...(metadata ? { metadata } : {}),
            idempotency,
          });
        },
      );
    },
    resolve,
    readRecords,
    filter: async (workspaceId, name, request) => {
      const { version: wanted, name: given, ...filter } = request;
      const source = await resolve(workspaceId, name, wanted);
      const target =
        given ?? viewName(source.dataset, source.version.version, filter);
      const existing = await store.datasets.get(workspaceId, target);
      const view = {
        source: source.dataset.name,
        version: source.version.version,
        filter,
      };
      if (existing) {
        if (canonicalJson(existing.metadata.view) === canonicalJson(view)) {
          return { dataset: existing, created: false };
        }
        throw conflict(
          "dataset_exists",
          `Dataset '${target}' already exists and is not this view; pick another name.`,
        );
      }

      const matches = compileFilter(filter);
      const records = (await readRecords(source.version)).filter(matches);
      const created = await store.datasets.create({
        workspaceId,
        name: target,
        metadata: { view },
      });
      if (!created) {
        // A concurrent identical filter won the race.
        return { dataset: await get(workspaceId, target), created: false };
      }
      if (records.length === 0) return { dataset: created, created: true };

      const part = await writePart(workspaceId, created.id, records);
      const dataset = await store.datasets.appendVersion({
        datasetId: created.id,
        parts: [part],
      });

      return { dataset, created: true };
    },
    listRecords: async (workspaceId, name, input) => {
      const { dataset, version } = await resolve(
        workspaceId,
        name,
        input.version,
      );
      const after = decodeCursor(input.cursor, 1);
      const offset = after ? Number(after[0]) : 0;
      if (!Number.isInteger(offset) || offset < 0) {
        throw invalid("invalid_cursor", "The pagination cursor is malformed.");
      }

      // One page without loading the version (dataset-pages.ts).
      const index = await indexes.get(version);
      const data = await readVersionPage(
        storage,
        version.parts,
        index,
        offset,
        input.limit,
      );
      const nextOffset = offset + data.length;

      return {
        dataset: dataset.name,
        version: version.version,
        total: index.total,
        data,
        next_cursor:
          nextOffset < index.total ? encodeCursor([nextOffset]) : null,
      };
    },
    writePart,
  };
};
