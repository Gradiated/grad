import type { ApiKey, ApiKeyScope, CreatedApiKey, TrainableModel } from "../generated/models.js";
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
