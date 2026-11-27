import {
  messageText,
  type ChatMessage,
  type EvalRubricItem,
} from "../../contracts.js";
import { errorMessage } from "../../errors.js";
import { choiceMatches, finalNumberMatches } from "./answers.js";
import { InferenceOutage } from "./inference.js";
import type { ChatCompletionClient, RegexEvaluator } from "./types.js";

export const MAX_SCORED_CHARS = 16_384;

export interface ScoringInput {
  prompt: readonly ChatMessage[];
  output: string;
  reference: string | null;
}

export interface ScoringResult {
  scores: Record<string, number>;
  errors: string[];
  /** Items that produced no real score (their entry in `scores` is 0). */
  failed: string[];
  judgeTokens: Record<string, number>;
}

export interface ScoringContext {
  regex: RegexEvaluator;
  /**
   * Regex items (flags/pattern) that already timed out in this eval: they score 0
   * without running again, so one catastrophic pattern costs one timeout per eval,
   * not one per output, on the replica's shared regex worker.
   */
  timedOutRegex?: Set<string>;
  judge: ChatCompletionClient | null;
  /** The eval's workspace: sent with every judge call. */
  workspace: string;
  evalId?: string | undefined;
  /** Judge ref → the model name the endpoint serves it under (resolved at plan). */
  judgeTargets: Readonly<Record<string, { inference_model: string }>>;
}

const JUDGE_SYSTEM_PROMPT =
  'You are an evaluation judge. Score the response against the criteria. Reply with only a JSON object of the form {"score": <number from 0 to 1>}.';

const DEFAULT_CRITERIA =
  "Rate how correct, complete and helpful the response is for the conversation.";

export const buildJudgeMessages = (
  item: EvalRubricItem,
  input: ScoringInput,
): ChatMessage[] => {
  const conversation = input.prompt
    .map((m) => `${m.role}: ${messageText(m)}`)
    .join("\n");

  return [
    { role: "system", content: JUDGE_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Criteria:\n${item.prompt ?? DEFAULT_CRITERIA}`,
        `Conversation:\n${conversation}`,
        `Response:\n${input.output.slice(0, MAX_SCORED_CHARS)}`,
        `Reference answer:\n${input.reference ?? "(none)"}`,
      ].join("\n\n"),
    },
  ];
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Parses `{"score": x}` (first JSON object containing a numeric score) or a bare number. */
export const parseJudgeScore = (text: string): number | null => {
  const trimmed = text.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return clamp01(Number(trimmed));

  for (
    let start = trimmed.indexOf("{");
    start >= 0;
    start = trimmed.indexOf("{", start + 1)
  ) {
    for (
      let end = trimmed.indexOf("}", start);
      end >= 0;
      end = trimmed.indexOf("}", end + 1)
    ) {
      try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
        const score = (parsed as { score?: unknown } | null)?.score;
        if (typeof score === "number" && Number.isFinite(score))
          return clamp01(score);
      } catch {
        // keep scanning
      }
    }
  }

  return null;
};

const validatorScore = (item: EvalRubricItem, input: ScoringInput): number => {
  const output = input.output.trim();
  switch (item.validator) {
    case "json":
      try {
        JSON.parse(output);
        return 1;
      } catch {
        return 0;
      }
    case "exact_match":
      return input.reference !== null && output === input.reference.trim()
        ? 1
        : 0;
    case "final_number":
      return finalNumberMatches(output, input.reference) ? 1 : 0;
    case "choice":
      return choiceMatches(output, input.reference) ? 1 : 0;
    default:
      return output.length > 0 ? 1 : 0;
  }
};

/**
 * Scores one model output with every server-side rubric item (regex,
 * validator, judge). `code` items are skipped: they run in the SDK process
 * and are posted back via /v1/evals/{id}/scores.
 */
export const scoreOutput = async (
  rubric: readonly EvalRubricItem[],
  input: ScoringInput,
  ctx: ScoringContext,
): Promise<ScoringResult> => {
  const result: ScoringResult = {
    scores: {},
    errors: [],
    failed: [],
    judgeTokens: {},
  };

  for (const item of rubric) {
    if (item.kind === "code") continue;

    if (item.kind === "validator") {
      result.scores[item.name] = validatorScore(item, input);
      continue;
    }

    if (item.kind === "regex") {
      const key = `${item.flags ?? ""}/${item.pattern ?? ""}`;
      if (ctx.timedOutRegex?.has(key)) {
        result.scores[item.name] = 0;
        continue;
      }
      const outcome = await ctx.regex.test(
        item.pattern ?? "",
        item.flags ?? "",
        input.output.slice(0, MAX_SCORED_CHARS),
      );
      if ("timedOut" in outcome) ctx.timedOutRegex?.add(key);
      result.scores[item.name] =
        "matched" in outcome && outcome.matched ? 1 : 0;
      continue;
    }

    result.scores[item.name] = 0;
    result.failed.push(item.name);
    if (!ctx.judge || !item.model) {
      result.errors.push(`judge '${item.name}': no judge endpoint configured`);
      continue;
    }

    try {
      const reply = await ctx.judge.complete({
        model: ctx.judgeTargets[item.model]?.inference_model ?? item.model,
        workspace: ctx.workspace,
        evalId: ctx.evalId,
        messages: buildJudgeMessages(item, input),
        temperature: 0,
        max_tokens: 256,
      });
      result.judgeTokens[item.model] =
        (result.judgeTokens[item.model] ?? 0) +
        reply.usage.prompt_tokens +
        reply.usage.completion_tokens;
      const score = parseJudgeScore(reply.text);
      if (score === null) {
        result.errors.push(
          `judge '${item.name}': unparseable reply ${JSON.stringify(reply.text.slice(0, 120))}`,
        );
      } else {
        result.scores[item.name] = score;
        result.failed.pop();
      }
    } catch (error) {
      // An outage says nothing about the output: never score it 0.
      if (error instanceof InferenceOutage) throw error;
      result.errors.push(`judge '${item.name}': ${errorMessage(error)}`);
    }
  }

  return result;
};

/** Weighted mean over rubric items; missing scores count as 0. */
export const combineScores = (
  rubric: readonly EvalRubricItem[],
  scores: Readonly<Record<string, number>>,
): number => {
  let weighted = 0;
  let total = 0;
  for (const item of rubric) {
    weighted += (scores[item.name] ?? 0) * item.weight;
    total += item.weight;
  }

  return total > 0 ? Number((weighted / total).toFixed(4)) : 0;
};
