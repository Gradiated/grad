import type { ApiKey, ApiKeyScope, CreatedApiKey, TrainableModel, UsageGroupBy, UsageKind, UsageRecord, UsageSummary } from "../generated/models.js";
import type { RequestOptions } from "../transport.js";
import type { Core } from "../core.js";
import { Paginator } from "../pagination.js";

export class ModelsResource {
  constructor(private readonly core: Core) {}

  /** Trainable base models with their adapters, recipes and prices. */
  async list(options?: RequestOptions): Promise<TrainableModel[]> {
    return (await this.core.api.listBaseModels(options)).data;
  }
}

export class KeysResource {
  constructor(private readonly core: Core) {}

  /** Mints a scoped key; `secret` is shown only once. */
  create(input: { name: string; scopes: ApiKeyScope[] }, options?: RequestOptions): Promise<CreatedApiKey> {
    return this.core.api.createApiKey(input, options);
  }

  list(options: { limit?: number } & RequestOptions = {}): Paginator<ApiKey> {
    const { limit, ...request } = options;
    return new Paginator(async (cursor) => {
      const page = await this.core.api.listApiKeys({ ...(limit !== undefined ? { limit } : {}), ...(cursor ? { cursor } : {}) }, request);
      return { data: page.data, nextCursor: page.nextCursor };
    }, request.signal);
  }

  revoke(id: string, options?: RequestOptions): Promise<ApiKey> {
    return this.core.api.revokeApiKey(id, options);
  }
}

/**
 * A period bound, in UTC: `"YYYY-MM-DD"` (as `to`, it covers that whole day), an ISO timestamp
 * string, or a `Date` (an instant; as `to`, exclusive).
 */
export type UsageBound = string | Date;

export interface UsagePeriod {
  /** Start of the period (inclusive). */
  from?: UsageBound;
  /** End of the period: a date covers that whole UTC day; a timestamp is exclusive. */
  to?: UsageBound;
}

export interface UsageListOptions extends UsagePeriod {
  /** A run (or its id): its training and the evals it started (labeling, teacher answers, checkpoint evals). */
  runId?: string | { id: string };
  /** An eval (or its id). */
  evalId?: string | { id: string };
  kind?: UsageKind;
  /** Page size. */
  limit?: number;
}

const bound = (value: UsageBound | undefined): string | undefined => (value instanceof Date ? value.toISOString() : value);

const refId = (value: string | { id: string } | undefined): string | undefined => (typeof value === "object" ? value.id : value);

export class UsageResource {
  constructor(private readonly core: Core) {}

  /** Total cost and tokens, by kind, the top runs and evals, and `groupBy` groups. Default period: this UTC month. */
  summary(options: UsagePeriod & { groupBy?: UsageGroupBy } & RequestOptions = {}): Promise<UsageSummary> {
    const { from, to, groupBy, ...request } = options;
    return this.core.api.getUsageSummary({ from: bound(from), to: bound(to), groupBy }, request);
  }

  /** Billed rows, newest first: one per billed increment of a run or eval attempt. */
  list(options: UsageListOptions & RequestOptions = {}): Paginator<UsageRecord> {
    const { from, to, runId, evalId, kind, limit, ...request } = options;
    const filters = { from: bound(from), to: bound(to), runId: refId(runId), evalId: refId(evalId), kind, limit };
    return new Paginator(async (cursor) => {
      const page = await this.core.api.listUsage({ ...filters, ...(cursor ? { cursor } : {}) }, request);
      return { data: page.data, nextCursor: page.nextCursor };
    }, request.signal);
  }
}
