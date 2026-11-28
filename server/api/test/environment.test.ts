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
      "AUTH_MODE=cloud requires GRAD_CLOUD_AUTH_DATABASE_URL, GRAD_CLOUD_JWKS_URL, GRAD_CLOUD_JWT_ISSUER.",
    );
    expect(() =>
      parseServerEnvironment({
        ...DB,
        AUTH_MODE: "none",
        BILLING_MODE: "cloud",
      }),
    ).toThrow(
      "BILLING_MODE=cloud requires GRAD_CLOUD_BILLING_URL, GRAD_CLOUD_PRICES_URL, CLOUD_SERVICE_TOKEN.",
    );
    const billing = {
      ...DB,
      AUTH_MODE: "none",
      BILLING_MODE: "cloud",
      GRAD_CLOUD_BILLING_URL: "https://api.example.com/billing",
      GRAD_CLOUD_PRICES_URL: "https://api.example.com/prices",
      CLOUD_SERVICE_TOKEN: "svc",
    };
    expect(() =>
      parseServerEnvironment({
        ...billing,
        GRAD_CLOUD_BILLING_URL: "http://billing.example.com",
      }),
    ).toThrow(/GRAD_CLOUD_BILLING_URL must use https/);
    expect(
      parseServerEnvironment({
        ...billing,
        GRAD_CLOUD_BILLING_URL: "http://billing.cloud.svc:8080/billing",
      }).GRAD_CLOUD_BILLING_URL,
    ).toBe("http://billing.cloud.svc:8080/billing");
    expect(() =>
      parseServerEnvironment({
        ...billing,
        GRAD_INFERENCE_BASE_URL: "http://127.0.0.1:9/v1",
      }),
    ).toThrow(/set GRAD_CLOUD_GATEWAY_URL instead/);
    expect(() =>
      parseServerEnvironment({
        ...billing,
        GRAD_CLOUD_GATEWAY_URL: "https://gw.example.com/v1",
      }),
    ).toThrow("GRAD_CLOUD_GATEWAY_URL requires CLOUD_INTERNAL_API_URL.");
    expect(
      parseServerEnvironment({
        ...billing,
        GRAD_CLOUD_GATEWAY_URL: "https://gw.example.com/v1",
        CLOUD_INTERNAL_API_URL: "https://api.example.com",
      }).inferenceConfigured,
    ).toBe(true);
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
      GRAD_INFERENCE_BASE_URL: "http://vllm/v1",
      GRAD_INFERENCE_API_KEY: "k",
    });
    expect(shared).toMatchObject({
      judgeBaseUrl: "http://vllm/v1",
      judgeApiKey: "k",
      GRAD_SERVER_URL: "http://127.0.0.1:8787",
      EVAL_CONCURRENCY: 8,
      GRAD_LEASE_SECONDS: 180,
    });
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
      expect(deps.billing.pushUsage).toBeUndefined();
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
          GRAD_INFERENCE_BASE_URL: "http://127.0.0.1:9/v1",
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
          GRAD_CLOUD_AUTH_DATABASE_URL: "postgres://127.0.0.1:9/product",
          GRAD_CLOUD_JWKS_URL: "http://127.0.0.1:9/jwks.json",
          GRAD_CLOUD_JWT_ISSUER: "https://api.example.com",
          GRAD_CLOUD_BILLING_URL: "http://127.0.0.1:9/billing",
          GRAD_CLOUD_PRICES_URL: "http://127.0.0.1:9/prices",
          CLOUD_SERVICE_TOKEN: "svc",
          S3_BUCKET: "b",
          S3_ENDPOINT: "http://127.0.0.1:9",
          S3_REGION: "us-east-1",
          TRAINER_API_KEY_HASH: hashApiKey("w"),
        }),
      );
      // Billing is down at boot: the server starts, unpriced (model
      // lookups answer 503 billing_unavailable until a list is fetched).
      expect(cloud.billing.pushUsage).toBeDefined();
      expect(cloud.prices?.fresh()).toBe(false);
      expect(() => cloud.catalog.list()).toThrow(
        expect.objectContaining({ code: "billing_unavailable" }),
      );
      expect(cloud.traces).toBeNull();
      expect(cloud.inferenceConfigured).toBe(false);
      expect(await cloud.auth.authenticate("w")).toMatchObject({
        kind: "worker",
      });
      await cloud.store.close();

      // The `gradiated` source waits for the product's traces:pull: off
      // (501 source_unavailable, "coming soon") unless switched on.
      const cloudEnv = {
        DATABASE_URL: postgresUrl(),
        AUTH_MODE: "cloud",
        GRAD_CLOUD_AUTH_DATABASE_URL: "postgres://127.0.0.1:9/product",
        GRAD_CLOUD_JWKS_URL: "http://127.0.0.1:9/jwks.json",
        GRAD_CLOUD_JWT_ISSUER: "https://api.example.com",
        CLOUD_INTERNAL_API_URL: "http://127.0.0.1:9",
        CLOUD_SERVICE_TOKEN: "svc",
        S3_BUCKET: "b",
        S3_ENDPOINT: "http://127.0.0.1:9",
        S3_REGION: "us-east-1",
        TRAINER_API_KEY_HASH: hashApiKey("w"),
      };
      for (const [flag, traced] of [
        [undefined, false],
        ["true", true],
      ] as const) {
        const deps = await buildDependencies(
          parseServerEnvironment({
            ...cloudEnv,
            ...(flag ? { GRAD_CLOUD_TRACES_ENABLED: flag } : {}),
          }),
        );
        expect(deps.traces !== null && deps.traces !== undefined).toBe(traced);
        await deps.store.close();
      }
      // Switched on without the product's address: off, and said so at boot.
      const { CLOUD_INTERNAL_API_URL: _url, ...unaddressed } = cloudEnv;
      expect(
        parseServerEnvironment({
          ...unaddressed,
          GRAD_CLOUD_TRACES_ENABLED: "true",
        }).warnings.join(" "),
      ).toMatch(/GRAD_CLOUD_TRACES_ENABLED=true needs CLOUD_INTERNAL_API_URL/);
    } finally {
      process.env = saved;
    }
  });
});
