import type {
  Dataset,
  DatasetRecord,
  FilterDatasetRequest,
} from "../contracts.js";
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
import { canonicalJson, compileFilter, viewName } from "./dataset-filter.js";
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
  part: string = newId("part"),
): string =>
  `datasets/${encodeURIComponent(workspaceId)}/${datasetId}/parts/${part}.jsonl`;

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
      const { dataset } = await store.datasets.appendVersion({
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

      const records = await readRecords(version);
      const data = records.slice(offset, offset + input.limit);
      const nextOffset = offset + data.length;

      return {
        dataset: dataset.name,
        version: version.version,
        total: records.length,
        data,
        next_cursor:
          nextOffset < records.length ? encodeCursor([nextOffset]) : null,
      };
    },
    writePart,
  };
};
