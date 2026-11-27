import {
  messageText,
  type ChatMessage,
  type DatasetRecord,
  type RecipeKind,
} from "./contracts.js";

const asMessages = (
  value: string | ChatMessage[] | undefined,
  role: ChatMessage["role"],
): ChatMessage[] => {
  if (value === undefined) return [];
  if (typeof value === "string") return [{ role, content: value }];

  return value;
};

const hasAssistantTarget = (messages: readonly ChatMessage[]): boolean =>
  messages.some(
    (m) =>
      m.role === "assistant" &&
      (messageText(m).trim().length > 0 || (m.tool_calls?.length ?? 0) > 0),
  );

const expectedText = (expected: unknown): string | null => {
  if (typeof expected === "string") return expected;
  if (expected && typeof expected === "object") {
    const obj = expected as Record<string, unknown>;
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.label === "string") return obj.label;
  }

  return null;
};

/**
 * Full conversation of a record including its training target, from plain
 * `messages`, `grad.trajectory/1` (`input.messages` + `output.turns` or
 * `expected_output`), or `prompt` + `completion`.
 */
export const recordConversation = (record: DatasetRecord): ChatMessage[] => {
  if (record.messages && record.messages.length > 0) return record.messages;

  if (record.input?.messages) {
    const turns = record.output?.turns ?? [];
    const target = expectedText(record.expected_output);
    if (turns.length > 0) return [...record.input.messages, ...turns];
    if (target !== null) {
      return [...record.input.messages, { role: "assistant", content: target }];
    }

    return record.input.messages;
  }

  if (record.prompt !== undefined) {
    const completion =
      record.completion !== undefined
        ? asMessages(record.completion, "assistant")
        : (() => {
            const target = expectedText(record.expected_output);
            return target === null
              ? []
              : [{ role: "assistant" as const, content: target }];
          })();

    return [...asMessages(record.prompt, "user"), ...completion];
  }

  return [];
};

/** Prompt (everything before the final assistant turn) and the reference answer. */
export const recordPromptAndReference = (
  record: DatasetRecord,
): { prompt: ChatMessage[]; reference: string | null } | null => {
  const explicit = expectedText(record.expected_output);

  if (record.input?.messages && record.input.messages.length > 0) {
    const turns = record.output?.turns ?? [];
    const last = turns.filter((t) => t.role === "assistant").pop();

    return {
      prompt: record.input.messages,
      reference: explicit ?? (last ? messageText(last) : null),
    };
  }

  if (record.prompt !== undefined) {
    const completion =
      record.completion === undefined
        ? null
        : typeof record.completion === "string"
          ? record.completion
          : record.completion.map(messageText).join("");

    return {
      prompt: asMessages(record.prompt, "user"),
      reference: explicit ?? completion,
    };
  }

  const messages = record.messages ?? [];
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }

  const prompt =
    lastAssistant >= 0 ? messages.slice(0, lastAssistant) : messages;
  if (!prompt.some((m) => m.role === "user")) return null;

  const target = lastAssistant >= 0 ? messages[lastAssistant] : undefined;

  return {
    prompt,
    reference: explicit ?? (target ? messageText(target) : null),
  };
};

const isPreferencePair = (r: DatasetRecord): boolean =>
  r.prompt !== undefined && r.chosen !== undefined && r.rejected !== undefined;

const scoreModels = (r: DatasetRecord): string[] =>
  Object.keys(r.scores ?? {}).filter((k) => k.includes("/") || k.includes("@"));

export interface RecipeUsability {
  usable: number;
  total: number;
  /** Example of why a record was unusable, for error messages. */
  reasons: string[];
  /** Router only: candidate models discovered from per-model scores. */
  discoveredModels?: string[];
}

const SHAPE_HELP: Record<string, string> = {
  sft: 'SFT needs chat records with an assistant turn: {"messages": [{"role": "user", ...}, {"role": "assistant", ...}]}, a grad.trajectory/1 record with input.messages and output.turns, or {"prompt": ..., "completion": ...}.',
  dpo: 'DPO needs preference pairs {"prompt", "chosen", "rejected"} or grad.trajectory/1 records sharing a group_id with role "chosen" and role "rejected".',
  router:
    'Router training needs per-model scores on each record, e.g. {"messages": [...], "scores": {"qwen/qwen3-8b": 0.4, "qwen/qwen3-32b": 0.9}}.',
  decision:
    'Decision models need a state and a label: {"state": {...} | "messages": [...], "expected_output": {"label": ...}} or "scores".',
  embedding:
    'Embedding training needs {"query": ..., "positive": ..., "negatives"?: [...]}.',
};

export const recordShapeHelp = (kind: RecipeKind): string =>
  SHAPE_HELP[kind] ?? "";

/**
 * Counts how many records a recipe can actually train on. Unknown shapes are
 * never silently accepted: callers reject plans with zero usable records.
 */
export const assessRecipeUsability = (
  kind: RecipeKind,
  records: readonly DatasetRecord[],
): RecipeUsability => {
  const reasons = new Set<string>();
  const note = (reason: string) => {
    if (reasons.size < 3) reasons.add(reason);
  };

  if (kind === "dpo") {
    let usable = 0;
    const groups = new Map<string, Set<string>>();
    for (const r of records) {
      if (isPreferencePair(r)) {
        usable += 1;
        continue;
      }
      if (r.group_id && (r.role === "chosen" || r.role === "rejected")) {
        const roles = groups.get(r.group_id) ?? new Set<string>();
        roles.add(r.role);
        groups.set(r.group_id, roles);
        continue;
      }
      note(
        "record is neither a {prompt, chosen, rejected} pair nor a chosen/rejected trajectory",
      );
    }
    let oneSided = 0;
    for (const roles of groups.values()) {
      if (roles.has("chosen") && roles.has("rejected")) usable += 1;
      else oneSided += 1;
    }
    if (oneSided > 0) {
      note(
        `${oneSided} trajectory group(s) have only a chosen or only a rejected side`,
      );
    }

    return { usable, total: records.length, reasons: [...reasons] };
  }

  if (kind === "cartridge") {
    return { usable: records.length, total: records.length, reasons: [] };
  }

  let usable = 0;
  const models = new Set<string>();
  for (const r of records) {
    let ok = false;
    if (
      kind === "sft" ||
      kind === "distill" ||
      kind === "reward" ||
      kind === "grpo"
    ) {
      ok = hasAssistantTarget(recordConversation(r));
      if (!ok) note("record has no assistant turn to train on");
    } else if (kind === "router") {
      const scored = scoreModels(r);
      scored.forEach((m) => models.add(m));
      ok =
        scored.length >= 1 &&
        (recordConversation(r).length > 0 ||
          typeof r.prompt === "string" ||
          typeof r.query === "string");
      if (!ok) note("record has no per-model scores keyed by model id");
    } else if (kind === "decision") {
      const hasState =
        r.state !== undefined ||
        r.input?.features !== undefined ||
        recordConversation(r).length > 0;
      const hasLabel =
        r.expected_output !== undefined ||
        Object.keys(r.scores ?? {}).length > 0;
      ok = hasState && hasLabel;
      if (!ok)
        note(
          "record needs a state (state, input.features or messages) and a label (expected_output or scores)",
        );
    } else if (kind === "embedding") {
      ok =
        typeof (
          r.query ?? (typeof r.prompt === "string" ? r.prompt : undefined)
        ) === "string" && typeof r.positive === "string";
      if (!ok) note("record needs 'query' and 'positive'");
    }
    if (ok) usable += 1;
  }

  return {
    usable,
    total: records.length,
    reasons: [...reasons],
    ...(kind === "router" ? { discoveredModels: [...models].sort() } : {}),
  };
};
