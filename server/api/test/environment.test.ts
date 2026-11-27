import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { hashApiKey } from "../src/adapters.js";
import { buildDependencies } from "../src/bootstrap.js";
import { isLoopbackHost, parseServerEnvironment } from "../src/environment.js";

const ADMIN_HASH = hashApiKey("admin");

describe("parseServerEnvironment", () => {
  it("defaults to loopback, api_key auth and disabled deploy", () => {
    const env = parseServerEnvironment({ ADMIN_API_KEY_HASH: ADMIN_HASH });
    expect(env).toMatchObject({
      HOST: "127.0.0.1",
      PORT: 8787,
      AUTH_MODE: "api_key",
      DEPLOY_MODE: "disabled",
      BILLING_MODE: "noop",
      MAX_ATTEMPTS: 3,
    });
    expect(env.warnings.join(" ")).toMatch(/in-memory store/);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });

  it("fails fast on configurations that can never work or are unsafe by accident", () => {
    expect(() => parseServerEnvironment({})).toThrow(/ADMIN_API_KEY_HASH/);
    expect(() =>
      parseServerEnvironment({ AUTH_MODE: "none", DEPLOY_MODE: "local" }),
    ).toThrow(/DEPLOY_MODE=local was removed/);
    expect(() => parseServerEnvironment({ AUTH_MODE: "cloud" })).toThrow(
      /CLOUD_INTERNAL_API_URL/,
    );
    expect(() =>
      parseServerEnvironment({
        AUTH_MODE: "none",
        TRAINER_API_KEY: "a",
        TRAINER_API_KEY_HASH: ADMIN_HASH,
      }),
    ).toThrow(/only one/);
    expect(() =>
      parseServerEnvironment({ AUTH_MODE: "none", PORT: "99999" }),
    ).toThrow(/Invalid server configuration/);
  });

  it("warns loudly about AUTH_MODE=none, louder on non-loopback hosts", () => {
    const local = parseServerEnvironment({
      AUTH_MODE: "none",
      DATABASE_URL: "postgres://x",
    });
    expect(local.warnings).toHaveLength(1);
    expect(local.warnings[0]).toMatch(/DISABLED/);
    const exposed = parseServerEnvironment({
      AUTH_MODE: "none",
      HOST: "0.0.0.0",
      DATABASE_URL: "postgres://x",
    });
    expect(exposed.warnings.join(" ")).toMatch(
      /anyone who can reach this port/,
    );
  });

  it("resolves judge endpoints with fallbacks", () => {
    const shared = parseServerEnvironment({
      AUTH_MODE: "none",
      INFERENCE_BASE_URL: "http://vllm/v1",
      INFERENCE_API_KEY: "k",
    });
    expect(shared).toMatchObject({
      judgeBaseUrl: "http://vllm/v1",
      judgeApiKey: "k",
    });
    const helm = parseServerEnvironment({
      AUTH_MODE: "none",
      INFERENCE_BASE_URL: "http://vllm/v1",
      INFERENCE_API_KEY: "k",
      GRAD_JUDGE_BASE_URL: "http://judge/v1",
    });
    expect(helm).toMatchObject({
      judgeBaseUrl: "http://judge/v1",
      judgeApiKey: undefined,
    });
    expect(
      parseServerEnvironment({ AUTH_MODE: "none", EVAL_EXECUTOR: "0" })
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
          ADMIN_API_KEY_HASH: ADMIN_HASH,
          TRAINER_API_KEY: "worker-secret",
          STORAGE_DIR: dir,
          INFERENCE_BASE_URL: "http://127.0.0.1:9/v1",
          JUDGE_BASE_URL: "http://127.0.0.1:10/v1",
          GRAD_EXTRA_MODELS_JSON:
            '[{"id":"t/x","family":"llm","adapters":["lora"],"price_per_million_tokens_usd":1,"calibrated_lrs":{"sft":1e-4}}]',
        }),
      );
      expect(deps.storage.kind).toBe("local");
      expect(deps.deploy.mode).toBe("disabled");
      expect(deps.serving.mode).toBe("disabled");
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
          AUTH_MODE: "none",
          STORAGE_DIR: dir,
          INFERENCE_BASE_URL: "http://127.0.0.1:9/v1",
        }),
      );
      expect(none.inference?.judge).toBe(none.inference?.models);
      expect(await none.auth.authenticate(undefined)).toMatchObject({
        kind: "dev",
      });
      await none.regex.close();

      const cloud = await buildDependencies(
        parseServerEnvironment({
          AUTH_MODE: "cloud",
          BILLING_MODE: "cloud",
          DEPLOY_MODE: "cloud",
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
      expect(cloud.deploy.mode).toBe("cloud");
      expect(cloud.serving.mode).toBe("cloud");
      expect(cloud.inference).toBeNull();
      expect(await cloud.auth.authenticate("w")).toMatchObject({
        kind: "worker",
      });
      await cloud.regex.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
