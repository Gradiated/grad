import { ApiClient } from "./generated/client.js";
import {
  readEnv,
  Transport,
  type RawResponse,
  type RequestOptions,
  type RequestSpec,
  type ServerSentEvent,
  type Sleep,
  type SSEOptions,
  type StreamOptions,
  type TransportLike,
} from "./transport.js";
import { DEFAULT_BASE_URL, defaultConfigPath, loadProfile, validateBaseURL } from "./config.js";
import type { Core } from "./core.js";
import { defaultPollContext, type PollContext } from "./polling.js";
import { Artifact, ArtifactsResource, deployArtifact, DeploymentsResource, type ArtifactRef, type DeployOptions } from "./resources/artifacts.js";
import { DatasetsResource, ImportsResource } from "./resources/datasets.js";
import { EvalsResource } from "./resources/evals.js";
import { KeysResource, ModelsResource } from "./resources/misc.js";
import { CheckpointsResource, RunsResource } from "./resources/runs.js";
import { SecretsResource, SourcesResource } from "./resources/sources.js";
import type { Deployment } from "./generated/models.js";

export interface GradOptions {
  /** API key (default: GRADIATED_API_KEY, then the `grad login` config file). */
  apiKey?: string | undefined;
  /** API root (default: GRADIATED_BASE_URL, then the config file, then https://api.gradiated.com). */
  baseURL?: string | undefined;
  /** Config-file profile (default: GRADIATED_PROFILE or "default"). */
  profile?: string | undefined;
  /** Config file path (default: $XDG_CONFIG_HOME/gradiated/config.json or ~/.config/gradiated/config.json). */
  configPath?: string | undefined;
  /** Per-attempt request timeout until response headers (and JSON bodies) arrive; default 60 s. */
  timeoutMs?: number | undefined;
  /** Retries for transient failures (default 2). */
  maxRetries?: number | undefined;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch | undefined;
  defaultHeaders?: Record<string, string> | undefined;
  userAgent?: string | undefined;
  /** Test hooks: the clock used for retry backoff and polling. */
  sleep?: Sleep | undefined;
  now?: (() => number) | undefined;
  random?: (() => number) | undefined;
}

export interface ResolvedConfig {
  baseURL: string;
  apiKey: string | undefined;
  apiKeySource: "option" | "env" | "config" | "none";
}

/** Resolves configuration once: explicit options, then environment, then the CLI config file. */
const resolveConfig = async (options: GradOptions): Promise<ResolvedConfig> => {
  let baseURL = options.baseURL ?? readEnv("GRADIATED_BASE_URL");
  let apiKey = options.apiKey ?? readEnv("GRADIATED_API_KEY");
  let apiKeySource: ResolvedConfig["apiKeySource"] = options.apiKey !== undefined ? "option" : apiKey !== undefined ? "env" : "none";
  if (baseURL === undefined || apiKey === undefined) {
    const profile = await loadProfile(options.configPath ?? defaultConfigPath(), options.profile ?? readEnv("GRADIATED_PROFILE") ?? "default");
    baseURL ??= profile?.baseURL;
    if (apiKey === undefined && profile?.apiKey !== undefined) {
      apiKey = profile.apiKey;
      apiKeySource = "config";
    }
  }
  return { baseURL: baseURL ?? DEFAULT_BASE_URL, apiKey: apiKey === "" ? undefined : apiKey, apiKeySource };
};

/** Builds the real transport on first use, so configuration can come from a file without blocking the constructor. */
class LazyTransport implements TransportLike {
  private pending: Promise<{ transport: Transport; config: ResolvedConfig }> | undefined;

  constructor(private readonly options: GradOptions) {}

  resolve(): Promise<{ transport: Transport; config: ResolvedConfig }> {
    this.pending ??= resolveConfig(this.options).then((config) => ({
      config,
      transport: new Transport({
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        timeoutMs: this.options.timeoutMs,
        maxRetries: this.options.maxRetries,
        fetch: this.options.fetch,
        defaultHeaders: this.options.defaultHeaders,
        userAgent: this.options.userAgent,
        sleep: this.options.sleep,
        random: this.options.random,
      }),
    }));
    return this.pending;
  }

  async json(spec: RequestSpec, options?: RequestOptions): Promise<unknown> {
    return (await this.resolve()).transport.json(spec, options);
  }

  async raw(spec: RequestSpec, options?: StreamOptions): Promise<RawResponse> {
    return (await this.resolve()).transport.raw(spec, options);
  }

  async *sse(spec: RequestSpec, options?: SSEOptions): AsyncGenerator<ServerSentEvent, void, undefined> {
    yield* (await this.resolve()).transport.sse(spec, options);
  }

  /** PUTs to an upload URL without the API key (presigned S3 or the server's signed blob route). */
  async upload(url: string, headers: Record<string, string>, body: Blob | Uint8Array | string, options?: RequestOptions): Promise<RawResponse> {
    const { config } = await this.resolve();
    const target = new URL(url, `${config.baseURL.replace(/\/+$/, "")}/`);
    const uploader = new Transport({
      baseURL: target.origin,
      apiKey: undefined,
      timeoutMs: this.options.timeoutMs,
      maxRetries: this.options.maxRetries,
      fetch: this.options.fetch,
      userAgent: this.options.userAgent,
      sleep: this.options.sleep,
      random: this.options.random,
    });
    return uploader.raw(
      { method: "PUT", path: `${target.pathname}${target.search}`, body, headers: Object.entries(headers), accept: "*/*" },
      options,
    );
  }
}

/**
 * The Gradiated training and serving client.
 *
 * ```ts
 * const grad = new Grad(); // GRADIATED_API_KEY, GRADIATED_BASE_URL, or `grad login`
 * const run = await grad.runs.create({ dataset, name: "support-router", recipe: recipes.router() }).wait();
 * ```
 */
export class Grad {
  /** Low-level typed client: one method per OpenAPI operation (wire-exact, camelCase keys). */
  readonly api: ApiClient;
  readonly models: ModelsResource;
  readonly datasets: DatasetsResource;
  readonly imports: ImportsResource;
  readonly runs: RunsResource;
  readonly checkpoints: CheckpointsResource;
  readonly artifacts: ArtifactsResource;
  readonly deployments: DeploymentsResource;
  readonly evals: EvalsResource;
  readonly keys: KeysResource;
  readonly secrets: SecretsResource;
  readonly sources: SourcesResource;
  readonly #transport: LazyTransport;
  readonly #core: Core;

  constructor(options: GradOptions = {}) {
    if (options.baseURL !== undefined) validateBaseURL(options.baseURL);
    this.#transport = new LazyTransport(options);
    this.api = new ApiClient(this.#transport);
    const poll: PollContext = {
      sleep: options.sleep ?? defaultPollContext.sleep,
      now: options.now ?? defaultPollContext.now,
    };
    this.#core = {
      api: this.api,
      transport: this.#transport,
      poll,
      upload: (url, headers, body, request) => this.#transport.upload(url, headers, body, request),
      baseURL: async () => (await this.#transport.resolve()).config.baseURL,
    };
    this.models = new ModelsResource(this.#core);
    this.datasets = new DatasetsResource(this.#core);
    this.imports = new ImportsResource(this.#core);
    this.runs = new RunsResource(this.#core);
    this.checkpoints = new CheckpointsResource(this.#core);
    this.artifacts = new ArtifactsResource(this.#core);
    this.deployments = new DeploymentsResource(this.#core);
    this.evals = new EvalsResource(this.#core);
    this.keys = new KeysResource(this.#core);
    this.secrets = new SecretsResource(this.#core);
    this.sources = new SourcesResource(this.#core);
  }

  /** The base URL and key source this client resolved (the key itself is never returned). */
  async config(): Promise<{ baseURL: string; apiKeySource: ResolvedConfig["apiKeySource"] }> {
    const { config } = await this.#transport.resolve();
    return { baseURL: config.baseURL, apiKeySource: config.apiKeySource };
  }

  /** Deploys an artifact (same as `grad.deployments.create`). */
  deploy(artifact: ArtifactRef | Artifact, options?: DeployOptions): Promise<Deployment> {
    return deployArtifact(this.#core, artifact, options);
  }
}
