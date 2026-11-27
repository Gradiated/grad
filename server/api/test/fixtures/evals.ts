import type { BillingAdapter } from "../../src/adapters.js";
import type { DatasetRecord } from "../../src/contracts.js";
import { createOpenAICompatibleClient } from "../../src/services/evals/inference.js";
import type { EvalService } from "../../src/services/evals/service.js";
import type { ArtifactRecord } from "../../src/store/types.js";
import { makeTestApp, WORKSPACE_A, type TestApp } from "./app.js";
import { startFakeOpenAI, type FakeOpenAI } from "./fake-openai.js";

export interface EvalHarness {
  t: TestApp;
  fake: FakeOpenAI;
  close: () => Promise<void>;
}

/** Test app whose inference + judge clients point at a fake OpenAI-compatible server. */
export const makeEvalHarness = async (
  options: { maxAttempts?: number; billing?: BillingAdapter } = {},
): Promise<EvalHarness> => {
  const fake = await startFakeOpenAI();
  const client = createOpenAICompatibleClient({
    baseUrl: fake.baseUrl,
    retryDelayMs: 1,
    maxAttempts: 2,
  });
  const t = await makeTestApp({
    ...(options.billing ? { billing: options.billing } : {}),
    inference: { models: client, judge: client },
    settings: {
      maxAttempts: options.maxAttempts ?? 3,
      evalConcurrency: 3,
    },
  });

  return {
    t,
    fake,
    close: async () => {
      await t.close();
      await fake.close();
    },
  };
};

export const qaRecords = (count: number): DatasetRecord[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `q${i}`,
    messages: [
      { role: "user" as const, content: `question ${i}` },
      { role: "assistant" as const, content: `gold ${i}` },
    ],
  }));

export const seedDataset = (
  t: TestApp,
  name: string,
  records: DatasetRecord[],
  workspaceId = WORKSPACE_A,
) =>
  t.services.datasets
    .push(workspaceId, name, records)
    .then((pushed) => pushed.value);

export const seedArtifact = (
  t: TestApp,
  name: string,
  options: { format?: ArtifactRecord["format"]; workspaceId?: string } = {},
) =>
  t.deps.store.artifacts.createRelease({
    workspaceId: options.workspaceId ?? WORKSPACE_A,
    name,
    runId: null,
    sourceId: null,
    baseModel: "test/tiny-qwen3",
    recipeKind: "sft",
    format: options.format ?? "peft_lora",
    storageKey: `artifacts/${name}`,
    sha256: "0".repeat(64),
    sizeBytes: 1,
    manifest: {},
    evalReport: null,
  });

/** Replies with the gold answer ("gold N") for "question N". */
export const goldResponder = (request: {
  messages: Array<{ role: string; content?: unknown }>;
}) => {
  const user = request.messages.find((m) => m.role === "user");
  const n = String(user?.content ?? "").replace("question ", "");

  return { content: `gold ${n}` };
};

/** `evals.create` without an Idempotency-Key: the created eval. */
export const createEval = async (
  evals: EvalService,
  ...args: Parameters<EvalService["create"]>
) => (await evals.create(...args)).value;
