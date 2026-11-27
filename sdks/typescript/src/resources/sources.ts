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

export interface AddSourceOptions extends RequestOptions {
  provider: SourceProvider;
  /** Five-field UTC cron; leave it out to sync only on request. */
  schedule?: string;
}

/** An observability provider synced into a dataset; each sync adds a dataset version. */
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

  /**
   * Syncs now; `await source.sync().wait()` blocks until the new version exists.
   * `full: true` rebuilds the dataset from the provider. A sync in progress is returned as is.
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

export const addSource = async (core: Core, dataset: DatasetRef, options: AddSourceOptions): Promise<Source> => {
  const { provider: body, schedule, ...request } = options;
  const data = await core.api.createDatasetSource(
    datasetName(dataset),
    { provider: body, ...(schedule !== undefined ? { schedule } : {}) },
    request,
  );
  return new Source(core, data);
};

export class SecretsResource {
  constructor(private readonly core: Core) {}

  /** Creates or replaces a secret. The value is encrypted at rest and never returned. */
  async set(name: string, value: string, options?: RequestOptions): Promise<SecretRef> {
    if (typeof value !== "string" || value === "") {
      throw new GradUsageError("A secret value must be a non-empty string.", "invalid_secret");
    }
    return new SecretRef(await this.core.api.setSecret({ name, value }, options));
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

  /** Connects `provider` to `dataset` (see also `dataset.addSource`). */
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

  async remove(id: string, options?: RequestOptions): Promise<void> {
    await this.core.api.deleteSource(id, options);
  }
}
