import type {
  Dataset as DatasetData,
  DatasetRecord,
  HfColumnMapping,
  ImportJob as ImportJobData,
  RenderDatasetRequest,
  RenderDatasetResponse,
} from "../generated/models.js";
import type { RequestOptions } from "../generated/transport.js";
import { isNodeRuntime, type Core } from "../core.js";
import { GradUsageError, ImportFailedError } from "../errors.js";
import { Paginator } from "../pagination.js";
import { Pending } from "../pending.js";
import { pollUntil, type WaitOptions } from "../polling.js";

export type DatasetRef = string | { name: string };
export const datasetName = (ref: DatasetRef): string => (typeof ref === "string" ? ref : ref.name);

type Connector = NonNullable<ImportJobData["connector"]>;

export interface ImportFileOptions extends RequestOptions {
  /** Trace format; `auto` detects OpenAI chat, OTel, Langfuse, PostHog, Braintrust, LangSmith and grad.trajectory/1. */
  connector?: Connector;
  format?: "auto" | "jsonl" | "json" | "parquet";
}

export interface FromHfOptions extends WaitOptions {
  /** Dataset name to create (default: derived from the repo and split). */
  name?: string;
  split?: string;
  /** HF config / subset name. */
  subset?: string;
  revision?: string;
  limit?: number;
  connector?: Connector;
  /** Column mapping (also accepted at the top level: `prompt: "question"`). */
  columns?: HfColumnMapping;
  messages?: string;
  prompt?: string;
  completion?: string;
  chosen?: string;
  rejected?: string;
  answer?: string;
  query?: string;
  positive?: string;
}

export interface PushOptions extends RequestOptions {
  metadata?: Record<string, unknown>;
  /** Records per request (default 1000). */
  batchSize?: number;
  /** Approximate JSON bytes per request (default 8 MiB; the server caps bodies at 32 MiB). */
  maxBatchBytes?: number;
}

const DEFAULT_BATCH = 1000;
const DEFAULT_BATCH_BYTES = 8 * 1024 * 1024;

/** An async import job; `wait()` resolves when the records are in the dataset. */
export interface ImportJob extends ImportJobData {}
export class ImportJob {
  readonly #core: Core;

  constructor(core: Core, data: ImportJobData) {
    this.#core = core;
    Object.assign(this, data);
  }

  async refresh(options?: RequestOptions): Promise<this> {
    Object.assign(this, await this.#core.api.getImport(this.id, options));
    return this;
  }

  /** Polls until `completed` (throws ImportFailedError on `failed`). */
  async wait(options: WaitOptions = {}): Promise<ImportJob> {
    const done = await pollUntil(
      `import ${this.id}`,
      (signal) => this.#core.api.getImport(this.id, { signal }),
      (job) => job.status === "completed" || job.status === "failed",
      options,
      this.#core.poll,
    );
    Object.assign(this, done);
    if (done.status === "failed") throw new ImportFailedError(done);
    return this;
  }
}

export type PendingImport = Pending<ImportJob, ImportJob, WaitOptions>;

/** A named, versioned set of records. */
export interface Dataset extends DatasetData {}
export class Dataset {
  readonly #core: Core;

  constructor(core: Core, data: DatasetData) {
    this.#core = core;
    Object.assign(this, data);
  }

  async refresh(options?: RequestOptions): Promise<this> {
    Object.assign(this, await this.#core.api.getDataset(this.name, options));
    return this;
  }

  /** Current record count (refreshes from the server). */
  async count(options?: RequestOptions): Promise<number> {
    await this.refresh(options);
    return this.recordCount;
  }

  /** Appends records (or a JSONL file path in Node). */
  async push(records: DatasetRecord[] | Iterable<DatasetRecord> | AsyncIterable<DatasetRecord> | string, options?: PushOptions): Promise<this> {
    Object.assign(this, await pushRecords(this.#core, this.name, records, options));
    return this;
  }

  /** Uploads a JSONL/JSON/Parquet trace file and starts an import (Node only). */
  importFile(path: string, options: ImportFileOptions = {}): PendingImport {
    return new Pending(importFile(this.#core, this.name, path, options));
  }

  /** Imports a Hugging Face dataset into this dataset. */
  importHf(repo: string, options: Omit<FromHfOptions, "name"> = {}): PendingImport {
    return new Pending(importHf(this.#core, this.name, repo, options));
  }

  /** Records of the current (or a given) version, page by page. */
  records(options: { version?: number; limit?: number } & RequestOptions = {}): Paginator<DatasetRecord> {
    const { version, limit, ...request } = options;
    return new Paginator(async (cursor) => {
      const page = await this.#core.api.listDatasetRecords(
        this.name,
        { ...(version !== undefined ? { version } : {}), ...(limit !== undefined ? { limit } : {}), ...(cursor ? { cursor } : {}) },
        request,
      );
      return { data: page.data, nextCursor: page.nextCursor };
    }, request.signal);
  }

  /** Shows exactly which tokens train for the first few records. */
  render(options: RenderDatasetRequest = {}, request?: RequestOptions): Promise<RenderDatasetResponse> {
    return this.#core.api.renderDataset(this.name, options, request);
  }

  toJSON(): DatasetData {
    return { ...this } as DatasetData;
  }
}

const jsonSize = (value: unknown): number => JSON.stringify(value).length;

async function* iterate<T>(source: Iterable<T> | AsyncIterable<T>): AsyncGenerator<T> {
  yield* source as AsyncIterable<T>;
}

export const pushRecords = async (
  core: Core,
  name: string,
  records: DatasetRecord[] | Iterable<DatasetRecord> | AsyncIterable<DatasetRecord> | string,
  options: PushOptions = {},
): Promise<DatasetData> => {
  const { metadata, batchSize = DEFAULT_BATCH, maxBatchBytes = DEFAULT_BATCH_BYTES, ...request } = options;
  let source: AsyncIterable<DatasetRecord>;
  if (typeof records === "string") {
    if (!isNodeRuntime()) throw new GradUsageError("Pushing a file path needs Node.js; pass records in a browser.", "node_only");
    const { readJsonl } = await import("../node/files.js");
    source = readJsonl(records) as AsyncIterable<DatasetRecord>;
  } else {
    source = iterate(records);
  }
  let batch: DatasetRecord[] = [];
  let bytes = 0;
  let result: DatasetData | undefined;
  let first = true;
  const flush = async () => {
    if (batch.length === 0) return;
    result = await core.api.pushDatasetRecords(
      name,
      { records: batch, ...(first && metadata !== undefined ? { metadata } : {}) },
      request,
    );
    first = false;
    batch = [];
    bytes = 0;
  };
  for await (const record of source) {
    const size = jsonSize(record);
    if (batch.length > 0 && (batch.length >= batchSize || bytes + size > maxBatchBytes)) await flush();
    batch.push(record);
    bytes += size;
  }
  await flush();
  if (!result) throw new GradUsageError(`No records to push to dataset '${name}'.`, "empty_push");
  return result;
};

const importFile = async (core: Core, name: string, path: string, options: ImportFileOptions): Promise<ImportJob> => {
  if (!isNodeRuntime()) throw new GradUsageError("importFile needs Node.js (it reads the file from disk).", "node_only");
  const { connector, format, ...request } = options;
  const { describeFile } = await import("../node/files.js");
  const file = await describeFile(path);
  const ticket = await core.api.createUpload(
    { purpose: "dataset_import", filename: file.filename, sizeBytes: file.sizeBytes, sha256: file.sha256 },
    request,
  );
  const put = await core.upload(ticket.url, ticket.headers, file.blob, request);
  await put.cancel();
  const job = await core.api.createDatasetImport(
    name,
    {
      source: { kind: "upload", uploadId: ticket.uploadId, ...(format !== undefined ? { format } : {}) },
      ...(connector !== undefined ? { connector } : {}),
    },
    request,
  );
  return new ImportJob(core, job);
};

const hfColumns = (options: FromHfOptions): HfColumnMapping => {
  const columns: HfColumnMapping = { ...(options.columns ?? {}) };
  for (const key of ["messages", "prompt", "completion", "chosen", "rejected", "answer", "query", "positive"] as const) {
    const value = options[key];
    if (value !== undefined) columns[key] = value;
  }
  return columns;
};

const importHf = async (core: Core, name: string, repo: string, options: Omit<FromHfOptions, "name">): Promise<ImportJob> => {
  const columns = hfColumns(options);
  const job = await core.api.createDatasetImport(name, {
    source: {
      kind: "hf",
      repo,
      ...(options.split !== undefined ? { split: options.split } : {}),
      ...(options.subset !== undefined ? { config: options.subset } : {}),
      ...(options.revision !== undefined ? { revision: options.revision } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(Object.keys(columns).length > 0 ? { columns } : {}),
    },
    ...(options.connector !== undefined ? { connector: options.connector } : {}),
  });
  return new ImportJob(core, job);
};

export const hfDatasetName = (repo: string, split = "train"): string =>
  `${repo}-${split}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64)
    .replace(/[-.]+$/, "");

export class DatasetsResource {
  constructor(private readonly core: Core) {}

  /** Creates an empty dataset (409 ConflictError if the name exists). */
  async create(name: string, options: { metadata?: Record<string, unknown> } & RequestOptions = {}): Promise<Dataset> {
    const { metadata, ...request } = options;
    return new Dataset(this.core, await this.core.api.createDataset({ name, ...(metadata !== undefined ? { metadata } : {}) }, request));
  }

  async get(name: string, options?: RequestOptions): Promise<Dataset> {
    return new Dataset(this.core, await this.core.api.getDataset(name, options));
  }

  list(options: { limit?: number } & RequestOptions = {}): Paginator<Dataset> {
    const { limit, ...request } = options;
    return new Paginator(async (cursor) => {
      const page = await this.core.api.listDatasets({ ...(limit !== undefined ? { limit } : {}), ...(cursor ? { cursor } : {}) }, request);
      return { data: page.data.map((d) => new Dataset(this.core, d)), nextCursor: page.nextCursor };
    }, request.signal);
  }

  /** Pushes records (or a JSONL path in Node), creating the dataset if needed. Large inputs go in batches. */
  async push(
    name: string,
    records: DatasetRecord[] | Iterable<DatasetRecord> | AsyncIterable<DatasetRecord> | string,
    options?: PushOptions,
  ): Promise<Dataset> {
    return new Dataset(this.core, await pushRecords(this.core, name, records, options));
  }

  records(name: string, options: { version?: number; limit?: number } & RequestOptions = {}): Paginator<DatasetRecord> {
    return new Dataset(this.core, { name } as DatasetData).records(options);
  }

  render(name: string, options: RenderDatasetRequest = {}, request?: RequestOptions): Promise<RenderDatasetResponse> {
    return this.core.api.renderDataset(name, options, request);
  }

  importFile(name: DatasetRef, path: string, options: ImportFileOptions = {}): PendingImport {
    return new Pending(importFile(this.core, datasetName(name), path, options));
  }

  /**
   * Imports a Hugging Face dataset into a new (or existing) dataset and waits
   * for it: `await grad.datasets.fromHf("openai/gsm8k", { subset: "main", prompt: "question", answer: "answer" })`.
   */
  async fromHf(repo: string, options: FromHfOptions = {}): Promise<Dataset> {
    const name = options.name ?? hfDatasetName(repo, options.split);
    try {
      await this.core.api.createDataset({ name, metadata: { source: `hf:${repo}` } });
    } catch (error) {
      if ((error as { status?: number }).status !== 409) throw error;
    }
    const { timeoutMs, signal, pollIntervalMs, maxPollIntervalMs, ...rest } = options;
    const job = await importHf(this.core, name, repo, rest);
    await job.wait({ timeoutMs, signal, pollIntervalMs, maxPollIntervalMs });
    return this.get(name);
  }
}

export class ImportsResource {
  constructor(private readonly core: Core) {}

  async get(id: string, options?: RequestOptions): Promise<ImportJob> {
    return new ImportJob(this.core, await this.core.api.getImport(id, options));
  }

  list(options: { limit?: number } & RequestOptions = {}): Paginator<ImportJob> {
    const { limit, ...request } = options;
    return new Paginator(async (cursor) => {
      const page = await this.core.api.listImports({ ...(limit !== undefined ? { limit } : {}), ...(cursor ? { cursor } : {}) }, request);
      return { data: page.data.map((j) => new ImportJob(this.core, j)), nextCursor: page.nextCursor };
    }, request.signal);
  }

  async wait(id: string, options?: WaitOptions): Promise<ImportJob> {
    return (await this.get(id)).wait(options);
  }
}
