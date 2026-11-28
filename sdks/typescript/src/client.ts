import { ApiClient } from "./generated/client.js";
import {
  FileBody,
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
import { DEFAULT_BASE_URL, defaultConfigPath, isLoopback, loadProfile, missingKeyMessage, normalizeBaseURL, validateBaseURL } from "./config.js";
import { GradUsageError } from "./errors.js";
import type { Core } from "./core.js";
import { defaultPollContext, type PollContext } from "./polling.js";
import { ArtifactsResource } from "./resources/artifacts.js";
import { DatasetsResource, ImportsResource } from "./resources/datasets.js";
import { EvalsResource } from "./resources/evals.js";
import { KeysResource, ModelsResource, UsageResource } from "./resources/misc.js";
import { CheckpointsResource, RunsResource } from "./resources/runs.js";
import { SecretsResource, SourcesResource } from "./resources/sources.js";

export interface GradOptions {
  /** API key (default: the selected profile, GRADIATED_API_KEY, then the default profile). `""` talks to a server without authentication. */
  apiKey?: string | undefined;
  /** API root (default: the selected profile, GRADIATED_BASE_URL, the default profile, then https://api.gradiated.com). A trailing /v1 is dropped. */
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
  /** Set when no key is configured for a non-loopback server: every request fails with it. */
  missingKey?: string | undefined;
}

const OPTION_KEYS = new Set<string>([
  "apiKey", "baseURL", "profile", "configPath", "timeoutMs", "maxRetries", "fetch",
  "defaultHeaders", "userAgent", "sleep", "now", "random",
]);

/** Throws on an option the client doesn't know (`baseUrl` would otherwise be silently ignored). */
const checkOptions = (options: GradOptions): void => {
  for (const key of Object.keys(options)) {
    if (OPTION_KEYS.has(key)) continue;
    const near = [...OPTION_KEYS].find((k) => k.toLowerCase() === key.toLowerCase());
    throw new GradUsageError(
      `Unknown Grad option '${key}'${near ? `; did you mean '${near}'?` : ""} (options: ${[...OPTION_KEYS].join(", ")}).`,
      "unknown_option",
    );
  }
};

/**
 * Resolves configuration once, with the precedence every SDK and the CLI share:
 * options, then the selected profile (`profile` or GRADIATED_PROFILE), then
 * GRADIATED_API_KEY / GRADIATED_BASE_URL, then the `default` profile of the
 * `grad login` config file, then https://api.gradiated.com. A key saved in a
 * profile is only sent to that profile's own base URL.
 */
const resolveConfig = async (options: GradOptions): Promise<ResolvedConfig> => {
  const explicit = options.profile ?? readEnv("GRADIATED_PROFILE");
  const name = explicit ?? "default";
  const envURL = readEnv("GRADIATED_BASE_URL");
  const envKey = readEnv("GRADIATED_API_KEY");
  const covered = (options.baseURL ?? envURL) !== undefined && (options.apiKey ?? envKey) !== undefined;
  const path = options.configPath ?? defaultConfigPath();
  const profile = covered && explicit === undefined ? undefined : await loadProfile(path, name);
  if (explicit !== undefined && profile === undefined) {
    throw new GradUsageError(
      `Profile '${name}' not found in ${path ?? "the grad config file"}; create it with \`grad login --profile ${name}\`.`,
      "profile_not_found",
    );
  }
  const raw =
    options.baseURL ?? (explicit !== undefined ? profile?.baseURL : undefined) ?? envURL ?? profile?.baseURL ?? DEFAULT_BASE_URL;
  const baseURL = normalizeBaseURL(raw);
  // A saved key belongs to its profile's server: never send it anywhere else.
  const owner = profile?.baseURL !== undefined ? normalizeBaseURL(profile.baseURL, false) : DEFAULT_BASE_URL;
  const fileKey = profile?.apiKey !== undefined && owner === baseURL ? profile.apiKey : undefined;
  let apiKey: string | undefined;
  let apiKeySource: ResolvedConfig["apiKeySource"] = "none";
  if (options.apiKey !== undefined) [apiKey, apiKeySource] = [options.apiKey, "option"];
  else if (explicit !== undefined && fileKey !== undefined) [apiKey, apiKeySource] = [fileKey, "config"];
  else if (envKey !== undefined) [apiKey, apiKeySource] = [envKey, "env"];
  else if (fileKey !== undefined) [apiKey, apiKeySource] = [fileKey, "config"];
  let missingKey: string | undefined;
  if (apiKey === undefined && !isLoopback(baseURL)) {
    const note =
      profile?.apiKey !== undefined && fileKey === undefined
        ? ` (the key saved in profile '${name}' belongs to ${owner}, so it was not sent)`
        : "";
    missingKey = missingKeyMessage(baseURL) + note;
  }
  return { baseURL, apiKey: apiKey === "" ? undefined : apiKey, apiKeySource, missingKey };
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

  /** The transport for an API request; fails before sending when no key is configured for a remote server. */
  private async ready(): Promise<Transport> {
    const { transport, config } = await this.resolve();
    if (config.missingKey !== undefined) throw new GradUsageError(config.missingKey, "missing_api_key");
    return transport;
  }

  async json(spec: RequestSpec, options?: RequestOptions): Promise<unknown> {
    return (await this.ready()).json(spec, options);
  }

  async raw(spec: RequestSpec, options?: StreamOptions): Promise<RawResponse> {
    return (await this.ready()).raw(spec, options);
  }

  async *sse(spec: RequestSpec, options?: SSEOptions): AsyncGenerator<ServerSentEvent, void, undefined> {
    yield* (await this.ready()).sse(spec, options);
  }

  /** PUTs to an upload URL without the API key (presigned S3 or the server's signed blob route). */
  async upload(url: string, headers: Record<string, string>, file: { path: string; sizeBytes: number }, options?: RequestOptions): Promise<RawResponse> {
    const { config } = await this.resolve();
    const target = new URL(url, `${config.baseURL.replace(/\/+$/, "")}/`);
    const { nodeFetch } = await import("./node/files.js");
    const uploader = new Transport({
      baseURL: target.origin,
      apiKey: undefined,
      timeoutMs: this.options.timeoutMs,
      maxRetries: this.options.maxRetries,
      fetch: this.options.fetch ?? nodeFetch,
      userAgent: this.options.userAgent,
      sleep: this.options.sleep,
      random: this.options.random,
    });
    // No per-attempt deadline: a multi-GB upload outlasts any request timeout. `signal` still cancels it.
    return uploader.raw(
      { method: "PUT", path: `${target.pathname}${target.search}`, body: new FileBody(file.path, file.sizeBytes), headers: Object.entries(headers), accept: "*/*" },
      { ...options, timeoutMs: Number.POSITIVE_INFINITY },
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
  readonly evals: EvalsResource;
  readonly keys: KeysResource;
  readonly secrets: SecretsResource;
  readonly sources: SourcesResource;
  readonly usage: UsageResource;
  readonly #transport: LazyTransport;
  readonly #core: Core;

  constructor(options: GradOptions = {}) {
    checkOptions(options);
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
      upload: (url, headers, file, request) => this.#transport.upload(url, headers, file, request),
      baseURL: async () => (await this.#transport.resolve()).config.baseURL,
    };
    this.models = new ModelsResource(this.#core);
    this.datasets = new DatasetsResource(this.#core);
    this.imports = new ImportsResource(this.#core);
    this.runs = new RunsResource(this.#core);
    this.checkpoints = new CheckpointsResource(this.#core);
    this.artifacts = new ArtifactsResource(this.#core);
    this.evals = new EvalsResource(this.#core);
    this.keys = new KeysResource(this.#core);
    this.secrets = new SecretsResource(this.#core);
    this.sources = new SourcesResource(this.#core);
    this.usage = new UsageResource(this.#core);
  }

  /** The base URL and key source this client resolved (the key itself is never returned). */
  async config(): Promise<{ baseURL: string; apiKeySource: ResolvedConfig["apiKeySource"] }> {
    const { config } = await this.#transport.resolve();
    return { baseURL: config.baseURL, apiKeySource: config.apiKeySource };
  }
}
