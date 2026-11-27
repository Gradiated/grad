import type { ChatMessage } from "../../contracts.js";

export interface ChatCompletionRequest {
  model: string;
  messages: readonly ChatMessage[];
  temperature: number;
  max_tokens: number;
  tools?: ReadonlyArray<Record<string, unknown>> | undefined;
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
