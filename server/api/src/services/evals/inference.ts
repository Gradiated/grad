import type { ChatMessage } from "../../contracts.js";
import type { InferenceErrorReason } from "../../contracts/trainer-jobs.js";
import { ApiError, errorMessage } from "../../errors.js";
import type {
  ChatCompletionClient,
  ChatCompletionRequest,
  ChatCompletionResult,
} from "./types.js";

interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  timeoutMs?: number;
  /** Total attempts including the first (default 3). */
  maxAttempts?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
  /** Extra headers per call (the Cloud gateway's workspace and lane headers). */
  headers?: (request: ChatCompletionRequest) => Record<string, string>;
}

/** Names the workspace of every inference and judge call. */
const WORKSPACE_HEADER = "X-Grad-Workspace";

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

const toWireMessage = (message: ChatMessage): Record<string, unknown> => {
  const { train: _train, ...rest } = message;

  return rest;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

class CallError extends Error {
  constructor(
    message: string,
    readonly reason: InferenceErrorReason,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

/** A Retry-After header (seconds or an HTTP date) in ms; null when absent or unparseable. */
const retryAfterMs = (response: Response): number | null => {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);

  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
};

/** The longest Retry-After the client's own retries honour. */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * `503 capacity_unavailable`: the model has no capacity (the Cloud gateway's
 * eval lane found its pool at zero and it did not wake within the gateway's
 * own wait). Not retried by the client: the caller waits `retryAfterMs` and
 * tries again later.
 */
export class CapacityUnavailable extends ApiError {
  readonly reason = "capacity_unavailable" as const;

  constructor(
    readonly retryAfterMs: number,
    detail: string,
  ) {
    super(503, "capacity_unavailable", "No capacity for the model", detail);
  }
}

const reasonOfStatus = (status: number, body: string): InferenceErrorReason =>
  body.includes("capacity_unavailable")
    ? "capacity_unavailable"
    : status === 429
      ? "rate_limited"
      : status === 408 || status === 504
        ? "timeout"
        : status >= 500
          ? "server_error"
          : "rejected";

/**
 * An eval inference call that failed after its retries: `503
 * inference_unavailable` when every try was transient (unreachable, 429,
 * 5xx), else `502 inference_error`.
 */
export class InferenceError extends ApiError {
  constructor(
    detail: string,
    readonly reason: InferenceErrorReason,
    transient = false,
    /** The last response's Retry-After, in ms. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(
      transient ? 503 : 502,
      transient ? "inference_unavailable" : "inference_error",
      transient
        ? "Inference endpoint unavailable"
        : "Inference endpoint failed",
      detail,
    );
  }
}

/** The reason of a failed call (`server_error` for anything unclassified). */
export const inferenceErrorReason = (error: unknown): InferenceErrorReason =>
  error instanceof InferenceError || error instanceof CapacityUnavailable
    ? error.reason
    : "server_error";

/** The endpoint stayed unreachable, overloaded or 5xx through every retry: a transient outage, not the model's answer. */
export const isInferenceUnavailable = (error: unknown): boolean =>
  error instanceof ApiError && error.code === "inference_unavailable";

/** A call given up during an inference outage (or a stop): nothing about the task is known. */
export class InferenceOutage extends Error {
  constructor(
    message: string,
    /**
     * Still no capacity or a full lane at the end of the wait: the eval
     * fails (rather than spending attempts on more waits).
     */
    readonly terminal = false,
  ) {
    super(message);
  }
}

const parseCompletion = (body: unknown): ChatCompletionResult => {
  const payload = (body ?? {}) as {
    choices?: Array<{
      message?: { content?: unknown; tool_calls?: unknown };
    }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const message = payload.choices?.[0]?.message;
  if (!message) throw new Error("response has no choices[0].message");

  const text =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.tool_calls)
        ? JSON.stringify(message.tool_calls)
        : "";
  const tokens = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.round(value)
      : 0;

  return {
    text,
    usage: {
      prompt_tokens: tokens(payload.usage?.prompt_tokens),
      completion_tokens: tokens(payload.usage?.completion_tokens),
    },
  };
};

/**
 * Client for any OpenAI-compatible `/chat/completions` endpoint (vLLM,
 * SGLang, the Gradiated gateway). Retries 429/5xx/network errors with
 * exponential backoff (at least the response's Retry-After, up to 60 s);
 * when they persist, ApiError(503, inference_unavailable). `503
 * capacity_unavailable` is thrown at once as CapacityUnavailable; any other
 * failure is ApiError(502, inference_error).
 */
export const createOpenAICompatibleClient = (
  options: OpenAICompatibleOptions,
): ChatCompletionClient => {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const retryDelayMs = options.retryDelayMs ?? 250;
  const timeoutMs = options.timeoutMs ?? 120_000;

  const attempt = async (
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResult> => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      [WORKSPACE_HEADER]: request.workspace,
      ...options.headers?.(request),
    };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
          model: request.model,
          messages: request.messages.map(toWireMessage),
          temperature: request.temperature,
          max_tokens: request.max_tokens,
          ...(request.tools ? { tools: request.tools } : {}),
        }),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      throw new CallError(
        `request failed: ${errorMessage(error)}`,
        timedOut ? "timeout" : "unreachable",
        true,
      );
    }

    const text = await response.text();
    if (!response.ok) {
      const detail = `HTTP ${response.status}: ${text.slice(0, 300)}`;
      if (response.status === 503 && text.includes("capacity_unavailable")) {
        throw new CapacityUnavailable(
          retryAfterMs(response) ?? 30_000,
          `Model '${request.model}' at ${baseUrl}: ${detail}`,
        );
      }
      throw new CallError(
        detail,
        reasonOfStatus(response.status, text),
        RETRYABLE.has(response.status),
        retryAfterMs(response),
      );
    }

    try {
      return parseCompletion(JSON.parse(text) as unknown);
    } catch (error) {
      throw new CallError(
        `malformed completion: ${errorMessage(error)}`,
        "malformed",
        false,
      );
    }
  };

  return {
    complete: async (request) => {
      let lastError: unknown;
      for (let i = 0; i < maxAttempts; i += 1) {
        try {
          return await attempt(request);
        } catch (error) {
          if (error instanceof CapacityUnavailable) throw error;
          lastError = error;
          if (
            !(error instanceof CallError && error.retryable) ||
            i === maxAttempts - 1
          )
            break;
          await sleep(
            Math.max(
              retryDelayMs * 2 ** i,
              Math.min(MAX_RETRY_AFTER_MS, error.retryAfterMs ?? 0),
            ),
          );
        }
      }

      throw new InferenceError(
        `Model '${request.model}' at ${baseUrl}: ${errorMessage(lastError)}`,
        lastError instanceof CallError ? lastError.reason : "server_error",
        lastError instanceof CallError && lastError.retryable,
        lastError instanceof CallError ? lastError.retryAfterMs : null,
      );
    },
  };
};
