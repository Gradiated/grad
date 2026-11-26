import { describe, expect, it } from "vitest";

import type { Artifact, Deployment } from "../src/contracts.js";
import { computeDeterministicEmbedding, selectRoute } from "../src/serving.js";

const mockArtifact: Artifact = {
  id: "support-router@2026-11-27-1",
  workspace_id: "ws1",
  name: "support-router",
  version: "2026-11-27-1",
  run_id: "run_1",
  checkpoint_id: null,
  base_model: "qwen/qwen3-0.6b",
  recipe_kind: "router",
  format: "router_bundle",
  storage_key: "artifacts/ws1/support-router/run_1.grad.tar.gz",
  sha256: "a".repeat(64),
  size_bytes: 128,
  manifest: {
    router_config: {
      candidates: ["qwen/qwen3-8b", "qwen/qwen3-32b"],
      threshold: 0.65,
      fallback_model: "qwen/qwen3-32b",
    },
  },
  eval_report: null,
  created_at: new Date().toISOString(),
};

const mockDeployment: Deployment = {
  id: "dep_1",
  workspace_id: "ws1",
  name: "support-router",
  model_id: "ws1/support-router",
  active_artifact_id: mockArtifact.id,
  previous_artifact_id: null,
  fallback_model: "qwen/qwen3-32b",
  explore_rate: 0,
  status: "active",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe("selectRoute", () => {
  it("routes simple prompts to the cheap model and long prompts to fallback", () => {
    const simple = selectRoute({
      deployment: mockDeployment,
      artifact: mockArtifact,
      messages: [{ role: "user", content: "What are your support hours?" }],
    });
    expect(simple.model).toBe("qwen/qwen3-8b");
    expect(simple.is_exploration).toBe(false);

    const complex = selectRoute({
      deployment: mockDeployment,
      artifact: mockArtifact,
      messages: [{ role: "user", content: "x ".repeat(3000) }],
    });
    expect(complex.model).toBe("qwen/qwen3-32b");
    expect(complex.is_exploration).toBe(false);
  });

  it("keeps exploration arm sticky for the same session_id", () => {
    const exploringDeployment: Deployment = {
      ...mockDeployment,
      explore_rate: 0.5,
    };
    const first = selectRoute({
      deployment: exploringDeployment,
      artifact: mockArtifact,
      messages: [{ role: "user", content: "Hello" }],
      sessionId: "sess_sticky_123",
    });
    const second = selectRoute({
      deployment: exploringDeployment,
      artifact: mockArtifact,
      messages: [{ role: "user", content: "Hello" }],
      sessionId: "sess_sticky_123",
    });

    expect(first.is_exploration).toBe(second.is_exploration);
    expect(first.model).toBe(second.model);
  });
});

describe("computeDeterministicEmbedding", () => {
  it("returns deterministic L2-normalized vectors", () => {
    const a = computeDeterministicEmbedding("reset my password", "embed-v1");
    const b = computeDeterministicEmbedding("reset my password", "embed-v1");
    const c = computeDeterministicEmbedding("cancel subscription", "embed-v1");

    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    const norm = Math.sqrt(a.reduce((acc, v) => acc + v * v, 0));
    expect(norm).toBeCloseTo(1, 3);
  });
});
