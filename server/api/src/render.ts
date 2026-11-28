import {
  messageText,
  type ChatMessage,
  type DatasetRecord,
} from "./contracts.js";
import { DEFAULT_CHARS_PER_TOKEN } from "./catalog.js";
import { invalid } from "./errors.js";
import { recordConversation, recordPromptAndResponse } from "./records.js";

/**
 * Chat-template rendering and token estimates: what a record looks like to
 * the trainer (ChatML, loss masks) and about how many tokens it is. The
 * planner sizes runs with it and the dataset render previews it; the
 * trainer tokenizes for real.
 */

/**
 * Rough text token estimate (chars / the base tokenizer's characters per
 * token, 4 by default); plans label counts as estimates. At 4 it errs high for
 * English prose (Qwen3 averages about 4.6 characters a token there) and low
 * for code-free CJK text.
 */
export const estimateTextTokens = (
  text: string,
  charsPerToken = DEFAULT_CHARS_PER_TOKEN,
): number => {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  return Math.max(1, Math.ceil(trimmed.length / charsPerToken));
};

export interface RenderOptions {
  templateRevision: string;
  train_on: "last" | "all_assistant";
  thinking: "auto" | "on" | "off";
  preserve_thinking: boolean;
  /** The base tokenizer's characters per token (catalog; default 4). */
  charsPerToken?: number;
}

/** ChatML framing, exact for the Qwen3 tokenizer: `<|im_start|>`, role, newline. */
const HEADER_TOKENS = 3;
/** `<|im_end|>` and the newline after it. */
const FOOTER_TOKENS = 2;
/** `<think>\n\n</think>\n\n`, rendered (untrained) before a final answer without reasoning. */
const EMPTY_THINK = "<think>\n\n</think>\n\n";
const EMPTY_THINK_TOKENS = 4;
/** The generation header the trainer appends to router/classifier prompts. */
const GENERATION_HEADER_TOKENS = 3;

const stripThinking = (text: string): string =>
  text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");

const hasThinkingBlock = (text: string): boolean =>
  /<think>[\s\S]*?<\/think>/.test(text);

/**
 * ChatML preview with loss masks. Token counts are estimates; the trainer
 * renders with the pinned tokenizer and chat template.
 */
export const renderMessages = (
  recordId: string,
  messages: readonly ChatMessage[],
  options: RenderOptions,
): {
  record_id: string;
  template_revision: string;
  total_tokens: number;
  trained_tokens: number;
  trained_fraction: number;
  spans: Array<{ text: string; trained: boolean; tokens: number }>;
} => {
  let lastAssistantIndex = -1;
  messages.forEach((m, i) => {
    if (m.role === "assistant") lastAssistantIndex = i;
  });

  const spans: Array<{ text: string; trained: boolean; tokens: number }> = [];
  let totalTokens = 0;
  let trainedTokens = 0;

  messages.forEach((message, i) => {
    const rawContent = messageText(message);
    const isAssistant = message.role === "assistant";
    const isLastAssistant = i === lastAssistantIndex;

    const trained =
      message.train ??
      (isAssistant &&
        (options.train_on === "all_assistant" || isLastAssistant));

    if (trained && isAssistant) {
      const hasThink = hasThinkingBlock(rawContent);
      if (options.thinking === "off" && hasThink) {
        throw invalid(
          "render_conflict",
          `Record '${recordId}' contains a <think> block but thinking='off'.`,
        );
      }
      if (options.thinking === "on" && !hasThink) {
        throw invalid(
          "render_conflict",
          `Record '${recordId}' has no <think> block but thinking='on'.`,
        );
      }
    }

    const content =
      isAssistant && !isLastAssistant && !options.preserve_thinking
        ? stripThinking(rawContent)
        : rawContent;
    // The trainer renders the final answer behind an empty think block when it has none.
    const emptyThink =
      isLastAssistant &&
      i === messages.length - 1 &&
      !hasThinkingBlock(content);
    const header = `<|im_start|>${message.role}\n${emptyThink ? EMPTY_THINK : ""}`;
    const body = `${content}<|im_end|>\n`;
    const headerTokens = HEADER_TOKENS + (emptyThink ? EMPTY_THINK_TOKENS : 0);
    const bodyTokens =
      estimateTextTokens(content, options.charsPerToken) + FOOTER_TOKENS;

    spans.push({ text: header, trained: false, tokens: headerTokens });
    spans.push({ text: body, trained, tokens: bodyTokens });
    totalTokens += headerTokens + bodyTokens;
    if (trained) trainedTokens += bodyTokens;
  });

  return {
    record_id: recordId,
    template_revision: options.templateRevision,
    total_tokens: totalTokens,
    trained_tokens: trainedTokens,
    trained_fraction: totalTokens > 0 ? trainedTokens / totalTokens : 0,
    spans,
  };
};

const textOf = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value.map((m) => messageText(m as ChatMessage)).join("\n")
      : value === undefined
        ? ""
        : JSON.stringify(value);

export const estimateRecordTokens = (
  record: DatasetRecord,
  options: RenderOptions,
): { total: number; trained: number } => {
  const conversation = recordConversation(record);
  if (conversation.length > 0) {
    const rendered = renderMessages(
      record.id ?? "record",
      conversation,
      options,
    );

    return { total: rendered.total_tokens, trained: rendered.trained_tokens };
  }

  const text = [
    textOf(record.prompt),
    textOf(record.chosen),
    textOf(record.rejected),
    record.query ?? "",
    record.positive ?? "",
    ...(record.negatives ?? []),
    record.state === undefined ? "" : JSON.stringify(record.state),
    record.expected_output === undefined
      ? ""
      : JSON.stringify(record.expected_output),
  ].join("\n");
  const total = Math.max(16, estimateTextTokens(text, options.charsPerToken));

  return { total, trained: Math.max(8, Math.round(total * 0.4)) };
};

/** Tokens of a record's prompt rendered with the generation header, or null without one. */
export const promptTokens = (
  record: DatasetRecord,
  options: RenderOptions,
): number | null => {
  const prompt = recordPromptAndResponse(record)?.prompt ?? [];
  if (!prompt.some((m) => m.role === "user")) return null;

  return (
    renderMessages(record.id ?? "record", prompt, options).total_tokens +
    GENERATION_HEADER_TOKENS
  );
};
