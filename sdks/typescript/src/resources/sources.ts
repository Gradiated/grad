import type {
  Secret as SecretData,
  Source as SourceData,
  SourceProvider as SourceProviderData,
} from "../generated/models.js";
import type { RequestOptions } from "../transport.js";
import type { Core } from "../core.js";
import { GradUsageError } from "../errors.js";
import { Paginator } from "../pagination.js";
import { Pending } from "../pending.js";
import { datasetName, ImportJob, type DatasetRef, type PendingImport } from "./datasets.js";

/** A workspace secret: its name and metadata, never its value. Pass it as `secret`. */
export interface SecretRef extends SecretData {}
export class SecretRef {
  constructor(data: SecretData) {
    Object.assign(this, data);
  }

  toString(): string {
    return this.name;
  }
}

/** A secret reference (`await grad.secrets.get(name)`) or a secret name. */
export type SecretLike = SecretRef | { name: string } | string;

export const secretName = (secret: SecretLike): string => {
  const name = typeof secret === "string" ? secret : secret?.name;
  if (typeof name !== "string" || name === "") {
    throw new GradUsageError("secret must be a SecretRef from grad.secrets.get(...) or a secret name.", "invalid_secret");
  }
  return name;
};

export interface ProviderOptions {
  host?: string;
  secret?: SecretLike;
  project?: string;
  filters?: Record<string, unknown>;
}

export interface GradiatedOptions {
  models?: string[];
  tasks?: string[];
  versions?: string[];
  filters?: Record<string, unknown>;
}

export type SourceProvider = SourceProviderData;

const provider = (kind: string, options: ProviderOptions = {}): SourceProvider => ({
  kind,
  ...(options.host !== undefined ? { host: options.host } : {}),
  ...(options.secret !== undefined ? { secret: secretName(options.secret) } : {}),
  ...(options.project !== undefined ? { project: options.project } : {}),
  ...(options.filters !== undefined && Object.keys(options.filters).length > 0 ? { filters: options.filters } : {}),
});

/**
 * Observability providers a dataset can sync from:
 * `dataset.addSource({ provider: sources.langfuse({ host, secret }), schedule: "*\/15 * * * *" })`.
 */
export const sources = {
  /** Langfuse traces and scores; the secret is `PUBLIC_KEY:SECRET_KEY`. */
  langfuse: (options?: ProviderOptions): SourceProvider => provider("langfuse", options),
  /** LangSmith runs and feedback, including corrections. */
  langsmith: (options?: ProviderOptions): SourceProvider => provider("langsmith", options),
  /** Braintrust project logs, scores and `expected` answers (`project` is required). */
  braintrust: (options?: ProviderOptions): SourceProvider => provider("braintrust", options),
  /** PostHog LLM events and survey feedback (`project` is the numeric project id). */
  posthog: (options?: ProviderOptions): SourceProvider => provider("posthog", options),
  /** Arize Phoenix spans and annotations (`host` is required). */
  phoenix: (options?: ProviderOptions): SourceProvider => provider("phoenix", options),
  /** Gradiated Cloud gateway traces and feedback (Cloud only; no host or secret). */
  gradiated: (options: GradiatedOptions = {}): SourceProvider => {
    const filters: Record<string, unknown> = { ...(options.filters ?? {}) };
    for (const key of ["models", "tasks", "versions"] as const) {
      const values = options[key];
      if (values && values.length > 0) filters[key] = values;
    }
    return provider("gradiated", { filters });
  },
};

/** Sampling and record caps of a source (`sources.create` / `addSource` and `update`). */
export interface SourceLimits {
  /** The share of traces to sync (0, 1], chosen by a hash of the trace id, so re-syncs keep the same sample. */
  sampleRate?: number;
  /** At most this many new traces per sync (null: no cap). Feedback on synced traces always lands. */
  maxRecordsPerSync?: number | null;
  /** At most this many new traces per UTC day (null: no cap). */
  maxRecordsPerDay?: number | null;
  /** Seconds between the dataset versions scheduled syncs commit (default 900; 0: every sync). */
  versionInterval?: number;
}

export interface AddSourceOptions extends RequestOptions, SourceLimits {
  /**
   * The provider; its `filters` narrow what is synced (every provider takes `tags`,
   * `environment`, `model`, `version`, `release`, `name`, `user_id`, `session_id`, `metadata`,
   * `from`/`to`, `has_feedback` and `min_score`; other keys are a 422 ValidationError).
   */
  provider: SourceProvider;
  /** Five-field UTC cron (fires at most once a minute); leave it out to sync only on request. */
  schedule?: string;
}

/** Fields left out keep their value; `filters` replaces them all (`{}` clears them). */
export interface UpdateSourceOptions extends RequestOptions, SourceLimits {
  filters?: Record<string, unknown>;
  /** A five-field UTC cron, or null to sync only on request. */
  schedule?: string | null;
}

/**
 * An observability provider synced into a dataset; each sync adds a dataset version. A source
 * feeds exactly one dataset; a dataset can have several sources, and deleting the dataset deletes
 * them. `status` is `"paused"` after 10 failed syncs in a row (`pausedReason`, `lastError` say
 * why); `sync()` or a new value for its secret resumes it.
 */
export interface Source extends SourceData {}
export class Source {
  readonly #core: Core;

  constructor(core: Core, data: SourceData) {
    this.#core = core;
    Object.assign(this, data);
  }

  async refresh(options?: RequestOptions): Promise<this> {
    Object.assign(this, await this.#core.api.getSource(this.id, options));
    return this;
  }

  /** The effective filters, as the server validated them (single values as lists). */
  get filters(): Record<string, unknown> {
    return { ...(this.provider.filters ?? {}) };
  }

  /**
   * Changes filters, sampling, the record caps or the schedule from the next sync; updates this
   * object. Traces already synced stay (`sync({ full: true })` rebuilds with the new settings).
   */
  async update(options: UpdateSourceOptions): Promise<this> {
    Object.assign(this, await updateSource(this.#core, this.id, options));
    return this;
  }

  /**
   * Syncs now; `await source.sync().wait()` blocks until the new version exists.
   * `full: true` rebuilds the dataset from the provider. A sync in progress is returned as is
   * (a full request then runs right after it); within a minute of the last sync's start, that
   * sync is returned. Resumes a paused source.
   */
  sync(options: { full?: boolean } & RequestOptions = {}): PendingImport {
    return new Pending(syncSource(this.#core, this.id, options));
  }

  /** Disconnects the source; the dataset and its versions stay. */
  async remove(options?: RequestOptions): Promise<void> {
    await this.#core.api.deleteSource(this.id, options);
  }

  toJSON(): SourceData {
    return { ...this } as SourceData;
  }
}

const syncSource = async (core: Core, id: string, options: { full?: boolean } & RequestOptions): Promise<ImportJob> => {
  const { full = false, ...request } = options;
  return new ImportJob(core, await core.api.syncSource(id, { full }, request));
};

const defined = <T extends object>(fields: T): Partial<T> =>
  Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as Partial<T>;

export const addSource = async (core: Core, dataset: DatasetRef, options: AddSourceOptions): Promise<Source> => {
  const { provider: body, schedule, sampleRate, maxRecordsPerSync, maxRecordsPerDay, versionInterval, ...request } = options;
  const data = await core.api.createDatasetSource(
    datasetName(dataset),
    { provider: body, ...defined({ schedule, sampleRate, maxRecordsPerSync, maxRecordsPerDay, versionInterval }) },
    request,
  );
  return new Source(core, data);
};

const updateSource = async (core: Core, id: string, options: UpdateSourceOptions): Promise<SourceData> => {
  const { filters, schedule, sampleRate, maxRecordsPerSync, maxRecordsPerDay, versionInterval, ...request } = options;
  return core.api.updateSource(id, defined({ filters, schedule, sampleRate, maxRecordsPerSync, maxRecordsPerDay, versionInterval }), request);
};

export class SecretsResource {
  constructor(private readonly core: Core) {}

  /**
   * Creates or replaces a secret. The value is encrypted at rest and never returned.
   * `allowedHosts` are the only hosts the server sends it to (a source's host,
   * huggingface.co for HF imports, a logger's host); leave it out for the public
   * provider hosts. A secret for a self-hosted tool must name its host.
   */
  async set(
    name: string,
    value: string,
    options: { allowedHosts?: readonly string[] } & RequestOptions = {},
  ): Promise<SecretRef> {
    if (typeof value !== "string" || value === "") {
      throw new GradUsageError("A secret value must be a non-empty string.", "invalid_secret");
    }
    const { allowedHosts, ...request } = options;
    return new SecretRef(
      await this.core.api.setSecret(
        { name, value, ...(allowedHosts !== undefined ? { allowedHosts: [...allowedHosts] } : {}) },
        request,
      ),
    );
  }

  /** A reference to pass as `secret` (checks that it exists; never the value). */
  async get(name: string, options?: RequestOptions): Promise<SecretRef> {
    return new SecretRef(await this.core.api.getSecret(name, options));
  }

  list(options: { limit?: number } & RequestOptions = {}): Paginator<SecretRef> {
    const { limit, ...request } = options;
    return new Paginator(async (cursor) => {
      const page = await this.core.api.listSecrets({ ...(limit !== undefined ? { limit } : {}), ...(cursor ? { cursor } : {}) }, request);
      return { data: page.data.map((s) => new SecretRef(s)), nextCursor: page.nextCursor };
    }, request.signal);
  }

  /** Deletes a secret (409 ConflictError while a source uses it). */
  async delete(secret: SecretLike, options?: RequestOptions): Promise<void> {
    await this.core.api.deleteSecret(secretName(secret), options);
  }
}

export class SourcesResource {
  constructor(private readonly core: Core) {}

  /**
   * Connects `provider` to `dataset` (see also `dataset.addSource`). A source feeds one dataset;
   * a dataset can have several sources.
   */
  create(dataset: DatasetRef, options: AddSourceOptions): Promise<Source> {
    return addSource(this.core, dataset, options);
  }

  async get(id: string, options?: RequestOptions): Promise<Source> {
    return new Source(this.core, await this.core.api.getSource(id, options));
  }

  /** Sources, newest first; `dataset` keeps one dataset's. */
  list(options: { dataset?: DatasetRef; limit?: number } & RequestOptions = {}): Paginator<Source> {
    const { dataset, limit, ...request } = options;
    return new Paginator(async (cursor) => {
      const page = await this.core.api.listSources(
        {
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor ? { cursor } : {}),
          ...(dataset !== undefined ? { dataset: datasetName(dataset) } : {}),
        },
        request,
      );
      return { data: page.data.map((s) => new Source(this.core, s)), nextCursor: page.nextCursor };
    }, request.signal);
  }

  sync(id: string, options: { full?: boolean } & RequestOptions = {}): PendingImport {
    return new Pending(syncSource(this.core, id, options));
  }
  /** Changes a source from its next sync (see `Source.update`). */
  async update(id: string, options: UpdateSourceOptions): Promise<Source> {
    return new Source(this.core, await updateSource(this.core, id, options));
  }

  async remove(id: string, options?: RequestOptions): Promise<void> {
    await this.core.api.deleteSource(id, options);
  }
}
