import { createHash } from "node:crypto";

import {
  GeneratedApiClient,
  type ChatMessage,
  type DatasetRecord,
  type EvalRubricItem,
  type GeneratedClientOptions,
  type RecipeSpec,
  type SplitSpec,
} from "./generated/client.js";

export interface GradOptions extends Partial<GeneratedClientOptions> {}

export class Grad {
  readonly wire: GeneratedApiClient;

  constructor(options: GradOptions = {}) {
    const baseUrl =
      options.baseUrl ?? process.env.GRAD_BASE_URL ?? "http://127.0.0.1:8080";
    const apiKey = options.apiKey ?? process.env.GRAD_API_KEY;
    this.wire = new GeneratedApiClient({
      baseUrl,
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
      ...(options.fetchImpl !== undefined
        ? { fetchImpl: options.fetchImpl }
        : {}),
    });
  }

  readonly models = {
    list: async () => (await this.wire.listModels()).data,
  };

  readonly datasets = {
    list: async () => (await this.wire.listDatasets()).data,
    get: (name: string) => this.wire.getDataset(name),
    push: (
      name: string,
      records: DatasetRecord[],
      metadata?: Record<string, unknown>,
    ) =>
      this.wire.pushDatasetRecords(name, {
        records,
        ...(metadata ? { metadata } : {}),
      }),
    records: (name: string, query?: { limit?: number; offset?: number }) =>
      this.wire.listDatasetRecords(name, query),
    render: (
      name: string,
      options: {
        model?: string;
        train_on?: "last" | "all_assistant";
        thinking?: "auto" | "on" | "off";
        preserve_thinking?: boolean;
        limit?: number;
      } = {},
    ) => this.wire.renderDataset(name, options),
  };

  readonly runs = {
    plan: (input: {
      dataset: string;
      name: string;
      recipe: RecipeSpec;
      split?: SplitSpec;
      max_cost_usd?: number;
    }) => this.wire.planRun(input),
    create: (input: {
      dataset: string;
      name: string;
      recipe: RecipeSpec;
      split?: SplitSpec;
      max_cost_usd?: number;
    }) => this.wire.createRun(input),
    list: async () => (await this.wire.listRuns()).data,
    get: (id: string) => this.wire.getRun(id),
    metrics: (id: string, afterStep = -1) =>
      this.wire.listRunMetrics(id, { after_step: afterStep }),
    cancel: (id: string) => this.wire.cancelRun(id),
    resume: (id: string, maxCostUsd?: number) =>
      this.wire.resumeRun(
        id,
        maxCostUsd !== undefined ? { max_cost_usd: maxCostUsd } : {},
      ),
    checkpoints: async (id: string) =>
      (await this.wire.listRunCheckpoints(id)).data,
    wait: async (
      id: string,
      opts?: { pollMs?: number; timeoutMs?: number; signal?: AbortSignal },
    ) => {
      const rawPoll = opts?.pollMs ?? 500;
      const pollMs = Number.isFinite(rawPoll) ? Math.max(50, rawPoll) : 500;
      const deadline = Date.now() + (opts?.timeoutMs ?? 3_600_000);
      while (true) {
        if (opts?.signal?.aborted) {
          throw new Error(`Aborted waiting for run '${id}'.`);
        }
        const run = await this.wire.getRun(id);
        const status = String(run.status ?? "");
        if (
          status === "completed" ||
          status === "failed" ||
          status === "cancelled" ||
          status === "stopped_budget"
        ) {
          return run;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for run '${id}'.`);
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, pollMs);
          if (opts?.signal) {
            opts.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error(`Aborted waiting for run '${id}'.`));
              },
              { once: true },
            );
          }
        });
      }
    },
  };

  readonly checkpoints = {
    promote: (id: string, name?: string) =>
      this.wire.promoteCheckpoint(id, name ? { name } : {}),
  };

  readonly artifacts = {
    list: async (name?: string) =>
      (await this.wire.listArtifacts(name ? { name } : undefined)).data,
    get: (reference: string) => this.wire.getArtifact(reference),
    download: async (
      reference: string,
      opts?: { verifyChecksum?: boolean },
    ): Promise<Uint8Array> => {
      const { bytes, headers } = await this.wire.downloadArtifact(reference);
      const verify = opts?.verifyChecksum ?? true;
      const expectedSha = (headers.get("x-artifact-sha256") ?? "")
        .trim()
        .toLowerCase();
      if (verify) {
        if (!/^[0-9a-f]{64}$/.test(expectedSha)) {
          throw new Error(
            "Artifact download missing valid X-Artifact-Sha256 header.",
          );
        }
        const actualSha = createHash("sha256").update(bytes).digest("hex");
        if (actualSha !== expectedSha) {
          throw new Error(
            `Artifact SHA-256 mismatch: expected ${expectedSha}, got ${actualSha}.`,
          );
        }
      }
      return bytes;
    },
  };

  readonly deployments = {
    list: async () => (await this.wire.listDeployments()).data,
    get: (name: string) => this.wire.getDeployment(name),
  };

  readonly embeddings = {
    create: (input: { model: string; input: string | string[] }) =>
      this.wire.createEmbeddings(input),
  };

  readonly feedback = {
    record: (
      events: Array<{
        idempotency_key: string;
        inference_id?: string;
        session_id?: string;
        deployment_name?: string;
        score?: number;
        expected_output?: unknown;
        metrics?: Record<string, number>;
      }>,
    ) => this.wire.recordFeedback({ events }),
  };

  readonly evals = {
    plan: (input: {
      name?: string;
      models: string[];
      baseline?: string;
      dataset?: string;
      env_name?: string;
      tasks?: Array<Record<string, unknown>>;
      benchmarks?: Array<{ name: string; limit?: number }>;
      rubric?: EvalRubricItem[];
      samples?: number;
      pass_threshold?: number;
      max_cost_usd?: number;
    }) => this.wire.planEval(input),
    create: (input: {
      name?: string;
      models: string[];
      baseline?: string;
      dataset?: string;
      env_name?: string;
      tasks?: Array<Record<string, unknown>>;
      benchmarks?: Array<{ name: string; limit?: number }>;
      rubric?: EvalRubricItem[];
      samples?: number;
      pass_threshold?: number;
      max_cost_usd?: number;
    }) => this.wire.createEval(input),
    list: async () => (await this.wire.listEvals()).data,
    get: (id: string) => this.wire.getEval(id),
    failures: (id: string, query?: { model?: string; threshold?: number }) =>
      this.wire.listEvalFailures(id, query),
  };

  readonly keys = {
    create: (name: string, scopes: string[]) =>
      this.wire.createApiKey({ name, scopes }),
    list: async () => (await this.wire.listApiKeys()).data,
    revoke: (id: string) => this.wire.revokeApiKey(id),
  };

  deploy = (input: {
    artifact: string;
    name?: string;
    fallback?: string;
    explore_rate?: number;
  }) => this.wire.deployArtifact(input);

  route = (input: {
    deployment: string;
    messages: ChatMessage[];
    session_id?: string;
    tools?: Array<Record<string, unknown>>;
  }) => this.wire.routeRequest(input);
}
