import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createLocalApiKeyAuth,
  createNoopBillingAdapter,
  hashApiKey,
} from "../../src/adapters.js";
import { createGradApp } from "../../src/app.js";
import { createModelCatalog } from "../../src/catalog.js";
import type { AppDependencies } from "../../src/deps.js";
import { createRegexEvaluator } from "../../src/services/evals/regex.js";
import { LocalObjectStore } from "../../src/storage/local.js";
import { createBlobSigner } from "../../src/storage/signer.js";
import { ManualClock } from "./clock.js";
import { createTestStore } from "./postgres.js";

export const ADMIN_KEY = "grad_test_bootstrap_admin_key";
export const TRAINER_KEY = "grad_test_platform_trainer_key";
export const WORKSPACE_A = "ws_a";

export const TINY_MODELS_JSON = JSON.stringify([
  {
    id: "test/tiny-qwen3",
    hf_repo: null,
    family: "llm",
    adapters: ["lora", "prefix_kv"],
    default_for: [],
    price_per_million_tokens_usd: 1,
    max_context_tokens: 2048,
    template_revision: "qwen3@3",
    calibrated_lrs: {
      sft: 1e-3,
      dpo: 1e-4,
      router: 1e-3,
      cartridge: 1e-2,
      distill: 1e-3,
      reward: 1e-3,
    },
  },
  {
    id: "test/tiny-qwen3-teacher",
    hf_repo: null,
    family: "llm",
    adapters: ["lora", "prefix_kv"],
    default_for: [],
    price_per_million_tokens_usd: 2,
    max_context_tokens: 2048,
    template_revision: "qwen3@3",
    calibrated_lrs: { sft: 1e-3 },
  },
]);

/** A frontier judge the operator priced (GRAD_JUDGE_MODELS_JSON). */
export const TEST_JUDGE = "test/frontier-judge";
export const TEST_JUDGES_JSON = JSON.stringify([
  { id: TEST_JUDGE, price_per_million_tokens_usd: 10 },
]);

export interface TestApp {
  app: ReturnType<typeof createGradApp>["app"];
  services: ReturnType<typeof createGradApp>["services"];
  deps: AppDependencies;
  clock: ManualClock;
  storageDir: string;
  request: (
    pathname: string,
    init?: {
      method?: string;
      body?: unknown;
      token?: string | null;
      headers?: Record<string, string>;
    },
  ) => Promise<Response>;
  json: <T = Record<string, unknown>>(
    pathname: string,
    init?: {
      method?: string;
      body?: unknown;
      token?: string | null;
      headers?: Record<string, string>;
    },
  ) => Promise<{ status: number; body: T; headers: Headers }>;
  /** Mints a workspace key in `workspaceId` with `scopes`. */
  mintKey: (workspaceId: string, scopes: string[]) => Promise<string>;
  close: () => Promise<void>;
}

/** Builds an app over this test file's (emptied) Postgres schema, a temp local object store and a manual clock. */
export const makeTestApp = async (
  overrides: Partial<AppDependencies> = {},
): Promise<TestApp> => {
  const clock =
    overrides.clock instanceof ManualClock
      ? overrides.clock
      : new ManualClock();
  const storageDir = await mkdtemp(
    path.join(process.env.TMPDIR ?? os.tmpdir(), "grad-api-test-"),
  );
  const { store, dispose } = overrides.store
    ? { store: overrides.store, dispose: async () => undefined }
    : await createTestStore(clock);
  const deps: AppDependencies = {
    store,
    storage: new LocalObjectStore(storageDir),
    signer: createBlobSigner("test-signing-secret"),
    auth: createLocalApiKeyAuth({
      adminKeyHash: hashApiKey(ADMIN_KEY),
      trainerKeyHash: hashApiKey(TRAINER_KEY),
      workspaceId: WORKSPACE_A,
      lookup: store.apiKeys,
    }),
    billing: createNoopBillingAdapter(),
    catalog: createModelCatalog(TINY_MODELS_JSON, TEST_JUDGES_JSON),
    clock,
    inference: null,
    regex: createRegexEvaluator(),
    settings: { maxAttempts: 3, evalConcurrency: 4, usageExportLagSeconds: 0 },
    ...overrides,
  };
  const { app, services } = createGradApp(deps);

  const request: TestApp["request"] = (pathname, init = {}) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    const token = init.token === undefined ? ADMIN_KEY : init.token;
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: BodyInit | undefined;
    if (init.body !== undefined) {
      if (typeof init.body === "string" || init.body instanceof Uint8Array) {
        body = init.body as BodyInit;
      } else {
        headers["Content-Type"] ??= "application/json";
        body = JSON.stringify(init.body);
      }
    }

    return Promise.resolve(
      app.request(pathname, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers,
        ...(body !== undefined ? { body } : {}),
      }),
    );
  };

  return {
    app,
    services,
    deps,
    clock,
    storageDir,
    request,
    json: async (pathname, init) => {
      const res = await request(pathname, init);
      const text = await res.text();

      return {
        status: res.status,
        body: (text ? JSON.parse(text) : {}) as never,
        headers: res.headers,
      };
    },
    mintKey: async (workspaceId, scopes) => {
      const { secret } = await store.apiKeys.create({
        workspaceId,
        name: `k-${scopes.join("-").replace(/[^a-z0-9-]/g, "")}`.slice(0, 60),
        scopes: scopes as never,
      });

      return secret;
    },
    close: async () => {
      await deps.regex.close();
      await dispose();
      await rm(storageDir, { recursive: true, force: true });
    },
  };
};
