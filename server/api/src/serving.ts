import { createHash, randomUUID } from "node:crypto";

import type { Artifact, ChatMessage, Deployment } from "./contracts.js";
import { estimateTextTokens } from "./planner.js";

const hashUnit = (seed: string): number => {
  const digest = createHash("sha256").update(seed).digest();

  return digest.readUInt32BE(0) / 0x1_0000_0000;
};

const extractPromptText = (messages: readonly ChatMessage[]): string =>
  messages.map((m) => `${m.role}: ${m.content ?? ""}`).join("\n");

export const selectRoute = (input: {
  deployment: Deployment;
  artifact: Artifact;
  messages: readonly ChatMessage[];
  sessionId?: string;
}): {
  inference_id: string;
  deployment: string;
  artifact_id: string;
  model: string;
  is_exploration: boolean;
  confidence: number;
  scores: Record<string, number>;
} => {
  const inferenceId = `inf_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const routerConfig = (input.artifact.manifest.router_config ?? {}) as {
    candidates?: string[];
    threshold?: number;
    fallback_model?: string;
    feature_weights?: Record<string, number>;
  };

  const candidates =
    routerConfig.candidates && routerConfig.candidates.length > 0
      ? routerConfig.candidates
      : [
          "qwen/qwen3-8b",
          input.deployment.fallback_model ??
            routerConfig.fallback_model ??
            "qwen/qwen3-32b",
        ];

  const fallback =
    input.deployment.fallback_model ??
    routerConfig.fallback_model ??
    candidates[candidates.length - 1] ??
    "qwen/qwen3-32b";

  const cheapCandidate =
    candidates.find((c) => c !== fallback) ?? candidates[0] ?? fallback;

  const promptText = extractPromptText(input.messages);
  const tokens = estimateTextTokens(promptText);
  const complexitySignal = Math.min(1, tokens / 1200);
  const threshold = routerConfig.threshold ?? 0.65;

  // Higher score means the cheap model is predicted more likely to succeed.
  const cheapSuccessProb = Number(
    Math.max(0.05, Math.min(0.98, 0.92 - complexitySignal * 0.55)).toFixed(4),
  );
  const scores: Record<string, number> = {
    [cheapCandidate]: cheapSuccessProb,
    [fallback]: 0.96,
  };

  const stickyKey = input.sessionId ?? inferenceId;
  const exploreDraw = hashUnit(`${input.deployment.id}:explore:${stickyKey}`);
  const isExploration =
    input.deployment.explore_rate > 0 &&
    exploreDraw < input.deployment.explore_rate;

  let chosen: string;
  if (isExploration) {
    const idx =
      Math.floor(
        hashUnit(`${input.deployment.id}:arm:${stickyKey}`) * candidates.length,
      ) % candidates.length;
    chosen = candidates[idx] ?? fallback;
  } else {
    chosen = cheapSuccessProb >= threshold ? cheapCandidate : fallback;
  }

  return {
    inference_id: inferenceId,
    deployment: input.deployment.name,
    artifact_id: input.artifact.id,
    model: chosen,
    is_exploration: isExploration,
    confidence: scores[chosen] ?? 0.9,
    scores,
  };
};

export const computeDeterministicEmbedding = (
  text: string,
  modelSeed: string,
  dimensions = 64,
): number[] => {
  const vec = new Float64Array(dimensions);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) {
    vec[0] = 1;
    return Array.from(vec);
  }

  for (const token of tokens) {
    const digest = createHash("sha256")
      .update(`${modelSeed}:${token}`)
      .digest();
    for (let i = 0; i < dimensions; i += 1) {
      const byte = digest[i % digest.length] ?? 0;
      const signed = (byte / 255) * 2 - 1;
      vec[i] = (vec[i] ?? 0) + signed;
    }
  }

  let norm = 0;
  for (let i = 0; i < dimensions; i += 1) {
    const val = vec[i] ?? 0;
    norm += val * val;
  }
  const denom = Math.sqrt(norm) || 1;

  return Array.from(vec, (v) => Number((v / denom).toFixed(6)));
};
