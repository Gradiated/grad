import type { Dataset, DatasetRecord } from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { conflict, invalid, notFound } from "../errors.js";
import { newId } from "../ids.js";
import { decodeCursor, encodeCursor } from "../store/cursor.js";
import type {
  DatasetPart,
  DatasetVersion,
  Page,
  PageRequest,
} from "../store/types.js";
import {
  readVersionRecords,
  readVersionSlice,
  writeRecordsPart,
} from "./dataset-records.js";

export interface ResolvedDatasetVersion {
  dataset: Dataset;
  version: DatasetVersion;
}

export interface DatasetService {
  create(
    workspaceId: string,
    name: string,
    metadata: Record<string, unknown>,
  ): Promise<Dataset>;
  get(workspaceId: string, name: string): Promise<Dataset>;
  list(workspaceId: string, page: PageRequest): Promise<Page<Dataset>>;
  /** Creates the dataset if needed and appends records as a new version. */
  push(
    workspaceId: string,
    name: string,
    records: readonly DatasetRecord[],
    metadata?: Record<string, unknown>,
  ): Promise<Dataset>;
  /** Pins `version` (default: current) of a dataset; throws 404 / 422. */
  resolve(
    workspaceId: string,
    name: string,
    version?: number,
  ): Promise<ResolvedDatasetVersion>;
  readRecords(version: DatasetVersion): Promise<DatasetRecord[]>;
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
  /** Writes a part for `datasetId` at a fresh immutable key. */
  writePart(
    workspaceId: string,
    datasetId: string,
    records: readonly DatasetRecord[],
  ): Promise<DatasetPart>;
}

export const datasetPartKey = (
  workspaceId: string,
  datasetId: string,
): string =>
  `datasets/${encodeURIComponent(workspaceId)}/${datasetId}/parts/${newId("part")}.jsonl`;

const stampIds = (records: readonly DatasetRecord[]): DatasetRecord[] =>
  records.map((record) =>
    record.id ? record : { ...record, id: newId("rec").slice(0, 20) },
  );

export const createDatasetService = (deps: AppDependencies): DatasetService => {
  const { store, storage } = deps;

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
    writeRecordsPart(storage, datasetPartKey(workspaceId, datasetId), records);

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
    create: async (workspaceId, name, metadata) => {
      const created = await store.datasets.create({
        workspaceId,
        name,
        metadata,
      });
      if (!created) {
        throw conflict("dataset_exists", `Dataset '${name}' already exists.`);
      }

      return created;
    },
    get,
    list: (workspaceId, page) => store.datasets.list(workspaceId, page),
    push: async (workspaceId, name, records, metadata) => {
      const dataset = await store.datasets.getOrCreate({
        workspaceId,
        name,
        metadata: {},
      });
      const part = await writePart(workspaceId, dataset.id, stampIds(records));
      const { dataset: updated } = await store.datasets.appendVersion({
        datasetId: dataset.id,
        parts: [part],
        ...(metadata ? { metadata } : {}),
      });

      return updated;
    },
    resolve,
    readRecords: (version) => readVersionRecords(storage, version),
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

      const data = await readVersionSlice(
        storage,
        version,
        offset,
        input.limit,
      );
      const nextOffset = offset + data.length;

      return {
        dataset: dataset.name,
        version: version.version,
        total: version.record_count,
        data,
        next_cursor:
          nextOffset < version.record_count ? encodeCursor([nextOffset]) : null,
      };
    },
    writePart,
  };
};
