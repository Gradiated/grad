import type { ChatMessage } from "../../contracts.js";
import type { InferenceErrorReason } from "../../contracts/trainer-jobs.js";
import { ApiError, errorMessage } from "../../errors.js";
import type {
  ChatCompletionClient,
  ChatCompletionRequest,
  ChatCompletionResult,
} from "./types.js";

export interface OpenAICompatibleOptions {
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
export const WORKSPACE_HEADER = "X-Grad-Workspace";

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
  ) {
    super(message);
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

/** An eval inference call that failed after its retries. */
export class InferenceError extends ApiError {
  constructor(
    detail: string,
    readonly reason: InferenceErrorReason,
  ) {
    super(502, "inference_error", "Inference endpoint failed", detail);
  }
}

/** The reason of a failed call (`server_error` for anything unclassified). */
export const inferenceErrorReason = (error: unknown): InferenceErrorReason =>
  error instanceof InferenceError ? error.reason : "server_error";

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
 * exponential backoff; failures surface as ApiError(502, inference_error).
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
      throw new CallError(
        `HTTP ${response.status}: ${text.slice(0, 300)}`,
        reasonOfStatus(response.status, text),
        RETRYABLE.has(response.status),
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
          lastError = error;
          if (
            !(error instanceof CallError && error.retryable) ||
            i === maxAttempts - 1
          )
            break;
          await sleep(retryDelayMs * 2 ** i);
        }
      }

      throw new InferenceError(
        `Model '${request.model}' at ${baseUrl}: ${errorMessage(lastError)}`,
        lastError instanceof CallError ? lastError.reason : "server_error",
      );
    },
  };
};
