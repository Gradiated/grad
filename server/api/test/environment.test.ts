import { describe, expect, it } from "vitest";

import { hashApiKey } from "../src/adapters.js";
import { buildDependencies } from "../src/bootstrap.js";
import {
  isLoopbackHost,
  parseEvalWorkerEnvironment,
  parseServerEnvironment,
} from "../src/environment.js";
import { postgresUrl } from "./fixtures/postgres.js";
import { s3Target } from "./fixtures/s3.js";

const ADMIN_HASH = hashApiKey("admin");
const DB = { DATABASE_URL: "postgres://x", S3_BUCKET: "grad" };

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
    // Storage is S3-compatible only: there is no local-disk mode.
    expect(() =>
      parseServerEnvironment({
        DATABASE_URL: "postgres://x",
        AUTH_MODE: "none",
      }),
    ).toThrow(/S3_BUCKET is required/);
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
      ...DB,
    });
    expect(local.warnings).toHaveLength(1);
    expect(local.warnings[0]).toMatch(/DISABLED/);
    // r8 P2-16: full admin for anyone who can reach the port needs an explicit opt-in.
    expect(() =>
      parseServerEnvironment({
        AUTH_MODE: "none",
        HOST: "0.0.0.0",
        ...DB,
      }),
    ).toThrow(/refuses to listen on non-loopback HOST=0.0.0.0/);
    const exposed = parseServerEnvironment({
      AUTH_MODE: "none",
      AUTH_MODE_NONE_ALLOW_REMOTE: "true",
      HOST: "0.0.0.0",
      ...DB,
    });
    expect(exposed.warnings.join(" ")).toMatch(
      /anyone who can reach this port/,
    );
  });

  it("resolves the eval worker's endpoints with fallbacks", () => {
    const shared = parseEvalWorkerEnvironment({
      INFERENCE_BASE_URL: "http://vllm/v1",
      INFERENCE_API_KEY: "k",
    });
    expect(shared).toMatchObject({
      judgeBaseUrl: "http://vllm/v1",
      judgeApiKey: "k",
      GRAD_SERVER_URL: "http://127.0.0.1:8787",
      EVAL_CONCURRENCY: 8,
      GRAD_LEASE_SECONDS: 180,
    });
    expect(shared.warnings.join(" ")).toMatch(
      /INFERENCE_BASE_URL is deprecated; rename it to GRAD_INFERENCE_BASE_URL/,
    );
    const helm = parseEvalWorkerEnvironment({
      GRAD_INFERENCE_BASE_URL: "http://vllm/v1",
      GRAD_INFERENCE_API_KEY: "k",
      GRAD_JUDGE_BASE_URL: "http://judge/v1",
      EVAL_CONCURRENCY: "16",
    });
    expect(helm).toMatchObject({
      inferenceBaseUrl: "http://vllm/v1",
      inferenceApiKey: "k",
      judgeBaseUrl: "http://judge/v1",
      judgeApiKey: undefined,
      EVAL_CONCURRENCY: 16,
    });
    expect(helm.warnings).toEqual([]);
    const both = parseEvalWorkerEnvironment({
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
    // Without an endpoint it still scores with validators, and says so.
    expect(parseEvalWorkerEnvironment({}).warnings.join(" ")).toMatch(
      /GRAD_INFERENCE_BASE_URL is not set: this eval worker runs only validators/,
    );
    expect(() => parseEvalWorkerEnvironment({ EVAL_CONCURRENCY: "0" })).toThrow(
      /Invalid eval worker configuration: EVAL_CONCURRENCY/,
    );
  });

  it("only checks on the API that an eval endpoint is configured", () => {
    const api = parseServerEnvironment({
      ...DB,
      AUTH_MODE: "none",
      GRAD_INFERENCE_BASE_URL: "http://vllm/v1",
      GRAD_INFERENCE_API_KEY: "k",
      EVAL_CONCURRENCY: "4",
    });
    expect(api.inferenceConfigured).toBe(true);
    expect(api.warnings.join(" ")).toMatch(
      /GRAD_INFERENCE_API_KEY is ignored by the API: evals run on eval workers.*EVAL_CONCURRENCY is ignored by the API/,
    );
    expect(
      parseServerEnvironment({ ...DB, AUTH_MODE: "none" }).inferenceConfigured,
    ).toBe(false);
  });
});

describe("buildDependencies", () => {
  it("wires local adapters, the trainer key and the eval endpoint flag", async () => {
    const s3 = s3Target();
    const storage = {
      S3_BUCKET: s3.bucket,
      S3_ENDPOINT: s3.endpoint,
      S3_PUBLIC_ENDPOINT: "http://s3.example.test:9999",
    };
    // The AWS SDK's default credential chain reads the key from the process.
    const saved = { ...process.env };
    Object.assign(process.env, {
      AWS_ACCESS_KEY_ID: s3.accessKeyId,
      AWS_SECRET_ACCESS_KEY: s3.secretAccessKey,
      AWS_REGION: s3.region,
    });
    try {
      const deps = await buildDependencies(
        parseServerEnvironment({
          DATABASE_URL: postgresUrl(),
          ADMIN_API_KEY_HASH: ADMIN_HASH,
          TRAINER_API_KEY: "worker-secret",
          ...storage,
          GRAD_INFERENCE_BASE_URL: "http://127.0.0.1:9/v1",
          GRAD_JUDGE_BASE_URL: "http://127.0.0.1:10/v1",
          GRAD_EXTRA_MODELS_JSON:
            '[{"id":"t/x","family":"llm","adapters":["lora"],"price_per_million_tokens_usd":1,"calibrated_lrs":{"sft":1e-4}}]',
        }),
      );
      // S3_PUBLIC_ENDPOINT signs client upload tickets; workers keep S3_ENDPOINT.
      const sha = "0".repeat(64);
      const ticket = { sha256: sha, sizeBytes: 1, expiresInSeconds: 60 };
      expect(
        (
          await deps.storage.presignUpload(`a/${sha}`, {
            ...ticket,
            forClient: true,
          })
        ).url,
      ).toMatch(/^http:\/\/s3\.example\.test:9999\//);
      expect(
        (await deps.storage.presignUpload(`a/${sha}`, ticket)).url,
      ).toMatch(new RegExp(`^${s3.endpoint}/`));
      await deps.storage.put("boot/check", Buffer.from("ok"));
      expect(await deps.storage.head("boot/check")).toMatchObject({
        sizeBytes: 2,
      });
      expect(deps.billing.usageExport).toBeUndefined();
      expect(deps.settings.jobEventRetentionDays).toBe(90);
      expect(deps.inferenceConfigured).toBe(true);
      expect(deps.catalog.find("t/x")).toBeDefined();
      expect(await deps.auth.authenticate("worker-secret")).toMatchObject({
        scopes: ["trainer:worker"],
      });
      expect(await deps.auth.authenticate("admin")).toMatchObject({
        scopes: ["admin"],
      });
      await deps.store.close();

      const none = await buildDependencies(
        parseServerEnvironment({
          DATABASE_URL: postgresUrl(),
          AUTH_MODE: "none",
          ...storage,
          INFERENCE_BASE_URL: "http://127.0.0.1:9/v1",
        }),
      );
      expect(none.inferenceConfigured).toBe(true);
      expect(await none.auth.authenticate(undefined)).toMatchObject({
        kind: "dev",
      });
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
        }),
      );
      expect(cloud.billing.usageExport).toBeDefined();
      expect(cloud.inferenceConfigured).toBe(false);
      expect(await cloud.auth.authenticate("w")).toMatchObject({
        kind: "worker",
      });
      await cloud.store.close();
    } finally {
      process.env = saved;
    }
  });
});
