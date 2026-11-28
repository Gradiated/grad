import { createHash } from "node:crypto";

import type {
  Dataset,
  DatasetRecord,
  FilterDatasetRequest,
  RenderDatasetRequest,
  RenderDatasetResponse,
} from "../contracts.js";
import type { AppDependencies } from "../deps.js";
import { conflict, invalid, notFound } from "../errors.js";
import { createOnce, type Created } from "../idempotency.js";
import { newId } from "../ids.js";
import { renderMessages } from "../render.js";
import { recordConversation } from "../records.js";
import { decodeIntCursor, encodeCursor } from "../store/cursor.js";
import type {
  DatasetPart,
  DatasetVersion,
  IdempotencyInput,
  Page,
  ListFilter,
  PageRequest,
} from "../store/types.js";
import { canonicalJson, compileFilter, viewName } from "./dataset-filter.js";
import {
  createPartLinesCache,
  createVersionIndexCache,
  readVersionPage,
  type VersionIndex,
} from "./dataset-pages.js";
import { writeRecordsPart } from "./dataset-records.js";

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
  list(
    workspaceId: string,
    query: PageRequest & ListFilter,
  ): Promise<Page<Dataset>>;
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
  /**
   * Replaces the head version's record_count (each part's own distinct
   * records, summed) with its merged count, after records arrived whose ids
   * may already be in the dataset.
   */
  settleCount(dataset: Dataset): Promise<Dataset>;
  /**
   * A version's records with later parts (score updates) merged in by id,
   * a page at a time: memory is a page plus the parts it reads, never the
   * version (a 1M-record version read whole took 1.9 GB of a 1 GiB pod).
   */
  records(version: DatasetVersion): AsyncGenerator<DatasetRecord>;
  /**
   * Up to `max` of a version's merged records, every one when it has no more,
   * else pages spread evenly over it; `total` counts them all.
   */
  sample(
    version: DatasetVersion,
    max: number,
  ): Promise<{ records: DatasetRecord[]; total: number }>;
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
  /**
   * The first `limit` conversational records of the head version rendered
   * with `model`'s chat template and loss masks (estimated token counts).
   */
  render(
    workspaceId: string,
    name: string,
    input: RenderDatasetRequest,
  ): Promise<RenderDatasetResponse>;
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
/** Records read per page while rendering a preview. */
const RENDER_PAGE = 100;

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
const pushRecordIds = (records: readonly DatasetRecord[]): DatasetRecord[] => {
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

/** Records per page when a version is read through (`records`, `sample`). */
const RECORDS_PAGE = 5000;
/** Records per part a filtered view writes. */
const FILTER_PART_RECORDS = 20_000;

export const createDatasetService = (deps: AppDependencies): DatasetService => {
  const { store, storage } = deps;
  const indexes = createVersionIndexCache(storage);
  const partLines = createPartLinesCache(storage);

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

  const page = async (
    version: DatasetVersion,
    index: VersionIndex,
    from: number,
    limit: number,
  ) => readVersionPage(storage, version.parts, index, from, limit, partLines);

  async function* records(
    version: DatasetVersion,
  ): AsyncGenerator<DatasetRecord> {
    const index = await indexes.get(version);
    for (let from = 0; from < index.total; from += RECORDS_PAGE) {
      yield* await page(version, index, from, RECORDS_PAGE);
    }
  }

  const sample = async (version: DatasetVersion, max: number) => {
    const index = await indexes.get(version);
    if (index.total <= max) {
      return {
        records: await page(version, index, 0, index.total),
        total: index.total,
      };
    }
    const pages = Math.ceil(max / RECORDS_PAGE);
    const stride = Math.floor(index.total / pages);
    const out: DatasetRecord[] = [];
    for (let i = 0; i < pages; i += 1) {
      out.push(...(await page(version, index, i * stride, RECORDS_PAGE)));
    }

    return { records: out.slice(0, max), total: index.total };
  };

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

  const settleCount = async (dataset: Dataset): Promise<Dataset> => {
    const version = await store.datasets.getVersion(
      dataset.id,
      dataset.version,
    );
    if (!version) return dataset;
    const { total } = await indexes.get(version);
    if (total === dataset.record_count) return dataset;

    return (
      (await store.datasets.setRecordCount(
        dataset.id,
        dataset.version,
        total,
      )) ?? dataset
    );
  };

  const listRecords: DatasetService["listRecords"] = async (
    workspaceId,
    name,
    input,
  ) => {
    const { dataset, version } = await resolve(
      workspaceId,
      name,
      input.version,
    );
    const offset = decodeIntCursor(input.cursor);

    // One page without loading the version (dataset-pages.ts).
    const index = await indexes.get(version);
    const data = await readVersionPage(
      storage,
      version.parts,
      index,
      offset,
      input.limit,
      partLines,
    );
    const nextOffset = offset + data.length;

    return {
      dataset: dataset.name,
      version: version.version,
      total: index.total,
      data,
      next_cursor: nextOffset < index.total ? encodeCursor([nextOffset]) : null,
    };
  };

  const render: DatasetService["render"] = async (workspaceId, name, input) => {
    const model = deps.catalog.find(input.model);
    if (!model || model.family !== "llm") {
      throw invalid(
        "render_unsupported_model",
        `Model '${input.model}' is not a chat model in the catalog; run \`grad models list\` (GET /v1/base-models).`,
      );
    }

    // Page through the merged records only until `limit` conversations.
    const examples: RenderDatasetResponse["examples"] = [];
    let position = 0;
    let cursor: string | undefined;
    do {
      const page = await listRecords(workspaceId, name, {
        limit: RENDER_PAGE,
        cursor,
      });
      for (const record of page.data) {
        position += 1;
        const messages = recordConversation(record);
        if (messages.length === 0) continue;
        examples.push(
          renderMessages(record.id ?? `rec_${position}`, messages, {
            templateRevision: model.template_revision,
            train_on: input.train_on,
            thinking: input.thinking,
            preserve_thinking: input.preserve_thinking,
          }),
        );
        if (examples.length === input.limit) break;
      }
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined && examples.length < input.limit);

    return {
      dataset: name,
      model: model.id,
      template_revision: model.template_revision,
      token_counts: "estimated",
      examples,
    };
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
    list: (workspaceId, { limit, cursor, ...filter }) =>
      store.datasets.list(workspaceId, { limit, cursor }, filter),
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
          const appended = await store.datasets.appendPush({
            datasetId: dataset.id,
            part,
            ...(metadata ? { metadata } : {}),
            idempotency,
          });
          if (!appended) return get(workspaceId, name);
          // Only caller-chosen ids can repeat ones the dataset holds.
          return appended.version > 1 && records.some((r) => r.id)
            ? settleCount(appended)
            : appended;
        },
      );
    },
    resolve,
    settleCount,
    records,
    sample,
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

      // The matches stream into parts of FILTER_PART_RECORDS (never the
      // whole view in memory), written before the view exists: a read that
      // fails leaves no empty view for the next identical filter to return.
      const matches = compileFilter(filter);
      const id = newId("ds");
      const parts: DatasetPart[] = [];
      let chunk: DatasetRecord[] = [];
      const flush = async () => {
        if (chunk.length > 0)
          parts.push(await writePart(workspaceId, id, chunk));
        chunk = [];
      };
      for await (const record of records(source.version)) {
        if (!matches(record)) continue;
        chunk.push(record);
        if (chunk.length === FILTER_PART_RECORDS) await flush();
      }
      await flush();

      const dataset = await store.transaction(async () => {
        const created = await store.datasets.create({
          id,
          workspaceId,
          name: target,
          metadata: { view },
        });
        if (!created || parts.length === 0) return created;

        return store.datasets.appendVersion({ datasetId: id, parts });
      });
      // A concurrent identical filter won the race.
      if (!dataset)
        return { dataset: await get(workspaceId, target), created: false };

      return { dataset, created: true };
    },
    listRecords,
    render,
    writePart,
  };
};
