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

const isPreferencePair = (r: DatasetRecord): boolean =>
  r.prompt !== undefined && r.chosen !== undefined && r.rejected !== undefined;

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

/**
 * Counts how many records a recipe can actually train on. Unknown shapes are
 * never silently accepted: callers reject plans with zero usable records.
 */
export const assessRecipeUsability = (
  kind: RecipeKind,
  records: readonly DatasetRecord[],
  routerOptions: RouterLabelOptions = {},
): RecipeUsability => {
  const reasons = new Set<string>();
  const note = (reason: string) => {
    if (reasons.size < 3) reasons.add(reason);
  };

  if (kind === "dpo" || kind === "reward") {
    let usable = 0;
    const groups = new Map<string, Set<string>>();
    const pointwise = kind === "reward" ? routerOptions.rubric : undefined;
    for (const r of records) {
      if (isPreferencePair(r)) {
        usable += 1;
        continue;
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
          continue;
        }
      }
      if (r.group_id && (r.role === "chosen" || r.role === "rejected")) {
        const roles = groups.get(r.group_id) ?? new Set<string>();
        roles.add(r.role);
        groups.set(r.group_id, roles);
        continue;
      }
      note(
        pointwise === undefined
          ? "record is neither a {prompt, chosen, rejected} pair nor a chosen/rejected trajectory"
          : `record is neither a {prompt, chosen, rejected} pair, a chosen/rejected trajectory nor an answer with a '${pointwise}' score`,
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
    if (kind === "sft" || kind === "grpo") {
      ok = hasAssistantTarget(recordConversation(r));
      if (!ok) note("record has no assistant turn to train on");
    } else if (kind === "distill") {
      ok =
        recordPromptAndReference(r)?.prompt.some((m) => m.role === "user") ??
        false;
      if (!ok) note("record has no user prompt");
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
      else note(observed.reason ?? "record has no prompt");
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
