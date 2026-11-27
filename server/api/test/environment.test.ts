import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { hashApiKey } from "../src/adapters.js";
import { buildDependencies } from "../src/bootstrap.js";
import { isLoopbackHost, parseServerEnvironment } from "../src/environment.js";
import { metrics } from "../src/telemetry/metrics.js";
import { postgresUrl } from "./fixtures/postgres.js";

const errorCount = async (counter: {
  get(): Promise<{ values: Array<{ labels: object; value: number }> }>;
}): Promise<number> =>
  (await counter.get()).values.find(
    (v) => (v.labels as { result?: string }).result === "error",
  )?.value ?? 0;

const counterValues = async () => ({
  outputs: await errorCount(metrics.evalOutputs),
  judge: await errorCount(metrics.judgeCalls),
});

const ADMIN_HASH = hashApiKey("admin");
const DB = { DATABASE_URL: "postgres://x" };

describe("parseServerEnvironment", () => {
  it("defaults to loopback, api_key auth and noop billing", () => {
    const env = parseServerEnvironment({
      ...DB,
      ADMIN_API_KEY_HASH: ADMIN_HASH,
    });
    expect(env).toMatchObject({
      HOST: "127.0.0.1",
      PORT: 8787,
      AUTH_MODE: "api_key",
      BILLING_MODE: "noop",
      MAX_ATTEMPTS: 10,
    });
    expect(env.warnings).toEqual([]);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });

  it("fails fast on configurations that can never work or are unsafe by accident", () => {
    expect(() => parseServerEnvironment({ AUTH_MODE: "none" })).toThrow(
      /DATABASE_URL is required/,
    );
    expect(() => parseServerEnvironment(DB)).toThrow(/ADMIN_API_KEY_HASH/);
    expect(() =>
      parseServerEnvironment({
        ...DB,
        AUTH_MODE: "none",
        BILLING_MODE: "local",
      }),
    ).toThrow(/BILLING_MODE/);
    expect(() => parseServerEnvironment({ ...DB, AUTH_MODE: "cloud" })).toThrow(
      /CLOUD_INTERNAL_API_URL/,
    );
    expect(() =>
      parseServerEnvironment({
        ...DB,
        AUTH_MODE: "none",
        TRAINER_API_KEY: "a",
        TRAINER_API_KEY_HASH: ADMIN_HASH,
      }),
    ).toThrow(/only one/);
    expect(() =>
      parseServerEnvironment({ ...DB, AUTH_MODE: "none", PORT: "99999" }),
    ).toThrow(/Invalid server configuration/);
  });

  it("warns loudly about AUTH_MODE=none, louder on non-loopback hosts", () => {
    const local = parseServerEnvironment({
      AUTH_MODE: "none",
      DATABASE_URL: "postgres://x",
    });
    expect(local.warnings).toHaveLength(1);
    expect(local.warnings[0]).toMatch(/DISABLED/);
    // r8 P2-16: full admin for anyone who can reach the port needs an explicit opt-in.
    expect(() =>
      parseServerEnvironment({
        AUTH_MODE: "none",
        HOST: "0.0.0.0",
        DATABASE_URL: "postgres://x",
      }),
    ).toThrow(/refuses to listen on non-loopback HOST=0.0.0.0/);
    const exposed = parseServerEnvironment({
      AUTH_MODE: "none",
      AUTH_MODE_NONE_ALLOW_REMOTE: "true",
      HOST: "0.0.0.0",
      DATABASE_URL: "postgres://x",
    });
    expect(exposed.warnings.join(" ")).toMatch(
      /anyone who can reach this port/,
    );
  });

  it("resolves judge endpoints with fallbacks", () => {
    const shared = parseServerEnvironment({
      ...DB,
      AUTH_MODE: "none",
      INFERENCE_BASE_URL: "http://vllm/v1",
      INFERENCE_API_KEY: "k",
    });
    expect(shared).toMatchObject({
      judgeBaseUrl: "http://vllm/v1",
      judgeApiKey: "k",
    });
    expect(shared.warnings.join(" ")).toMatch(
      /INFERENCE_BASE_URL is deprecated; rename it to GRAD_INFERENCE_BASE_URL/,
    );
    const helm = parseServerEnvironment({
      ...DB,
      AUTH_MODE: "none",
      GRAD_INFERENCE_BASE_URL: "http://vllm/v1",
      GRAD_INFERENCE_API_KEY: "k",
      GRAD_JUDGE_BASE_URL: "http://judge/v1",
    });
    expect(helm).toMatchObject({
      inferenceBaseUrl: "http://vllm/v1",
      inferenceApiKey: "k",
      judgeBaseUrl: "http://judge/v1",
      judgeApiKey: undefined,
    });
    expect(helm.warnings.join(" ")).not.toMatch(/deprecated/);
    const both = parseServerEnvironment({
      ...DB,
      AUTH_MODE: "none",
      GRAD_INFERENCE_BASE_URL: "http://new/v1",
      INFERENCE_BASE_URL: "http://old/v1",
      JUDGE_BASE_URL: "http://old-judge/v1",
      JUDGE_API_KEY: "jk",
    });
    expect(both).toMatchObject({
      inferenceBaseUrl: "http://new/v1",
      judgeBaseUrl: "http://old-judge/v1",
      judgeApiKey: "jk",
    });
    expect(both.warnings.join(" ")).toMatch(
      /INFERENCE_BASE_URL is ignored because GRAD_INFERENCE_BASE_URL is set/,
    );
    expect(
      parseServerEnvironment({ ...DB, AUTH_MODE: "none", EVAL_EXECUTOR: "0" })
        .EVAL_EXECUTOR,
    ).toBe(false);
  });
});

describe("buildDependencies", () => {
  it("wires local adapters, the trainer key and inference clients", async () => {
    const dir = await mkdtemp(
      path.join(process.env.TMPDIR ?? os.tmpdir(), "grad-boot-"),
    );
    try {
      const deps = await buildDependencies(
        parseServerEnvironment({
          DATABASE_URL: postgresUrl(),
          ADMIN_API_KEY_HASH: ADMIN_HASH,
          TRAINER_API_KEY: "worker-secret",
          STORAGE_DIR: dir,
          GRAD_INFERENCE_BASE_URL: "http://127.0.0.1:9/v1",
          GRAD_JUDGE_BASE_URL: "http://127.0.0.1:10/v1",
          GRAD_EXTRA_MODELS_JSON:
            '[{"id":"t/x","family":"llm","adapters":["lora"],"price_per_million_tokens_usd":1,"calibrated_lrs":{"sft":1e-4}}]',
        }),
      );
      expect(deps.storage.kind).toBe("local");
      expect(deps.billing.usageExport).toBeUndefined();
      expect(deps.settings.jobEventRetentionDays).toBe(90);
      expect(deps.inference).not.toBeNull();
      expect(deps.inference?.judge).not.toBe(deps.inference?.models);
      expect(deps.catalog.find("t/x")).toBeDefined();
      expect(await deps.auth.authenticate("worker-secret")).toMatchObject({
        scopes: ["trainer:worker"],
      });
      expect(await deps.auth.authenticate("admin")).toMatchObject({
        scopes: ["admin"],
      });
      await deps.regex.close();
      await deps.store.close();

      const none = await buildDependencies(
        parseServerEnvironment({
          DATABASE_URL: postgresUrl(),
          AUTH_MODE: "none",
          STORAGE_DIR: dir,
          INFERENCE_BASE_URL: "http://127.0.0.1:9/v1",
        }),
      );
      // One endpoint, two counters: generations and judge calls.
      const before = await counterValues();
      const request = {
        model: "m",
        workspace: "ws",
        messages: [{ role: "user" as const, content: "hi" }],
        temperature: 0,
        max_tokens: 1,
      };
      await expect(none.inference?.models.complete(request)).rejects.toThrow();
      await expect(none.inference?.judge.complete(request)).rejects.toThrow();
      const after = await counterValues();
      expect(after.outputs - before.outputs).toBe(1);
      expect(after.judge - before.judge).toBe(1);
      expect(await none.auth.authenticate(undefined)).toMatchObject({
        kind: "dev",
      });
      await none.regex.close();
      await none.store.close();

      const cloud = await buildDependencies(
        parseServerEnvironment({
          DATABASE_URL: postgresUrl(),
          AUTH_MODE: "cloud",
          BILLING_MODE: "cloud",
          CLOUD_INTERNAL_API_URL: "http://127.0.0.1:9",
          CLOUD_SERVICE_TOKEN: "svc",
          S3_BUCKET: "b",
          S3_ENDPOINT: "http://127.0.0.1:9",
          S3_REGION: "us-east-1",
          TRAINER_API_KEY_HASH: hashApiKey("w"),
          BLOB_SIGNING_SECRET: "s",
        }),
      );
      expect(cloud.storage.kind).toBe("s3");
      expect(cloud.billing.usageExport).toBeDefined();
      expect(cloud.inference).toBeNull();
      expect(await cloud.auth.authenticate("w")).toMatchObject({
        kind: "worker",
      });
      await cloud.regex.close();
      await cloud.store.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
