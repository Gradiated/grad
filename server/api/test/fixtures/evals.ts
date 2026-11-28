import type { BillingAdapter } from "../../src/adapters.js";
import type { DatasetRecord } from "../../src/contracts.js";
import { createOpenAICompatibleClient } from "../../src/services/evals/inference.js";
import { createRegexEvaluator } from "../../src/services/evals/regex.js";
import type { EvalService } from "../../src/services/evals/service.js";
import type { InferenceClients } from "../../src/services/evals/types.js";
import type { ArtifactRecord } from "../../src/store/types.js";
import {
  createWorkerClient,
  type WorkerClient,
} from "../../src/worker/client.js";
import {
  createEvalWorker,
  type EvalWorker,
} from "../../src/worker/eval-worker.js";
import { makeTestApp, TRAINER_KEY, WORKSPACE_A, type TestApp } from "./app.js";
import { startFakeOpenAI, type FakeOpenAI } from "./fake-openai.js";

export interface EvalHarness {
  t: TestApp;
  fake: FakeOpenAI;
  /** An eval worker on the test app (over its HTTP routes). */
  worker: TestEvalWorker;
  close: () => Promise<void>;
}

export interface TestEvalWorker extends EvalWorker {
  client: WorkerClient;
  close: () => Promise<void>;
}

/** The test app's routes as `fetch` (an API restart: point `target.app` elsewhere). */
export const appFetch =
  (target: { app: TestApp["app"] }): typeof fetch =>
  async (input, init) =>
    target.app.request(
      input instanceof Request ? input : String(input),
      init as RequestInit,
    );

/** An eval worker (`grad-server worker --kinds eval`) wired to `t`'s routes. */
export const startEvalWorker = (
  t: Pick<TestApp, "app">,
  inference: InferenceClients,
  options: {
    workerId?: string;
    batchSize?: number;
    concurrency?: number;
    fetch?: typeof fetch;
    outageRetryMs?: number;
    outageMaxMs?: number;
    capacityMaxMs?: number;
    tmpMaxBytes?: number;
  } = {},
): TestEvalWorker => {
  const regex = createRegexEvaluator();
  const client = createWorkerClient({
    serverUrl: "http://grad.test",
    apiKey: TRAINER_KEY,
    workerId: options.workerId ?? "eval-worker-test",
    fetch: options.fetch ?? appFetch(t),
    retryDelaysMs: [1, 1, 1],
  });
  const worker = createEvalWorker({
    client,
    inference,
    regex,
    concurrency: options.concurrency ?? 3,
    batchSize: options.batchSize ?? 2,
    // Tests: an endpoint down past the client's retries gives up at once
    // (the attempt is handed back) unless the test waits it out.
    outageRetryMs: options.outageRetryMs ?? 1,
    outageMaxMs: options.outageMaxMs ?? 0,
    ...(options.capacityMaxMs !== undefined
      ? { capacityMaxMs: options.capacityMaxMs }
      : {}),
    tmpMaxBytes: options.tmpMaxBytes,
  });

  return {
    ...worker,
    client,
    close: async () => {
      await worker.stop();
      await regex.close();
    },
  };
};

/** Inference and judge clients on a fake OpenAI-compatible server. */
export const fakeInference = (fake: FakeOpenAI): InferenceClients => {
  const client = createOpenAICompatibleClient({
    baseUrl: fake.baseUrl,
    retryDelayMs: 1,
    maxAttempts: 2,
  });

  return { models: client, judge: client };
};

/** Test app with an eval worker whose inference + judge clients point at a fake OpenAI-compatible server. */
export const makeEvalHarness = async (
  options: { maxAttempts?: number; billing?: BillingAdapter } = {},
): Promise<EvalHarness> => {
  const fake = await startFakeOpenAI();
  const t = await makeTestApp({
    ...(options.billing ? { billing: options.billing } : {}),
    inferenceConfigured: true,
    settings: {
      maxAttempts: options.maxAttempts ?? 3,
    },
  });

  const worker = startEvalWorker(t, fakeInference(fake));

  return {
    t,
    fake,
    worker,
    close: async () => {
      await worker.close();
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
