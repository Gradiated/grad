import {
  messageText,
  type ChatMessage,
  type DatasetRecord,
  type RecipeKind,
} from "./contracts.js";
import { invalid } from "./errors.js";

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

const assistantTurn = (content: string): ChatMessage => ({
  role: "assistant",
  content,
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON with sorted keys and no spaces: the trainer's `json.dumps(sort_keys=True, separators=(",", ":"))`. */
const sortedJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedJson(value[k])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

/** Turns from a message, a list of messages or `{messages}`; null when it isn't one (trainer `as_messages`). */
const turnsOf = (value: unknown): ChatMessage[] | null => {
  if (typeof value === "string") return [assistantTurn(value)];
  if (Array.isArray(value)) {
    const out: ChatMessage[] = [];
    for (const item of value) {
      const turns = turnsOf(item);
      if (turns === null) return null;
      out.push(...turns);
    }

    return out;
  }
  if (isObject(value)) {
    if ("role" in value) return [value as ChatMessage];
    if (typeof value.content === "string")
      return [assistantTurn(value.content)];
    if (Array.isArray(value.messages)) return turnsOf(value.messages);
  }

  return null;
};

/**
 * The assistant answer an `expected_output` stands for (a gold answer or a
 * synced correction), or `[]` when it isn't one. Mirrors the trainer's
 * `recipes/data.py::expected_turns`: a string, a number, a message, a list of
 * messages or `{messages}` map directly; a one-key object with a string value
 * (`{"answer": ...}`) is that string; any other object is its JSON.
 */
export const expectedTurns = (value: unknown): ChatMessage[] => {
  if (value === null || value === undefined || typeof value === "boolean") {
    return [];
  }
  if (typeof value === "number") return [assistantTurn(String(value))];
  if (typeof value === "string") {
    return value.trim() ? [assistantTurn(value)] : [];
  }
  let turns: ChatMessage[] | null = null;
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (
      "role" in value ||
      Array.isArray(value.messages) ||
      typeof value.content === "string"
    ) {
      turns = turnsOf(value);
    } else if (entries.length === 1 && typeof entries[0]?.[1] === "string") {
      return expectedTurns(entries[0][1]);
    } else if (entries.length === 0) {
      return [];
    } else {
      return [assistantTurn(sortedJson(value))];
    }
  } else if (Array.isArray(value)) {
    turns = turnsOf(value);
  }

  return turns?.some((t) => t.role === "assistant") ? turns : [];
};

/**
 * The conversation as logged, with the record's own answer: `messages`,
 * `input.messages` + `output.turns`, or `prompt` + `completion`.
 */
export const ownConversation = (record: DatasetRecord): ChatMessage[] => {
  if (record.messages && record.messages.length > 0) return record.messages;
  if (
    record.schema === "grad.trajectory/1" ||
    (record.input?.messages?.length ?? 0) > 0
  ) {
    return [...(record.input?.messages ?? []), ...(record.output?.turns ?? [])];
  }
  if (record.prompt !== undefined) {
    return [
      ...asMessages(record.prompt, "user"),
      ...asMessages(record.completion, "assistant"),
    ];
  }

  return [];
};

/** (prompt, answer): the answer is the run of assistant turns ending the conversation. */
export const splitAnswer = (
  messages: readonly ChatMessage[],
): [ChatMessage[], ChatMessage[]] => {
  let cut = messages.length;
  while (cut > 0 && messages[cut - 1]?.role === "assistant") cut -= 1;

  return [messages.slice(0, cut), messages.slice(cut)];
};

/**
 * The conversation a record trains on (trainer `record_messages`).
 * `expected_output` is the target: it replaces the record's own final answer
 * (a synced correction), or answers a prompt that has none. A record without
 * a prompt trains on nothing.
 */
export const recordConversation = (record: DatasetRecord): ChatMessage[] => {
  const conversation = ownConversation(record);
  const target = expectedTurns(record.expected_output);
  const [prompt] = splitAnswer(conversation);
  if (prompt.length === 0) return [];

  return target.length > 0 ? [...prompt, ...target] : conversation;
};

/**
 * (prompt, chosen, rejected) for a record whose `expected_output` corrects
 * its own answer: the correction is chosen, the logged answer rejected.
 */
export const correctionPair = (
  record: DatasetRecord,
): [ChatMessage[], ChatMessage[], ChatMessage[]] | null => {
  const target = expectedTurns(record.expected_output);
  const [prompt, answer] = splitAnswer(ownConversation(record));
  if (target.length === 0 || prompt.length === 0 || answer.length === 0) {
    return null;
  }
  if (sortedJson(answer) === sortedJson(target)) return null;

  return [prompt, target, answer];
};

/**
 * Prompt (everything before the final assistant turn), the record's own
 * answer (that turn, or `completion`) and its gold `expected_output`.
 */
export const recordPromptAndResponse = (
  record: DatasetRecord,
): {
  prompt: ChatMessage[];
  response: string | null;
  expected: string | null;
} | null => {
  const expected = expectedText(record.expected_output);

  if (record.input?.messages && record.input.messages.length > 0) {
    const turns = record.output?.turns ?? [];
    const last = turns.filter((t) => t.role === "assistant").pop();

    return {
      prompt: record.input.messages,
      response: last ? messageText(last) : null,
      expected,
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
      response: completion,
      expected,
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
    response: target ? messageText(target) : null,
    expected,
  };
};

/** Prompt (everything before the final assistant turn) and the reference answer. */
export const recordPromptAndReference = (
  record: DatasetRecord,
): { prompt: ChatMessage[]; reference: string | null } | null => {
  const parts = recordPromptAndResponse(record);

  return parts
    ? { prompt: parts.prompt, reference: parts.expected ?? parts.response }
    : null;
};

/**
 * A {prompt, chosen, rejected} pair. Like the trainer (recipes/dpo.py), the
 * prompt may instead be `messages`, or the shared opening turns of `chosen`
 * and `rejected` when both are conversations (TRL's implicit-prompt format).
 */
const isPreferencePair = (r: DatasetRecord): boolean =>
  r.chosen !== undefined &&
  r.rejected !== undefined &&
  (r.prompt !== undefined ||
    r.messages !== undefined ||
    (Array.isArray(r.chosen) && Array.isArray(r.rejected)));

export interface RouterLabelOptions {
  /** Score name that measures quality (`scores[rubric]`). */
  rubric?: string | undefined;
  /** A labeling eval scores the prompts first: records only need a prompt. */
  labelled?: boolean | undefined;
  /** Explicit candidate models (lowercase ids). */
  candidates?: readonly string[] | undefined;
}

const looksLikeModelId = (key: string): boolean =>
  key.includes("/") || key.includes("@");

/**
 * Models a router record scores, mirroring the trainer (recipes/router.py):
 * one response per record (`metadata.model` + its score) or one prompt per
 * record with `scores` keyed by model id. Scores must be in [0, 1].
 */
export const routerObservations = (
  r: DatasetRecord,
  options: RouterLabelOptions,
): { models: string[]; reason?: string } => {
  const scores = r.scores ?? {};
  const model = r.metadata?.model;
  let observed: Array<[string, number]>;

  if (typeof model === "string" && model.trim()) {
    const values = Object.entries(scores);
    let value: number | undefined;
    if (options.rubric !== undefined) value = scores[options.rubric];
    else if (values.length === 1) value = values[0]?.[1];
    else if (values.length > 1) {
      return {
        models: [],
        reason: `record has several scores (${values
          .map(([k]) => k)
          .sort()
          .join(", ")}); pass recipe.rubric with the score name to train on`,
      };
    }
    observed = value === undefined ? [] : [[model.trim().toLowerCase(), value]];
  } else {
    observed = Object.entries(scores)
      .map(([k, v]): [string, number] => [k.trim().toLowerCase(), v])
      .filter(([k]) => (options.candidates ? true : looksLikeModelId(k)));
  }
  if (options.candidates) {
    observed = observed.filter(([k]) => options.candidates?.includes(k));
  }

  const outOfRange = observed.find(([, v]) => v < 0 || v > 1);
  if (outOfRange) {
    throw invalid(
      "router_score_out_of_range",
      `Router scores must be in [0, 1]; record '${r.id ?? "(no id)"}' has ${outOfRange[1]} for '${outOfRange[0]}'.`,
    );
  }
  if (observed.length === 0) {
    return {
      models: [],
      reason:
        options.rubric !== undefined
          ? `record has no '${options.rubric}' score for a candidate model`
          : "record has no per-model scores (scores keyed by model id, or metadata.model plus a score)",
    };
  }

  return { models: observed.map(([k]) => k) };
};

export interface RecipeUsability {
  /** Training items: records, or pairs for DPO and reward models. */
  usable: number;
  total: number;
  /** Records the recipe can't use (they are skipped). */
  unusable: number;
  /** Why records were unusable (up to 3 distinct reasons). */
  reasons: string[];
  /** Up to 3 unusable records, by id or `#<index>`. */
  examples: string[];
  /** Router only: candidate models discovered from per-model scores. */
  discoveredModels?: string[];
}

const SHAPE_HELP: Record<string, string> = {
  sft: 'SFT needs a prompt and an answer: {"messages": [{"role": "user", ...}, {"role": "assistant", ...}]}, {"input": {"messages": [...]}, "output": {"turns": [...]}}, {"prompt": ..., "completion": ...}, or any of these with "expected_output" as the answer.',
  dpo: 'DPO needs preference pairs {"prompt", "chosen", "rejected"}, grad.trajectory/1 records sharing a group_id with role "chosen" and role "rejected", or a logged answer with a correction in "expected_output" (the correction is chosen).',
  reward:
    'Reward models need preference pairs {"prompt", "chosen", "rejected"} (or grad.trajectory/1 records sharing a group_id with role "chosen" and role "rejected"), or, with recipe.rubric, answers carrying that score in [0, 1]: {"messages": [..., {"role": "assistant", ...}], "scores": {"resolved": 1.0}}.',
  distill:
    'Distillation needs prompts: {"messages": [{"role": "user", ...}]} (trailing assistant turns are ignored), a grad.trajectory/1 record, or {"prompt": ...}.',
  router:
    'Router training needs scored responses: one record per response with {"messages": [...], "metadata": {"model": "qwen/qwen3-8b"}, "scores": {"resolved": 1.0}} (pass recipe.rubric when records carry several scores), or one record per prompt with "scores" keyed by model id, e.g. {"qwen/qwen3-8b": 0.4, "qwen/qwen3-32b": 0.9}.',
  decision:
    'Decision models need a state and a label: {"state": {...} | "messages": [...], "expected_output": {"label": ...}} or "scores".',
  embedding:
    'Embedding training needs {"query": ..., "positive": ..., "negatives"?: [...]}.',
};

export const recordShapeHelp = (kind: RecipeKind): string =>
  SHAPE_HELP[kind] ?? "";

const recordLabel = (r: DatasetRecord, index: number): string =>
  r.id ?? `#${index}`;

/**
 * Counts how many records a recipe can actually train on, and which it can't
 * (with reasons and example ids for the plan warning). Unknown shapes are
 * never silently accepted: callers reject plans with zero usable records.
 */
export const assessRecipeUsability = (
  kind: RecipeKind,
  records: readonly DatasetRecord[],
  routerOptions: RouterLabelOptions = {},
): RecipeUsability => {
  const reasons = new Set<string>();
  const examples: string[] = [];
  let unusable = 0;
  const skip = (label: string, reason: string) => {
    unusable += 1;
    if (examples.length < 3) examples.push(label);
    if (reasons.size < 3) reasons.add(reason);
  };
  const result = (usable: number) => ({
    usable,
    total: records.length,
    unusable,
    reasons: [...reasons],
    examples,
  });

  if (kind === "dpo" || kind === "reward") {
    let usable = 0;
    const groups = new Map<string, { roles: Set<string>; labels: string[] }>();
    const pointwise = kind === "reward" ? routerOptions.rubric : undefined;
    records.forEach((r, index) => {
      if (isPreferencePair(r)) {
        usable += 1;
        return;
      }
      if (pointwise !== undefined && r.scores?.[pointwise] !== undefined) {
        const value = r.scores[pointwise];
        if (value < 0 || value > 1) {
          throw invalid(
            "reward_score_out_of_range",
            `Reward scores must be in [0, 1]; record '${r.id ?? "(no id)"}' has ${value} for '${pointwise}'.`,
          );
        }
        if (hasAssistantTarget(recordConversation(r))) {
          usable += 1;
          return;
        }
      }
      if (r.group_id && (r.role === "chosen" || r.role === "rejected")) {
        const group = groups.get(r.group_id) ?? {
          roles: new Set(),
          labels: [],
        };
        group.roles.add(r.role);
        group.labels.push(recordLabel(r, index));
        groups.set(r.group_id, group);
        return;
      }
      if (correctionPair(r)) {
        usable += 1;
        return;
      }
      skip(
        recordLabel(r, index),
        pointwise === undefined
          ? "record is neither a {prompt, chosen, rejected} pair, a chosen/rejected trajectory nor an answer with a differing expected_output"
          : `record is neither a {prompt, chosen, rejected} pair, a chosen/rejected trajectory, an answer with a differing expected_output nor an answer with a '${pointwise}' score`,
      );
    });
    for (const { roles, labels } of groups.values()) {
      if (roles.has("chosen") && roles.has("rejected")) usable += 1;
      else {
        for (const label of labels) {
          skip(
            label,
            "trajectory group has only a chosen or only a rejected side",
          );
        }
      }
    }

    return result(usable);
  }

  let usable = 0;
  const models = new Set<string>();
  records.forEach((r, index) => {
    let ok = false;
    let reason = "";
    if (kind === "sft" || kind === "grpo") {
      const conversation = recordConversation(r);
      ok = hasAssistantTarget(conversation);
      if (!ok) {
        reason =
          splitAnswer(ownConversation(r))[0].length === 0
            ? "record has no prompt (a user or system turn before the answer)"
            : "record has no assistant answer (an assistant turn, completion or expected_output) to train on";
      }
    } else if (kind === "cartridge") {
      ok = splitAnswer(ownConversation(r))[0].at(-1)?.role === "user";
      if (!ok) reason = "record has no user question as its last prompt turn";
    } else if (kind === "distill") {
      ok =
        recordPromptAndReference(r)?.prompt.some((m) => m.role === "user") ??
        false;
      if (!ok) reason = "record has no user prompt";
    } else if (kind === "router") {
      const hasPrompt =
        recordConversation(r).length > 0 ||
        typeof r.prompt === "string" ||
        typeof r.query === "string";
      const observed = routerOptions.labelled
        ? { models: [] }
        : routerObservations(r, routerOptions);
      ok = hasPrompt && (routerOptions.labelled || observed.models.length > 0);
      if (ok) observed.models.forEach((m) => models.add(m));
      else reason = observed.reason ?? "record has no prompt";
    } else if (kind === "decision") {
      const hasState =
        r.state !== undefined ||
        r.input?.features !== undefined ||
        recordConversation(r).length > 0;
      const hasLabel =
        r.expected_output !== undefined ||
        Object.keys(r.scores ?? {}).length > 0;
      ok = hasState && hasLabel;
      if (!ok) {
        reason =
          "record needs a state (state, input.features or messages) and a label (expected_output or scores)";
      }
    } else if (kind === "embedding") {
      ok =
        typeof (
          r.query ?? (typeof r.prompt === "string" ? r.prompt : undefined)
        ) === "string" && typeof r.positive === "string";
      if (!ok) reason = "record needs 'query' and 'positive'";
    }
    if (ok) usable += 1;
    else
      skip(
        recordLabel(r, index),
        reason || `record has no shape '${kind}' can use`,
      );
  });

  return {
    ...result(usable),
    ...(kind === "router" ? { discoveredModels: [...models].sort() } : {}),
  };
};
