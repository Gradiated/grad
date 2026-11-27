// AUTO-GENERATED from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.
/* HTTP runtime shared by every generated operation: typed errors, retries with
 * backoff and Retry-After, same-origin-only redirects, per-attempt timeouts
 * that stop at the response headers for streams, SSE parsing, request ids,
 * and the camelCase <-> wire key codec. Browser-safe: no Node imports. */

export const SDK_VERSION = "0.1.0";

type Env = Record<string, string | undefined>;
type ProcessLike = { version?: string; env?: Env; platform?: string };
const nodeProcess = (): ProcessLike | undefined =>
  (globalThis as { process?: ProcessLike }).process;

export const readEnv = (name: string): string | undefined => {
  const value = nodeProcess()?.env?.[name];
  return value === undefined || value === "" ? undefined : value;
};

// ---------------------------------------------------------------- errors

export interface FieldError {
  field: string;
  message: string;
}

export interface GradErrorInit {
  status?: number | undefined;
  code: string;
  requestId?: string | undefined;
  cause?: unknown;
}

/** Base class of every error the SDK throws. */
export class GradError extends Error {
  readonly status: number | undefined;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(message: string, init: GradErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
  }
}

export interface APIErrorInit {
  status: number;
  code: string;
  title: string;
  detail: string;
  type: string;
  requestId: string | undefined;
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
  fieldErrors: FieldError[];
  retryAfterMs: number | undefined;
}

/** The server answered with a non-2xx status (RFC 7807 problem+json when it can). */
export class APIError extends GradError {
  declare readonly status: number;
  readonly title: string;
  readonly detail: string;
  readonly type: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: unknown;
  readonly fieldErrors: FieldError[];
  readonly retryAfterMs: number | undefined;

  constructor(message: string, init: APIErrorInit) {
    super(message, {
      status: init.status,
      code: init.code,
      requestId: init.requestId,
    });
    this.title = init.title;
    this.detail = init.detail;
    this.type = init.type;
    this.method = init.method;
    this.url = init.url;
    this.headers = init.headers;
    this.body = init.body;
    this.fieldErrors = init.fieldErrors;
    this.retryAfterMs = init.retryAfterMs;
  }
}

export class BadRequestError extends APIError {}
export class AuthenticationError extends APIError {}
export class PermissionDeniedError extends APIError {}
export class NotFoundError extends APIError {}
export class ConflictError extends APIError {}
export class ValidationError extends APIError {}
export class RateLimitError extends APIError {}
export class ServerError extends APIError {}
/** 501 `deploy_unavailable`: this server cannot deploy or serve (self-hosted). */
export class DeployUnavailableError extends APIError {}
/** 501 `inference_unavailable`: no inference endpoint is configured. */
export class InferenceUnavailableError extends APIError {}

/** The request never produced an HTTP response (DNS, refused, reset, TLS). */
export class APIConnectionError extends GradError {}
/** The per-request timeout elapsed before a response (or a stream went idle). */
export class APITimeoutError extends APIConnectionError {}
/** The caller's AbortSignal fired. */
export class APIUserAbortError extends GradError {}
/** A redirect would leave the API origin (or change the method); refused so credentials never leak. */
export class RedirectError extends GradError {}
/** A 2xx response body was not valid JSON. */
export class ResponseDecodeError extends GradError {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** Parses `a.b: message; c: other` (the server's validation detail) or a problem `errors` array. */
export const parseFieldErrors = (body: unknown, detail: string): FieldError[] => {
  if (isObject(body) && Array.isArray(body.errors)) {
    return body.errors.flatMap((item): FieldError[] => {
      if (!isObject(item)) return [];
      const field =
        str(item.field) ??
        (Array.isArray(item.path) ? item.path.join(".") : undefined) ??
        str(item.pointer) ??
        "";
      return [{ field, message: str(item.message) ?? str(item.detail) ?? "" }];
    });
  }
  return detail
    .split("; ")
    .map((part) => /^([A-Za-z0-9_.[\]-]+): (.+)$/s.exec(part))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ field: m[1] ?? "", message: m[2] ?? "" }));
};

export const parseRetryAfterMs = (
  headers: Headers,
  now: number = Date.now(),
): number | undefined => {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && /^\d+(\.\d+)?$/.test(ms.trim())) return Number(ms);
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const value = raw.trim();
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
};

const errorClassFor = (status: number, code: string): typeof APIError => {
  if (code === "deploy_unavailable") return DeployUnavailableError;
  if (code === "inference_unavailable") return InferenceUnavailableError;
  if (status === 400) return BadRequestError;
  if (status === 401) return AuthenticationError;
  if (status === 403) return PermissionDeniedError;
  if (status === 404) return NotFoundError;
  if (status === 409) return ConflictError;
  if (status === 422) return ValidationError;
  if (status === 429) return RateLimitError;
  if (status >= 500) return ServerError;
  return APIError;
};

export interface ErrorContext {
  method: string;
  url: string;
  apiKeyConfigured: boolean;
}

/** Builds the typed error for a non-2xx response; tolerant of any body shape. */
export const makeAPIError = (
  status: number,
  headers: Headers,
  text: string,
  ctx: ErrorContext,
): APIError => {
  let body: unknown = text;
  try {
    body = text.trim() === "" ? undefined : JSON.parse(text);
  } catch {
    // Non-JSON body (proxy HTML, plain text): keep the raw text.
  }
  const problem = isObject(body) ? body : {};
  const code = str(problem.code) ?? `http_${status}`;
  const title = str(problem.title) ?? `HTTP ${status}`;
  const detail =
    str(problem.detail) ??
    str(problem.message) ??
    (typeof body === "string" ? body.slice(0, 500).trim() : "");
  const requestId = headers.get("x-request-id") ?? str(problem.request_id);
  let hint = "";
  if (status === 401 && !ctx.apiKeyConfigured) {
    hint =
      " No API key is configured: set GRADIATED_API_KEY, pass `apiKey`, or run `grad login`.";
  }
  const message = `${ctx.method} ${ctx.url} returned ${status} ${code}${detail ? `: ${detail}` : ""}${hint}${requestId ? ` (request_id ${requestId})` : ""}`;
  const ErrorClass = errorClassFor(status, code);
  return new ErrorClass(message, {
    status,
    code,
    title,
    detail,
    type: str(problem.type) ?? "about:blank",
    requestId,
    method: ctx.method,
    url: ctx.url,
    headers,
    body,
    fieldErrors: status === 422 ? parseFieldErrors(body, detail) : [],
    retryAfterMs: parseRetryAfterMs(headers),
  });
};

// ---------------------------------------------------------------- codec

/** Schema descriptor: 0 = copy verbatim, string = named schema, or a structural node. */
export type CodecNode =
  | 0
  | string
  | { a: CodecNode }
  | { m: CodecNode }
  | { o: Array<[string, string, CodecNode]>; x?: CodecNode }
  | { u: { a?: CodecNode; o?: CodecNode } };

export type CodecTable = Record<string, CodecNode>;

type FieldIndex = { byWire: Map<string, [string, CodecNode]>; byCamel: Map<string, [string, CodecNode]> };
const indexCache = new WeakMap<object, FieldIndex>();

const fieldIndex = (node: { o: Array<[string, string, CodecNode]> }): FieldIndex => {
  let index = indexCache.get(node);
  if (!index) {
    index = { byWire: new Map(), byCamel: new Map() };
    for (const [camel, wire, child] of node.o) {
      index.byWire.set(wire, [camel, child]);
      index.byCamel.set(camel, [wire, child]);
    }
    indexCache.set(node, index);
  }
  return index;
};

/** Renames declared keys between camelCase and wire names; user-keyed maps stay verbatim. */
export const convertKeys = (
  table: CodecTable,
  node: CodecNode,
  value: unknown,
  direction: "decode" | "encode",
): unknown => {
  if (node === 0 || value === null || value === undefined) return value;
  if (typeof node === "string") {
    const target = table[node];
    return target === undefined ? value : convertKeys(table, target, value, direction);
  }
  if ("a" in node) {
    return Array.isArray(value)
      ? value.map((item) => convertKeys(table, node.a, item, direction))
      : value;
  }
  if ("m" in node) {
    if (!isObject(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = convertKeys(table, node.m, item, direction);
    }
    return out;
  }
  if ("u" in node) {
    if (Array.isArray(value) && node.u.a !== undefined) {
      return convertKeys(table, node.u.a, value, direction);
    }
    if (isObject(value) && node.u.o !== undefined) {
      return convertKeys(table, node.u.o, value, direction);
    }
    return value;
  }
  if (!isObject(value)) return value;
  const index = fieldIndex(node);
  const lookup = direction === "decode" ? index.byWire : index.byCamel;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    const field = lookup.get(key);
    if (field) {
      out[field[0]] = convertKeys(table, field[1], item, direction);
    } else {
      out[key] = node.x === undefined ? item : convertKeys(table, node.x, item, direction);
    }
  }
  return out;
};

// ---------------------------------------------------------------- transport

export interface ResponseInfo {
  status: number;
  headers: Headers;
  requestId: string | undefined;
  url: string;
}

export interface RequestOptions {
  /** Cancels the request (and any retry wait). */
  signal?: AbortSignal | undefined;
  /** Per-attempt timeout until the response headers arrive (and, for JSON, the body). */
  timeoutMs?: number | undefined;
  /** Overrides the client's retry budget for this call. */
  maxRetries?: number | undefined;
  /** Extra headers for this call. */
  headers?: Record<string, string> | undefined;
  /** Called with status, headers and request id of the final response. */
  onResponse?: ((info: ResponseInfo) => void) | undefined;
}

export interface StreamOptions extends RequestOptions {
  /** Abort a streaming body that yields nothing for this long (default 120 s). */
  idleTimeoutMs?: number | undefined;
}

export interface SSEOptions extends StreamOptions {
  /** Resume an event stream after this event id (`Last-Event-ID`). */
  lastEventId?: string | undefined;
}

export interface RequestSpec {
  method: string;
  path: string;
  query?: Array<[string, unknown]> | undefined;
  headers?: Array<[string, unknown]> | undefined;
  /** JSON-serializable body (already in wire casing). */
  json?: unknown;
  /** Raw, replayable body (for uploads); ignored when `json` is set. */
  body?: Blob | Uint8Array | string | undefined;
  accept?: string | undefined;
}

export interface RawResponse extends ResponseInfo {
  /** The streaming body; read it once. Errors and idle timeouts surface as typed errors. */
  body: ReadableStream<Uint8Array>;
  /** Cancels the underlying request. */
  cancel: () => Promise<void>;
}

export interface ServerSentEvent {
  event: string;
  data: string;
  id: string | undefined;
  retry: number | undefined;
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface TransportOptions {
  baseURL: string;
  /** A key, or a resolver (called once per request) for lazily loaded credentials. */
  apiKey?: string | (() => Promise<string | undefined>) | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  fetch?: typeof fetch | undefined;
  defaultHeaders?: Record<string, string> | undefined;
  userAgent?: string | undefined;
  /** Injected for tests: waits between retries. */
  sleep?: Sleep | undefined;
  /** Injected for tests: jitter source in [0, 1). */
  random?: (() => number) | undefined;
}

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
export const MAX_RETRY_AFTER_MS = 60_000;
const MAX_REDIRECTS = 5;
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const NEVER_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const TIMEOUT = Symbol("timeout");

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const errorCodes = (error: unknown, depth = 0): string[] => {
  if (!isObject(error) && !(error instanceof Error)) return [];
  if (depth > 4) return [];
  const e = error as { code?: unknown; cause?: unknown; errors?: unknown };
  const codes = typeof e.code === "string" ? [e.code] : [];
  if (e.cause !== undefined) codes.push(...errorCodes(e.cause, depth + 1));
  if (Array.isArray(e.errors)) {
    for (const inner of e.errors) codes.push(...errorCodes(inner, depth + 1));
  }
  return codes;
};

const describeCause = (error: unknown): string => {
  const codes = errorCodes(error);
  const cause = (error as { cause?: unknown })?.cause;
  const text = cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error);
  return codes.length > 0 && !text.includes(codes[0] ?? "") ? `${codes[0]}: ${text}` : text;
};

export const encodePathParam = (value: unknown, name: string): string => {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text === "" || text === "." || text === "..") {
    throw new GradError(`Path parameter '${name}' must be a non-empty value other than '.' or '..'.`, {
      code: "invalid_path_parameter",
    });
  }
  return encodeURIComponent(text);
};

const scalar = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);

export const defaultUserAgent = (): string | undefined => {
  const version = nodeProcess()?.version;
  return version ? `grad-typescript/${SDK_VERSION} node/${version}` : undefined;
};

/** What generated clients need from a transport (lets callers resolve configuration lazily). */
export interface TransportLike {
  json(spec: RequestSpec, options?: RequestOptions): Promise<unknown>;
  raw(spec: RequestSpec, options?: StreamOptions): Promise<RawResponse>;
  sse(spec: RequestSpec, options?: SSEOptions): AsyncGenerator<ServerSentEvent, void, undefined>;
}

export class Transport implements TransportLike {
  readonly baseURL: string;
  private readonly origin: string;
  private readonly apiKey: TransportOptions["apiKey"];
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;
  private readonly userAgent: string | undefined;
  private readonly sleep: Sleep;
  private readonly random: () => number;

  constructor(options: TransportOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.baseURL);
    } catch {
      throw new GradError(`Invalid base URL '${options.baseURL}': it must be an absolute http(s) URL.`, {
        code: "invalid_base_url",
      });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new GradError(`Invalid base URL '${options.baseURL}': only http and https are supported (include the scheme, e.g. http://localhost:8787).`, {
        code: "invalid_base_url",
      });
    }
    this.baseURL = options.baseURL.replace(/\/+$/, "");
    this.origin = parsed.origin;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new GradError("No fetch implementation available; pass `fetch` (Node 20+ has one built in).", {
        code: "no_fetch",
      });
    }
    this.fetchImpl = fetchImpl;
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.userAgent = options.userAgent ?? defaultUserAgent();
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  buildURL(spec: RequestSpec): string {
    const url = new URL(`${this.baseURL}${spec.path}`);
    for (const [name, value] of spec.query ?? []) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item !== undefined && item !== null) url.searchParams.append(name, scalar(item));
        }
      } else {
        url.searchParams.append(name, scalar(value));
      }
    }
    return url.toString();
  }

  private async resolveKey(): Promise<string | undefined> {
    const key = typeof this.apiKey === "function" ? await this.apiKey() : this.apiKey;
    return key === "" ? undefined : key;
  }

  /** Exponential backoff with jitter: 0.5 s, 1 s, 2 s ... capped at 8 s, scaled into [50%, 100%]. */
  backoffMs(attempt: number): number {
    const base = Math.min(8_000, 500 * 2 ** attempt);
    return Math.round(base * (0.5 + this.random() * 0.5));
  }

  private async headersFor(spec: RequestSpec, options: RequestOptions | undefined): Promise<{ headers: Headers; keyed: boolean }> {
    const headers = new Headers(this.defaultHeaders);
    if (this.userAgent) headers.set("User-Agent", this.userAgent);
    headers.set("Accept", spec.accept ?? "application/json");
    const key = await this.resolveKey();
    if (key) headers.set("Authorization", `Bearer ${key}`);
    if (spec.json !== undefined) headers.set("Content-Type", "application/json");
    for (const [name, value] of spec.headers ?? []) {
      if (value !== undefined && value !== null) headers.set(name, scalar(value));
    }
    for (const [name, value] of Object.entries(options?.headers ?? {})) headers.set(name, value);
    return { headers, keyed: Boolean(key) };
  }

  /**
   * Sends with retries and same-origin redirects. Returns the successful
   * response plus a `done` callback that releases the attempt's timer/signal.
   * When `streaming`, the timeout stops once headers arrive.
   */
  private async send(
    spec: RequestSpec,
    options: RequestOptions | undefined,
    streaming: boolean,
  ): Promise<{ response: Response; url: string; done: () => void; signal: AbortSignal; abort: (reason: unknown) => void }> {
    const method = spec.method.toUpperCase();
    const idempotent = IDEMPOTENT.has(method);
    const maxRetries = Math.max(0, options?.maxRetries ?? this.maxRetries);
    const timeoutMs = options?.timeoutMs ?? this.timeoutMs;
    const userSignal = options?.signal;
    const { headers, keyed } = await this.headersFor(spec, options);
    const body: BodyInit | undefined = spec.json === undefined ? (spec.body as BodyInit | undefined) : JSON.stringify(spec.json);
    let url = this.buildURL(spec);
    let redirects = 0;

    for (let attempt = 0; ; attempt += 1) {
      if (userSignal?.aborted) throw this.abortError(method, url, userSignal.reason);
      const controller = new AbortController();
      const onUserAbort = () => controller.abort(userSignal?.reason);
      userSignal?.addEventListener("abort", onUserAbort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
        () => controller.abort(TIMEOUT),
        timeoutMs,
      );
      const done = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        userSignal?.removeEventListener("abort", onUserAbort);
      };

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          redirect: "manual",
          signal: controller.signal,
          ...(body !== undefined ? { body } : {}),
        });
      } catch (error) {
        done();
        if (userSignal?.aborted) throw this.abortError(method, url, userSignal.reason);
        const timedOut = controller.signal.reason === TIMEOUT;
        const neverSent = errorCodes(error).some((code) => NEVER_SENT_CODES.has(code));
        const wrapped = timedOut
          ? new APITimeoutError(`${method} ${url} timed out after ${timeoutMs} ms.`, { code: "timeout", cause: error })
          : new APIConnectionError(
              `${method} ${url} failed: could not reach ${this.origin} (${describeCause(error)}). Is the server running? Check GRADIATED_BASE_URL or \`baseURL\`.`,
              { code: "connection_error", cause: error },
            );
        if (attempt < maxRetries && (idempotent || (neverSent && !timedOut))) {
          await this.wait(this.backoffMs(attempt), userSignal, method, url);
          continue;
        }
        throw wrapped;
      }

      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400 && response.status !== 304)) {
        done();
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        const target = location ? new URL(location, url) : undefined;
        if (target && target.origin === this.origin && (method === "GET" || method === "HEAD") && redirects < MAX_REDIRECTS) {
          redirects += 1;
          url = target.toString();
          attempt -= 1;
          continue;
        }
        throw new RedirectError(
          `${method} ${url} was redirected (${response.status || "opaque"}) to ${target?.toString() ?? "an unknown location"}; refusing to follow a redirect that leaves ${this.origin} or changes a ${method} request, so credentials are never sent elsewhere. Point GRADIATED_BASE_URL at the final URL.`,
          { status: response.status || undefined, code: "redirect_refused", requestId: response.headers.get("x-request-id") ?? undefined },
        );
      }

      if (!response.ok) {
        let text = "";
        try {
          text = await response.text();
        } catch {
          // Body unreadable; the status alone still classifies the error.
        }
        done();
        const error = makeAPIError(response.status, response.headers, text, { method, url, apiKeyConfigured: keyed });
        const retryable = RETRY_STATUSES.has(response.status) && (idempotent || response.status === 429);
        if (retryable && attempt < maxRetries) {
          const retryAfter = error.retryAfterMs;
          if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
            await this.wait(retryAfter ?? this.backoffMs(attempt), userSignal, method, url);
            continue;
          }
        }
        options?.onResponse?.({ status: response.status, headers: response.headers, requestId: error.requestId, url });
        throw error;
      }

      if (streaming) {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      }
      options?.onResponse?.({
        status: response.status,
        headers: response.headers,
        requestId: response.headers.get("x-request-id") ?? undefined,
        url,
      });
      return { response, url, done, signal: controller.signal, abort: (reason) => controller.abort(reason) };
    }
  }

  private async wait(ms: number, signal: AbortSignal | undefined, method: string, url: string): Promise<void> {
    try {
      await this.sleep(ms, signal);
    } catch (error) {
      throw this.abortError(method, url, signal?.reason ?? error);
    }
  }

  private abortError(method: string, url: string, reason: unknown): APIUserAbortError {
    return new APIUserAbortError(`${method} ${url} was aborted.`, { code: "aborted", cause: reason });
  }

  /** JSON request; resolves to the parsed body (undefined for empty bodies). */
  async json(spec: RequestSpec, options?: RequestOptions): Promise<unknown> {
    const method = spec.method.toUpperCase();
    const { response, url, done, signal } = await this.send(spec, options, false);
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      if (options?.signal?.aborted) throw this.abortError(method, url, options.signal.reason);
      if (signal.reason === TIMEOUT) {
        throw new APITimeoutError(`${method} ${url} timed out reading the response body.`, { code: "timeout", cause: error });
      }
      throw new APIConnectionError(`${method} ${url} failed while reading the response: ${describeCause(error)}`, {
        code: "connection_error",
        cause: error,
      });
    } finally {
      done();
    }
    if (response.status === 204 || response.status === 205 || text.trim() === "") return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new ResponseDecodeError(
        `${method} ${url} returned ${response.status} with a body that is not JSON: ${text.slice(0, 200)}`,
        { status: response.status, code: "invalid_json", requestId: response.headers.get("x-request-id") ?? undefined, cause: error },
      );
    }
  }

  /** Streaming request; the timeout covers only the headers, then an idle timeout guards the body. */
  async raw(spec: RequestSpec, options?: StreamOptions): Promise<RawResponse> {
    const method = spec.method.toUpperCase();
    const { response, url, done, signal, abort } = await this.send(spec, options, true);
    const idleMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const source = response.body;
    const userSignal = options?.signal;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (idle !== undefined) clearTimeout(idle);
      idle = setTimeout(() => abort(TIMEOUT), idleMs);
    };
    const finish = () => {
      if (idle !== undefined) clearTimeout(idle);
      idle = undefined;
      done();
    };
    const reader = source?.getReader();
    const body = new ReadableStream<Uint8Array>({
      start: () => arm(),
      pull: async (controller) => {
        if (!reader) {
          finish();
          controller.close();
          return;
        }
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            finish();
            controller.close();
            return;
          }
          arm();
          controller.enqueue(chunk.value);
        } catch (error) {
          finish();
          if (userSignal?.aborted) controller.error(this.abortError(method, url, userSignal.reason));
          else if (signal.reason === TIMEOUT) {
            controller.error(new APITimeoutError(`${method} ${url}: the stream sent nothing for ${idleMs} ms.`, { code: "timeout", cause: error }));
          } else {
            controller.error(new APIConnectionError(`${method} ${url}: the stream broke: ${describeCause(error)}`, { code: "connection_error", cause: error }));
          }
        }
      },
      cancel: (reason) => {
        finish();
        // Not awaited: cancelling a tee'd body resolves only once every branch is cancelled.
        void reader?.cancel(reason).catch(() => undefined);
      },
    });
    return {
      status: response.status,
      headers: response.headers,
      requestId: response.headers.get("x-request-id") ?? undefined,
      url,
      body,
      cancel: async () => {
        finish();
        abort(new Error("cancelled"));
        await body.cancel().catch(() => undefined);
      },
    };
  }

  /** Single SSE connection; yields events until the server closes the stream. */
  async *sse(spec: RequestSpec, options?: SSEOptions): AsyncGenerator<ServerSentEvent, void, undefined> {
    const extra: Record<string, string> = { ...(options?.headers ?? {}) };
    if (options?.lastEventId !== undefined) extra["Last-Event-ID"] = options.lastEventId;
    const raw = await this.raw({ ...spec, accept: "text/event-stream" }, { ...options, headers: extra });
    const reader = raw.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let event = "";
    let data: string[] = [];
    let id: string | undefined;
    let retry: number | undefined;
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.search(/\r\n|\r|\n/)) >= 0) {
          const line = buffer.slice(0, newline);
          const sep = buffer.startsWith("\r\n", newline) ? 2 : 1;
          buffer = buffer.slice(newline + sep);
          if (line === "") {
            if (data.length > 0 || event !== "") {
              yield { event: event || "message", data: data.join("\n"), id, retry };
            }
            event = "";
            data = [];
            retry = undefined;
            continue;
          }
          if (line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          let fieldValue = colon < 0 ? "" : line.slice(colon + 1);
          if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
          if (field === "event") event = fieldValue;
          else if (field === "data") data.push(fieldValue);
          else if (field === "id" && !fieldValue.includes("\0")) id = fieldValue;
          else if (field === "retry" && /^\d+$/.test(fieldValue)) retry = Number(fieldValue);
        }
        if (done) break;
      }
    } finally {
      reader.releaseLock();
      await raw.cancel();
    }
  }
}
