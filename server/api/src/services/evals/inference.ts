import type { ChatMessage } from "../../contracts.js";
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

class RetryableError extends Error {}

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
      throw new RetryableError(`request failed: ${errorMessage(error)}`);
    }

    const text = await response.text();
    if (!response.ok) {
      const detail = `HTTP ${response.status}: ${text.slice(0, 300)}`;
      if (RETRYABLE.has(response.status)) throw new RetryableError(detail);
      throw new Error(detail);
    }

    try {
      return parseCompletion(JSON.parse(text) as unknown);
    } catch (error) {
      throw new Error(`malformed completion: ${errorMessage(error)}`);
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
          if (!(error instanceof RetryableError) || i === maxAttempts - 1)
            break;
          await sleep(retryDelayMs * 2 ** i);
        }
      }

      throw new ApiError(
        502,
        "inference_error",
        "Inference endpoint failed",
        `Model '${request.model}' at ${baseUrl}: ${errorMessage(lastError)}`,
      );
    },
  };
};
