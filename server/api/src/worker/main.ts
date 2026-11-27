import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

import {
  parseEvalWorkerEnvironment,
  type EvalEndpoints,
} from "../environment.js";
import { createGatewayInference } from "../cloud/gateway.js";
import { createOpenAICompatibleClient } from "../services/evals/inference.js";
import { createRegexEvaluator } from "../services/evals/regex.js";
import type { InferenceClients } from "../services/evals/types.js";
import { log, withLogContext } from "../telemetry/log.js";
import { workerTokenSource } from "../worker-auth/token-source.js";
import { createWorkerClient } from "./client.js";
import {
  createEvalWorker,
  parseWorkerArgs,
  unconfiguredInference,
} from "./eval-worker.js";

const endpointClients = (
  baseUrl: string,
  env: EvalEndpoints,
): InferenceClients => {
  const models = createOpenAICompatibleClient({
    baseUrl,
    apiKey: env.inferenceApiKey,
    timeoutMs: 120_000,
  });
  const judge =
    env.judgeBaseUrl && env.judgeBaseUrl !== baseUrl
      ? createOpenAICompatibleClient({
          baseUrl: env.judgeBaseUrl,
          apiKey: env.judgeApiKey,
          timeoutMs: 120_000,
        })
      : models;

  return { models, judge };
};

/** `grad-server worker --kinds eval`: the eval worker, until SIGTERM. */
export const runWorker = async (args: readonly string[]): Promise<void> => {
  parseWorkerArgs(args);
  const env = parseEvalWorkerEnvironment();
  for (const warning of env.warnings) log("warn", warning);

  // Cloud: every model and judge call goes to the gateway's eval lane.
  const inference = env.GRAD_CLOUD_GATEWAY_URL
    ? createGatewayInference({
        baseUrl: env.GRAD_CLOUD_GATEWAY_URL,
        token: env.GRAD_CLOUD_GATEWAY_TOKEN as string,
      })
    : env.inferenceBaseUrl
      ? endpointClients(env.inferenceBaseUrl, env)
      : unconfiguredInference();
  const regex = createRegexEvaluator();
  // A per-process suffix, so a restarted container takes a new attempt.
  const workerId = `${env.GRAD_WORKER_ID ?? hostname()}-${randomBytes(4).toString("hex")}`;
  const worker = createEvalWorker({
    client: createWorkerClient({
      serverUrl: env.GRAD_SERVER_URL,
      // GRAD_WORKER_TOKEN, else GRAD_WORKER_TOKEN_FILE (re-read per request), else TRAINER_API_KEY.
      apiKey: workerTokenSource(),
      workerId,
    }),
    inference,
    regex,
    concurrency: env.EVAL_CONCURRENCY,
    leaseSeconds: env.GRAD_LEASE_SECONDS,
    capacityMaxMs: env.GRAD_EVAL_CAPACITY_WAIT_SECONDS * 1000,
  });

  log("info", "grad-server eval worker started", {
    worker_id: workerId,
    server: env.GRAD_SERVER_URL,
    concurrency: env.EVAL_CONCURRENCY,
  });
  const running = withLogContext({ worker_id: workerId }, () =>
    worker.run(env.GRAD_POLL_INTERVAL_S * 1000),
  );
  const shutdown = (signal: string) => {
    log("info", "eval worker stopping: handing its eval back", { signal });
    void worker.stop();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  await running;
  await regex.close();
  log("info", "grad-server eval worker stopped", { worker_id: workerId });
  process.exit(0);
};
