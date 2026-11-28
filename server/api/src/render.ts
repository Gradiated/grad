import {
  messageText,
  type ChatMessage,
  type DatasetRecord,
} from "./contracts.js";
import { DEFAULT_CHARS_PER_TOKEN } from "./catalog.js";
import { invalid } from "./errors.js";
import { recordConversation } from "./records.js";

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

/** `<|im_start|>`, the role and its newline. */
const HEADER_TOKENS = 3;
/** The generation header the trainer appends to router/classifier prompts. */
const GENERATION_HEADER_TOKENS = 3;

/** OpenAI-style `tool_calls` and tools as the template's `tojson` writes them (Python's json.dumps). */
const toJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(toJson).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);

    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${toJson(v)}`).join(", ")}}`;
  }

  return JSON.stringify(value) ?? "null";
};

const stripNewlines = (text: string, end: "start" | "end" | "both"): string => {
  let out = text;
  if (end !== "end") out = out.replace(/^\n+/, "");
  if (end !== "start") out = out.replace(/\n+$/, "");

  return out;
};

/** (reasoning, answer): `reasoning_content`, else what comes before a `</think>`. */
const splitReasoning = (message: ChatMessage): [string, string] => {
  const content = messageText(message);
  const reasoning = (message as { reasoning_content?: unknown })
    .reasoning_content;
  if (typeof reasoning === "string") return [reasoning, content];
  if (!content.includes("</think>")) return ["", content];

  const before = stripNewlines(content.split("</think>")[0] as string, "end");

  return [
    stripNewlines(before.split("<think>").at(-1) as string, "start"),
    stripNewlines(content.split("</think>").at(-1) as string, "start"),
  ];
};

const toolCallsText = (
  recordId: string,
  calls: ChatMessage["tool_calls"],
  content: string,
): string =>
  (calls ?? [])
    .map((call, i) => {
      if (typeof call !== "object" || call === null || Array.isArray(call)) {
        throw invalid(
          "render_conflict",
          `Record '${recordId}': tool_calls entries must be objects.`,
        );
      }
      const fn = (call.function ?? call) as Record<string, unknown>;
      const args = fn.arguments ?? {};
      const name = String(fn.name ?? "");
      const text = `<tool_call>\n{"name": "${name}", "arguments": ${typeof args === "string" ? args : toJson(args)}}\n</tool_call>`;

      return (i === 0 && content) || i > 0 ? `\n${text}` : text;
    })
    .join("");

/** The last user turn that isn't a tool response (the template's `last_query_index`). */
const lastQueryIndex = (messages: readonly ChatMessage[]): number => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as ChatMessage;
    const text = m.content;
    if (
      m.role === "user" &&
      typeof text === "string" &&
      !(text.startsWith("<tool_response>") && text.endsWith("</tool_response>"))
    ) {
      return i;
    }
  }

  return messages.length - 1;
};

/**
 * The trainer's chat rendering (templates.py `render_chat`, the Qwen3
 * template): the same text and the same trained spans, so the preview shows
 * what trains. Thinking follows it too: reasoning is `reasoning_content` or
 * what comes before a `</think>`; the turns after the last user query keep it
 * (the final answer gets an empty think block without), earlier turns lose
 * it unless `preserve_thinking`. Token counts are estimates (framing exact,
 * text by characters); the trainer tokenizes for real.
 * server/api/test/trainer-parity.test.ts holds it to the trainer.
 */
export const renderMessages = (
  recordId: string,
  messages: readonly ChatMessage[],
  options: RenderOptions,
  tools?: ReadonlyArray<Record<string, unknown>>,
): {
  record_id: string;
  template_revision: string;
  total_tokens: number;
  trained_tokens: number;
  trained_fraction: number;
  spans: Array<{ text: string; trained: boolean; tokens: number }>;
} => {
  const spans: Array<{ text: string; trained: boolean; tokens: number }> = [];
  const emit = (text: string, tokens: number, trained = false) => {
    if (!text) return;
    const last = spans.at(-1);
    if (last && last.trained === trained) {
      last.text += text;
      last.tokens += tokens;
    } else {
      spans.push({ text, trained, tokens });
    }
  };
  const estimate = (text: string) =>
    estimateTextTokens(text, options.charsPerToken);
  const conflict = (detail: string) =>
    invalid("render_conflict", `Record '${recordId}' ${detail}`);

  const first = messages[0];
  if (tools && tools.length > 0) {
    const intro = first?.role === "system" ? `${messageText(first)}\n\n` : "";
    const body =
      `${intro}# Tools\n\nYou may call one or more functions to assist with the user query.\n\n` +
      "You are provided with function signatures within <tools></tools> XML tags:\n<tools>" +
      tools.map((tool) => `\n${toJson(tool)}`).join("") +
      "\n</tools>\n\nFor each function call, return a json object with function name and " +
      "arguments within <tool_call></tool_call> XML tags:\n<tool_call>\n" +
      '{"name": <function-name>, "arguments": <args-json-object>}\n</tool_call>';
    emit(
      `<|im_start|>system\n${body}<|im_end|>\n`,
      HEADER_TOKENS + estimate(body) + 2,
    );
  } else if (first?.role === "system") {
    const body = messageText(first);
    emit(
      `<|im_start|>system\n${body}<|im_end|>\n`,
      HEADER_TOKENS + estimate(body) + 2,
    );
  }

  const lastQuery = lastQueryIndex(messages);
  let lastAssistant = -1;
  messages.forEach((m, i) => {
    if (m.role === "assistant") lastAssistant = i;
  });
  const n = messages.length;
  messages.forEach((message, i) => {
    const { role } = message;
    if (message.train === true && role !== "assistant") {
      throw invalid(
        "render_conflict",
        `Record '${recordId}': only assistant turns can be trained (message ${i} is '${role}').`,
      );
    }
    if (role === "user" || (role === "system" && i !== 0)) {
      const body = messageText(message);
      emit(
        `<|im_start|>${role}\n${body}<|im_end|>\n`,
        HEADER_TOKENS + estimate(body) + 2,
      );
    } else if (role === "tool") {
      const body = messageText(message);
      if (i === 0 || messages[i - 1]?.role !== "tool")
        emit("<|im_start|>user", 2);
      emit(`\n<tool_response>\n${body}\n</tool_response>`, estimate(body) + 5);
      if (i === n - 1 || messages[i + 1]?.role !== "tool")
        emit("<|im_end|>\n", 2);
    } else if (role === "assistant") {
      const trained =
        message.train ??
        (options.train_on === "all_assistant" || i === lastAssistant);
      const [reasoning, content] = splitReasoning(message);
      const hasReasoning = reasoning.trim().length > 0;
      if (trained && options.thinking === "off" && hasReasoning) {
        throw conflict(`message ${i} contains reasoning but thinking='off'.`);
      }
      if (trained && options.thinking === "on" && !hasReasoning) {
        throw conflict(
          `message ${i} has no <think> reasoning but thinking='on'.`,
        );
      }
      emit("<|im_start|>assistant\n", HEADER_TOKENS);
      const showThink =
        (i > lastQuery && (i === n - 1 || reasoning.length > 0)) ||
        (options.preserve_thinking && hasReasoning);
      let body = content;
      if (showThink) {
        const think = stripNewlines(reasoning, "both");
        emit(
          `<think>\n${think}\n</think>\n\n`,
          4 + estimate(think),
          trained && hasReasoning,
        );
        body = stripNewlines(content, "start");
      }
      const answer =
        body + toolCallsText(recordId, message.tool_calls, content);
      emit(`${answer}<|im_end|>`, estimate(answer) + 1, trained);
      emit("\n", 1);
    }
  });

  const totalTokens = spans.reduce((sum, s) => sum + s.tokens, 0);
  const trainedTokens = spans.reduce(
    (sum, s) => sum + (s.trained ? s.tokens : 0),
    0,
  );

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
      record.tools,
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

/** Tokens of a prompt rendered with the generation header (the trainer's `encode_prompt`). */
export const promptTokens = (
  prompt: readonly ChatMessage[],
  options: RenderOptions,
): number =>
  renderMessages("prompt", prompt, { ...options, train_on: "last" })
    .total_tokens + GENERATION_HEADER_TOKENS;
