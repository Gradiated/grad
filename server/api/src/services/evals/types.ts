import type { ChatMessage } from "../../contracts.js";

export interface ChatCompletionRequest {
  model: string;
  /**
   * The workspace the call is for, sent as `X-Grad-Workspace` on every call:
   * artifact ids are unique only per workspace, so a shared endpoint (the
   * Cloud gateway) needs it to serve the right adapter and bill the right
   * workspace.
   */
  workspace: string;
  /** The eval the call is for (the Cloud gateway tags its usage with it). */
  evalId?: string | undefined;
  messages: readonly ChatMessage[];
  temperature: number;
  max_tokens: number;
  tools?: ReadonlyArray<Record<string, unknown>> | undefined;
  /** Aborts the call and its retries (the eval worker is stopping or the eval halted). */
  signal?: AbortSignal | undefined;
}

export interface ChatCompletionResult {
  text: string;
  usage: { prompt_tokens: number; completion_tokens: number };
}

/** OpenAI-compatible `/chat/completions` client (vLLM, SGLang, Gradiated gateway). */
export interface ChatCompletionClient {
  complete(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
}

export interface InferenceClients {
  models: ChatCompletionClient;
  judge: ChatCompletionClient;
}

export type RegexOutcome = { matched: boolean } | { timedOut: true };

/** Bounded regex execution off the event loop (hard per-call timeout). */
export interface RegexEvaluator {
  test(pattern: string, flags: string, input: string): Promise<RegexOutcome>;
  close(): Promise<void>;
}
